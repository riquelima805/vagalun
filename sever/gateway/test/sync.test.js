'use strict';
const os = require('os'), fs = require('fs'), path = require('path');
process.env.GATEWAY_DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vgl-sync-')), 'x.json');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const registry = require('../registry');
const content = require('../content');
const sync = require('../registrySync');
const { canonicalManifestV2 } = require('../../chain/siteManifest');
const H = require('./helpers');

const fileMeta = (fileId, keyB64) => ({
  fileId, k: 1, m: 0, n: 1, blockSize: 1024, originalLength: 10, fileKeyB64: keyB64,
  blocks: [{ blockIndex: 0, plainLength: 10, shardSize: 10, iv: 'AAAA', authTag: 'AAAA', placements: [{ shardIndex: 0, nodeId: 'node-0', shardHash: 'a'.repeat(64) }] }],
});
const mkEntry = (key, domain, version, routes, extra = {}) => ({
  domain, ownerPubkeyB58: key.pub, routes, version,
  signatureV2B64: H.sign(key, canonicalManifestV2(domain, version, routes)),
  signatureB64: H.sign(key, registry.canonicalManifest(domain, routes)), updatedAt: Date.now(), ...extra,
});
const KEY_A = Buffer.alloc(32, 1).toString('base64'), KEY_B = Buffer.alloc(32, 2).toString('base64');
const snap = (o) => ({ v: 1, now: Date.now(), gateways: [], sites: [], files: [], peers: [], ...o });

test('arquivo com fileKey DIFERENTE da assinada pelo dono é recusado (seed malicioso trocando a chave)', async () => {
  const key = H.newSiteKey();
  const routes = [{ path: '/', fileId: 'f'.repeat(32), contentType: 'text/html', fileKeyB64: KEY_A }];
  const res = await sync.ingestSnapshot(snap({ sites: [mkEntry(key, 'chave.test', 1, routes)], files: [fileMeta('f'.repeat(32), KEY_B)] }));
  assert.equal(res.sites.ok, 1);
  assert.equal(res.files.ok, 0);
  assert.match(res.files.rejected[0].reason, /fileKey difere/);
  assert.equal(registry.getFile('f'.repeat(32)), undefined);
});

test('arquivo que NENHUM site verificado referencia é recusado', async () => {
  const res = await sync.ingestSnapshot(snap({ files: [fileMeta('9'.repeat(32), KEY_A)] }));
  assert.match(res.files.rejected[0].reason, /não é referenciado/);
});

test('site com assinatura inválida / adulterado é recusado', async () => {
  const key = H.newSiteKey();
  const routes = [{ path: '/', fileId: 'a'.repeat(32), contentType: 'text/html', fileKeyB64: KEY_A }];
  const e = mkEntry(key, 'forjado.test', 1, routes);
  const tampered = { ...e, routes: [{ ...routes[0], fileId: 'b'.repeat(32) }] };
  const res = await sync.ingestSnapshot(snap({ sites: [tampered] }));
  assert.equal(res.sites.ok, 0);
  assert.match(res.sites.rejected[0].reason, /assinatura/);
});

test('rollback, troca de dono e downgrade v2->v1 não passam', async () => {
  const key = H.newSiteKey(), other = H.newSiteKey();
  const routes = [{ path: '/', fileId: 'c'.repeat(32), contentType: 'text/html', fileKeyB64: KEY_A }];
  assert.equal((await sync.ingestSnapshot(snap({ sites: [mkEntry(key, 'v.test', 5, routes)] }))).sites.ok, 1);
  // versão menor: não regride
  const r1 = await sync.ingestSnapshot(snap({ sites: [mkEntry(key, 'v.test', 3, routes)] }));
  assert.equal(r1.sites.ok, 0); assert.equal(registry.getSiteFull('v.test').version, 5);
  // outro dono, versão maior
  const r2 = await sync.ingestSnapshot(snap({ sites: [mkEntry(other, 'v.test', 9, routes)] }));
  assert.match(r2.sites.rejected[0].reason, /dono/);
  // downgrade pra v1 (replay de manifesto velho assinado em v1)
  const v1 = { domain: 'v.test', ownerPubkeyB58: key.pub, routes, version: 0, signatureB64: H.sign(key, registry.canonicalManifest('v.test', routes)), updatedAt: Date.now() + 99999 };
  const r3 = await sync.ingestSnapshot(snap({ sites: [v1] }));
  assert.match(r3.sites.rejected[0].reason, /downgrade/);
  assert.equal(registry.getSiteFull('v.test').version, 5);
});

test('strict: manifesto v1 é recusado', async () => {
  const key = H.newSiteKey();
  const routes = [{ path: '/', fileId: 'd'.repeat(32), contentType: 'text/html', fileKeyB64: '' }];
  const v1 = { domain: 'legado.test', ownerPubkeyB58: key.pub, routes, version: 0, signatureB64: H.sign(key, registry.canonicalManifest('legado.test', routes)), updatedAt: Date.now() };
  assert.equal((await sync.ingestSnapshot(snap({ sites: [v1] }), { strict: true })).sites.ok, 0);
  assert.equal((await sync.ingestSnapshot(snap({ sites: [v1] }), { strict: false })).sites.ok, 1);
});

test('peers de infra (gateway-*) vindos do seed são ignorados; relay de celular entra', async () => {
  const res = await sync.ingestSnapshot(snap({ peers: [{ nodeId: 'x1', relayNodeId: 'gateway-evil' }, { nodeId: 'x2', relayNodeId: 'phone-9' }] }));
  assert.equal(res.peers, 1);
  assert.equal(registry.getPeer('x1'), undefined);
  assert.equal(registry.getPeer('x2').relayNodeId, 'phone-9');
});

test('conteúdo fabricado (metadados válidos, bytes que NÃO geram o fileId) é descartado em strict', async () => {
  const key = H.newSiteKey();
  const good = Buffer.from('conteudo verdadeiro');
  const fileId = crypto.createHash('sha256').update('ver.test' + '/index.html').update(good).digest('hex').slice(0, 32);
  const routes = [{ path: '/', fileId, contentType: 'text/html', fileKeyB64: KEY_A }];
  await sync.ingestSnapshot(snap({ sites: [mkEntry(key, 'ver.test', 1, routes)], files: [fileMeta(fileId, KEY_A)] }));
  const orig = content.getRangeBuffer;
  try {
    content.getRangeBuffer = async () => Buffer.from('conteudo TROCADO!!');
    assert.equal(await sync.verifyFileContent({ fileId, domain: 'ver.test', path: '/' }, { strict: true }), 'unverifiable');
    assert.equal(registry.getFile(fileId), undefined, 'descartado');
    await sync.ingestSnapshot(snap({ files: [fileMeta(fileId, KEY_A)] })); // reinsere
    content.getRangeBuffer = async () => good;
    assert.equal(await sync.verifyFileContent({ fileId, domain: 'ver.test', path: '/' }, { strict: true }), 'verified');
    assert.equal(registry.getFile(fileId).integrity, 'verified');
  } finally { content.getRangeBuffer = orig; }
});

test('arquivo grande é pulado (não baixa tudo só pra conferir) e celulares offline => "error" (tenta depois)', async () => {
  const key = H.newSiteKey();
  const routes = [{ path: '/big.bin', fileId: 'e'.repeat(32), contentType: 'x', fileKeyB64: KEY_A }];
  await sync.ingestSnapshot(snap({ sites: [mkEntry(key, 'big.test', 1, routes)], files: [{ ...fileMeta('e'.repeat(32), KEY_A), originalLength: 50 * 1024 * 1024 }] }));
  assert.equal(await sync.verifyFileContent({ fileId: 'e'.repeat(32), domain: 'big.test', path: '/big.bin' }, { maxBytes: 1024 }), 'skipped');
  const orig = content.getRangeBuffer;
  content.getRangeBuffer = async () => { throw new Error('peers offline'); };
  try { assert.equal(await sync.verifyFileContent({ fileId: 'e'.repeat(32), domain: 'big.test', path: '/big.bin' }, { maxBytes: 1 << 30 }), 'error'); }
  finally { content.getRangeBuffer = orig; }
});

test('exportSnapshot só expõe arquivos COM fileKey (privados não vazam) e respeita ?since e ?domain', async () => {
  const key = H.newSiteKey();
  const fid = '7'.repeat(32), priv = '8'.repeat(32);
  registry.registerFile(fileMeta(fid, KEY_A));
  const privMeta = fileMeta(priv, KEY_A); delete privMeta.fileKeyB64; registry.registerFile(privMeta);
  const routes = [{ path: '/', fileId: fid, contentType: 'text/html', fileKeyB64: KEY_A }, { path: '/p', fileId: priv, contentType: 'text/html', fileKeyB64: '' }];
  registry.registerSite('exp.test', key.pub, routes, H.sign(key, canonicalManifestV2('exp.test', 4, routes)), 4, H.sign(key, registry.canonicalManifest('exp.test', routes)));
  const all = sync.exportSnapshot({});
  assert.ok(all.files.some((f) => f.fileId === fid));
  assert.ok(!all.files.some((f) => f.fileId === priv), 'arquivo sem fileKey não é exportado');
  assert.equal(sync.exportSnapshot({ domain: 'exp.test' }).sites.length, 1);
  assert.equal(sync.exportSnapshot({ domain: 'nao.existe' }).sites.length, 0);
  assert.equal(sync.exportSnapshot({ since: Date.now() + 10_000 }).sites.length, 0);
  assert.equal(sync.exportSnapshot({ domain: 'exp.test', withFiles: false }).files.length, 0);
});
