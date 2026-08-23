// Self-test sem JVM: simula um "upload" (RS encode + AES-GCM, do jeito que o app faz),
// sobe shard-servers TCP falsos que falam o protocolo real (ShardProtocol.kt), registra
// tudo no gateway e confere que GET /raw/:fileId com Range devolve exatamente os bytes
// esperados — inclusive range cruzando fronteira de bloco.
const assert = require('assert');
const crypto = require('crypto');
const net = require('net');
const http = require('http');

const reedSolomon = require('../reedSolomon');
const { writeJson, writeFrame, FrameReader } = require('../shardTransport');
const registry = require('../registry');
const content = require('../content');
const { parseRange } = require('../range');
const base58 = require('../base58');
const cryptoMod = require('../crypto');
const { server } = require('../gateway');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  - ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL - ${name}`);
    console.log(`         ${e.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok  - ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL - ${name}`);
    console.log(e.stack);
  }
}

// ---------- 1) Reed-Solomon round trip (GF256 + matriz) ----------
console.log('\n[1] Reed-Solomon encode/decode');
{
  const original = crypto.randomBytes(50_000);
  const k = 6, m = 4;
  const encoded = reedSolomon.encode(original, k, m);

  check('encode produz n=k+m shards do tamanho certo', () => {
    assert.strictEqual(encoded.shards.length, k + m);
    for (const s of encoded.shards) assert.strictEqual(s.length, encoded.shardSize);
  });

  // pega k shards aleatórios (mistura shards de dados e de paridade) e decodifica
  const idxs = [...Array(k + m).keys()].sort(() => Math.random() - 0.5).slice(0, k);
  const available = idxs.map((i) => ({ index: i, data: encoded.shards[i] }));
  const decoded = reedSolomon.decode(available, original.length, encoded.shardSize, k, m);

  check('decode com k shards aleatórios (dados+paridade) reconstrói o original', () => {
    assert.ok(Buffer.compare(decoded, original) === 0, 'buffers diferentes');
  });

  check('decode falha com shards insuficientes', () => {
    assert.throws(() => reedSolomon.decode(available.slice(0, k - 1), original.length, encoded.shardSize, k, m));
  });
}

// ---------- 2) AES-256-GCM (mesmo esquema do KeyManager.kt) ----------
console.log('\n[2] AES-256-GCM');
{
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const plaintext = Buffer.from('conteúdo de teste do bloco, com acentuação e tal 🚀');

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const decrypted = cryptoMod.decryptBlock(ciphertext, iv.toString('base64'), authTag.toString('base64'), key);
  check('decryptBlock recupera o plaintext exato', () => {
    assert.ok(Buffer.compare(decrypted, plaintext) === 0);
  });
  check('ciphertext tem o mesmo tamanho do plaintext (GCM não muda tamanho)', () => {
    assert.strictEqual(ciphertext.length, plaintext.length);
  });
}

// ---------- 3) base58 + Ed25519 (manifesto de site) ----------
console.log('\n[3] base58 + assinatura Ed25519 do manifesto de site');
{
  const roundtrip = crypto.randomBytes(32);
  check('base58 encode/decode é round-trip', () => {
    assert.ok(Buffer.compare(base58.decode(base58.encode(roundtrip)), roundtrip) === 0);
  });

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const pubkeyB58 = base58.encode(rawPub);

  const domain = 'exemplo.vagalun';
  const routes = [
    { path: '/', fileId: 'file-index', contentType: 'text/html; charset=utf-8' },
    { path: '/app.js', fileId: 'file-js', contentType: 'application/javascript; charset=utf-8' },
  ];
  const message = registry.canonicalManifest(domain, routes);
  const signature = crypto.sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64');

  check('verifyEd25519 aceita assinatura válida', () => {
    assert.ok(cryptoMod.verifyEd25519(message, signature, pubkeyB58));
  });
  check('verifyEd25519 rejeita mensagem adulterada', () => {
    assert.ok(!cryptoMod.verifyEd25519(message + 'x', signature, pubkeyB58));
  });

  registry.registerSite(domain, pubkeyB58, routes, signature);
  check('registerSite + resolveSite resolve a rota certa', () => {
    const r = registry.resolveSite(domain, '/app.js');
    assert.strictEqual(r.fileId, 'file-js');
  });

  const { publicKey: otherPub } = crypto.generateKeyPairSync('ed25519');
  const otherRawPub = otherPub.export({ type: 'spki', format: 'der' }).subarray(-32);
  const otherPubkeyB58 = base58.encode(otherRawPub);
  check('registerSite rejeita reassinatura do mesmo domínio com outra chave', () => {
    assert.throws(() => registry.registerSite(domain, otherPubkeyB58, routes, signature));
  });
}

// ---------- 4) range.js ----------
console.log('\n[4] parseRange');
{
  check('bytes=0-99', () => assert.deepStrictEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 }));
  check('bytes=500- (aberto no fim)', () => assert.deepStrictEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 }));
  check('bytes=-200 (sufixo)', () => assert.deepStrictEqual(parseRange('bytes=-200', 1000), { start: 800, end: 999 }));
  check('range além do tamanho -> unsatisfiable', () => assert.strictEqual(parseRange('bytes=5000-', 1000), 'unsatisfiable'));
  check('sem header -> null', () => assert.strictEqual(parseRange(undefined, 1000), null));
  check('end é limitado ao tamanho real', () => assert.deepStrictEqual(parseRange('bytes=900-99999', 1000), { start: 900, end: 999 }));
}

// ---------- 5) Fim a fim: shard-servers TCP falsos + gateway HTTP real ----------
console.log('\n[5] Fim a fim (TCP shard servers + content.rangeChunks + HTTP /raw)');

function startFakeShardNode(shardsByKey) {
  return new Promise((resolve) => {
    const srv = net.createServer((socket) => {
      const reader = new FrameReader(socket);
      (async () => {
        const header = await reader.readJson();
        if (header.op === 'get_range' || header.op === 'get') {
          const data = shardsByKey.get(header.shardKey);
          if (!data) {
            writeJson(socket, { ok: false, error: 'shard não encontrado' });
          } else {
            const offset = header.offset || 0;
            const length = header.length ?? data.length;
            const slice = header.op === 'get_range' ? data.subarray(offset, offset + length) : data;
            writeJson(socket, { ok: true });
            writeFrame(socket, slice);
          }
        } else {
          writeJson(socket, { ok: false, error: 'op não suportada no fake node' });
        }
        socket.end();
      })().catch(() => socket.destroy());
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function e2e() {
  // "arquivo" com 2 blocos, k=3 m=2, pra forçar range cruzando bloco
  const blockSize = 4096;
  const originalBuf = crypto.randomBytes(Math.floor(blockSize * 1.6)); // 2 blocos, 2º parcial
  const k = 3, m = 2;
  const fileKey = crypto.randomBytes(32);
  const fileId = 'selftest-file-1';

  const blocks = [];
  const shardsByKey = new Map();
  const nodePorts = [];
  const nodes = [];

  // sobe n=k+m nós fake, cada um guardando shards de todos os blocos nesse "slot" de índice
  for (let i = 0; i < k + m; i++) {
    const srv = await startFakeShardNode(shardsByKey);
    nodes.push(srv);
    nodePorts.push(srv.address().port);
    registry.addPeer(`node-${i}`, '127.0.0.1', srv.address().port);
  }

  let offset = 0;
  let blockIndex = 0;
  while (offset < originalBuf.length) {
    const end = Math.min(offset + blockSize, originalBuf.length);
    const plainChunk = originalBuf.subarray(offset, end);

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', fileKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plainChunk), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const encoded = reedSolomon.encode(ciphertext, k, m);
    const placements = [];
    for (let s = 0; s < k + m; s++) {
      const shardKey = content.shardKeyFor(fileId, blockIndex, s);
      shardsByKey.set(shardKey, encoded.shards[s]);
      placements.push({ shardIndex: s, nodeId: `node-${s}` });
    }

    blocks.push({
      blockIndex,
      plainLength: plainChunk.length,
      shardSize: encoded.shardSize,
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      placements,
    });

    offset = end;
    blockIndex++;
  }

  registry.registerFile({
    fileId,
    fileName: 'selftest.bin',
    k, m, n: k + m,
    blockSize,
    originalLength: originalBuf.length,
    blocks,
    fileKeyB64: fileKey.toString('base64'),
  });

  // getRangeBuffer direto (sem HTTP) cobrindo os 2 blocos
  await checkAsync('rangeChunks reconstrói o arquivo inteiro exatamente', async () => {
    const file = registry.getFile(fileId);
    const full = await content.getRangeBuffer(file, 0, originalBuf.length - 1);
    assert.ok(Buffer.compare(full, originalBuf) === 0, 'arquivo reconstruído diferente do original');
  });

  await checkAsync('range cruzando fronteira de bloco bate byte a byte', async () => {
    const file = registry.getFile(fileId);
    const start = blockSize - 100;
    const end = blockSize + 300;
    const slice = await content.getRangeBuffer(file, start, end);
    assert.ok(Buffer.compare(slice, originalBuf.subarray(start, end + 1)) === 0);
  });

  await checkAsync('cache de bloco é usado na segunda leitura (mesmo bloco)', async () => {
    const file = registry.getFile(fileId);
    content.blockCache.clear();
    await content.fetchBlockPlaintext(file, file.blocks[0]);
    const sizeAfterFirst = content.blockCache.size();
    await content.fetchBlockPlaintext(file, file.blocks[0]);
    assert.strictEqual(content.blockCache.size(), sizeAfterFirst, 'cache deveria ter reutilizado, não crescido');
  });

  await checkAsync('multi-source: reconstrói bloco mesmo com m nós fora do ar (só k respondem)', async () => {
    const file = registry.getFile(fileId);
    const block = file.blocks[0];
    content.blockCache.clear();

    // derruba m peers desse bloco (mantém exatamente k vivos) trocando pra uma porta morta
    const toKill = block.placements.slice(0, m);
    const original = toKill.map((p) => registry.getPeer(p.nodeId));
    for (const p of toKill) registry.addPeer(p.nodeId, '127.0.0.1', 1); // porta 1: ninguém escutando

    try {
      const plaintext = await content.fetchBlockPlaintext(file, block);
      assert.ok(Buffer.compare(plaintext, originalBuf.subarray(0, block.plainLength)) === 0);
    } finally {
      for (const peer of original) registry.addPeer(peer.nodeId, peer.host, peer.port);
    }
  });

  // Sobe o gateway HTTP de verdade e bate via fetch, com Range
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const gwPort = server.address().port;

  await checkAsync('GET /raw/:fileId sem Range devolve tudo, 200', async () => {
    const resp = await fetch(`http://127.0.0.1:${gwPort}/raw/${fileId}`);
    assert.strictEqual(resp.status, 200);
    const body = Buffer.from(await resp.arrayBuffer());
    assert.ok(Buffer.compare(body, originalBuf) === 0);
  });

  await checkAsync('GET /raw/:fileId com Range devolve 206 + Content-Range certo', async () => {
    const start = 10, end = 200;
    const resp = await fetch(`http://127.0.0.1:${gwPort}/raw/${fileId}`, { headers: { Range: `bytes=${start}-${end}` } });
    assert.strictEqual(resp.status, 206);
    assert.strictEqual(resp.headers.get('content-range'), `bytes ${start}-${end}/${originalBuf.length}`);
    const body = Buffer.from(await resp.arrayBuffer());
    assert.ok(Buffer.compare(body, originalBuf.subarray(start, end + 1)) === 0);
  });

  await checkAsync('GET /raw/:fileId com Range cruzando bloco via HTTP bate exato', async () => {
    const start = blockSize - 50, end = blockSize + 50;
    const resp = await fetch(`http://127.0.0.1:${gwPort}/raw/${fileId}`, { headers: { Range: `bytes=${start}-${end}` } });
    assert.strictEqual(resp.status, 206);
    const body = Buffer.from(await resp.arrayBuffer());
    assert.ok(Buffer.compare(body, originalBuf.subarray(start, end + 1)) === 0);
  });

  await checkAsync('HEAD /raw/:fileId devolve Content-Length sem corpo', async () => {
    const resp = await fetch(`http://127.0.0.1:${gwPort}/raw/${fileId}`, { method: 'HEAD' });
    assert.strictEqual(resp.status, 200);
    assert.strictEqual(resp.headers.get('content-length'), String(originalBuf.length));
  });

  await checkAsync('Range inválido (além do arquivo) -> 416', async () => {
    const resp = await fetch(`http://127.0.0.1:${gwPort}/raw/${fileId}`, { headers: { Range: `bytes=999999-` } });
    assert.strictEqual(resp.status, 416);
  });

  await checkAsync('arquivo sem fileKeyB64 -> 403 (não publicado pro gateway)', async () => {
    registry.registerFile({ fileId: 'privado-1', fileName: 'x', k: 3, m: 2, n: 5, blockSize: 4096, originalLength: 10, blocks: [] });
    const resp = await fetch(`http://127.0.0.1:${gwPort}/raw/privado-1`);
    assert.strictEqual(resp.status, 403);
  });

  await checkAsync('site estático resolve via Host header', async () => {
    // publica um "site" reaproveitando o mesmo fileId, testando resolução por domínio
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
    const pubkeyB58 = base58.encode(rawPub);
    const domain = 'meusite.vagalun';
    const routes = [{ path: '/', fileId, contentType: 'application/octet-stream' }];
    const message = registry.canonicalManifest(domain, routes);
    const signature = crypto.sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64');
    registry.registerSite(domain, pubkeyB58, routes, signature);

    // fetch()/undici ignora Host custom (é header proibido no spec) — usa http.request cru,
    // que é o que qualquer client HTTP "de verdade" (curl, browser via DNS) manda de fato.
    const { status, body } = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: gwPort, path: '/', headers: { Host: domain } },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        }
      );
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(status, 200);
    assert.ok(Buffer.compare(body, originalBuf) === 0);
  });

  await checkAsync('/admin/status responde contadores', async () => {
    const resp = await fetch(`http://127.0.0.1:${gwPort}/admin/status`);
    const json = await resp.json();
    assert.ok(json.ok);
    assert.ok(json.peers >= k + m);
    assert.ok(json.files >= 1);
  });

  server.close();
  for (const n of nodes) n.close();
}

e2e()
  .catch((e) => { failures++; console.error('erro inesperado no e2e:', e); })
  .then(() => {
    console.log(`\n${failures === 0 ? 'TODOS OS TESTES PASSARAM' : `${failures} FALHA(S)`}`);
    process.exit(failures === 0 ? 0 : 1);
  });
