'use strict';
// Simula como o PC node monta o gateway: handler do hospedeiro + gw.tryHandle(req,res).
const os = require('os'), fs = require('fs'), path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startGatewayNode } = require('../gatewayNode');
const { canonicalManifestV2 } = require('../../chain/siteManifest');
const H = require('./helpers');

let gw, host, port, registry;
test.before(async () => {
  gw = startGatewayNode({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pcgw-')), nodeId: 'AbCdEfGh1234567', publicUrl: '', seeds: [], signalerUrls: ['ws://127.0.0.1:9'] });
  registry = require('../registry'); // só DEPOIS do startGatewayNode (ele define GATEWAY_DATA_FILE antes da carga)
  host = http.createServer((req, res) => {
    if (gw.tryHandle(req, res)) return;
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('PCNODE-DASHBOARD');
  });
  await new Promise((r) => host.listen(0, '127.0.0.1', r));
  port = host.address().port;
});
test.after(() => { gw.stop(); host.close(); host.closeAllConnections?.(); });
// http.request (e não fetch): o fetch do Node ignora o header Host customizado
const get = (p, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c));
    res.on('end', () => { const b = Buffer.concat(chunks); resolve({ status: res.statusCode, text: async () => b.toString(), json: async () => JSON.parse(b.toString()) }); });
  });
  req.on('error', reject); req.end();
});

test('PC node continua dono do que é dele (painel, /api), e o gateway só responde as rotas dele', async () => {
  assert.equal(await (await get('/')).text(), 'PCNODE-DASHBOARD');
  assert.equal(await (await get('/api/status')).text(), 'PCNODE-DASHBOARD');
  const info = await (await get('/gw/info')).json();
  assert.equal(info.ok, true); assert.equal(info.kind, 'pc');
  assert.equal((await get('/raw/naoexiste')).status, 404);
  assert.equal((await get('/sync/registry')).status, 200);
});

test('/admin/* NUNCA é encaminhado ao gateway (réplica não publica/apaga), nem com token', async () => {
  for (const [p, m] of [['/admin/files', 'POST'], ['/admin/status', 'GET'], ['/admin/files/x', 'DELETE']]) {
    const r = await get(p, { 'x-admin-token': 'tok' }, m);
    assert.equal(await r.text(), 'PCNODE-DASHBOARD', `${m} ${p} caiu no gateway!`);
  }
});

test('Host de site conhecido (DNS apontado pra cá) é servido pelo gateway; Host desconhecido fica com o hospedeiro', async () => {
  const key = H.newSiteKey();
  const routes = [{ path: '/', fileId: 'a'.repeat(32), contentType: 'text/html', fileKeyB64: 'AAAA' }];
  registry.registerSite('meu.site.test', key.pub, routes, H.sign(key, canonicalManifestV2('meu.site.test', 1, routes)), 1, null);
  const r = await get('/', { host: 'meu.site.test' });
  assert.equal(r.status, 404); // gateway respondeu ("arquivo do site não encontrado nos metadados"), não o painel
  assert.match((await r.json()).error, /arquivo do site/);
  assert.equal(await (await get('/', { host: 'outro.dominio.test' })).text(), 'PCNODE-DASHBOARD');
  assert.equal(await (await get('/', { host: 'localhost:8787' })).text(), 'PCNODE-DASHBOARD');
});

test('identidade do relay: gateway-pc-<prefixo da pubkey> (infra: não aparece como celular)', () => {
  assert.equal(process.env.GATEWAY_RELAY_NODE_ID, 'gateway-pc-AbCdEfGh');
  assert.equal(process.env.GATEWAY_KIND, 'pc');
  assert.equal(process.env.GATEWAY_ALLOW_GEO_OVERRIDE, '0');
});

test('status() mostra sync e contadores (pra o painel do PC node)', () => {
  const s = gw.status();
  assert.equal(s.sites, 1); assert.deepEqual(s.sync.seeds, []);
});
