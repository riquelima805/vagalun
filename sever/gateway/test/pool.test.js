'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const P = require('../vendor/vagalun-player/vagalun-gateway-pool.js');
const server = require('../../chain/siteManifest');
const base58 = require('../base58');

const R = (path, fileId = 'f', contentType = 'text/html', fileKeyB64 = 'K') => ({ path, fileId, contentType, fileKeyB64 });
const key = () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, pub: base58.encode(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)) };
};
const sign = (k, m) => crypto.sign(null, Buffer.from(m), k.privateKey).toString('base64');
const entryV2 = (k, domain, version, routes) => ({ domain, ownerPubkeyB58: k.pub, routes, version, signatureV2B64: sign(k, server.canonicalManifestV2(domain, version, routes)) });

test('manifesto v2 do navegador == do servidor, byte a byte (caixa mista, UTF-8, emoji, vazio)', () => {
  const cases = [
    ['meu.site', 1, [R('/'), R('/B.css'), R('/a.css')]],
    ['x.site', 1760000000, [R('/z'), R('/é.js'), R('/日本.html'), R('/😀.png'), R('/\uE000'), R('/a')]],
    ['x.site', 3, []], ['x.site', 2, [R('/a', 'f', '', '')]],
  ];
  for (const [d, v, rs] of cases) assert.equal(P.canonicalManifestV2(d, v, rs), server.canonicalManifestV2(d, v, rs));
  for (const [d, v, rs] of [['x.site', 2, [R('/a|b')]], ['x.site', 2, [R('/a'), R('/a')]], ['X.site', 2, [R('/a')]], ['x.site', 0, [R('/a')]]]) {
    assert.throws(() => P.canonicalManifestV2(d, v, rs)); assert.throws(() => server.canonicalManifestV2(d, v, rs));
  }
});

test('hash do manifesto no navegador == hash que o contrato guarda (sha256 do canônico)', async () => {
  const rs = [R('/'), R('/x.js')];
  assert.equal(P.hex(await P.manifestHashV2('a.site', 7, rs)), server.manifestHash('a.site', 7, rs).toString('hex'));
});

test('verifySiteEntry: assinatura Ed25519 via WebCrypto; adulteração e dono errado falham', async () => {
  const k = key(), rs = [R('/')];
  const e = entryV2(k, 'a.site', 5, rs);
  assert.equal((await P.verifySiteEntry(e, 'a.site')).version, 5);
  await assert.rejects(P.verifySiteEntry({ ...e, routes: [R('/', 'OUTRO')] }, 'a.site'), /assinatura/);
  await assert.rejects(P.verifySiteEntry({ ...e, ownerPubkeyB58: key().pub }, 'a.site'), /assinatura/);
  await assert.rejects(P.verifySiteEntry(e, 'b.site'), /inválida/);
});

test('pin: dono não muda, versão não regride, v2 não volta pra v1', async () => {
  const k = key(), rs = [R('/')];
  const pinned = { owner: k.pub, version: 5 };
  await P.verifySiteEntry(entryV2(k, 'a.site', 5, rs), 'a.site', { pinned });   // igual: ok
  await P.verifySiteEntry(entryV2(k, 'a.site', 6, rs), 'a.site', { pinned });   // maior: ok
  await assert.rejects(P.verifySiteEntry(entryV2(k, 'a.site', 4, rs), 'a.site', { pinned }), /rollback/);
  await assert.rejects(P.verifySiteEntry(entryV2(key(), 'a.site', 9, rs), 'a.site', { pinned }), /dono do site mudou/);
  const v1 = { domain: 'a.site', ownerPubkeyB58: k.pub, routes: rs, version: 0, signatureB64: sign(k, P.canonicalManifestV1('a.site', rs)) };
  await assert.rejects(P.verifySiteEntry(v1, 'a.site', { pinned }), /downgrade/);
  assert.equal((await P.verifySiteEntry(v1, 'a.site', {})).v2, false);          // v1 sem pin: aceito (legado)
  await assert.rejects(P.verifySiteEntry(v1, 'a.site', { strict: true }), /strict/);
});

test('gancho on-chain: dono, versão e HASH precisam bater com o registro da chain', async () => {
  const k = key(), rs = [R('/'), R('/x.js')], e = entryV2(k, 'a.site', 8, rs);
  const good = { owner: k.pub, version: 8, manifestHashHex: server.manifestHash('a.site', 8, rs).toString('hex') };
  await P.verifySiteEntry(e, 'a.site', { chain: async () => good });
  await assert.rejects(P.verifySiteEntry(e, 'a.site', { chain: async () => ({ ...good, manifestHashHex: '00'.repeat(32) }) }), /hash/);
  await assert.rejects(P.verifySiteEntry(e, 'a.site', { chain: async () => ({ ...good, version: 7 }) }), /versão/);
  await assert.rejects(P.verifySiteEntry(e, 'a.site', { chain: async () => ({ ...good, owner: key().pub }) }), /dono difere/);
  await assert.rejects(P.verifySiteEntry(e, 'a.site', { chain: async () => null }), /não registrado/);
});

test('verifyEd25519 injetável (navegador sem Ed25519 no WebCrypto usa tweetnacl)', async () => {
  const k = key(), e = entryV2(k, 'a.site', 1, [R('/')]);
  let called = 0;
  await P.verifySiteEntry(e, 'a.site', { verifyEd25519: async () => { called++; return true; } });
  assert.equal(called, 1);
});

test('fileId: regra do publisher (/ -> /index.html) e arquivo adulterado não passa', async () => {
  const buf = Buffer.from('<h1>oi</h1>');
  const id = (salt) => crypto.createHash('sha256').update(salt).update(buf).digest('hex').slice(0, 32);
  assert.equal(await P.fileIdMatches(id('d.site/index.html'), 'd.site', '/', buf), true);
  assert.equal(await P.fileIdMatches(id('d.site/app.js'), 'd.site', '/app.js', buf), true);
  assert.equal(await P.fileIdMatches(id('d.site/app.js'), 'd.site', '/app.js', Buffer.from('<h1>OI</h1>')), false);
  assert.equal(await P.fileIdMatches(id('d.site/app.js'), 'outro.site', '/app.js', buf), false, 'salt inclui o domínio');
});

// ---- race / hedge / ranking --------------------------------------------------------------
const mkPool = (urls, o = {}) => { const p = new P.Pool({ seeds: urls, hedgeMs: 40, timeoutMs: 1000, ...o }); return p; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('race: o 1º lento é "hedged" — o 2º dispara e vence; o lento é abortado', async () => {
  const p = mkPool(['http://slow.test', 'http://fast.test']);
  p.gws.get('http://slow.test').rtt = 1; p.gws.get('http://fast.test').rtt = 100;
  let slowAborted = false;
  const r = await p.race(async (gw, signal) => {
    if (gw.includes('slow')) { await new Promise((res, rej) => { signal.addEventListener('abort', () => { slowAborted = true; rej(new Error('abort')); }); setTimeout(res, 800); }); return 'slow'; }
    return 'fast';
  });
  assert.equal(r.value, 'fast');
  await sleep(20); assert.equal(slowAborted, true);
});

test('race: falha rápida passa pro próximo na hora (sem esperar o hedge); todos falhando => erro agregado', async () => {
  const p = mkPool(['http://a.test', 'http://b.test', 'http://c.test'], { hedgeMs: 5000 });
  const t0 = Date.now();
  const r = await p.race(async (gw) => { if (!gw.includes('c.test')) throw new Error('caiu'); return 'c'; });
  assert.equal(r.value, 'c'); assert.ok(Date.now() - t0 < 500);
  await assert.rejects(p.race(async () => { throw new Error('x'); }), /todos os gateways falharam/);
});

test('ranking: RTT menor primeiro; falha pesa; conteúdo ruim pesa MUITO mais; sucesso zera falhas', async () => {
  const p = mkPool(['http://a.test', 'http://b.test', 'http://c.test']);
  p.gws.get('http://a.test').rtt = 30; p.gws.get('http://b.test').rtt = 60; p.gws.get('http://c.test').rtt = 90;
  assert.deepEqual(p.ranked().map((g) => new URL(g.url).hostname), ['a.test', 'b.test', 'c.test']);
  p._fail('http://a.test', new Error('x')); p._fail('http://a.test', new Error('x'));
  assert.equal(p.ranked()[0].url, 'http://b.test');
  p._ok('http://a.test', 30);
  assert.equal(p.ranked()[0].url, 'http://a.test');
  const bad = new Error('mentiu'); bad.vagalunBad = true;
  p._fail('http://a.test', bad);
  assert.equal(p.ranked().at(-1).url, 'http://a.test');
});

test('addGateways: ignora esquemas estranhos, normaliza, respeita teto', () => {
  const p = mkPool([], { maxGateways: 3 });
  p.addGateways(['javascript:alert(1)', 'ftp://x', 'não é url', 'https://ok.test/caminho', 'https://ok.test', 'https://b.test', 'https://c.test', 'https://d.test']);
  assert.deepEqual([...p.gws.keys()], ['https://ok.test', 'https://b.test', 'https://c.test']);
});

test('fetchSite: dono fixado persiste no store; segundo gateway com OUTRO dono é recusado', async () => {
  const k = key(), evilK = key(), rs = [R('/', 'a'.repeat(32))];
  const body = Buffer.from('oi');
  const fid = crypto.createHash('sha256').update('d.site/index.html').update(body).digest('hex').slice(0, 32);
  const real = [R('/', fid, 'text/html')];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/sync/registry') {
      const who = u.host === 'good.test' ? k : evilK;
      return { ok: true, json: async () => ({ sites: [entryV2(who, 'd.site', 3, real)] }) };
    }
    if (u.pathname.startsWith('/raw/')) return { ok: true, status: 200, arrayBuffer: async () => body };
    return { ok: false, status: 404 };
  };
  const store = new Map();
  const st = { get: async (x) => store.get(x) ?? null, set: async (x, v) => { store.set(x, v); } };
  const p1 = new P.Pool({ seeds: ['http://good.test'], fetchImpl, store: st });
  const r = await p1.fetchSite('d.site', '/');
  assert.equal(r.verified, 'yes');
  assert.deepEqual(store.get('pin:d.site'), { owner: k.pub, version: 3 });
  // "novo SW": mesmo store, gateway que serve manifesto de OUTRO dono (mesmo bem assinado)
  const p2 = new P.Pool({ seeds: ['http://evil.test'], fetchImpl, store: st });
  await assert.rejects(p2.fetchSite('d.site', '/'), /dono do site mudou/);
});
