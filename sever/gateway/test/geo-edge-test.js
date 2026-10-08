// Teste fim a fim de: ordenação por distância, k+1 mais próximos, headers de CDN,
// cache de borda por demanda (replicar / servir / expirar) e métricas.
//
// Sobe um signaling FALSO (WebSocket + GET /directory/geo) e vários "celulares" falsos
// em cidades diferentes, que falam o mesmo protocolo relay do app (put/get_range/delete).
// Rodar:  GATEWAY_DATA_FILE=/tmp/gw-geo-test.json node gateway/test/geo-edge-test.js

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');

process.env.GATEWAY_DATA_FILE = process.env.GATEWAY_DATA_FILE || '/tmp/gw-geo-test.json';
// começa sempre do zero: o registry persiste em disco e réplicas de uma rodada anterior quebram as contagens
for (const f of [process.env.GATEWAY_DATA_FILE, process.env.GATEWAY_DATA_FILE + '.tmp']) { try { require('fs').rmSync(f); } catch {} }
process.env.GATEWAY_EDGE_MIN_HITS = '3';
process.env.GATEWAY_EDGE_COOLDOWN_MS = '150';
process.env.GATEWAY_EDGE_TTL_MS = '600';
process.env.GATEWAY_RESERVE_MS = '120';
process.env.GATEWAY_HEDGE_MS = '300';

const CITIES = {
  sp:  { lat: -23.5, lon: -46.6, region: 'São Paulo, BR' },
  rj:  { lat: -22.9, lon: -43.2, region: 'Rio de Janeiro, BR' },
  lis: { lat: 38.7,  lon: -9.1,  region: 'Lisboa, PT' },
  mad: { lat: 40.4,  lon: -3.7,  region: 'Madrid, ES' },
  par: { lat: 48.9,  lon: 2.4,   region: 'Paris, FR' },
};

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`  ok  - ${name}`); }
  catch (e) { failures++; console.log(`  FAIL - ${name}\n         ${e.stack.split('\n').slice(0, 4).join('\n         ')}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000, step = 25) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return false;
}

// ---------- signaling falso ----------
const sockets = new Map();  // nodeId -> ws
const geoTable = new Map(); // nodeId -> { lat, lon, region }
function startFakeSignaling() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/directory/geo') {
        const nodes = {};
        for (const [id, ws] of sockets) {
          if (ws.readyState !== WebSocket.OPEN) continue;
          const g = geoTable.get(id);
          nodes[id] = g ? { lat: g.lat, lon: g.lon, region: g.region } : { lat: null, lon: null, region: null };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, nodes }));
      }
      res.writeHead(404); res.end();
    });
    const wss = new WebSocket.Server({ server: srv });
    wss.on('connection', (ws) => {
      let self = null;
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'register') { self = msg.nodeId; sockets.set(self, ws); }
        else if (msg.type === 'relay') {
          const t = sockets.get(msg.to);
          if (!t || t.readyState !== WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'relay_error', reason: 'peer_offline', requestId: msg.requestId }));
          } else t.send(JSON.stringify({ type: 'relay', from: self, requestId: msg.requestId, header: msg.header, payloadBase64: msg.payloadBase64 }));
        } else if (msg.type === 'relay_response') {
          const t = sockets.get(msg.to);
          if (t) t.send(JSON.stringify({ type: 'relay_response', from: self, requestId: msg.requestId, header: msg.header, payloadBase64: msg.payloadBase64 }));
        }
      });
      ws.on('close', () => { if (self && sockets.get(self) === ws) sockets.delete(self); });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ---------- celular falso ----------
function startPhone(url, nodeId, city, { refusePut = false } = {}) {
  return new Promise((resolve) => {
    const store = new Map();
    const stats = { gets: 0, puts: 0, deletes: 0 };
    const ws = new WebSocket(url);
    geoTable.set(nodeId, city);
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'register', nodeId })); setTimeout(() => resolve(phone), 40); });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== 'relay') return;
      const { from, requestId, header, payloadBase64 } = msg;
      const payload = payloadBase64 ? Buffer.from(payloadBase64, 'base64') : null;
      let rh, rp = null;
      if (header.op === 'put') {
        stats.puts++;
        if (refusePut) rh = { ok: false, error: 'sem espaço' };
        else { store.set(header.shardKey, payload); rh = { ok: true }; }
      } else if (header.op === 'get_range' || header.op === 'get') {
        stats.gets++;
        const d = store.get(header.shardKey);
        if (!d) rh = { ok: false, error: 'não encontrado' };
        else { rp = header.op === 'get_range' ? d.subarray(header.offset || 0, (header.offset || 0) + (header.length ?? d.length)) : d; rh = { ok: true }; }
      } else if (header.op === 'delete') {
        stats.deletes++; store.delete(header.shardKey); rh = { ok: true };
      } else rh = { ok: false, error: 'op?' };
      const out = { type: 'relay_response', to: from, requestId, header: rh };
      if (rp) out.payloadBase64 = rp.toString('base64');
      ws.send(JSON.stringify(out));
    });
    const phone = { nodeId, store, stats, close: () => ws.close() };
  });
}

// ---------- publica um arquivo k=1 (cada shard = cópia completa) nos celulares dados ----------
function publishReplicated(registry, content, reedSolomon, hashShard, fileId, holders /* [{logical, relay}] */) {
  const blockSize = 4096;
  const original = crypto.randomBytes(6000); // 2 blocos
  const key = crypto.randomBytes(32);
  const k = 1, m = holders.length - 1;
  const blocks = [];
  const phonesByRelay = holders;
  let off = 0, bi = 0;
  while (off < original.length) {
    const end = Math.min(off + blockSize, original.length);
    const plain = original.subarray(off, end);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    const enc = reedSolomon.encode(ct, k, m);
    const placements = holders.map((h, s) => ({ shardIndex: s, nodeId: h.logical, shardHash: hashShard(enc.shards[s]) }));
    holders.forEach((h, s) => h.phone.store.set(content.shardKeyFor(fileId, bi, s), enc.shards[s]));
    blocks.push({ blockIndex: bi, plainLength: plain.length, shardSize: enc.shardSize, iv: iv.toString('base64'), authTag: c.getAuthTag().toString('base64'), placements });
    off = end; bi++;
  }
  registry.registerFile({ fileId, fileName: 'video.mp4', k, m, n: k + m, blockSize, originalLength: original.length, blocks, fileKeyB64: key.toString('base64') });
  return original;
}

function httpGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
function httpPost(port, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'text/plain' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
}
const p2p = async (port, fileId, city) => {
  const q = city ? `?geo=${CITIES[city].lat},${CITIES[city].lon}` : '';
  const r = await httpGet(port, `/p2p/${fileId}${q}`);
  return { status: r.status, json: JSON.parse(r.body.toString()) };
};

(async () => {
  const sig = await startFakeSignaling();
  const sigPort = sig.address().port;
  process.env.GATEWAY_SIGNALING_URL = `ws://127.0.0.1:${sigPort}`;
  process.env.GATEWAY_SIGNALING_PUBLIC_URL = ''; // sem meshBridge

  // só agora carrega os módulos (leem env no load)
  const registry = require('../registry');
  const content = require('../content');
  const geo = require('../geo');
  const edge = require('../edge');
  const reedSolomon = require('../reedSolomon');
  const { hashShard } = require('../shardHash');
  const { fetchShardsMultiSource } = require('../multiSource');
  const { server } = require('../gateway');

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const gw = server.address().port;
  const url = process.env.GATEWAY_SIGNALING_URL;

  // ================= multiSource =================
  console.log('\n[1] multiSource: os k mais próximos primeiro; k+1 e o resto só se precisar');
  await check('k=2 com initial=2: dispara só 2 de 6 e para quando junta k', async () => {
    const called = [];
    const ps = [0, 1, 2, 3, 4, 5].map((i) => ({ shardIndex: i }));
    const r = await fetchShardsMultiSource(ps, 2, async (p) => { called.push(p.shardIndex); return Buffer.from([p.shardIndex]); }, { initial: 2, reserveMs: 50, hedgeMs: 200 });
    assert.strictEqual(r.length, 2);
    await sleep(300);
    assert.deepStrictEqual(called, [0, 1]);
  });
  await check('falha de um dos primeiros puxa o próximo da fila NA HORA (sem esperar timer)', async () => {
    const called = [];
    const ps = [0, 1, 2, 3].map((i) => ({ shardIndex: i }));
    const t0 = Date.now();
    const r = await fetchShardsMultiSource(ps, 2, async (p) => { called.push(p.shardIndex); return p.shardIndex === 0 ? null : Buffer.from([p.shardIndex]); }, { initial: 2, reserveMs: 5000, hedgeMs: 9000 });
    assert.deepStrictEqual(r.map((x) => x.index).sort(), [1, 2]);
    assert.ok(Date.now() - t0 < 500);
    assert.ok(!called.includes(3));
  });
  await check('reserva: se o mais próximo demora mais que reserveMs, o k+1-ésimo entra e ganha', async () => {
    const called = [];
    const ps = [0, 1, 2].map((i) => ({ shardIndex: i }));
    const r = await fetchShardsMultiSource(ps, 1, async (p) => { called.push(p.shardIndex); if (p.shardIndex === 0) { await sleep(600); } return Buffer.from([p.shardIndex]); }, { initial: 1, reserveMs: 50, hedgeMs: 3000 });
    assert.strictEqual(r[0].index, 1);
    assert.deepStrictEqual(called, [0, 1]); // o 3º nem foi pedido
  });
  await check('hedge: se a reserva também trava, depois de hedgeMs entra o resto', async () => {
    const ps = [0, 1, 2].map((i) => ({ shardIndex: i }));
    const t0 = Date.now();
    const r = await fetchShardsMultiSource(ps, 1, async (p) => {
      if (p.shardIndex <= 1) { await sleep(2000); return null; }
      return Buffer.from([9]);
    }, { initial: 1, reserveMs: 40, hedgeMs: 150 });
    assert.strictEqual(r[0].index, 2);
    assert.ok(Date.now() - t0 < 1000, 'demorou demais: ' + (Date.now() - t0));
  });
  await check('sem opts: comportamento antigo (todos de uma vez)', async () => {
    const called = [];
    const ps = [0, 1, 2, 3].map((i) => ({ shardIndex: i }));
    await fetchShardsMultiSource(ps, 2, async (p) => { called.push(p.shardIndex); return Buffer.from([1]); });
    assert.deepStrictEqual(called, [0, 1, 2, 3]);
  });
  await check('todos falham -> erro com a mesma mensagem de antes', async () => {
    await assert.rejects(
      fetchShardsMultiSource([{ shardIndex: 0 }, { shardIndex: 1 }], 1, async () => null, { initial: 1, reserveMs: 20 }),
      /só consegui 0 de 1 shards necessários/
    );
  });

  // ================= celulares =================
  const phones = {
    sp1: await startPhone(url, 'phone-sp-1', CITIES.sp),
    rj:  await startPhone(url, 'phone-rj-1', CITIES.rj),
    lis: await startPhone(url, 'phone-lis-1', CITIES.lis),
    mad: await startPhone(url, 'phone-mad-1', CITIES.mad),
    par: await startPhone(url, 'phone-par-1', CITIES.par, { refusePut: true }),
  };
  registry.addRelayPeer('node-0', 'phone-sp-1');
  registry.addRelayPeer('node-1', 'phone-rj-1');
  registry.addRelayPeer('node-2', 'phone-lis-1');
  await geo.refreshNodeGeo();

  // ================= geo: ordenação =================
  console.log('\n[2] /p2p ordena só entre quem TEM o arquivo, do mais perto ao mais longe');
  const A = 'file-A';
  const originalA = publishReplicated(registry, content, reedSolomon, hashShard, A, [
    { logical: 'node-0', phone: phones.sp1 }, { logical: 'node-1', phone: phones.rj }, { logical: 'node-2', phone: phones.lis },
  ]);

  await check('visitante em São Paulo: SP, Rio, Lisboa (e Madrid/Paris nem aparecem: não têm o arquivo)', async () => {
    const { status, json } = await p2p(gw, A, 'sp');
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json.candidates.map((c) => c.relayNodeId), ['phone-sp-1', 'phone-rj-1', 'phone-lis-1']);
    assert.ok(json.candidates[0].distanceKm < 50);
    assert.strictEqual(json.geoSource, 'override');
    assert.strictEqual(json.metricsUrl, '/metrics/player');
    assert.strictEqual(json.distanceKm, json.candidates[0].distanceKm);
    assert.ok(json.candidates.every((c) => c.online === true));
  });
  await check('visitante em Madrid: a ordem muda (Lisboa primeiro)', async () => {
    const { json } = await p2p(gw, A, 'mad');
    assert.strictEqual(json.candidates[0].relayNodeId, 'phone-lis-1');
    assert.ok(json.candidates[0].distanceKm < 700);
    assert.strictEqual(json.candidates[0].region, 'Lisboa, PT');
  });
  await check('sem geo do visitante: mantém a ordem original (não quebra)', async () => {
    const { json } = await p2p(gw, A, null);
    assert.strictEqual(json.geoSource, 'none');
    assert.deepStrictEqual(json.candidates.map((c) => c.relayNodeId), ['phone-sp-1', 'phone-rj-1', 'phone-lis-1']);
    assert.strictEqual(json.candidates[0].distanceKm, null);
  });

  // ================= headers + k+1 no /raw =================
  console.log('\n[3] /raw: headers de CDN e conteúdo íntegro');
  const rawGeo = (city) => `/raw/${A}?geo=${CITIES[city].lat},${CITIES[city].lon}`;
  await check('MISS na 1ª vez, servido pelo celular mais perto (Lisboa), bytes corretos', async () => {
    content.blockCache.clear();
    const r = await httpGet(gw, rawGeo('mad'));
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.equals(originalA), 'bytes diferentes');
    assert.strictEqual(r.headers['x-cache'], 'MISS');
    assert.strictEqual(r.headers['x-vagalun-node'], geo.alias('phone-lis-1'));
    assert.strictEqual(r.headers['x-vagalun-region'], 'Lisboa, PT');
    assert.ok(Number(r.headers['x-vagalun-distance-km']) < 700);
    assert.match(r.headers['server-timing'], /ttfb;dur=\d+, cache;desc="MISS", node;desc="n-[0-9a-f]{8}"/);
    assert.match(r.headers['access-control-expose-headers'], /X-Cache/);
  });
  await check('gastou banda só do mais perto: São Paulo e Rio não receberam nenhum pedido', async () => {
    assert.strictEqual(phones.sp1.stats.gets, 0, `sp recebeu ${phones.sp1.stats.gets} gets`);
    assert.strictEqual(phones.rj.stats.gets, 0, `rj recebeu ${phones.rj.stats.gets} gets`);
    assert.ok(phones.lis.stats.gets > 0);
  });
  await check('2ª vez: X-Cache HIT (RAM do gateway), sem node', async () => {
    const r = await httpGet(gw, rawGeo('mad'));
    assert.strictEqual(r.headers['x-cache'], 'HIT');
    assert.strictEqual(r.headers['x-vagalun-node'], undefined);
    assert.ok(r.body.equals(originalA));
  });
  await check('celular mais perto cai: fallback transparente pro próximo, conteúdo íntegro', async () => {
    phones.lis.close();
    await until(async () => { await geo.refreshNodeGeo(); return geo.isOnline('phone-lis-1') === false; });
    content.blockCache.clear();
    const r = await httpGet(gw, rawGeo('mad'));
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.equals(originalA));
    assert.strictEqual(r.headers['x-vagalun-node'], geo.alias('phone-rj-1')); // Lisboa caiu; Rio é o vivo mais perto de Madrid (Rio < São Paulo)
  });
  await check('/p2p manda o celular offline pro FIM da lista', async () => {
    const { json } = await p2p(gw, A, 'mad');
    const last = json.candidates[json.candidates.length - 1];
    assert.strictEqual(last.relayNodeId, 'phone-lis-1');
    assert.strictEqual(last.online, false);
    assert.strictEqual(json.candidates[0].online, true);
  });
  await check('erro antes do 1º byte vira 502 limpo, sem Cache-Control/ETag de sucesso', async () => {
    phones.sp1.close(); phones.rj.close();
    await until(async () => { await geo.refreshNodeGeo(); return geo.isOnline('phone-sp-1') === false && geo.isOnline('phone-rj-1') === false; });
    content.blockCache.clear();
    const r = await httpGet(gw, rawGeo('sp'));
    assert.strictEqual(r.status, 502);
    assert.strictEqual(r.headers['cache-control'], undefined);
    assert.strictEqual(r.headers['etag'], undefined);
  });

  // ================= cache de borda =================
  console.log('\n[4] cache de borda: replica quando a demanda vem de longe');
  // arquivo B só em dois celulares do Brasil; demanda vem de Madrid
  const spB = await startPhone(url, 'phone-sp-2', CITIES.sp);
  const rjB = await startPhone(url, 'phone-rj-2', CITIES.rj);
  registry.addRelayPeer('node-3', 'phone-sp-2');
  registry.addRelayPeer('node-4', 'phone-rj-2');
  await geo.refreshNodeGeo();
  const B = 'file-B';
  const originalB = publishReplicated(registry, content, reedSolomon, hashShard, B, [
    { logical: 'node-3', phone: spB }, { logical: 'node-4', phone: rjB },
  ]);

  await check('2 acessos de Madrid: ainda abaixo do mínimo (3), nada replicado', async () => {
    await p2p(gw, B, 'mad'); await p2p(gw, B, 'mad');
    await sleep(100);
    assert.strictEqual(registry.getEdgeReplicas(B).length, 0);
  });
  await check('acesso de São Paulo NÃO conta pra Madrid e não replica (já tem celular perto)', async () => {
    for (let i = 0; i < 5; i++) await p2p(gw, B, 'sp');
    await sleep(100);
    assert.strictEqual(registry.getEdgeReplicas(B).length, 0);
  });
  await check('3º acesso de Madrid dispara a réplica no celular de Madrid (Paris recusa put e não é o mais perto)', async () => {
    await p2p(gw, B, 'mad');
    assert.ok(await until(() => registry.getEdgeReplicas(B).length === 1), 'réplica não foi criada');
    const rep = registry.getEdgeReplicas(B)[0];
    assert.strictEqual(rep.relayNodeId, 'phone-mad-1');
    assert.strictEqual(rep.region, 'Madrid, ES');
    // todos os blocos gravados, com bytes idênticos ao holder
    assert.strictEqual(phones.mad.store.size, 2);
    // a réplica copia o shard do holder mais perto DO ALVO (aqui o shardIndex 1, que está no Rio)
    for (const [k, v] of phones.mad.store) {
      const orig = spB.store.get(k) || rjB.store.get(k);
      assert.ok(orig && v.equals(orig), 'bloco ' + k + ' diferente do original');
    }
  });
  await check('próximo /p2p de Madrid já lista a réplica de borda em 1º, edge:true, perto', async () => {
    const { json } = await p2p(gw, B, 'mad');
    assert.strictEqual(json.candidates[0].relayNodeId, 'phone-mad-1');
    assert.strictEqual(json.candidates[0].edge, true);
    assert.ok(json.candidates[0].distanceKm < 50);
    assert.ok(json.distanceKm < 50);
    assert.strictEqual(json.candidates.length, 3);
  });
  await check('/raw de Madrid: X-Cache HIT-EDGE servido pela réplica; bytes corretos', async () => {
    content.blockCache.clear();
    const r = await httpGet(gw, `/raw/${B}?geo=${CITIES.mad.lat},${CITIES.mad.lon}`);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.equals(originalB));
    assert.strictEqual(r.headers['x-cache'], 'HIT-EDGE');
    assert.strictEqual(r.headers['x-vagalun-node'], geo.alias('phone-mad-1'));
  });
  await check('/raw de São Paulo continua indo pro celular de origem (MISS), não pra borda', async () => {
    content.blockCache.clear();
    const r = await httpGet(gw, `/raw/${B}?geo=${CITIES.sp.lat},${CITIES.sp.lon}`);
    assert.strictEqual(r.headers['x-cache'], 'MISS');
    assert.strictEqual(r.headers['x-vagalun-node'], geo.alias('phone-sp-2'));
  });
  await check('shard corrompido na réplica de borda é descartado e cai pro origem', async () => {
    for (const [k, v] of phones.mad.store) { const bad = Buffer.from(v); bad[0] ^= 0xff; phones.mad.store.set(k, bad); }
    content.blockCache.clear();
    const r = await httpGet(gw, `/raw/${B}?geo=${CITIES.mad.lat},${CITIES.mad.lon}`);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.equals(originalB));
    assert.strictEqual(r.headers['x-cache'], 'MISS'); // veio de origem, não da borda corrompida
  });
  await check('celular alvo que recusa o put: nada é registrado e o parcial é desfeito', async () => {
    // arquivo C só no Brasil; único celular "perto" da Paris é o que recusa put
    const spC = await startPhone(url, 'phone-sp-3', CITIES.sp);
    registry.addRelayPeer('node-5', 'phone-sp-3');
    await geo.refreshNodeGeo();
    publishReplicated(registry, content, reedSolomon, hashShard, 'file-C', [{ logical: 'node-5', phone: spC }, { logical: 'node-3', phone: spB }]);
    // Madrid também é elegível; para isolar o caso, tira Madrid do jogo desta vez
    phones.mad.close();
    await until(async () => { await geo.refreshNodeGeo(); return geo.isOnline('phone-mad-1') === false; });
    for (let i = 0; i < 3; i++) await p2p(gw, 'file-C', 'par');
    await sleep(250);
    assert.strictEqual(registry.getEdgeReplicas('file-C').length, 0);
    assert.ok(phones.par.stats.puts >= 1, 'deveria ter tentado o celular de Paris');
    assert.strictEqual(phones.par.store.size, 0);
  });

  // ================= expiração =================
  console.log('\n[5] expiração');
  await check('réplica sem acesso por mais que o TTL é apagada do celular e do registry', async () => {
    const m2 = await startPhone(url, 'phone-mad-2', CITIES.mad);
    await geo.refreshNodeGeo();
    // recria uma réplica de B em Madrid-2 (Madrid-1 caiu)
    registry.removeEdgeReplica(B, registry.getEdgeReplicas(B)[0]?.nodeId);
    await sleep(200); // passa o cooldown de 150ms
    for (let i = 0; i < 3; i++) await p2p(gw, B, 'mad');
    assert.ok(await until(() => registry.getEdgeReplicas(B).length === 1), 'não recriou a réplica');
    assert.strictEqual(m2.store.size, 2);
    await sleep(700); // > TTL (600 ms)
    await edge.sweep();
    assert.strictEqual(registry.getEdgeReplicas(B).length, 0);
    assert.strictEqual(m2.store.size, 0);
    assert.strictEqual(m2.stats.deletes, 2);
  });

  // ================= métricas =================
  console.log('\n[6] métricas');
  await check('/metrics/player aceita beacon (CORS simples, text/plain) e /metrics/public reflete', async () => {
    const r = await httpPost(gw, '/metrics/player', { fileId: B, bytes: 6000, blocks: 2, edgeBlocks: 2, ms: 300, nodes: { 'phone-mad-2': 2 } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(JSON.parse(r.body).accepted, true);
    const m = JSON.parse((await httpGet(gw, '/metrics/public')).body.toString());
    assert.ok(m.ok);
    assert.strictEqual(m.traffic.bytesDirectP2P, 6000);
    assert.ok(m.traffic.p2pShare > 0 && m.traffic.p2pShare <= 1);
    assert.ok(m.cache.MISS >= 1 && m.cache['HIT-EDGE'] >= 1 && m.cache.HIT >= 1);
    assert.ok(m.edge.created >= 2 && m.edge.evicted >= 1 && m.edge.failed >= 1);
    assert.ok(m.regions.some((x) => /Madrid|manual/.test(x.region) || x.region.includes('(manual)')));
    assert.ok(m.nodes.length > 0);
    assert.ok(!JSON.stringify(m).includes('phone-'), 'métricas não podem vazar nodeId real de celular');
  });
  await check('beacon lixo/enorme é rejeitado sem derrubar nada', async () => {
    assert.strictEqual((await httpPost(gw, '/metrics/player', 'não é json')).status, 400);
    assert.strictEqual((await httpPost(gw, '/metrics/player', JSON.stringify({ x: 'a'.repeat(10000) }))).status, 413);
  });
  await check('/metrics/dashboard serve a página e OPTIONS responde CORS', async () => {
    const d = await httpGet(gw, '/metrics/dashboard');
    assert.strictEqual(d.status, 200);
    assert.match(d.body.toString(), /Vagalun CDN/);
    const o = await new Promise((res) => http.request({ host: '127.0.0.1', port: gw, path: '/metrics/player', method: 'OPTIONS' }, (r) => { r.resume(); res(r); }).end());
    assert.strictEqual(o.statusCode, 204);
  });

  // ================= desligar edge =================
  console.log('\n[7] GATEWAY_EDGE_ENABLED=0');
  await check('com borda desligada nenhum acesso replica', async () => {
    process.env.GATEWAY_EDGE_ENABLED = '0';
    const before = phones.par.stats.puts;
    for (let i = 0; i < 4; i++) await p2p(gw, 'file-C', 'lis');
    await sleep(150);
    assert.strictEqual(registry.getEdgeReplicas('file-C').length, 0);
    assert.strictEqual(phones.par.stats.puts, before);
    delete process.env.GATEWAY_EDGE_ENABLED;
  });

  console.log(failures ? `\n${failures} FALHA(S)` : '\nTODOS OS TESTES PASSARAM');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
