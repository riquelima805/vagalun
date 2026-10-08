// Gateway HTTP mínimo (roadmap passo 3) + multi-source/cache (passo 4).
// Não mexe no sever/server.js (signaling/relay WebRTC) — é um serviço à parte,
// que fala o protocolo TCP de shard (ShardProtocol.kt) direto com os nós.
//
// Rotas de conteúdo:
//   GET/HEAD /raw/:fileId        -> serve um arquivo publicado direto pelo fileId
//   GET      /p2p/:fileId        -> bilhete pro navegador buscar DIRETO nos celulares via
//                                    WebRTC (ver sever/gateway/p2pPlayerScript.js), sem passar
//                                    pela banda da VPS — só existe pra arquivo publicado com k=1
//                                    (replicado inteiro, ver isStreamable em publish.cjs)
//   GET      /__vgl/p2p.js       -> o script do player P2P, injetado automático no HTML publicado
//   GET/HEAD /*  (com Host: dominio) -> resolve domínio/path via manifesto de site
//
// GATEWAY_SIGNALING_PUBLIC_URL: URL ws(s):// do signaling (sever/server.js)
// alcançável PELO NAVEGADOR do visitante (não confundir com a URL que o
// próprio hosting-platform usa pra publicar, que pode ser interna/privada).
// Sem essa env var, /p2p/:fileId ainda funciona mas sem `signalingUrl` —
// o player.js detecta isso e não tenta P2P, só usa o /raw/:fileId normal.
//
// Rotas admin (protegidas por GATEWAY_ADMIN_TOKEN se configurado):
//   POST /admin/peers   { nodeId, host, port } (TCP/LAN) OU { nodeId, relayNodeId } (celular via relay)
//   POST /admin/files   FileMeta (mesmo shape do GossipRegistry.serializeFiles(), + fileKeyB64 opcional)
//   DELETE /admin/files/:fileId  -> apaga os shards desse arquivo em todos os nós + remove do registry
//   POST /admin/sites   { domain, ownerPubkey, routes: [{path, fileId, contentType}], signature }
//   GET  /admin/status
//
// O que fica de fora de propósito (passo 5, "ctt" = contrato): cobrança por chunk
// entregue / recibo assinado / claim on-chain. Isso mexe no contrato Anchor e no
// modelo econômico do vault — fica pra depois que passo 3-4 estiver rodando estável,
// como o roadmap já sinalizava.

// GET/HEAD /raw/:fileId e as rotas de site suportam `Range: bytes=X-Y` e
// respondem 206 Partial Content.
//
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const registry = require('./registry');
const { verifySiteAgainstChain } = require('./siteVerify');
const gwDirectory = require('./gwDirectory');
const registrySync = require('./registrySync');
const { rateLimited: syncRateLimited, clientIp: syncClientIp } = require('./rateLimit');
const content = require('./content');
const mime = require('./mime');
const { parseRange } = require('./range');
const fs = require('fs');
const path = require('path');
const registryBackup = require('./registryBackup');
const meshBridge = require('./meshBridge');
const { rateLimited, clientIp } = require('./rateLimit');
const geo = require('./geo');
const edge = require('./edge');
const metrics = require('./metrics');
const { dashboardHtml } = require('./metricsDashboard');

// Bundle do player oficial (@vagalun/player) — buildado a partir de
// vagalun-player/ e copiado aqui em sever/gateway/vendor/vagalun-player/.
// Pra atualizar: rode `npm run build:lib` no projeto do player e recopie
// os 2 arquivos. Carregado uma vez em memória (raramente muda em runtime).
const VENDOR_DIR = path.join(__dirname, 'vendor', 'vagalun-player');
let vendorPlayerJs = null, vendorPlayerCss = null;
try {
  vendorPlayerJs = fs.readFileSync(path.join(VENDOR_DIR, 'vagalun-player.iife.js'));
  vendorPlayerCss = fs.readFileSync(path.join(VENDOR_DIR, 'vagalun-player.css'));
} catch (e) {
  console.warn('[gateway] bundle do player não encontrado em', VENDOR_DIR, '— /__vgl/vagalun-player.* vai responder 404. Rode npm run build:lib no vagalun-player/ e copie o dist/ pra cá.', e.message);
}

const PORT = parseInt(process.env.GATEWAY_PORT || '8788', 10);
const ADMIN_TOKEN = process.env.GATEWAY_ADMIN_TOKEN || null;

function readBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error('corpo da requisição muito grande'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}

function sendRateLimited(res) {
  res.writeHead(429, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Retry-After': '5',
  });
  res.end(JSON.stringify({ ok: false, error: 'rate limit excedido, tenta de novo em alguns segundos' }));
}

// Item 14: cada byte que o gateway serve também consome banda de quem
// guarda o shard de verdade (celular/PC) — um flood aqui vira flood lá.
// Duas janelas: uma geral por IP (contra flood genérico), e uma mais
// apertada por IP+fileId (contra "baixar o mesmo arquivo gigante em
// loop", que passaria batido num limite só-por-IP se o resto do tráfego
// desse IP for baixo).
function checkContentRateLimit(req, res, fileId) {
  const ip = clientIp(req);
  if (rateLimited(`content-ip:${ip}`, 300, 60_000)) { sendRateLimited(res); return false; }
  if (fileId && rateLimited(`content-file:${ip}:${fileId}`, 120, 60_000)) { sendRateLimited(res); return false; }
  return true;
}

function checkAdmin(req, res) {
  if (!ADMIN_TOKEN) return true; // modo dev — sem token, endpoints abertos (ver aviso no boot)
  const given = req.headers['x-admin-token'] || '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(ADMIN_TOKEN);
  // comparação em tempo constante — evita vazar o token por diferença de tempo de resposta
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    sendJson(res, 401, { ok: false, error: 'token de admin inválido ou ausente (header X-Admin-Token)' });
    return false;
  }
  return true;
}

async function handleAdmin(req, res, pathname) {
  // Item 14 fix: token válido pula o rate limit por IP — esse limite existe
  // pra proteger contra brute-force/abuso anônimo, não pra travar o próprio
  // backend autenticado (hosting) publicando um deploy legítimo.
  const givenToken = req.headers['x-admin-token'] || '';
  const hasValidToken = !!ADMIN_TOKEN &&
    Buffer.from(String(givenToken)).length === Buffer.from(ADMIN_TOKEN).length &&
    crypto.timingSafeEqual(Buffer.from(String(givenToken)), Buffer.from(ADMIN_TOKEN));
  if (!hasValidToken && rateLimited(`admin-ip:${clientIp(req)}`, 600, 60_000)) { sendRateLimited(res); return; }
  if (!checkAdmin(req, res)) return;

  // DELETE /admin/files/:fileId — único método/rota fora do padrão "POST ou status"
  if (req.method === 'DELETE' && pathname.startsWith('/admin/files/')) {
    const fileId = decodeURIComponent(pathname.slice('/admin/files/'.length));
    if (!fileId) { sendJson(res, 400, { ok: false, error: 'fileId obrigatório' }); return; }
    const file = registry.getFile(fileId);
    if (!file) { sendJson(res, 404, { ok: false, error: 'arquivo não encontrado no registry' }); return; }
    try {
      const result = await content.deleteFileFromNodes(file);
      registry.deleteFile(fileId);
      sendJson(res, 200, { ok: true, fileId, ...result });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  if (req.method !== 'POST' && pathname !== '/admin/status') {
    sendJson(res, 405, { ok: false, error: 'método não permitido' });
    return;
  }

  try {
    if (pathname === '/admin/status') {
      sendJson(res, 200, {
        ok: true,
        peers: registry.listPeers().length,
        files: registry.listFiles().length,
        sites: registry.listSites().length,
        cachedBlocks: content.blockCache.size(),
      });
      return;
    }

    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');

    if (pathname === '/admin/peers') {
      if (body.relayNodeId) {
        registry.addRelayPeer(body.nodeId, body.relayNodeId);
      } else {
        registry.addPeer(body.nodeId, body.host, body.port);
      }
      sendJson(res, 200, { ok: true });
    } else if (pathname === '/admin/files') {
      registry.registerFile(body);
      sendJson(res, 200, { ok: true, fileId: body.fileId, blocks: body.blocks.length });
      // Mesmo esquema do /admin/sites logo abaixo: sem isso, o arquivo fica só no
      // registry.js do gateway e nunca entra no GossipRegistry.files dos nós de
      // verdade — mesmo que o site que o referencia já tenha propagado.
      if (process.env.GATEWAY_SIGNALING_PUBLIC_URL) {
        meshBridge.announceFilesToMesh(process.env.GATEWAY_SIGNALING_PUBLIC_URL, [body.fileId])
          .catch((e) => console.error('[meshBridge] falha ao anunciar arquivo pra malha P2P:', e.message));
      }
    } else if (pathname === '/admin/files/backfill-mesh') {
      // Empurra pra malha P2P TODOS os arquivos que o gateway já conhece (inclusive
      // os publicados antes dessa ponte existir).
      if (!process.env.GATEWAY_SIGNALING_PUBLIC_URL) {
        sendJson(res, 400, { ok: false, error: 'GATEWAY_SIGNALING_PUBLIC_URL não configurada neste gateway' });
        return;
      }
      const result = await meshBridge.announceFilesToMesh(process.env.GATEWAY_SIGNALING_PUBLIC_URL, body.fileIds);
      sendJson(res, result.ok ? 200 : 502, result);
    } else if (pathname === '/admin/sites') {
      const siteVersion = body.version === undefined || body.version === null ? null : Number(body.version);
      // Confere a chain ANTES de aceitar (SITE_CHAIN_MODE=off => não faz nada, comportamento antigo).
      const chainCheck = await verifySiteAgainstChain({
        domain: body.domain, ownerPubkey: body.ownerPubkey, version: siteVersion, routes: body.routes,
      });
      if (!chainCheck.ok) {
        sendJson(res, 409, { ok: false, error: `verificação on-chain falhou: ${chainCheck.reason}` });
        return;
      }
      registry.registerSite(body.domain, body.ownerPubkey, body.routes, body.signature, siteVersion, body.legacySignature || null);
      sendJson(res, 200, { ok: true, domain: body.domain, routes: body.routes.length, version: siteVersion || 0, onChain: !chainCheck.skipped });
      // Fire-and-forget: não trava a resposta HTTP esperando a malha P2P responder.
      // Se falhar (sem signaling configurado, sem peer online ainda), o site continua
      // acessível via gateway normalmente — só não aparece no navegador P2P até
      // alguém rodar o backfill manual ou até um peer ficar online e isso rodar de novo.
      if (process.env.GATEWAY_SIGNALING_PUBLIC_URL) {
        meshBridge.announceSitesToMesh(process.env.GATEWAY_SIGNALING_PUBLIC_URL, [body.domain])
          .catch((e) => console.error('[meshBridge] falha ao anunciar site pra malha P2P:', e.message));
      }
    } else if (pathname === '/admin/sites/backfill-mesh') {
      // Empurra pra malha P2P TODOS os sites que o gateway já conhece (inclusive os
      // publicados antes dessa ponte existir) — resposta ÚNICA pra
      // "os sites que já postei vão aparecer no navegador?".
      if (!process.env.GATEWAY_SIGNALING_PUBLIC_URL) {
        sendJson(res, 400, { ok: false, error: 'GATEWAY_SIGNALING_PUBLIC_URL não configurada neste gateway' });
        return;
      }
      const result = await meshBridge.announceSitesToMesh(process.env.GATEWAY_SIGNALING_PUBLIC_URL, body.domains);
      sendJson(res, result.ok ? 200 : 502, result);
    } else {
      sendJson(res, 404, { ok: false, error: 'rota admin desconhecida' });
    }
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e.message });
  }
}

const EXPOSE_HEADERS = 'X-Cache, X-Vagalun-Node, X-Vagalun-Region, X-Vagalun-Distance-Km, Server-Timing, Content-Range, Accept-Ranges, Content-Length, ETag';

// Header HTTP só aceita Latin-1; região vem de base externa (pode ter acento/outros alfabetos).
const asciiHeader = (v) => String(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '?');

function visitorOf(req) {
  const url = new URL(req.url, 'http://internal');
  return geo.visitorGeo(req, url.searchParams, clientIp);
}

async function serveFile(req, res, file, contentType, { etag, cacheControl, kind = 'raw' } = {}) {
  const total = file.originalLength;
  const t0 = Date.now();
  const visitor = visitorOf(req);

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', EXPOSE_HEADERS);
  res.setHeader('Content-Type', contentType);
  // ETag/Cache-Control só entram quando a resposta é de sucesso (ou 304/HEAD): um 502
  // com "immutable" ficaria preso no cache do navegador/CDN.
  const applyCacheHeaders = () => {
    if (etag) res.setHeader('ETag', etag);
    if (cacheControl) res.setHeader('Cache-Control', cacheControl);
  };

  // Se o navegador (ou uma CDN na frente) já tem esse ETag, nem busca shard nenhum.
  if (etag && req.headers['if-none-match'] === etag) {
    applyCacheHeaders();
    res.writeHead(304);
    res.end();
    metrics.recordServe({ kind, status: 304 });
    return;
  }

  if (req.method === 'HEAD') {
    applyCacheHeaders();
    res.setHeader('Content-Length', total);
    res.writeHead(200);
    res.end();
    return;
  }

  let start = 0;
  let end = Math.max(total - 1, 0);
  let status = 200;
  let contentRange = null;

  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const parsed = parseRange(rangeHeader, total);
    if (parsed === 'unsatisfiable') {
      res.setHeader('Content-Range', `bytes */${total}`);
      res.writeHead(416);
      res.end();
      return;
    }
    if (parsed) {
      ({ start, end } = parsed);
      status = 206;
      contentRange = `bytes ${start}-${end}/${total}`;
    }
  }

  const length = total === 0 ? 0 : end - start + 1;

  if (total === 0) {
    applyCacheHeaders();
    res.setHeader('Content-Length', 0);
    res.writeHead(status);
    res.end();
    return;
  }

  const ctx = content.newCtx(visitor);
  const it = content.rangeChunks(file, start, end, ctx)[Symbol.asyncIterator]();

  // Busca o 1º bloco ANTES de mandar o status: se falhar aqui, ainda dá pra responder 502 limpo.
  let first;
  try {
    first = await it.next();
  } catch (e) {
    console.error(`erro servindo ${file.fileId} [${start}-${end}]:`, e.message);
    metrics.recordServe({ kind, status: 502 });
    sendJson(res, 502, { ok: false, error: e.message }, { 'Access-Control-Allow-Origin': '*' });
    return;
  }

  const ttfb = Date.now() - t0;
  const sum = content.summarizeCtx(ctx);
  applyCacheHeaders();
  if (contentRange) res.setHeader('Content-Range', contentRange);
  res.setHeader('Content-Length', length);
  res.setHeader('X-Cache', sum.cache);
  let timing = `ttfb;dur=${ttfb}, cache;desc="${sum.cache}"`;
  if (sum.node) {
    res.setHeader('X-Vagalun-Node', sum.node.alias);
    if (sum.node.region) res.setHeader('X-Vagalun-Region', asciiHeader(sum.node.region));
    if (sum.node.distanceKm != null) res.setHeader('X-Vagalun-Distance-Km', String(sum.node.distanceKm));
    timing += `, node;desc="${sum.node.alias}"`;
  }
  res.setHeader('Server-Timing', timing);
  res.writeHead(status);

  let sent = 0;
  try {
    let r = first;
    while (!r.done) {
      sent += r.value.length;
      if (!res.write(r.value)) await new Promise((resolve) => res.once('drain', resolve));
      r = await it.next();
    }
    res.end();
    metrics.recordServe({ kind, status, bytes: sent, ttfbMs: ttfb, visitor, ctx, cache: sum.cache });
  } catch (e) {
    console.error(`erro servindo ${file.fileId} [${start}-${end}]:`, e.message);
    metrics.recordServe({ kind, status: 502 });
    res.destroy();
  }
}

// ---- /metrics/* ----
const METRICS_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const BEACON_MAX_BYTES = 4096;

async function handleMetrics(req, res, pathname) {
  if (req.method === 'OPTIONS') { res.writeHead(204, METRICS_CORS); res.end(); return; }

  if (pathname === '/metrics/public' && req.method === 'GET') {
    sendJson(res, 200, metrics.snapshot(registry), { ...METRICS_CORS, 'Cache-Control': 'no-store' });
    return;
  }
  if (pathname === '/metrics/dashboard' && req.method === 'GET') {
    const html = dashboardHtml();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }
  if (pathname === '/metrics/player' && req.method === 'POST') {
    // O player manda com Content-Type text/plain (CORS "simples", sem preflight) via sendBeacon.
    if (rateLimited(`beacon:${clientIp(req)}`, 60, 60_000)) { sendRateLimited(res); return; }
    // Lê até BEACON_MAX_BYTES; passou disso, responde 413 e descarta o resto (sem destruir
    // o socket antes da resposta, senão o cliente vê "socket hang up" em vez do 413).
    const raw = await new Promise((resolve) => {
      const chunks = [];
      let total = 0, tooBig = false;
      req.on('data', (c) => {
        total += c.length;
        if (total > BEACON_MAX_BYTES) { tooBig = true; chunks.length = 0; return; }
        if (!tooBig) chunks.push(c);
      });
      req.on('end', () => resolve(tooBig ? null : Buffer.concat(chunks)));
      req.on('error', () => resolve(null));
    });
    if (!raw) {
      sendJson(res, 413, { ok: false, error: 'beacon grande demais' }, { ...METRICS_CORS, Connection: 'close' });
      return;
    }
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { sendJson(res, 400, { ok: false, error: 'JSON inválido' }, METRICS_CORS); return; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) { sendJson(res, 400, { ok: false, error: 'JSON inválido' }, METRICS_CORS); return; }
    const accepted = metrics.recordPlayerBeacon(body, visitorOf(req));
    sendJson(res, 200, { ok: true, accepted }, METRICS_CORS);
    return;
  }
  sendJson(res, 404, { ok: false, error: 'rota de métricas desconhecida' }, METRICS_CORS);
}

// Site estático: domínio + path -> fileId via manifesto assinado. Usado pelo roteamento por Host
// (DNS) e pelo endereçamento por caminho /site/<domínio>/<path> (sem DNS: qualquer gateway serve).
async function serveSite(req, res, host, pathname) {
  if (!checkContentRateLimit(req, res, `site:${host}${pathname}`)) return;
  const route = registry.resolveSite(host, pathname);
  if (!route) { sendJson(res, 404, { ok: false, error: 'site ou rota não encontrados' }, { 'Access-Control-Allow-Origin': '*' }); return; }
  const file = registry.getFile(route.fileId);
  if (!file) { sendJson(res, 404, { ok: false, error: 'arquivo do site não encontrado nos metadados' }, { 'Access-Control-Allow-Origin': '*' }); return; }
  if (!file.fileKeyB64) { sendJson(res, 403, { ok: false, error: 'arquivo não publicado para acesso via gateway' }, { 'Access-Control-Allow-Origin': '*' }); return; }
  // O path pode apontar pra um fileId DIFERENTE depois de um redeploy: não é "immutable". O fileId
  // vira ETag (304 quando não mudou), com must-revalidate.
  res.setHeader('X-Vagalun-Fileid', route.fileId);
  return serveFile(req, res, file, route.contentType, {
    etag: `"${file.fileId}"`,
    cacheControl: 'public, max-age=60, must-revalidate',
    kind: 'site',
  });
}

// ---- /gw/* e /sync/registry ----
const GW_CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' };

async function handleGw(req, res, pathname) {
  if (req.method === 'OPTIONS') { res.writeHead(204, GW_CORS); res.end(); return; }
  const url = new URL(req.url, 'http://internal');

  if (pathname === '/gw/info' && (req.method === 'GET' || req.method === 'HEAD')) {
    // Barato de propósito: o cliente usa isso pra medir RTT. `nonce` é eco (prova de controle da URL no announce).
    const nonce = (url.searchParams.get('nonce') || '').slice(0, 64);
    const body = {
      ok: true, gw: 1, nonce: nonce || undefined,
      kind: process.env.GATEWAY_KIND || 'vps', url: gwDirectory.getSelf(), now: Date.now(),
      sites: registry.listSites().length, files: registry.listFiles().length,
      signalingUrls: (process.env.GATEWAY_SIGNALING_URLS || '').split(',').map((x) => x.trim()).filter(Boolean),
    };
    sendJson(res, 200, body, GW_CORS);
    return;
  }
  if (pathname === '/gw/list' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, gateways: gwDirectory.list() }, GW_CORS);
    return;
  }
  if (pathname === '/gw/announce' && req.method === 'POST') {
    if (syncRateLimited(`gwann:${syncClientIp(req)}`, 5, 60_000)) { sendJson(res, 429, { ok: false, error: 'muitos announces' }, GW_CORS); return; }
    try {
      const raw = await readBody(req, 4096);
      const body = JSON.parse(raw.toString('utf8'));
      const r = await gwDirectory.announce(body.url);
      sendJson(res, 200, r, GW_CORS);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message }, GW_CORS);
    }
    return;
  }
  if (pathname === '/sync/registry' && req.method === 'GET') {
    if (syncRateLimited(`sync:${syncClientIp(req)}`, 60, 60_000)) { sendJson(res, 429, { ok: false, error: 'muitos pedidos de sync' }, GW_CORS); return; }
    const since = Number(url.searchParams.get('since') || 0) || 0;
    const domain = (url.searchParams.get('domain') || '').toLowerCase() || null;
    const withFiles = url.searchParams.get('files') !== '0';
    sendJson(res, 200, registrySync.exportSnapshot({ since, domain, withFiles }), GW_CORS);
    return;
  }
  sendJson(res, 404, { ok: false, error: 'rota /gw desconhecida' }, GW_CORS);
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://internal').pathname);
  } catch {
    res.writeHead(400); res.end('URL inválida'); return;
  }

  if (pathname.startsWith('/admin/')) {
    return handleAdmin(req, res, pathname);
  }

  if (pathname === '/' && req.method === 'GET' && !req.headers.host?.includes('.')) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Vagalun Gateway (CDN lite) — online');
    return;
  }

  if (pathname.startsWith('/metrics/')) {
    return handleMetrics(req, res, pathname);
  }

  // ---- Gateway distribuído: descoberta, ping, sincronização ----
  if (pathname.startsWith('/gw/') || pathname === '/sync/registry') {
    return handleGw(req, res, pathname);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: 'método não permitido' });
    return;
  }

  // Endereçamento por caminho (estilo gateway IPFS): /site/<domínio>/<caminho>. Não depende de DNS
  // apontar pra ESTE gateway — o cliente pode pedir o mesmo site a qualquer gateway da lista.
  if (pathname.startsWith('/site/')) {
    const rest = pathname.slice('/site/'.length);
    const slash = rest.indexOf('/');
    const domain = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
    const sub = slash === -1 ? '/' : rest.slice(slash) || '/';
    if (!domain) { sendJson(res, 400, { ok: false, error: 'domínio ausente' }, { 'Access-Control-Allow-Origin': '*' }); return; }
    if (slash === -1) { res.writeHead(301, { Location: `/site/${domain}/` }); res.end(); return; }
    return serveSite(req, res, domain, sub);
  }

  // Scripts do cliente distribuído (pool de gateways + ponte P2P do service worker)
  if (pathname === '/__vgl/vagalun-gateway-pool.js' || pathname === '/__vgl/vagalun-sw-bridge.js') {
    try {
      const body = fs.readFileSync(path.join(VENDOR_DIR, pathname.slice('/__vgl/'.length)));
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    } catch { res.writeHead(404); res.end('arquivo do cliente não encontrado em vendor/vagalun-player/'); }
    return;
  }

  // Bundle do player oficial — servido pelo próprio gateway pra qualquer
  // domínio, tipo o script do Analytics: injetado automático (ver
  // injectP2pPlayer em hosting/gateway-client/publish.cjs) nos sites que
  // têm vídeo/áudio publicado em modo replicado.
  if (pathname === '/__vgl/vagalun-player.iife.js' || pathname === '/__vgl/vagalun-player.css') {
    const isJs = pathname.endsWith('.js');
    const body = isJs ? vendorPlayerJs : vendorPlayerCss;
    if (!body) { res.writeHead(404); res.end('bundle do player não encontrado no servidor'); return; }
    res.writeHead(200, {
      'Content-Type': isJs ? 'application/javascript; charset=utf-8' : 'text/css; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    });
    res.end(body);
    return;
  }

  // Service worker do player: precisa ser servido da raiz (escopo '/') pra interceptar o site inteiro.
  if (pathname === '/vagalun-sw.js') {
    try {
      const sw = fs.readFileSync(path.join(VENDOR_DIR, 'vagalun-sw.js'));
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Service-Worker-Allowed': '/',
        'Cache-Control': 'no-cache',
      });
      res.end(sw);
    } catch {
      res.writeHead(404); res.end('vagalun-sw.js não encontrado em vendor/vagalun-player/');
    }
    return;
  }

  // Acesso direto por fileId
  if (pathname.startsWith('/raw/')) {
    const fileId = pathname.slice('/raw/'.length);
    if (!checkContentRateLimit(req, res, fileId)) return;
    const file = registry.getFile(fileId);
    if (!file) { sendJson(res, 404, { ok: false, error: 'arquivo não encontrado' }); return; }
    if (!file.fileKeyB64) { sendJson(res, 403, { ok: false, error: 'arquivo não publicado para acesso via gateway' }); return; }
    const url = new URL(req.url, 'http://internal');
    const contentType = url.searchParams.get('type') || mime.guess(file.fileName || '');
    // fileId é hash do conteúdo (deriveFileId, sha256) — mesmo fileId SEMPRE
    // são os mesmos bytes, então dá pra cachear "pra sempre" (immutable) e
    // usar o próprio fileId como ETag, sem precisar calcular nada a mais.
    return serveFile(req, res, file, contentType, {
      etag: `"${file.fileId}"`,
      cacheControl: 'public, max-age=31536000, immutable',
    });
  }

  // Bilhete pro navegador buscar o arquivo DIRETO nos celulares via WebRTC
  // (p2p-player.js), sem passar pela banda da VPS. Só existe pra arquivos
  // publicados com k=1 (replicados inteiros, não fatiados por Reed-Solomon —
  // ver publish.cjs/isStreamable): com k=1 cada shard já é uma cópia
  // completa e independente do arquivo cifrado, então dá pra pedir o
  // arquivo inteiro de UM peer só, sem precisar reconstruir RS.
  // Não é uma rota "admin": é pública de propósito, igual /raw/:fileId —
  // fileKeyB64 só é publicado aqui pra conteúdo que já é público por
  // natureza (site estático), mesma lógica de sempre.
  if (pathname.startsWith('/p2p/')) {
    const fileId = pathname.slice('/p2p/'.length);
    if (!checkContentRateLimit(req, res, fileId)) return;
    const file = registry.getFile(fileId);
    if (!file) { sendJson(res, 404, { ok: false, error: 'arquivo não encontrado' }); return; }
    if (!file.fileKeyB64) { sendJson(res, 403, { ok: false, error: 'arquivo não publicado para acesso via gateway' }); return; }
    if (file.k !== 1) {
      sendJson(res, 409, { ok: false, error: 'arquivo não foi publicado em modo replicado (k=1) — sem P2P direto pra ele, use /raw/:fileId' });
      return;
    }
    const firstBlock = file.blocks[0];
    const visitor = visitorOf(req);

    // Quem tem o arquivo: placements do publish + réplicas de borda (edge.js).
    // Só peer tipo 'relay' (celular via signaling) é alcançável por um navegador de fora —
    // peer 'tcp' é só LAN/dev.
    const holders = [];
    const seenRelay = new Set();
    for (const p of (firstBlock?.placements || [])) {
      const peer = registry.getPeer(p.nodeId);
      if (peer && peer.transport === 'relay' && !seenRelay.has(peer.relayNodeId)) {
        seenRelay.add(peer.relayNodeId);
        holders.push({ shardIndex: p.shardIndex, nodeId: p.nodeId, relayNodeId: peer.relayNodeId, peer, edge: false });
      }
    }
    for (const rep of registry.getEdgeReplicas(file.fileId)) {
      const peer = registry.getPeer(rep.nodeId);
      if (peer && peer.transport === 'relay' && !seenRelay.has(peer.relayNodeId)) {
        seenRelay.add(peer.relayNodeId);
        holders.push({ shardIndex: rep.shardIndex, nodeId: rep.nodeId, relayNodeId: peer.relayNodeId, peer, edge: true });
      }
    }
    if (holders.length === 0) {
      sendJson(res, 409, { ok: false, error: 'nenhum peer relay disponível pra esse arquivo agora — use /raw/:fileId' });
      return;
    }

    // Do mais perto ao mais longe; celular offline conhecido vai pro fim.
    const ranked = geo.rank(holders, visitor, (h) => h.relayNodeId);
    const candidates = ranked.map((r) => ({
      shardIndex: r.item.shardIndex,
      relayNodeId: r.item.relayNodeId,
      distanceKm: r.distanceKm,
      region: r.region,
      online: r.online,
      edge: r.item.edge,
    }));

    metrics.recordManifest(visitor);
    edge.onP2PAccess(file, visitor, ranked); // em background: nunca atrasa a resposta

    sendJson(res, 200, {
      ok: true,
      fileId: file.fileId,
      fileName: file.fileName || null,
      contentType: mime.guess(file.fileName || ''),
      fileKeyB64: file.fileKeyB64,
      blockSize: file.blockSize,
      originalLength: file.originalLength,
      candidates, // [{ shardIndex, relayNodeId, distanceKm, region, online, edge }] — mais perto primeiro
      geoSource: visitor.source, // 'override' | 'ip' | 'none'
      visitorRegion: visitor.region,
      distanceKm: candidates[0].distanceKm,
      metricsUrl: '/metrics/player',
      blocks: file.blocks.map((b) => ({ blockIndex: b.blockIndex, plainLength: b.plainLength, iv: b.iv, authTag: b.authTag })),
      signalingUrl: process.env.GATEWAY_SIGNALING_PUBLIC_URL || null,
      // lista (federação): o player usa a 1ª como preferida e as outras como failover
      signalingUrls: (process.env.GATEWAY_SIGNALING_PUBLIC_URLS || process.env.GATEWAY_SIGNALING_PUBLIC_URL || '').split(',').map((x) => x.trim()).filter(Boolean),
      rawUrl: `/raw/${file.fileId}`, // fallback: HTTP normal via VPS se P2P falhar
    }, { 'Cache-Control': 'no-store' }); // lista de peers ao vivo — nunca cachear
    return;
  }

  // Site estático: domínio (Host header) + path -> fileId via manifesto assinado
  return serveSite(req, res, (req.headers.host || '').split(':')[0], pathname);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Gateway HTTP (CDN lite) rodando na porta ${PORT}`);
    if (!ADMIN_TOKEN) {
      console.warn('AVISO: GATEWAY_ADMIN_TOKEN não configurado — /admin/* está aberto. Defina a env var em produção.');
    }
  });
  registryBackup.start();
  gwDirectory.setSelf(process.env.GATEWAY_PUBLIC_URL || '');
  const syncSeeds = (process.env.GATEWAY_SYNC_SEEDS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (syncSeeds.length) {
    new registrySync.SyncLoop({
      seeds: syncSeeds, intervalMs: parseInt(process.env.GATEWAY_SYNC_INTERVAL_MS || '60000', 10),
      strict: process.env.GATEWAY_SYNC_STRICT === '1', verify: process.env.GATEWAY_SYNC_VERIFY !== '0',
    }).start();
    if (gwDirectory.getSelf()) {
      for (const seed of syncSeeds) {
        fetch(`${seed.replace(/\/$/, '')}/gw/announce`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: gwDirectory.getSelf() }) }).catch(() => {});
      }
    }
  }
  setInterval(() => gwDirectory.sweep().catch(() => {}), 10 * 60_000).unref();
  geo.startPolling();
  edge.startSweeper();
  if (process.env.GATEWAY_ALLOW_GEO_OVERRIDE !== '0') {
    console.warn('AVISO: ?geo=lat,lon está habilitado (demo). Em produção use GATEWAY_ALLOW_GEO_OVERRIDE=0.');
  }
}

module.exports = { server };
