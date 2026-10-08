'use strict';

/**
 * registrySync.js — réplica do registry entre gateways, SEM confiar no gateway de origem.
 *
 *   GET /sync/registry?since=<ms>[&domain=<d>]  ->  { sites, files, peers, gateways }
 *
 * O que a réplica aceita e por quê:
 *   SITE   só se a assinatura do dono confere (v2, ou v1 legado), o dono bate com o já fixado,
 *          a versão é maior (anti-rollback) e — se SITE_CHAIN_MODE estiver ligado — o hash bate com a chain.
 *          Isso reaproveita registry.registerSite e siteVerify: as MESMAS regras do /admin/sites.
 *   ARQUIVO só se for referenciado por um site que acabou de passar acima E, se o site é v2, a fileKey
 *          do arquivo for IGUAL à que o dono assinou. (Sem isso um seed malicioso trocaria a chave.)
 *   CONTEÚDO como a fileKey é pública (site estático), quem controla os metadados consegue fabricar um
 *          arquivo "válido" pro GCM. O que amarra o conteúdo é o fileId = sha256(domínio+caminho+bytes):
 *          a réplica baixa o arquivo (se for pequeno) e confere. Mismatch => descarta.
 *   PEERS  só pares tipo relay (nodeId -> relayNodeId do celular); nunca infra.
 *
 * Quem pode ser SEED é decisão do operador (GATEWAY_SYNC_SEEDS). Gateways aprendidos por /gw/list
 * servem de alternativa pro CLIENTE, mas NÃO viram fonte de sync automaticamente.
 */

const crypto = require('crypto');
const registry = require('./registry');
const content = require('./content');
const gwDirectory = require('./gwDirectory');
const { buildSiteGossipEntry } = require('./meshBridge');
const { verifySiteAgainstChain } = require('./siteVerify');

const sha32 = (salt, buf) => crypto.createHash('sha256').update(salt).update(buf).digest('hex').slice(0, 32);

/** Salt do fileId de arquivo de site: a mesma regra do publishSite.js e do hosting/publish.cjs. */
function siteSaltCandidates(domain, routePath) {
  const rel = routePath === '/' ? '/index.html' : routePath;
  return [...new Set([domain + rel, domain + routePath])];
}

// ------------------------------------------------------------------ exportação

function exportSnapshot({ since = 0, domain = null, withFiles = true } = {}) {
  const sites = [];
  const files = new Map();
  const relayPeers = new Map();
  for (const d of registry.listSites()) {
    if (domain && d !== domain) continue;
    const site = registry.getSiteFull(d);
    if (!site || site.updatedAt <= since) continue;
    const entry = buildSiteGossipEntry(d);
    if (!entry) continue; // site legado sem routesRaw: precisa ser republicado
    sites.push(entry);
    if (!withFiles) continue;
    for (const r of entry.routes) {
      const f = registry.getFile(r.fileId);
      if (!f || !f.fileKeyB64) continue; // só conteúdo público por natureza (mesma regra de /p2p)
      files.set(f.fileId, f);
      const holders = [...f.blocks.flatMap((b) => b.placements || []), ...(registry.getEdgeReplicas(f.fileId) || [])];
      for (const p of holders) {
        const peer = registry.getPeer(p.nodeId);
        if (peer && peer.transport === 'relay') relayPeers.set(peer.nodeId, { nodeId: peer.nodeId, relayNodeId: peer.relayNodeId });
      }
    }
  }
  return {
    v: 1,
    now: Date.now(),
    gateways: gwDirectory.list(),
    sites,
    files: [...files.values()],
    peers: [...relayPeers.values()],
  };
}

// ------------------------------------------------------------------ importação (verificada)

function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }

/**
 * @returns {Promise<{sites:{ok:number, rejected:Array}, files:{ok:number, rejected:Array}, peers:number, verifyQueue:Array}>}
 */
async function ingestSnapshot(snap, { strict = false, log = () => {}, chainCfg } = {}) {
  const out = { sites: { ok: 0, skipped: 0, rejected: [] }, files: { ok: 0, rejected: [] }, peers: 0, verifyQueue: [] };
  if (!isObj(snap) || snap.v !== 1 || !Array.isArray(snap.sites)) throw new Error('snapshot inválido');

  const accepted = new Map(); // domain -> true (sites que passaram agora)
  for (const e of snap.sites) {
    try {
      if (!isObj(e) || typeof e.domain !== 'string' || !Array.isArray(e.routes)) throw new Error('entrada de site inválida');
      const version = Number(e.version || 0);
      const v2 = version > 0;
      if (strict && !v2) throw new Error('manifesto v1 não aceito (strict)');
      const sig = v2 ? e.signatureV2B64 : e.signatureB64;
      if (!sig) throw new Error('sem assinatura');

      const existing = registry.getSiteFull(e.domain);
      if (existing && existing.ownerPubkeyB58 === e.ownerPubkeyB58) {
        if (v2 && (existing.version || 0) >= version) { out.sites.skipped++; accepted.set(e.domain, true); continue; }
        if (!v2 && (existing.version || 0) === 0 && existing.signatureB64 === sig) { out.sites.skipped++; accepted.set(e.domain, true); continue; }
      }

      const chain = await verifySiteAgainstChain(
        { domain: e.domain, ownerPubkey: e.ownerPubkeyB58, version: v2 ? version : null, routes: e.routes },
        chainCfg
      );
      if (!chain.ok) throw new Error(`chain: ${chain.reason}`);

      registry.registerSite(e.domain, e.ownerPubkeyB58, e.routes, sig, v2 ? version : null, v2 ? (e.signatureB64 || null) : null);
      accepted.set(e.domain, true);
      out.sites.ok++;
    } catch (err) {
      out.sites.rejected.push({ domain: e && e.domain, reason: err.message });
      log(`[sync] site recusado ${e && e.domain}: ${err.message}`);
    }
  }

  // peers relay (pra os placements dos arquivos resolverem)
  for (const p of Array.isArray(snap.peers) ? snap.peers : []) {
    try {
      if (isObj(p) && p.nodeId && p.relayNodeId && !registry.getPeer(p.nodeId)) { registry.addRelayPeer(p.nodeId, p.relayNodeId); out.peers++; }
    } catch (_) { /* infra/inválido: ignora */ }
  }

  // arquivo -> rotas que o referenciam, em QUALQUER site já verificado e registrado (não só os desta
  // rodada): no sync incremental o site pode ter sido aceito antes e o arquivo chegar depois.
  const refs = new Map(); // fileId -> [{ domain, path, v2, fileKeyB64 }]
  for (const d of registry.listSites()) {
    const s = registry.getSiteFull(d);
    if (!s || !s.routesRaw) continue;
    for (const r of s.routesRaw) {
      const list = refs.get(r.fileId) || [];
      list.push({ domain: d, path: r.path, v2: (s.version || 0) > 0, fileKeyB64: r.fileKeyB64 || '' });
      refs.set(r.fileId, list);
    }
  }
  for (const f of Array.isArray(snap.files) ? snap.files : []) {
    try {
      const list = refs.get(f && f.fileId);
      if (!list) throw new Error('não é referenciado por nenhum site verificado');
      if (!f.fileKeyB64) throw new Error('sem fileKey');
      // v2: a fileKey TEM que ser a assinada pelo dono. v1 (legado): a chave não era assinada, aceita.
      const ref = list.find((r) => !r.v2 || r.fileKeyB64 === f.fileKeyB64);
      if (!ref) throw new Error('fileKey difere da que o dono assinou');
      const had = registry.getFile(f.fileId);
      registry.registerFile(f);
      out.files.ok++;
      if (!had || had.integrity !== 'verified') out.verifyQueue.push({ fileId: f.fileId, domain: ref.domain, path: ref.path });
    } catch (err) {
      out.files.rejected.push({ fileId: f && f.fileId, reason: err.message });
      log(`[sync] arquivo recusado ${f && f.fileId}: ${err.message}`);
    }
  }

  if (Array.isArray(snap.gateways)) gwDirectory.learn(snap.gateways, 'sync');
  return out;
}

/**
 * Baixa o arquivo pelos shards e confere o fileId. 'verified' | 'unverifiable' | 'skipped' | 'error'
 * 'unverifiable' = nenhum salt conhecido bate: pode ser publicador com outra regra de fileId OU adulteração.
 * Em strict a réplica descarta; fora dele guarda marcado (`integrity: 'unverified'`).
 */
async function verifyFileContent({ fileId, domain, path }, { maxBytes = 2 * 1024 * 1024, strict = false, log = () => {} } = {}) {
  const f = registry.getFile(fileId);
  if (!f) return 'error';
  if (f.originalLength > maxBytes) return 'skipped';
  let buf;
  try { buf = f.originalLength === 0 ? Buffer.alloc(0) : await content.getRangeBuffer(f, 0, f.originalLength - 1); } catch (e) { log(`[sync] não deu pra baixar ${fileId} p/ conferir: ${e.message}`); return 'error'; }
  if (siteSaltCandidates(domain, path).some((salt) => sha32(salt, buf) === fileId)) {
    f.integrity = 'verified';
    return 'verified';
  }
  if (strict) {
    registry.deleteFile(fileId);
    log(`[sync] ${fileId} (${domain}${path}) NÃO bate com o fileId — descartado`);
    return 'unverifiable';
  }
  f.integrity = 'unverified';
  log(`[sync] ${fileId} (${domain}${path}) não verificável (regra de fileId desconhecida?) — mantido como "unverified"`);
  return 'unverifiable';
}

// ------------------------------------------------------------------ puxar de um seed

async function pullFrom(seedUrl, { since = 0, fetchImpl = fetch, timeoutMs = 15000, domain = null } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const q = new URLSearchParams({ since: String(since) });
    if (domain) q.set('domain', domain);
    const r = await fetchImpl(`${seedUrl.replace(/\/$/, '')}/sync/registry?${q}`, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

class SyncLoop {
  constructor({ seeds, intervalMs = 60_000, strict = false, verify = true, maxVerifyBytes = 2 * 1024 * 1024, log = console.log, fetchImpl = fetch, chainCfg } = {}) {
    this.seeds = (seeds || []).map(gwDirectory.normalizeUrl).filter(Boolean);
    this.intervalMs = intervalMs; this.strict = strict; this.verify = verify;
    this.maxVerifyBytes = maxVerifyBytes; this.log = log; this.fetchImpl = fetchImpl; this.chainCfg = chainCfg;
    this.since = new Map(); // seed -> ts
    this.timer = null;
    this.last = { at: 0, ok: 0, failed: 0, sites: 0, files: 0 };
    this.verifyPending = [];
  }

  async roundOnce() {
    let ok = 0, failed = 0, sites = 0, files = 0;
    for (const seed of this.seeds) {
      try {
        const snap = await pullFrom(seed, { since: this.since.get(seed) || 0, fetchImpl: this.fetchImpl });
        const res = await ingestSnapshot(snap, { strict: this.strict, log: this.log, chainCfg: this.chainCfg });
        // só avança o cursor se NADA foi recusado por motivo transitório; recusa por regra não volta a ser aceita
        this.since.set(seed, Math.max(0, (snap.now || Date.now()) - 5000));
        sites += res.sites.ok; files += res.files.ok;
        this.verifyPending.push(...res.verifyQueue);
        ok++;
      } catch (e) { failed++; this.log(`[sync] seed ${seed} falhou: ${e.message}`); }
    }
    if (this.verify) await this.drainVerify();
    this.last = { at: Date.now(), ok, failed, sites, files };
    return this.last;
  }

  async drainVerify() {
    const batch = this.verifyPending.splice(0, this.verifyPending.length);
    for (const item of batch) {
      const r = await verifyFileContent(item, { maxBytes: this.maxVerifyBytes, strict: this.strict, log: this.log });
      if (r === 'error') this.verifyPending.push(item); // celulares offline agora: tenta na próxima rodada
    }
  }

  start() {
    if (this.timer || !this.seeds.length) return;
    const run = () => this.roundOnce().catch((e) => this.log(`[sync] rodada falhou: ${e.message}`));
    run();
    this.timer = setInterval(run, this.intervalMs);
    this.timer.unref();
  }

  stop() { clearInterval(this.timer); this.timer = null; }
  status() { return { seeds: this.seeds, ...this.last, pendingVerify: this.verifyPending.length }; }
}

module.exports = { exportSnapshot, ingestSnapshot, verifyFileContent, pullFrom, SyncLoop, siteSaltCandidates };
