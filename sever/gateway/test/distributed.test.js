'use strict';
// E2E multi-processo: 2 signalers, 3 "celulares", gateway A (primário) e gateway B (réplica por sync).
const os = require('os'), fs = require('fs'), path = require('path');
process.env.GATEWAY_DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vgl-reg-')), 'x.json'); // só p/ registry.canonicalManifest
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const registry = require('../registry');
const H = require('./helpers');
const Pool = require('../vendor/vagalun-player/vagalun-gateway-pool.js');

const DOMAIN = 'e2e.vagalun.test';
const FILES = {
  '/index.html': Buffer.from('<html><link rel=stylesheet href=/B.css><script src=/a.js></script>OLA</html>'),
  '/B.css': Buffer.from('body{color:red}'.repeat(200)),
  '/a.js': Buffer.from('console.log("a")'.repeat(300)),
};
const S = {};
const key = H.newSiteKey();

test.before(async () => {
  S.sig1 = await H.startSignaler(19501);
  S.sig2 = await H.startSignaler(19502);
  S.sigUrls = [S.sig1.url, S.sig2.url];
  S.store = new Map();
  S.phoneIds = ['phone-0', 'phone-1', 'phone-2'];
  S.phones = S.phoneIds.map((id) => H.startPhone(id, S.sigUrls, S.store));
  await H.sleep(400);
  S.A = await H.startGateway('A', { GATEWAY_PORT: 19511, GATEWAY_SIGNALING_URLS: S.sigUrls.join(','), GATEWAY_RELAY_NODE_ID: 'gateway-A' });
  S.pub = await H.publishSite(S.A, { domain: DOMAIN, files: FILES, version: 1000, key, store: S.store, phoneIds: S.phoneIds, registry });
});

test.after(() => {
  S.phones?.forEach((p) => p.close());
  [S.A, S.B].forEach((g) => g && g.kill());
  [S.sig1, S.sig2].forEach((s) => s && s.close());
});

test('A serve o site por /site/<domínio>/ (via relay federado) e o ETag é o fileId', async () => {
  const r = await fetch(`${S.A.url}/site/${DOMAIN}/`);
  assert.equal(r.status, 200, S.A.log());
  assert.equal(Buffer.from(await r.arrayBuffer()).toString(), FILES['/index.html'].toString());
  assert.equal(r.headers.get('x-vagalun-fileid'), S.pub.routes.find((x) => x.path === '/').fileId);
  const css = await fetch(`${S.A.url}/site/${DOMAIN}/B.css`);
  assert.equal(Buffer.from(await css.arrayBuffer()).toString(), FILES['/B.css'].toString());
});

test('B (réplica) sincroniza de A: site v2 + arquivos + peers, e CONFERE o conteúdo contra o fileId', async () => {
  S.B = await H.startGateway('B', {
    GATEWAY_PORT: 19512, GATEWAY_SIGNALING_URLS: [S.sig2.url, S.sig1.url].join(','), GATEWAY_RELAY_NODE_ID: 'gateway-B',
    GATEWAY_SYNC_SEEDS: S.A.url, GATEWAY_SYNC_INTERVAL_MS: '500',
  });
  await H.until(async () => {
    const snap = await (await fetch(`${S.B.url}/sync/registry`)).json();
    return snap.files.length === 3 && snap.files.every((f) => f.integrity === 'verified');
  }, 20000, 'B sincronizar e verificar os 3 arquivos').catch((e) => { throw new Error(e.message + '\n--B--\n' + S.B.log()); });
  for (const p of ['/', '/B.css', '/a.js']) {
    const a = Buffer.from(await (await fetch(`${S.A.url}/site/${DOMAIN}${p}`)).arrayBuffer());
    const b = Buffer.from(await (await fetch(`${S.B.url}/site/${DOMAIN}${p}`)).arrayBuffer());
    assert.ok(a.equals(b), `conteúdo de ${p} difere entre A e B`);
  }
});

test('descoberta: B se anunciou pra A (A confirmou o controle da URL) e A aparece pra B', async () => {
  await H.until(async () => (await (await fetch(`${S.A.url}/gw/list`)).json()).gateways.includes(S.B.url), 10000, 'A listar B');
  const listB = (await (await fetch(`${S.B.url}/gw/list`)).json()).gateways;
  assert.ok(listB.includes(S.A.url));
});

test('pool do cliente: aprende gateways via /gw/list, mede RTT e devolve conteúdo VERIFICADO', async () => {
  const pool = new Pool.Pool({ seeds: [S.A.url] });
  await pool.refresh();
  assert.ok(pool.ranked().map((g) => g.url).includes(S.B.url), 'pool aprendeu B por /gw/list');
  assert.ok(pool.ranked().every((g) => g.rtt != null), 'RTT medido');
  const r = await pool.fetchSite(DOMAIN, '/B.css');
  assert.equal(r.verified, 'yes');
  assert.equal(Buffer.from(r.bytes).toString(), FILES['/B.css'].toString());
  assert.equal(r.contentType, 'text/css');
  const idx = await pool.fetchSite(DOMAIN, '/qualquer/rota/spa'); // fallback pra '/', como no servidor
  assert.equal(Buffer.from(idx.bytes).toString(), FILES['/index.html'].toString());
});

test('gateway MENTIROSO (altera 1 byte) é detectado, penalizado, e o cliente cai pro próximo', async () => {
  // proxy "malicioso" na frente de A: repassa tudo, mas corrompe /raw/*
  const evil = http.createServer(async (req, res) => {
    const up = await fetch(`${S.A.url}${req.url}`, { headers: { range: req.headers.range || '' } });
    let body = Buffer.from(await up.arrayBuffer());
    if (req.url.startsWith('/raw/') && body.length) { body = Buffer.from(body); body[0] ^= 0xff; }
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') || 'application/octet-stream', 'access-control-allow-origin': '*' });
    res.end(body);
  });
  await new Promise((r) => evil.listen(19520, '127.0.0.1', r));
  try {
    const pool = new Pool.Pool({ seeds: ['http://127.0.0.1:19520', S.B.url], strict: true, hedgeMs: 50 });
    pool.gws.get('http://127.0.0.1:19520').rtt = 1; // finge que o mentiroso é o mais "rápido"
    pool.gws.get(S.B.url).rtt = 50;
    const r = await pool.fetchSite(DOMAIN, '/a.js');
    assert.equal(r.verified, 'yes');
    assert.equal(r.gateway, S.B.url, 'serviu o gateway honesto');
    assert.equal(Buffer.from(r.bytes).toString(), FILES['/a.js'].toString());
    assert.ok(pool.gws.get('http://127.0.0.1:19520').bad >= 1, 'mentiroso marcado como ruim');
    assert.equal(pool.ranked()[0].url, S.B.url, 'e rebaixado no ranking');
  } finally { evil.close(); evil.closeAllConnections?.(); }
});

test('um signaler cai: o gateway continua buscando shards pelo outro e a réplica segue sincronizando', async () => {
  S.sig1.close();
  await H.sleep(600);
  // arquivo NOVO (não está no cache de blocos de ninguém) publicado em A depois da queda
  const key2 = H.newSiteKey();
  const files2 = { '/index.html': Buffer.from('<html>site2 depois da queda do signaler</html>') };
  await H.publishSite(S.A, { domain: 'segundo.vagalun.test', files: files2, version: 2000, key: key2, store: S.store, phoneIds: S.phoneIds, registry });
  const r = await fetch(`${S.A.url}/site/segundo.vagalun.test/`);
  assert.equal(r.status, 200, 'A serve via o signaler restante\n' + S.A.log());
  await H.until(async () => {
    const snap = await (await fetch(`${S.B.url}/sync/registry?domain=segundo.vagalun.test`)).json();
    return snap.files.length === 1 && snap.files[0].integrity === 'verified';
  }, 25000, 'B replicar+verificar o site novo com 1 signaler fora').catch((e) => { throw new Error(e.message + '\n--B--\n' + S.B.log()); });
});

test('A cai de vez: o cliente continua servido por B, com conteúdo verificado e rápido', async () => {
  S.A.kill();
  await H.sleep(300);
  const pool = new Pool.Pool({ seeds: [S.A.url, S.B.url], hedgeMs: 100, timeoutMs: 3000 });
  const t0 = Date.now();
  const r = await pool.fetchSite(DOMAIN, '/');
  assert.equal(r.verified, 'yes');
  assert.equal(r.gateway, S.B.url);
  assert.ok(Date.now() - t0 < 4000, `levou ${Date.now() - t0}ms`);
  assert.equal(Buffer.from(r.bytes).toString(), FILES['/index.html'].toString());
});
