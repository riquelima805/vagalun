'use strict';
const os = require('os'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const { WebSocketServer } = WebSocket;
const { attachSignaling } = require('./signaling-core.fixture.js');
const { encodeAndUpload, deriveFileId } = require('../../publisher/encodeAndUpload');
const { canonicalManifestV2 } = require('../../chain/siteManifest');
const base58 = require('../base58');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, label = 'condição') {
  const t = Date.now();
  let last;
  while (Date.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch (e) { last = e; } await sleep(100); }
  throw new Error(`timeout esperando ${label}${last ? ': ' + last.message : ''}`);
}
const tmp = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vgl-')), name);

function startSignaler(port) {
  return new Promise((resolve) => {
    const h = http.createServer();
    const wss = new WebSocketServer({ server: h });
    attachSignaling(wss, {});
    h.listen(port, '127.0.0.1', () => resolve({
      port, url: `ws://127.0.0.1:${port}`,
      close() { for (const c of wss.clients) c.terminate(); wss.close(); h.closeAllConnections?.(); h.close(); },
    }));
  });
}

/** "celular": registrado em TODOS os signalers, responde relay get_range/get/put com um store em memória */
function startPhone(nodeId, signalerUrls, store) {
  const sockets = signalerUrls.map((u) => {
    const ws = new WebSocket(u);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'register', nodeId })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type !== 'relay') return;
      const h = m.header || {};
      let header = { ok: false, error: 'op desconhecida' }, payload = null;
      if (h.op === 'get_range' || h.op === 'get') {
        const d = store.get(h.shardKey);
        if (!d) header = { ok: false, error: 'shard não encontrado' };
        else { header = { ok: true }; payload = h.op === 'get' ? d : d.subarray(h.offset || 0, (h.offset || 0) + (h.length ?? d.length)); }
      }
      const resp = { type: 'relay_response', to: m.from, requestId: m.requestId, header };
      if (payload) resp.payloadBase64 = Buffer.from(payload).toString('base64');
      ws.send(JSON.stringify(resp));
    });
    ws.on('error', () => {});
    return ws;
  });
  return { nodeId, close() { sockets.forEach((s) => { try { s.terminate(); } catch (_) {} }); } };
}

async function startGateway(name, env) {
  const port = env.GATEWAY_PORT;
  const dataFile = tmp(`${name}.json`);
  const child = spawn(process.execPath, ['gateway.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, GATEWAY_DATA_FILE: dataFile, GATEWAY_ADMIN_TOKEN: 'tok', GATEWAY_ALLOW_GEO_OVERRIDE: '0',
      GATEWAY_ANNOUNCE_ALLOW_PRIVATE: '1', GATEWAY_PUBLIC_URL: `http://127.0.0.1:${port}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const url = `http://127.0.0.1:${port}`;
  await until(async () => (await fetch(`${url}/gw/info`)).ok, 15000, `gateway ${name} subir`).catch((e) => { throw new Error(e.message + '\n' + log); });
  return { name, url, port, child, log: () => log, kill() { try { child.kill('SIGKILL'); } catch (_) {} } };
}

async function admin(gw, route, body) {
  const r = await fetch(`${gw.url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': 'tok' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${route} -> ${r.status} ${JSON.stringify(j)}`);
  return j;
}

function newSiteKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, pub: base58.encode(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) };
}
const sign = (key, msg) => crypto.sign(null, Buffer.from(msg, 'utf8'), key.privateKey).toString('base64');

/**
 * Publica um site v2 em `gw` (peers + arquivos + manifesto). Os shards vão direto pro `store` dos celulares.
 * files: { '/index.html': Buffer, '/B.css': Buffer, ... }
 */
async function publishSite(gw, { domain, files, version, key, store, phoneIds, registry }) {
  for (let i = 0; i < phoneIds.length; i++) await admin(gw, '/admin/peers', { nodeId: `node-${i}`, relayNodeId: phoneIds[i] });
  const nodes = phoneIds.map((_, i) => ({ nodeId: `node-${i}` }));
  const routes = [];
  for (const [rel, buf] of Object.entries(files)) {
    const fileId = deriveFileId(buf, domain + rel);
    const manifest = await encodeAndUpload(buf, {
      fileId, k: 1, m: phoneIds.length - 1, nodes,
      putShardFn: async (_node, shardKey, data) => { store.set(shardKey, Buffer.from(data)); return true; },
    });
    manifest.fileName = rel.split('/').pop();
    await admin(gw, '/admin/files', manifest);
    routes.push({ path: rel === '/index.html' ? '/' : rel, fileId, contentType: rel.endsWith('.css') ? 'text/css' : rel.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8', fileKeyB64: manifest.fileKeyB64 });
  }
  const signature = sign(key, canonicalManifestV2(domain, version, routes));
  const legacySignature = sign(key, registry.canonicalManifest(domain, routes));
  await admin(gw, '/admin/sites', { domain, ownerPubkey: key.pub, routes, signature, version, legacySignature });
  return { routes, signature, legacySignature };
}

module.exports = { sleep, until, tmp, startSignaler, startPhone, startGateway, admin, newSiteKey, sign, publishSite };
