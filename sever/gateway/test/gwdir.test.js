'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
delete process.env.GATEWAY_ANNOUNCE_ALLOW_PRIVATE;
const dir = require('../gwDirectory');

test('normalizeUrl: só origem http(s), sem credenciais/path', () => {
  assert.equal(dir.normalizeUrl('https://gw.exemplo.com/algum/path?x=1'), 'https://gw.exemplo.com');
  assert.equal(dir.normalizeUrl('http://1.2.3.4:8788/'), 'http://1.2.3.4:8788');
  for (const bad of ['ftp://x.com', 'javascript:alert(1)', 'https://user:pw@x.com', 'não é url', '']) assert.equal(dir.normalizeUrl(bad), null, bad);
});

test('SSRF: announce recusa loopback/privado/link-local/metadata da nuvem', async () => {
  for (const u of ['http://127.0.0.1:8788', 'http://localhost:8788', 'http://10.0.0.5', 'http://192.168.1.10:80', 'http://169.254.169.254', 'http://[::1]:80', 'http://172.16.3.4']) {
    await assert.rejects(dir.announce(u, { fetchImpl: async () => { throw new Error('NÃO devia nem ter ligado'); } }), /privado|inválida|resolv|ENOTFOUND|EAI/, u);
  }
  assert.equal(dir.isPrivateIp('100.64.0.1'), true);   // CGNAT
  assert.equal(dir.isPrivateIp('93.184.216.34'), false);
});

test('announce exige o eco do nonce (prova de controle da URL)', async () => {
  dir._reset();
  const echo = async (url) => { const n = new URL(url).searchParams.get('nonce'); return { ok: true, json: async () => ({ ok: true, nonce: n }) }; };
  const wrong = async () => ({ ok: true, json: async () => ({ ok: true, nonce: 'outro' }) });
  assert.deepEqual(await dir.announce('http://93.184.216.34:8788', { fetchImpl: echo }), { ok: true });
  await assert.rejects(dir.announce('http://93.184.216.35:8788', { fetchImpl: wrong }), /não confirmou/);
  assert.deepEqual(dir.list({ includeSelf: false }), ['http://93.184.216.34:8788']);
});

test('lista tem teto, não duplica e aprendizado passivo não faz requisição', () => {
  dir._reset(); dir.setSelf('http://93.184.216.1:1');
  const many = Array.from({ length: 200 }, (_, i) => `http://93.184.${i % 250}.${(i * 7) % 250}:80`);
  dir.learn(many); dir.learn(many);
  assert.ok(dir.list().length <= 65); // 64 + self
  assert.equal(dir.list()[0], 'http://93.184.216.1:1');
});
