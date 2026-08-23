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
const content = require('./content');
const mime = require('./mime');
const { parseRange } = require('./range');
const fs = require('fs');
const path = require('path');

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

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
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
    } else if (pathname === '/admin/sites') {
      registry.registerSite(body.domain, body.ownerPubkey, body.routes, body.signature);
      sendJson(res, 200, { ok: true, domain: body.domain, routes: body.routes.length });
    } else {
      sendJson(res, 404, { ok: false, error: 'rota admin desconhecida' });
    }
  } catch (e) {
    sendJson(res, 400, { ok: false, error: e.message });
  }
}

async function serveFile(req, res, file, contentType) {
  const total = file.originalLength;

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', contentType);

  if (req.method === 'HEAD') {
    res.setHeader('Content-Length', total);
    res.writeHead(200);
    res.end();
    return;
  }

  let start = 0;
  let end = Math.max(total - 1, 0);
  let status = 200;

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
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    }
  }

  res.setHeader('Content-Length', total === 0 ? 0 : end - start + 1);
  res.writeHead(status);

  if (total === 0) { res.end(); return; }

  try {
    for await (const chunk of content.rangeChunks(file, start, end)) {
      if (!res.write(chunk)) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    }
    res.end();
  } catch (e) {
    console.error(`erro servindo ${file.fileId} [${start}-${end}]:`, e.message);
    if (!res.headersSent) {
      sendJson(res, 502, { ok: false, error: e.message });
    } else {
      res.destroy();
    }
  }
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

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, error: 'método não permitido' });
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

  // Acesso direto por fileId
  if (pathname.startsWith('/raw/')) {
    const fileId = pathname.slice('/raw/'.length);
    const file = registry.getFile(fileId);
    if (!file) { sendJson(res, 404, { ok: false, error: 'arquivo não encontrado' }); return; }
    if (!file.fileKeyB64) { sendJson(res, 403, { ok: false, error: 'arquivo não publicado para acesso via gateway' }); return; }
    const url = new URL(req.url, 'http://internal');
    const contentType = url.searchParams.get('type') || mime.guess(file.fileName || '');
    return serveFile(req, res, file, contentType);
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
    const file = registry.getFile(fileId);
    if (!file) { sendJson(res, 404, { ok: false, error: 'arquivo não encontrado' }); return; }
    if (!file.fileKeyB64) { sendJson(res, 403, { ok: false, error: 'arquivo não publicado para acesso via gateway' }); return; }
    if (file.k !== 1) {
      sendJson(res, 409, { ok: false, error: 'arquivo não foi publicado em modo replicado (k=1) — sem P2P direto pra ele, use /raw/:fileId' });
      return;
    }
    const firstBlock = file.blocks[0];
    const candidates = [];
    for (const p of (firstBlock?.placements || [])) {
      const peer = registry.getPeer(p.nodeId);
      // Só peer tipo 'relay' (celular via signaling) é alcançável por um
      // navegador de fora — peer 'tcp' é só LAN/dev, não serve pra visitante real.
      if (peer && peer.transport === 'relay') {
        candidates.push({ shardIndex: p.shardIndex, relayNodeId: peer.relayNodeId });
      }
    }
    if (candidates.length === 0) {
      sendJson(res, 409, { ok: false, error: 'nenhum peer relay disponível pra esse arquivo agora — use /raw/:fileId' });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      fileId: file.fileId,
      fileName: file.fileName || null,
      contentType: mime.guess(file.fileName || ''),
      fileKeyB64: file.fileKeyB64,
      blockSize: file.blockSize,
      originalLength: file.originalLength,
      candidates, // [{ shardIndex, relayNodeId }] — em ordem de preferência
      blocks: file.blocks.map((b) => ({ blockIndex: b.blockIndex, plainLength: b.plainLength, iv: b.iv, authTag: b.authTag })),
      signalingUrl: process.env.GATEWAY_SIGNALING_PUBLIC_URL || null,
      rawUrl: `/raw/${file.fileId}`, // fallback: HTTP normal via VPS se P2P falhar
    });
    return;
  }

  // Site estático: domínio (Host header) + path -> fileId via manifesto assinado
  const host = (req.headers.host || '').split(':')[0];
  const route = registry.resolveSite(host, pathname);
  if (!route) { sendJson(res, 404, { ok: false, error: 'site ou rota não encontrados' }); return; }
  const file = registry.getFile(route.fileId);
  if (!file) { sendJson(res, 404, { ok: false, error: 'arquivo do site não encontrado nos metadados' }); return; }
  if (!file.fileKeyB64) { sendJson(res, 403, { ok: false, error: 'arquivo não publicado para acesso via gateway' }); return; }
  return serveFile(req, res, file, route.contentType);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Gateway HTTP (CDN lite) rodando na porta ${PORT}`);
    if (!ADMIN_TOKEN) {
      console.warn('AVISO: GATEWAY_ADMIN_TOKEN não configurado — /admin/* está aberto. Defina a env var em produção.');
    }
  });
}

module.exports = { server };
