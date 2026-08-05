// Coração do passo 3+4: dado um FileMeta (striping já feito no passo 1) e um range de
// bytes do arquivo lógico, descobre quais blocos cobrem o range, busca só esses blocos
// (multi-source: passo 4), decodifica (RS + AES-GCM) e entrega só a fatia pedida.
//
// Granularidade é por BLOCO, não por byte dentro do shard: pra servir um range a gente
// sempre reconstrói o(s) bloco(s) inteiros que tocam o range e depois corta em memória.
// Isso é exatamente o "Range request" descrito no passo 2 do roadmap ("calcula quais
// blocos cobrem esse intervalo → só busca esses blocos"). A op get_range do passo 2 é
// usada mesmo assim pra buscar o shard (em vez de handleGet), porque no nó ela evita
// carregar o arquivo inteiro em RAM (RandomAccessFile + seek).

const registry = require('./registry');
const { fetchShardsMultiSource } = require('./multiSource');
const shardTransport = require('./shardTransport');
const reedSolomon = require('./reedSolomon');
const { decryptBlock } = require('./crypto');
const { LRUCache } = require('./cache');

const blockCache = new LRUCache(parseInt(process.env.GATEWAY_CACHE_BLOCKS || '256', 10));

function shardKeyFor(fileId, blockIndex, shardIndex) {
  return `${fileId}_b${blockIndex}_s${shardIndex}`;
}

function coveringBlocks(file, start, end) {
  const out = [];
  for (const block of file.blocks) {
    const blockStart = block.blockIndex * file.blockSize;
    const blockEnd = blockStart + block.plainLength - 1;
    if (blockEnd < start || blockStart > end) continue;
    out.push(block);
  }
  return out.sort((a, b) => a.blockIndex - b.blockIndex);
}

async function fetchBlockPlaintext(file, block) {
  const cacheKey = `${file.fileId}:${block.blockIndex}`;
  const cached = blockCache.get(cacheKey);
  if (cached) return cached;

  const placements = block.placements
    .map((p) => {
      const peer = registry.getPeer(p.nodeId);
      if (!peer) return null;
      return { shardIndex: p.shardIndex, nodeId: p.nodeId, host: peer.host, port: peer.port };
    })
    .filter(Boolean);

  if (placements.length < file.k) {
    throw new Error(
      `bloco ${block.blockIndex}: só ${placements.length} peer(s) conhecido(s) de ${block.placements.length} placements, precisa de ${file.k}`
    );
  }

  const shards = await fetchShardsMultiSource(placements, file.k, async (p) => {
    try {
      return await shardTransport.getShardRange(
        p.host, p.port, shardKeyFor(file.fileId, block.blockIndex, p.shardIndex), 0, block.shardSize
      );
    } catch (e) {
      return null;
    }
  });

  const ciphertext = reedSolomon.decode(shards, block.plainLength, block.shardSize, file.k, file.m);

  if (!file.fileKeyB64) {
    throw new Error('arquivo não publicado para acesso via gateway (sem chave associada)');
  }
  const plaintext = decryptBlock(ciphertext, block.iv, block.authTag, Buffer.from(file.fileKeyB64, 'base64'));

  blockCache.set(cacheKey, plaintext);
  return plaintext;
}

// Gera os pedaços de bytes [start, end] (inclusive) do arquivo lógico, bloco a bloco —
// dá pra usar tanto pra montar um Buffer só (testes) quanto pra fazer streaming (HTTP).
async function* rangeChunks(file, start, end) {
  for (const block of coveringBlocks(file, start, end)) {
    const plaintext = await fetchBlockPlaintext(file, block);
    const blockStart = block.blockIndex * file.blockSize;
    const from = Math.max(start, blockStart) - blockStart;
    const to = Math.min(end, blockStart + block.plainLength - 1) - blockStart;
    yield plaintext.subarray(from, to + 1);
  }
}

async function getRangeBuffer(file, start, end) {
  const parts = [];
  for await (const chunk of rangeChunks(file, start, end)) parts.push(chunk);
  return Buffer.concat(parts);
}

module.exports = { coveringBlocks, fetchBlockPlaintext, rangeChunks, getRangeBuffer, blockCache, shardKeyFor };
