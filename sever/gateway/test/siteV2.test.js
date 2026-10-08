'use strict';
// Roda sem tocar no disco real: aponta o registry pra um diretório temporário.
const os = require('os'), fs = require('fs'), path = require('path');
process.env.GATEWAY_DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reg-')), 'gateway-data.json');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const registry = require('../registry');
const base58 = require('../base58');
const { canonicalManifestV2, manifestHash } = require('../../chain/siteManifest');
const { verifySiteAgainstChain } = require('../siteVerify');
const { buildSiteGossipEntry } = require('../meshBridge');

function newKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { priv: privateKey, pub: base58.encode(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) };
}
const sign = (k, msg) => crypto.sign(null, Buffer.from(msg), k.priv).toString('base64');
const routes = [{ path: '/', fileId: 'f1', contentType: 'text/html', fileKeyB64: 'KEY1' }, { path: '/B.css', fileId: 'f2', contentType: 'text/css', fileKeyB64: 'KEY2' }];
const D = 'v2.teste.site';

test('v2: aceita, guarda versão, expõe assinatura v1 (legado) e v2 no gossip', () => {
  const k = newKey();
  registry.registerSite(D, k.pub, routes, sign(k, canonicalManifestV2(D, 10, routes)), 10, sign(k, registry.canonicalManifest(D, routes)));
  const e = buildSiteGossipEntry(D);
  assert.equal(e.version, 10);
  assert.ok(e.signatureV2B64 && e.signatureB64 && e.signatureV2B64 !== e.signatureB64);
  assert.equal(e.routes.find((r) => r.path === '/B.css').fileKeyB64, 'KEY2', 'fileKey vem do que foi ASSINADO');
  // o v1 que apps antigos verificam bate com o canônico v1
  const ok = crypto.verify(null, Buffer.from(registry.canonicalManifest(D, routes)), crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(base58.decode(k.pub))]), format: 'der', type: 'spki' }), Buffer.from(e.signatureB64, 'base64'));
  assert.equal(ok, true);
  globalThis.__k = k;
});

test('v2: rollback (versão igual ou menor) recusado; versão maior aceita', () => {
  const k = globalThis.__k;
  const sig = (v) => sign(k, canonicalManifestV2(D, v, routes));
  assert.throws(() => registry.registerSite(D, k.pub, routes, sig(10), 10), /rollback/);
  assert.throws(() => registry.registerSite(D, k.pub, routes, sig(9), 9), /rollback/);
  registry.registerSite(D, k.pub, routes, sig(11), 11);
  assert.equal(registry.getSiteFull(D).version, 11);
});

test('v2: downgrade pra v1 recusado (replay de manifesto velho assinado em v1)', () => {
  const k = globalThis.__k;
  assert.throws(() => registry.registerSite(D, k.pub, routes, sign(k, registry.canonicalManifest(D, routes))), /downgrade/);
});

test('v2: outro dono recusado; fileKey adulterada invalida a assinatura (no v1 passava)', () => {
  const k = globalThis.__k, other = newKey();
  assert.throws(() => registry.registerSite(D, other.pub, routes, sign(other, canonicalManifestV2(D, 50, routes)), 50), /dono não confere/);
  const tampered = routes.map((r) => ({ ...r, fileKeyB64: r.path === '/' ? 'EVIL' : r.fileKeyB64 }));
  assert.throws(() => registry.registerSite(D, k.pub, tampered, sign(k, canonicalManifestV2(D, 60, routes)), 60), /assinatura/);
});

test("v2: rota com '|' é rejeitada (v1 deixava colidir)", () => {
  const k = newKey();
  const bad = [{ path: '/a|X', fileId: 'Y', contentType: 't' }];
  assert.throws(() => registry.registerSite('pipe.teste.site', k.pub, bad, 'x', 1));
});

test('v1 legado continua funcionando pra domínio novo (sem version)', () => {
  const k = newKey();
  registry.registerSite('legado.teste.site', k.pub, routes, sign(k, registry.canonicalManifest('legado.teste.site', routes)));
  assert.equal(registry.getSiteFull('legado.teste.site').version, 0);
});

// ---- verificação on-chain (chain simulada) ----
const mkChain = (record, boom) => ({
  resolveSiteOnChain: async () => { if (boom) throw new Error('sem quórum on-chain'); return { record }; },
  checkManifestAgainstRecord: require('../../chain/siteChain').checkManifestAgainstRecord,
});
const cfg = (mode) => ({ mode, programId: 'P', rpcUrls: ['a', 'b'] });

test('chain off: ignora', async () => {
  assert.deepEqual(await verifySiteAgainstChain({ domain: D, ownerPubkey: 'x', version: 1, routes }, cfg('off')), { ok: true, skipped: true });
});

test('chain required: precisa de registro; hash/versão/dono precisam bater', async () => {
  const k = newKey();
  const rec = { owner: k.pub, version: 5, manifestHash: manifestHash(D, 5, routes) };
  const args = { domain: D, ownerPubkey: k.pub, version: 5, routes };
  assert.equal((await verifySiteAgainstChain(args, cfg('required'), { chain: mkChain(rec) })).ok, true);
  assert.equal((await verifySiteAgainstChain(args, cfg('required'), { chain: mkChain(null) })).ok, false);
  assert.match((await verifySiteAgainstChain({ ...args, ownerPubkey: 'outro' }, cfg('required'), { chain: mkChain(rec) })).reason, /dono/);
  assert.match((await verifySiteAgainstChain({ ...args, version: 4 }, cfg('required'), { chain: mkChain(rec) })).reason, /versão/);
  const tampered = routes.map((r) => ({ ...r, fileId: 'EVIL' }));
  assert.match((await verifySiteAgainstChain({ ...args, routes: tampered }, cfg('required'), { chain: mkChain(rec) })).reason, /hash/);
  assert.match((await verifySiteAgainstChain({ ...args, version: null }, cfg('required'), { chain: mkChain(rec) })).reason, /v2/);
});

test('chain optional: sem registro passa (migração); COM registro divergente falha', async () => {
  const k = newKey();
  const args = { domain: D, ownerPubkey: k.pub, version: 5, routes };
  assert.equal((await verifySiteAgainstChain(args, cfg('optional'), { chain: mkChain(null) })).ok, true);
  const rec = { owner: k.pub, version: 5, manifestHash: Buffer.alloc(32) };
  assert.equal((await verifySiteAgainstChain(args, cfg('optional'), { chain: mkChain(rec) })).ok, false);
});

test('RPC indisponível NÃO desliga a verificação (falha fechada)', async () => {
  const r = await verifySiteAgainstChain({ domain: D, ownerPubkey: 'x', version: 1, routes }, cfg('optional'), { chain: mkChain(null, true) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /indispon/);
});
