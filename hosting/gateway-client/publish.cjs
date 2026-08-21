// Versão "biblioteca" do publisher/publishSite.js, pra ser chamada de dentro
// do server.js do hosting-platform (ESM) via createRequire, em vez de rodar
// como script de linha de comando separado.
//
// publishSiteDir(siteDir, domain, opts) faz o mesmo fluxo:
//   1. registra o(s) nó(s) no gateway (/admin/peers)
//   2. fatia+cifra+RS-encode cada arquivo, sobe os shards, registra (/admin/files)
//   3. monta+assina o manifesto do site, publica (/admin/sites)
//
// opts:
//   gatewayUrl (obrigatório)      - ex: http://localhost:8788
//   adminToken (opcional)
//   k, m (default 1, 0)           - sem redundância por padrão (1 nó só)
//   relayUrl + relayNodeId        - modo celular via internet (recomendado)
//   nodeHost + nodePort           - modo TCP direto (LAN/dev)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { encodeAndUpload, deriveFileId, buildSingleNodeSlots, buildSingleRelayNodeSlots, buildMultiRelayNodeSlots } = require('./encodeAndUpload.cjs');
const { connectRelay, putShardViaRelay } = require('./relayTransport.cjs');
const { getOrCreateSiteKey } = require('./siteKeys.cjs');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wasm': 'application/wasm',
};
function guessMime(fileName) {
  const idx = fileName.lastIndexOf('.');
  return idx === -1 ? 'application/octet-stream' : (MIME[fileName.slice(idx).toLowerCase()] || 'application/octet-stream');
}

// Vídeo/áudio é publicado diferente do resto: em vez de fatiar com
// Reed-Solomon (k>1, cada nó só tem um pedaço), publica com k=1 replicado em
// vários celulares (cada um vira uma cópia completa e independente do
// arquivo cifrado — matematicamente, RS com k=1 é replicação pura, ver
// reedSolomon.cjs). Isso é o que permite o navegador do visitante baixar
// DIRETO de um celular via WebRTC (p2pPlayerScript.js) sem precisar
// reconstruir vários shards — e sem passar pela banda da VPS.
const STREAM_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mp3', '.wav', '.ogg', '.m4a', '.aac']);
function isStreamable(relPath) {
  const idx = relPath.lastIndexOf('.');
  return idx !== -1 && STREAM_EXTENSIONS.has(relPath.slice(idx).toLowerCase());
}

// Troca cada <video>/<audio> (cujo src, ou src de algum <source> filho,
// aponte pra um arquivo streamable já publicado) por um <div> + o player
// oficial (VagalunPlayer, servido pelo gateway em /__vgl/vagalun-player.iife.js)
// já configurado com fonte P2P (WebRTC direto no celular) + fallback
// automático pro /raw/:fileId (HTTP normal via VPS) — igual o script do
// Analytics, sem o usuário mexer em nada. <video> que não referencia
// nenhum arquivo streamable (raro — praticamente todo mp4/webm publicado
// vira streamable) fica intocado.
// Converte o adsConfig salvo pelo usuário no painel (site.adsConfig, formato
// simples: { enabled, vastUrl, preroll, midroll, midrollInterval, banner })
// pro formato que options.ads do VagalunPlayer espera de fato (ver player.js:
// prerollVast / midroll: [{at, vastUrl}] / overlay). Cada vídeo publicado
// desse site recebe a MESMA tag VAST do dono do site — é o anúncio dele.
function buildAdsOptions(adsConfig) {
  if (!adsConfig || !adsConfig.enabled || !adsConfig.vastUrl) return null;
  const ads = {};
  if (adsConfig.preroll !== false) ads.prerollVast = adsConfig.vastUrl;
  if (adsConfig.midroll) {
    const interval = adsConfig.midrollInterval > 0 ? adsConfig.midrollInterval : 300;
    // até 3 mid-rolls espaçados pelo intervalo configurado (ex: a cada 5min)
    ads.midroll = [1, 2, 3].map((n) => ({ at: interval * n, vastUrl: adsConfig.vastUrl }));
  }
  return Object.keys(ads).length ? ads : null;
}

let vglAutoCounter = 0;
function injectP2pPlayer(html, htmlRoutePath, streamableByPath, adsConfig) {
  const usedFileIds = [];
  const blockRe = /<(video|audio)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  const base = htmlRoutePath.slice(0, htmlRoutePath.lastIndexOf('/') + 1) || '/';

  function resolveEntry(src) {
    if (!src || /^(https?:)?\/\//i.test(src) || src.startsWith('data:')) return null;
    const resolved = src.startsWith('/') ? src : path.posix.normalize(base + src);
    return streamableByPath.get(resolved) || null;
  }

  const out = html.replace(blockRe, (full, tag, attrs, children) => {
    const attrSrcMatch = attrs.match(/\bsrc\s*=\s*("([^"]*)"|'([^']*)')/i);
    const candidates = [];
    if (attrSrcMatch) candidates.push(attrSrcMatch[2] ?? attrSrcMatch[3]);
    const sourceRe = /<source\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)')[^>]*>/gi;
    let sm;
    while ((sm = sourceRe.exec(children))) candidates.push(sm[2] ?? sm[3]);

    let entry = null;
    for (const c of candidates) { entry = resolveEntry(c); if (entry) break; }
    if (!entry) return full; // não referencia arquivo streamable — deixa como estava

    const get = (name) => {
      const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
      return m ? (m[2] ?? m[3]) : null;
    };
    const has = (name) => new RegExp(`\\b${name}\\b`, 'i').test(attrs);
    const poster = tag === 'video' ? get('poster') : null;
    const width = get('width');
    const height = get('height');
    const autoplay = has('autoplay');
    const muted = has('muted') || autoplay; // autoplay em navegador moderno só funciona muted mesmo
    const loop = has('loop');

    const elId = `vgl-auto-${++vglAutoCounter}`;
    usedFileIds.push(entry.fileId);
    const styleAttr = width || height
      ? ` style="${width ? `width:${/^\d+$/.test(width) ? width + 'px' : width};` : ''}${height ? `height:${/^\d+$/.test(height) ? height + 'px' : height};` : ''}"`
      : '';
    const adsOpts = buildAdsOptions(adsConfig);
    const opts = {
      sources: [
        { type: 'p2p', fileId: entry.fileId },
        { type: 'progressive', src: `/raw/${entry.fileId}` }
      ],
      ...(poster ? { poster } : {}),
      ...(autoplay ? { autoplay: true } : {}),
      ...(muted ? { muted: true } : {}),
      ...(loop ? { loop: true } : {}),
      ...(adsOpts ? { ads: adsOpts } : {}),
    };
    return `<div id="${elId}" class="vgl-embed"${styleAttr}></div>\n`
      + `<script>new VagalunPlayer(${JSON.stringify(`#${elId}`)}, ${JSON.stringify(opts)});</script>`;
  });

  if (usedFileIds.length === 0) return html;
  const head = `<link rel="stylesheet" href="/__vgl/vagalun-player.css">\n<script src="/__vgl/vagalun-player.iife.js"></script>\n`;
  if (/<head[^>]*>/i.test(out)) return out.replace(/<head([^>]*)>/i, `<head$1>\n${head}`);
  return head + out;
}

function listFilesRecursive(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, base));
    else out.push({ abs: full, rel: '/' + path.relative(base, full).split(path.sep).join('/') });
  }
  return out;
}

async function httpJson(url, method, body, adminToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (adminToken) headers['X-Admin-Token'] = adminToken;
  const resp = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || json.ok === false) {
    throw new Error(`${method} ${url} -> ${resp.status}: ${json.error || JSON.stringify(json)}`);
  }
  return json;
}

// canonicalManifest precisa ser IDÊNTICO ao do gateway/registry.js pra assinatura bater.
function canonicalManifest(domain, routes) {
  const sorted = routes.slice().sort((a, b) => a.path.localeCompare(b.path));
  return `${domain}\n${sorted.map((r) => `${r.path}|${r.fileId}|${r.contentType || ''}`).join('\n')}`;
}

async function publishSiteDir(siteDir, domain, opts) {
  const {
    gatewayUrl, adminToken, k = 1, m = 0,
    relayUrl, relayNodeId, nodeHost, nodePort,
    skipFile = () => false, // (relPath, sizeBytes) => boolean
    streamReplicas = 3, // quantas cópias completas de vídeo/áudio (ver isStreamable)
    // previousRoutes: routes (com fileId) da última publicação bem-sucedida
    // deste site, ex: [{ path, fileId, contentType }]. Quando um arquivo
    // tem o mesmo path E o mesmo fileId (fileId é derivado do conteúdo,
    // ver deriveFileId), o conteúdo não mudou — pulamos o encode+upload
    // dos shards e só reaproveitamos a rota antiga no manifesto novo.
    // Isso é o que evita reencodar/reenviar o site inteiro a cada edição
    // de um único arquivo.
    previousRoutes = [],
    // Config de anúncio do DONO DO SITE (site.adsConfig, vindo de
    // POST /api/sites/:siteId/ads no painel) — injetada em todo <video>
    // reescrito pro player P2P deste site. null/undefined = sem anúncio.
    adsConfig = null,
  } = opts;
  if (!gatewayUrl) throw new Error('gatewayUrl é obrigatório');
  const n = k + m;
  const previousByPath = new Map(
    previousRoutes.map((r) => [r.path === '/index.html' ? '/' : r.path, r])
  );

  let nodes, putShardFn, relayClient = null, phoneIds = null;
  if (relayUrl) {
    if (!relayNodeId) throw new Error('relayNodeId é obrigatório junto com relayUrl');
    relayClient = await connectRelay(relayUrl, `hosting-platform-${Date.now()}`);
    phoneIds = Array.isArray(relayNodeId) ? relayNodeId : String(relayNodeId).split(',').map((s) => s.trim()).filter(Boolean);
    nodes = phoneIds.length > 1 ? buildMultiRelayNodeSlots(phoneIds, n) : buildSingleRelayNodeSlots(phoneIds[0], n);
    putShardFn = async (node, shardKey, data) => putShardViaRelay(relayClient, node.relayTo, shardKey, data);
  } else if (nodeHost && nodePort) {
    nodes = buildSingleNodeSlots(nodeHost, nodePort, n);
  } else {
    throw new Error('preciso de (relayUrl + relayNodeId) ou (nodeHost + nodePort) pra saber onde publicar');
  }

  // Slots à parte pra vídeo/áudio replicado (k=1, prefixo diferente pra
  // nunca colidir com os slots RS normais mesmo que n seja menor). Só faz
  // sentido de verdade em modo relay com mais de 1 celular — em modo TCP
  // único ou 1 celular só, cai pra 1 réplica (sem redundância extra, mas
  // ainda assim habilita o P2P: 1 réplica > 0).
  function buildStreamNodes(count) {
    const prefix = 'snode';
    if (relayUrl && phoneIds) {
      return phoneIds.length > 1
        ? buildMultiRelayNodeSlots(phoneIds, count, prefix)
        : buildSingleRelayNodeSlots(phoneIds[0], count, prefix);
    }
    return buildSingleNodeSlots(nodeHost, nodePort, count, prefix);
  }
  const streamNodeCount = relayUrl && phoneIds ? Math.min(streamReplicas, phoneIds.length) : 1;
  const streamNodes = buildStreamNodes(streamNodeCount);

  try {
    for (const node of nodes) {
      const body = relayUrl
        ? { nodeId: node.nodeId, relayNodeId: node.relayTo }
        : { nodeId: node.nodeId, host: node.host, port: node.port };
      await httpJson(`${gatewayUrl}/admin/peers`, 'POST', body, adminToken);
    }

    const files = listFilesRecursive(siteDir);
    if (files.length === 0) throw new Error('pasta do site está vazia, nada pra publicar');

    // Passada 1: tudo que NÃO é HTML primeiro — assim, quando chegar a vez
    // de reescrever o HTML (passada 2), já sabemos o fileId de cada vídeo
    // referenciado, sem depender da ordem de leitura do diretório.
    const htmlFiles = [];
    const otherFiles = [];
    for (const f of files) {
      (f.rel.toLowerCase().endsWith('.html') || f.rel.toLowerCase().endsWith('.htm') ? htmlFiles : otherFiles).push(f);
    }

    const routes = [];
    const streamableByPath = new Map(); // routePath -> { fileId }
    let skippedCount = 0;
    let reusedCount = 0;
    let uploadedCount = 0;
    let streamRegistered = false;

    async function publishOneFile(f, buf, streamable) {
      const routePath = f.rel === '/index.html' ? '/' : f.rel;
      const fileId = deriveFileId(buf, domain + f.rel);
      const contentType = guessMime(f.abs);

      const prev = previousByPath.get(routePath);
      if (prev && prev.fileId === fileId) {
        // Mesmo path, mesmo hash de conteúdo: já está publicado nos nós de
        // uma rodada anterior. Não reencoda nem reenvia shard nenhum —
        // só reaproveita a rota no manifesto novo.
        reusedCount++;
        routes.push({ path: routePath, fileId, contentType, size: buf.length });
        if (streamable) streamableByPath.set(routePath, { fileId });
        return;
      }

      if (streamable) {
        if (!streamRegistered) {
          for (const node of streamNodes) {
            const body = relayUrl
              ? { nodeId: node.nodeId, relayNodeId: node.relayTo }
              : { nodeId: node.nodeId, host: node.host, port: node.port };
            await httpJson(`${gatewayUrl}/admin/peers`, 'POST', body, adminToken);
          }
          streamRegistered = true;
        }
        const manifest = await encodeAndUpload(buf, { fileId, k: 1, m: streamNodes.length - 1, nodes: streamNodes, putShardFn });
        manifest.fileName = path.basename(f.abs);
        await httpJson(`${gatewayUrl}/admin/files`, 'POST', manifest, adminToken);
        streamableByPath.set(routePath, { fileId });
      } else {
        const manifest = await encodeAndUpload(buf, { fileId, k, m, nodes, putShardFn });
        manifest.fileName = path.basename(f.abs);
        await httpJson(`${gatewayUrl}/admin/files`, 'POST', manifest, adminToken);
      }
      uploadedCount++;
      routes.push({ path: routePath, fileId, contentType, size: buf.length });
    }

    for (const f of otherFiles) {
      const stat = fs.statSync(f.abs);
      if (skipFile(f.rel, stat.size)) { skippedCount++; continue; }
      const buf = fs.readFileSync(f.abs);
      await publishOneFile(f, buf, isStreamable(f.rel));
    }
    for (const f of htmlFiles) {
      const stat = fs.statSync(f.abs);
      if (skipFile(f.rel, stat.size)) { skippedCount++; continue; }
      const routePath = f.rel === '/index.html' ? '/' : f.rel;
      const original = fs.readFileSync(f.abs, 'utf8');
      const rewritten = injectP2pPlayer(original, routePath, streamableByPath, adsConfig);
      await publishOneFile(f, Buffer.from(rewritten, 'utf8'), false);
    }

    if (routes.length === 0) throw new Error('nenhum arquivo elegível pro gateway (tudo filtrado por tamanho/tipo, ou pasta vazia)');
    if (!routes.some((r) => r.path === '/') && routes.some((r) => r.path === '/index.html')) {
      const idx = routes.find((r) => r.path === '/index.html');
      routes.push({ path: '/', fileId: idx.fileId, contentType: idx.contentType, size: idx.size });
    }

    const { pubkeyB58, privateKey } = getOrCreateSiteKey(domain);
    const canonical = canonicalManifest(domain, routes);
    const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');

    await httpJson(`${gatewayUrl}/admin/sites`, 'POST', { domain, ownerPubkey: pubkeyB58, routes, signature }, adminToken);

    // Apaga nos nós os fileIds que existiam na publicação anterior e não
    // aparecem mais na atual (arquivo removido, ou path com conteúdo novo —
    // o fileId antigo fica órfão). Roda DEPOIS do /admin/sites confirmar o
    // manifesto novo, pra nunca apagar um shard que o site ainda referencia.
    // Best-effort: falha aqui não derruba a publicação (o site já está no
    // ar com o manifesto certo; o shard órfão só fica ocupando espaço até
    // uma limpeza futura).
    const currentFileIds = new Set(routes.map((r) => r.fileId));
    const orphanFileIds = [...new Set(
      previousRoutes.map((r) => r.fileId).filter((fid) => !currentFileIds.has(fid))
    )];
    let deletedCount = 0;
    const deleteFailures = [];
    for (const fileId of orphanFileIds) {
      try {
        await httpJson(`${gatewayUrl}/admin/files/${encodeURIComponent(fileId)}`, 'DELETE', undefined, adminToken);
        deletedCount++;
      } catch (e) {
        deleteFailures.push({ fileId, error: e.message });
      }
    }

    return {
      domain, pubkeyB58,
      fileCount: routes.length,
      skipped: skippedCount,
      uploaded: uploadedCount,
      reused: reusedCount,
      deletedOrphans: deletedCount,
      deleteFailures,
      routes: routes.map((r) => r.path),
      // routesFull vai com fileId — server.js guarda isso pra passar como
      // previousRoutes na próxima publicação e continuar pulando os
      // arquivos que não mudaram.
      routesFull: routes,
    };
  } finally {
    if (relayClient) relayClient.close();
  }
}

// ===========================================================================
// Helpers "sem diretório" — usados pelo Explorador (hosting/server.js) pra
// ler/escrever arquivo por arquivo direto nos nós, sem precisar de uma pasta
// local (hosting/sites/<id>) como estágio intermediário. Reaproveitam a
// mesma lógica de resolveNodes/upload/assinatura do publishSiteDir acima,
// só que operando sobre um Buffer avulso em vez de um diretório inteiro.

// Registra o(s) nó(s) no gateway e devolve { nodes, putShardFn, relayClient }
// prontos pra encodeAndUpload. relayClient (se houver) precisa ser fechado
// pelo chamador (relayClient.close()) quando terminar.
async function resolvePublishTargets(opts) {
  const {
    gatewayUrl, adminToken, k = 1, m = 0,
    relayUrl, relayNodeId, nodeHost, nodePort,
    prefix = 'node',
  } = opts;
  if (!gatewayUrl) throw new Error('gatewayUrl é obrigatório');
  const n = k + m;

  let nodes, putShardFn, relayClient = null;
  if (relayUrl) {
    if (!relayNodeId) throw new Error('relayNodeId é obrigatório junto com relayUrl');
    relayClient = await connectRelay(relayUrl, `hosting-platform-${Date.now()}`);
    const phoneIds = Array.isArray(relayNodeId) ? relayNodeId : String(relayNodeId).split(',').map((s) => s.trim()).filter(Boolean);
    nodes = phoneIds.length > 1 ? buildMultiRelayNodeSlots(phoneIds, n, prefix) : buildSingleRelayNodeSlots(phoneIds[0], n, prefix);
    putShardFn = async (node, shardKey, data) => putShardViaRelay(relayClient, node.relayTo, shardKey, data);
  } else if (nodeHost && nodePort) {
    nodes = buildSingleNodeSlots(nodeHost, nodePort, n, prefix);
  } else {
    throw new Error('preciso de (relayUrl + relayNodeId) ou (nodeHost + nodePort) pra saber onde publicar');
  }

  for (const node of nodes) {
    const body = relayUrl
      ? { nodeId: node.nodeId, relayNodeId: node.relayTo }
      : { nodeId: node.nodeId, host: node.host, port: node.port };
    await httpJson(`${gatewayUrl}/admin/peers`, 'POST', body, adminToken);
  }

  return { nodes, putShardFn, relayClient, k, m };
}

// Igual resolvePublishTargets, mas forçando modo replicado (k=1) com até
// `replicas` celulares — é o que o upload avulso de vídeo/áudio pelo
// Explorador usa pra também virar P2P-elegível, do mesmo jeito que o
// publish de site inteiro (ver isStreamable/streamReplicas em publishSiteDir).
async function resolveStreamTargets(opts, replicas = 3) {
  const phoneCount = opts.relayUrl
    ? (Array.isArray(opts.relayNodeId) ? opts.relayNodeId.length : String(opts.relayNodeId || '').split(',').filter(Boolean).length)
    : 1;
  const count = Math.max(1, Math.min(replicas, phoneCount || 1));
  return resolvePublishTargets({ ...opts, k: 1, m: count - 1, prefix: 'snode' });
}

// Sobe UM arquivo (Buffer) pros nós e registra no gateway (/admin/files).
// Não mexe no manifesto do site — só devolve a rota { path, fileId,
// contentType, size } pronta pra entrar (ou substituir uma existente) em
// routes antes de chamar publishRoutes.
async function uploadFileToGateway(buffer, relPath, domain, targets, gwOpts) {
  const { gatewayUrl, adminToken } = gwOpts;
  const { nodes, putShardFn, k, m } = targets;
  const routePath = relPath === '/index.html' ? '/' : relPath;
  const fileId = deriveFileId(buffer, domain + relPath);
  const contentType = guessMime(relPath);

  const manifest = await encodeAndUpload(buffer, { fileId, k, m, nodes, putShardFn });
  manifest.fileName = path.basename(relPath);
  await httpJson(`${gatewayUrl}/admin/files`, 'POST', manifest, adminToken);

  return { path: routePath, fileId, contentType, size: buffer.length };
}

// Apaga um fileId dos nós + registry (best-effort — não lança, só avisa).
async function deleteFileFromGateway(fileId, gwOpts) {
  if (!fileId) return { ok: true, skipped: true };
  const { gatewayUrl, adminToken } = gwOpts;
  try {
    await httpJson(`${gatewayUrl}/admin/files/${encodeURIComponent(fileId)}`, 'DELETE', undefined, adminToken);
    return { ok: true };
  } catch (e) {
    console.warn(`[publish] falha ao apagar fileId ${fileId} dos nós (best-effort):`, e.message);
    return { ok: false, error: e.message };
  }
}

// Assina e publica um manifesto (routes já resolvidas, com fileId) pro
// domínio. Usado tanto depois de subir um arquivo novo quanto depois de só
// renomear/mover/apagar rotas (sem reencode nenhum).
async function publishRoutes(domain, routes, gwOpts) {
  const { gatewayUrl, adminToken } = gwOpts;
  if (!routes.some((r) => r.path === '/') && routes.some((r) => r.path === '/index.html')) {
    const idx = routes.find((r) => r.path === '/index.html');
    routes.push({ path: '/', fileId: idx.fileId, contentType: idx.contentType, size: idx.size });
  }
  const { pubkeyB58, privateKey } = getOrCreateSiteKey(domain);
  const canonical = canonicalManifest(domain, routes);
  const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');
  await httpJson(`${gatewayUrl}/admin/sites`, 'POST', { domain, ownerPubkey: pubkeyB58, routes, signature }, adminToken);
  return { domain, pubkeyB58 };
}

// Busca o conteúdo (já decifrado) de um arquivo publicado direto no gateway,
// por fileId — é o que o Explorador usa pra abrir um arquivo no editor sem
// precisar de cópia local. Usa a mesma rota pública GET /raw/:fileId que o
// gateway já expõe pra servir sites.
async function fetchFileFromGateway(fileId, gwOpts) {
  const { gatewayUrl } = gwOpts;
  const resp = await fetch(`${gatewayUrl}/raw/${encodeURIComponent(fileId)}`);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(`GET /raw/${fileId} -> ${resp.status}: ${body.error || resp.statusText}`);
  }
  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}

module.exports = {
  publishSiteDir,
  resolvePublishTargets,
  resolveStreamTargets,
  uploadFileToGateway,
  deleteFileFromGateway,
  publishRoutes,
  fetchFileFromGateway,
  isStreamable,
};
