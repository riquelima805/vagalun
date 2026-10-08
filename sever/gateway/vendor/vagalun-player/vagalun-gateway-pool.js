/* vagalun-gateway-pool.js — o CLIENTE escolhe o gateway e NÃO confia em nenhum.
 *
 * Script clássico (UMD): funciona em página (<script>), em Service Worker (importScripts) e em Node
 * (require). Sem dependências; usa só fetch + WebCrypto.
 *
 *   const pool = new VagalunPool.Pool({ seeds: ['https://gw1.exemplo', 'https://gw2.exemplo'] });
 *   await pool.refresh();                              // aprende gateways (/gw/list) e mede RTT (/gw/info)
 *   const r = await pool.fetchSite('video.vagalun.shop', '/app.js');
 *   // r = { bytes, contentType, fileId, verified: 'yes'|'no', version, gateway }
 *
 * O que é verificado (de cada gateway, sempre):
 *   1) manifesto do site: assinatura Ed25519 do dono; dono "fixado" (TOFU, ou a chain via opts.chain);
 *      versão nunca anda pra trás; v2 nunca volta pra v1;
 *   2) arquivo: sha256(domínio+caminho+bytes) == fileId (é isso que amarra bytes ao manifesto assinado).
 * Gateway que mente é marcado e vai pro fim do ranking; a requisição cai pro próximo.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.VagalunPool = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const te = new TextEncoder();
  const subtle = () => {
    const c = (typeof crypto !== 'undefined' && crypto) || (typeof globalThis !== 'undefined' && globalThis.crypto);
    if (!c || !c.subtle) throw new Error('crypto.subtle indisponível (precisa de HTTPS)');
    return c.subtle;
  };

  // ------------------------------------------------------------ utilidades

  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function base58decode(s) {
    let n = 0n;
    for (const ch of s) {
      const v = B58.indexOf(ch);
      if (v < 0) throw new Error('base58 inválido');
      n = n * 58n + BigInt(v);
    }
    const bytes = [];
    while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
    let zeros = 0;
    for (const ch of s) { if (ch === '1') zeros++; else break; }
    return Uint8Array.from([...new Array(zeros).fill(0), ...bytes]);
  }
  function b64decode(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function hex(buf) { return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
  function concat(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }

  // ------------------------------------------------------------ manifesto v2 (idêntico a sever/chain/siteManifest.js)

  function cmpUtf8(a, b) {
    const x = te.encode(a), y = te.encode(b);
    const n = Math.min(x.length, y.length);
    for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  }
  function validDomain(d) {
    return typeof d === 'string' && /^[a-z0-9.-]{3,100}$/.test(d) && !/^[.-]|[.-]$/.test(d) && !d.includes('..');
  }
  /** string canônica, ou lança erro se o manifesto for inválido/ambíguo */
  function canonicalManifestV2(domain, version, routes) {
    if (!validDomain(domain)) throw new Error('domínio inválido');
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('version inválida');
    const seen = new Set();
    const lines = routes
      .map((r) => {
        const f = [r.path, r.fileId, r.contentType || '', r.fileKeyB64 || ''];
        for (const x of f) if (typeof x !== 'string' || x.includes('\n') || x.includes('|')) throw new Error('campo inválido na rota');
        return { path: f[0], line: f.join('|') };
      })
      .sort((x, y) => cmpUtf8(x.path, y.path))
      .map((r) => { if (seen.has(r.path)) throw new Error('rota duplicada'); seen.add(r.path); return r.line; });
    return ['vagalun-site-v2', domain, String(version), ...lines].join('\n');
  }
  /** v1 legado: `domain\npath|fileId|contentType` ordenado com localeCompare (como o registry.js) */
  function canonicalManifestV1(domain, routes) {
    const lines = [...routes].sort((a, b) => a.path.localeCompare(b.path)).map((r) => `${r.path}|${r.fileId}|${r.contentType || ''}`);
    return `${domain}\n${lines.join('\n')}`;
  }

  async function sha256(bytes) { return new Uint8Array(await subtle().digest('SHA-256', bytes)); }

  /** manifestHash on-chain = sha256(canônico v2) */
  async function manifestHashV2(domain, version, routes) {
    return sha256(te.encode(canonicalManifestV2(domain, version, routes)));
  }

  async function defaultVerifyEd25519(messageBytes, sigB64, pubB58) {
    const pub = base58decode(pubB58);
    if (pub.length !== 32) return false;
    let key;
    try { key = await subtle().importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']); }
    catch (e) { const err = new Error('ed25519_unsupported'); err.code = 'ED25519_UNSUPPORTED'; throw err; }
    return subtle().verify({ name: 'Ed25519' }, key, b64decode(sigB64), messageBytes);
  }

  /** Mesma regra do publishSite.js / hosting: fileId = sha256(domínio + caminhoRelativo + bytes)[:32] */
  function siteSaltCandidates(domain, routePath) {
    const rel = routePath === '/' ? '/index.html' : routePath;
    return [...new Set([domain + rel, domain + routePath])];
  }
  async function fileIdMatches(fileId, domain, routePath, bytes) {
    for (const salt of siteSaltCandidates(domain, routePath)) {
      const h = hex(await sha256(concat(te.encode(salt), bytes))).slice(0, 32);
      if (h === fileId) return true;
    }
    return false;
  }

  /**
   * Verifica a entrada de site recebida de um gateway. Devolve { owner, version, routes, v2 }.
   * Lança Error em qualquer problema (assinatura, dono, rollback, downgrade, chain).
   */
  async function verifySiteEntry(entry, domain, { pinned, chain, verifyEd25519 = defaultVerifyEd25519, strict = false } = {}) {
    if (!entry || entry.domain !== domain || !Array.isArray(entry.routes) || !entry.ownerPubkeyB58) throw new Error('entrada de site inválida');
    const version = Number(entry.version || 0);
    const v2 = version > 0;
    if (strict && !v2) throw new Error('manifesto v1 não aceito (strict)');
    const sig = v2 ? entry.signatureV2B64 : entry.signatureB64;
    if (!sig) throw new Error('sem assinatura');
    const msg = te.encode(v2 ? canonicalManifestV2(domain, version, entry.routes) : canonicalManifestV1(domain, entry.routes));
    if (!(await verifyEd25519(msg, sig, entry.ownerPubkeyB58))) throw new Error('assinatura do manifesto inválida');

    if (pinned) {
      if (pinned.owner !== entry.ownerPubkeyB58) throw new Error('dono do site mudou — recusado');
      if (v2 && version < pinned.version) throw new Error('rollback: versão menor que a já vista');
      if (!v2 && pinned.version > 0) throw new Error('downgrade pra v1 recusado');
    }
    if (chain) {
      const rec = await chain(domain); // { owner, version, manifestHashHex } | null
      if (!rec) throw new Error('domínio não registrado on-chain');
      if (rec.owner !== entry.ownerPubkeyB58) throw new Error('dono difere do on-chain');
      if (!v2) throw new Error('registro on-chain exige manifesto v2');
      if (rec.version !== version) throw new Error(`versão ${version} != on-chain ${rec.version}`);
      if (hex(await manifestHashV2(domain, version, entry.routes)) !== rec.manifestHashHex) throw new Error('hash do manifesto != on-chain');
    }
    return { owner: entry.ownerPubkeyB58, version, routes: entry.routes, v2 };
  }

  // ------------------------------------------------------------ Pool

  const memoryStore = () => {
    const m = new Map();
    return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); } };
  };
  const join = (base, path) => base.replace(/\/$/, '') + path;

  class Pool {
    /**
     * @param {object} o
     * @param {string[]} o.seeds           gateways conhecidos de fábrica (a página/SW costuma incluir a própria origem)
     * @param {typeof fetch} [o.fetchImpl]
     * @param {number} [o.hedgeMs]         espera antes de disparar o próximo gateway em paralelo
     * @param {number} [o.timeoutMs]       limite por tentativa
     * @param {boolean} [o.strict]         exige v2 e fileId verificável; senão devolve verified:'no' em vez de recusar
     * @param {{get:Function,set:Function}} [o.store]  guarda dono/versão fixados (async)
     * @param {(domain:string)=>Promise<object|null>} [o.chain]  resolvedor on-chain (opcional)
     * @param {Function} [o.verifyEd25519]
     */
    constructor(o = {}) {
      this.fetch = o.fetchImpl || ((...a) => fetch(...a));
      this.hedgeMs = o.hedgeMs ?? 350;
      this.timeoutMs = o.timeoutMs ?? 8000;
      this.strict = !!o.strict;
      this.store = o.store || memoryStore();
      this.chain = o.chain || null;
      this.verifyEd25519 = o.verifyEd25519 || defaultVerifyEd25519;
      this.maxGateways = o.maxGateways ?? 16;
      this.gws = new Map(); // url -> { url, rtt, fails, bad, lastOk, via }
      this.manifests = new Map(); // domain -> { at, verified }
      this.manifestTtlMs = o.manifestTtlMs ?? 60_000;
      this.addGateways(o.seeds || [], 'seed');
    }

    addGateways(urls, via = 'learned') {
      for (const u of urls || []) {
        let o;
        try { const x = new URL(u); if (!/^https?:$/.test(x.protocol)) continue; o = `${x.protocol}//${x.host}`; } catch (_) { continue; }
        if (!this.gws.has(o) && this.gws.size < this.maxGateways) this.gws.set(o, { url: o, rtt: null, fails: 0, bad: 0, lastOk: 0, via });
      }
    }

    /** menor é melhor. RTT desconhecido vale 1500ms; falha recente e CONTEÚDO RUIM pesam. */
    _score(g) { return (g.rtt == null ? 1500 : g.rtt) + g.fails * 800 + g.bad * 20000; }
    ranked() { return [...this.gws.values()].sort((a, b) => this._score(a) - this._score(b)); }

    _ok(url, ms) {
      const g = this.gws.get(url); if (!g) return;
      g.rtt = g.rtt == null ? ms : Math.round(g.rtt * 0.6 + ms * 0.4); g.fails = 0; g.lastOk = Date.now();
    }
    _fail(url, err) {
      const g = this.gws.get(url); if (!g) return;
      if (err && err.vagalunBad) g.bad += 1; else g.fails = Math.min(g.fails + 1, 6);
    }

    async _fetchJson(url, timeoutMs = 4000) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const r = await this.fetch(url, { signal: ctl.signal, cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return await r.json();
      } finally { clearTimeout(t); }
    }

    /** Aprende gateways novos (/gw/list dos 2 melhores) e mede o RTT de todos (/gw/info), em paralelo. */
    async refresh() {
      const top = this.ranked().slice(0, 2);
      await Promise.all(top.map(async (g) => {
        try { const j = await this._fetchJson(join(g.url, '/gw/list')); this.addGateways(j.gateways, 'list'); } catch (_) { /* tenta o resto */ }
      }));
      await Promise.all([...this.gws.values()].map(async (g) => {
        const t0 = Date.now();
        try { const j = await this._fetchJson(join(g.url, '/gw/info?t=' + t0), 3000); if (j && j.ok) this._ok(g.url, Date.now() - t0); else this._fail(g.url); }
        catch (e) { this._fail(g.url, e); }
      }));
      return this.ranked();
    }

    /**
     * Corrida "hedged": começa pelo melhor; se não deu certo em hedgeMs (ou falhou), dispara o próximo
     * SEM cancelar o primeiro; o primeiro que terminar OK vence e os outros são abortados.
     * attempt(gatewayUrl, signal) devolve o resultado ou lança. Lança vagalunBad:true se o gateway MENTIU.
     */
    race(attempt, { max = 4 } = {}) {
      const order = this.ranked().slice(0, max);
      if (!order.length) return Promise.reject(new Error('nenhum gateway conhecido'));
      return new Promise((resolve, reject) => {
        let started = 0, failures = 0, done = false, timer = null;
        const ctls = [], errors = [];
        const startNext = () => {
          clearTimeout(timer);
          if (done || started >= order.length) return;
          const g = order[started++];
          const ctl = new AbortController(); ctls.push(ctl);
          const t0 = Date.now();
          const to = setTimeout(() => ctl.abort(), this.timeoutMs);
          Promise.resolve().then(() => attempt(g.url, ctl.signal)).then((value) => {
            clearTimeout(to);
            if (done) return;
            done = true; clearTimeout(timer);
            this._ok(g.url, Date.now() - t0);
            ctls.forEach((c) => { if (c !== ctl) c.abort(); });
            resolve({ value, gateway: g.url });
          }, (err) => {
            clearTimeout(to);
            if (done) return;
            this._fail(g.url, err);
            errors.push(`${g.url}: ${err && err.message}`);
            if (++failures >= order.length) { done = true; clearTimeout(timer); reject(new Error('todos os gateways falharam: ' + errors.join(' | '))); }
            else startNext();
          });
          if (started < order.length) timer = setTimeout(startNext, this.hedgeMs);
        };
        startNext();
      });
    }

    /** Manifesto verificado de um site (cache curto em memória; dono/versão fixados no store). */
    async getSiteManifest(domain) {
      const c = this.manifests.get(domain);
      if (c && Date.now() - c.at < this.manifestTtlMs) return c.verified;
      const pinKey = 'pin:' + domain;
      const pinned = await this.store.get(pinKey);
      const { value } = await this.race(async (gw, signal) => {
        const r = await this.fetch(join(gw, `/sync/registry?domain=${encodeURIComponent(domain)}&files=0`), { signal, cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const snap = await r.json();
        const entry = (snap.sites || []).find((s) => s.domain === domain);
        if (!entry) throw new Error('gateway não conhece o site');
        try {
          return await verifySiteEntry(entry, domain, { pinned, chain: this.chain, verifyEd25519: this.verifyEd25519, strict: this.strict });
        } catch (e) { e.vagalunBad = e.code !== 'ED25519_UNSUPPORTED'; throw e; }
      });
      await this.store.set(pinKey, { owner: value.owner, version: Math.max(value.version, pinned ? pinned.version : 0) });
      this.manifests.set(domain, { at: Date.now(), verified: value });
      return value;
    }

    /** Baixa e CONFERE um arquivo de site. */
    async fetchSite(domain, path = '/', { range } = {}) {
      const m = await this.getSiteManifest(domain);
      const route = m.routes.find((r) => r.path === path) || m.routes.find((r) => r.path === '/');
      if (!route) throw new Error('rota não encontrada no manifesto');
      const headers = range ? { Range: range } : {};
      const { value, gateway } = await this.race(async (gw, signal) => {
        const r = await this.fetch(join(gw, `/raw/${route.fileId}`), { signal, headers });
        if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (range) return { bytes, verified: 'no' }; // pedaço: não dá pra conferir o fileId inteiro
        if (await fileIdMatches(route.fileId, domain, route.path, bytes)) return { bytes, verified: 'yes' };
        if (this.strict) { const e = new Error('conteúdo não bate com o fileId'); e.vagalunBad = true; throw e; }
        // não-strict: pode ser publicador com outra regra de salt. Não dá pra distinguir de adulteração.
        return { bytes, verified: 'no' };
      });
      return {
        bytes: value.bytes, verified: value.verified, contentType: route.contentType,
        fileId: route.fileId, version: m.version, gateway,
      };
    }

    /** Resposta crua (vídeo/Range): sem verificação de conteúdo, mas com failover/hedge. */
    async fetchRaw(fileId, init = {}) {
      return this.race(async (gw, signal) => {
        const r = await this.fetch(join(gw, `/raw/${fileId}`), { ...init, signal });
        if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
        return r;
      });
    }
  }

  return {
    Pool, base58decode, canonicalManifestV2, canonicalManifestV1, manifestHashV2, verifySiteEntry,
    fileIdMatches, siteSaltCandidates, defaultVerifyEd25519, hex,
  };
});
