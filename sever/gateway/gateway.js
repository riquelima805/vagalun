// Gateway HTTP mínimo (roadmap passo 3) + multi-source/cache (passo 4).
// Não mexe no sever/server.js (signaling/relay WebRTC) — é um serviço à parte,
// que fala o protocolo TCP de shard (ShardProtocol.kt) direto com os nós.
//
// Rotas de conteúdo:
//   GET/HEAD /raw/:fileId        -> serve um arquivo publicado direto pelo fileId
//   GET/HEAD /*  (com Host: dominio) -> resolve domínio/path via manifesto de site
//
// Ambas suportam `Range: bytes=X-Y` e respondem 206 Partial Content.
//
// Rotas admin (protegidas por GATEWAY_ADMIN_TOKEN se configurado):
//   POST /admin/peers   { nodeId, host, port }
//   POST /admin/files   FileMeta (mesmo shape do GossipRegistry.serializeFiles(), + fileKeyB64 opcional)
//   POST /admin/sites   { domain, ownerPubkey, routes: [{path, fileId, contentType}], signature }
//   GET  /admin/status
//
// O que fica de fora de propósito (passo 5, "ctt" = contrato): cobrança por chunk
// entregue / recibo assinado / claim on-chain. Isso mexe no contrato Anchor e no
// modelo econômico do vault — fica pra depois que passo 3-4 estiver rodando estável,
// como o roadmap já sinalizava.

const http = require('http');
const { URL } = require('url');

const registry = require('./registry');
const content = require('./content');
const mime = require('./mime');
const { parseRange } = require('./range');

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
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    sendJson(res, 401, { ok: false, error: 'token de admin inválido ou ausente (header X-Admin-Token)' });
    return false;
  }
  return true;
}

async function handleAdmin(req, res, pathname) {
  if (!checkAdmin(req, res)) return;
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
      registry.addPeer(body.nodeId, body.host, body.port);
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
