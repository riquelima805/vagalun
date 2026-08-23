const registry = require('./registry');
const { fetchShardsMultiSource } = require('./multiSource');
const shardTransport = require('./shardTransport');
const reedSolomon = require('./reedSolomon');
const { decryptBlock } = require('./crypto');
const { LRUCache } = require('./cache');
const { connectRelay } = require('./relayTransport');

const blockCache = new LRUCache(parseInt(process.env.GATEWAY_CACHE_BLOCKS || '256', 10));

// Conexão única e persistente com o signaling, usada só quando algum peer é
// do tipo 'relay' (celular atrás de NAT/rede móvel). Conecta sob demanda na
// primeira leitura que precisar dela, e reutiliza depois.
const GATEWAY_SIGNALING_URL = process.env.GATEWAY_SIGNALING_URL || 'ws://localhost:8787';
const GATEWAY_RELAY_NODE_ID = process.env.GATEWAY_RELAY_NODE_ID || 'gateway-1';
let relayClientPromise = null;
function getRelayClient() {
  if (!GATEWAY_SIGNALING_URL) {
    throw new Error('peer relay encontrado, mas GATEWAY_SIGNALING_URL não está configurado no gateway');
  }
  if (!relayClientPromise) {
    relayClientPromise = connectRelay(GATEWAY_SIGNALING_URL, GATEWAY_RELAY_NODE_ID);
  }
  return relayClientPromise;
}

async function getShardRangeFromPeer(peer, shardKey, offset, length) {
  if (peer.transport === 'relay') {
    const client = await getRelayClient();
    const resp = await client.request(peer.relayNodeId, { op: 'get_range', shardKey, offset, length });
    if (!resp.header || !resp.header.ok) return null;
    return resp.payload;
  }
  // padrão: TCP direto (LAN/dev)
  return shardTransport.getShardRange(peer.host, peer.port, shardKey, offset, length);
}

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
      return { shardIndex: p.shardIndex, nodeId: p.nodeId, peer };
    })
    .filter(Boolean);

  if (placements.length < file.k) {
    throw new Error(
      `bloco ${block.blockIndex}: só ${placements.length} peer(s) conhecido(s) de ${block.placements.length} placements, precisa de ${file.k}`
    );
  }

  const shards = await fetchShardsMultiSource(placements, file.k, async (p) => {
    try {
      return await getShardRangeFromPeer(
        p.peer, shardKeyFor(file.fileId, block.blockIndex, p.shardIndex), 0, block.shardSize
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

async function deleteShardFromPeer(peer, shardKey) {
  if (peer.transport === 'relay') {
    const client = await getRelayClient();
    const resp = await client.request(peer.relayNodeId, { op: 'delete', shardKey });
    return !!(resp.header && resp.header.ok);
  }
  return shardTransport.deleteShard(peer.host, peer.port, shardKey);
}

// Apaga TODOS os shards de um arquivo (todos os blocos, todos os placements)
// nos nós que o hospedam. Best-effort: node offline/erro não trava o resto —
// só entra na lista de falhas, pra quem chamou decidir se tenta de novo depois.
// Não mexe no registry (isso é responsabilidade de quem chama).
async function deleteFileFromNodes(file) {
  const results = { deleted: 0, failed: [] };
  for (const block of file.blocks) {
    for (const p of block.placements) {
      const peer = registry.getPeer(p.nodeId);
      const shardKey = shardKeyFor(file.fileId, block.blockIndex, p.shardIndex);
      if (!peer) {
        results.failed.push({ shardKey, nodeId: p.nodeId, error: 'peer desconhecido (offline/nunca registrado)' });
        continue;
      }
      try {
        const ok = await deleteShardFromPeer(peer, shardKey);
        if (ok) results.deleted++;
        else results.failed.push({ shardKey, nodeId: p.nodeId, error: 'nó respondeu ok:false' });
      } catch (e) {
        results.failed.push({ shardKey, nodeId: p.nodeId, error: e.message });
      }
    }
  }
  return results;
}

module.exports = { coveringBlocks, fetchBlockPlaintext, rangeChunks, getRangeBuffer, blockCache, shardKeyFor, deleteFileFromNodes };
