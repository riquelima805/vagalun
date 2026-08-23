// Pega um Buffer de arquivo, fatia em blocos, cifra cada bloco (AES-256-GCM),
// aplica Reed-Solomon (k shards de dados + m de paridade) e sobe os shards
// resultantes pros nós via shardTransport (mesmo protocolo TCP do ShardServer.kt).
//
// Espelha exatamente o que o selftest.js do gateway simula, só que falando
// com nós de verdade em vez de nós fake em memória.

const crypto = require('crypto');
const reedSolomon = require('./reedSolomon.cjs');
const shardTransport = require('./shardTransport.cjs');

const DEFAULT_BLOCK_SIZE = 256 * 1024; // 256KB por bloco antes de fatiar em shards

async function defaultPutShard(node, shardKey, data) {
  return shardTransport.putShard(node.host, node.port, shardKey, data);
}

// nodes: array de { nodeId, host, port } — os "slots" de shard 0..n-1.
// Com 1 celular só, repita o MESMO host:port (ou o mesmo nodeId, no modo
// relay) em vários slots (ver buildSingleNodeSlots abaixo) — cada shardKey
// já é único por índice, então não colide fisicamente no dispositivo.
//
// putShardFn: (node, shardKey, data) => Promise<boolean>. Por padrão usa TCP
// direto (LAN). Pra celular atrás de NAT/rede móvel, passe a versão que fala
// via relay/signaling (ver publishSite.js --relay-url).
async function encodeAndUpload(buffer, { fileId, k, m, nodes, blockSize = DEFAULT_BLOCK_SIZE, putShardFn = defaultPutShard }) {
  const n = k + m;
  if (nodes.length !== n) {
    throw new Error(`preciso de exatamente ${n} slots de nó (k=${k}+m=${m}), recebi ${nodes.length}`);
  }

  const fileKey = crypto.randomBytes(32);
  const blocks = [];

  let offset = 0;
  let blockIndex = 0;
  while (offset < buffer.length || (buffer.length === 0 && blockIndex === 0)) {
    const end = Math.min(offset + blockSize, buffer.length);
    const plainChunk = buffer.subarray(offset, end);

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', fileKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plainChunk), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const encoded = reedSolomon.encode(ciphertext, k, m);

    const placements = [];
    for (let s = 0; s < n; s++) {
      const shardKey = `${fileId}_b${blockIndex}_s${s}`;
      const node = nodes[s];
      const ok = await putShardFn(node, shardKey, encoded.shards[s]);
      if (!ok) {
        throw new Error(`falha ao enviar shard ${s} do bloco ${blockIndex} pro nó ${node.nodeId} (${node.host}:${node.port})`);
      }
      placements.push({ shardIndex: s, nodeId: node.nodeId });
    }

    blocks.push({
      blockIndex,
      plainLength: plainChunk.length,
      shardSize: encoded.shardSize,
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      placements,
    });

    if (buffer.length === 0) break;
    offset = end;
    blockIndex++;
  }

  return {
    fileId,
    fileName: undefined, // preenchido por quem chama
    k, m, n,
    blockSize,
    originalLength: buffer.length,
    blocks,
    fileKeyB64: fileKey.toString('base64'), // publicado de propósito: conteúdo público (site)
  };
}

// Gera fileId determinístico a partir do conteúdo (evita duplicar publish do mesmo arquivo).
function deriveFileId(buffer, salt = '') {
  return crypto.createHash('sha256').update(salt).update(buffer).digest('hex').slice(0, 32);
}

// Com um único celular como nó (modo TCP/LAN), registra o MESMO host:port sob
// n nodeIds distintos (node-0..node-(n-1)) — cada um vira um "slot" de shard
// válido pro registry do gateway.
function buildSingleNodeSlots(host, port, n, prefix = 'node') {
  return Array.from({ length: n }, (_, i) => ({ nodeId: `${prefix}-${i}`, host, port }));
}

// Modo relay: não existe host:port alcançável de fora, só o nodeId que o
// celular usou pra se registrar no signaling. Todos os n slots apontam pro
// mesmo nodeId real (mesmo celular) — o `id` de cada slot é só pra rotular
// o placement no manifesto, o `relayTo` é quem de fato recebe a mensagem.
function buildSingleRelayNodeSlots(phoneNodeId, n, prefix = 'node') {
  return Array.from({ length: n }, (_, i) => ({ nodeId: `${prefix}-${i}`, relayTo: phoneNodeId }));
}

// Com N celulares de verdade: cada shard vai pra um celular diferente
// (round-robin se tiver menos celulares que slots). É isso que dá redundância
// real — se um celular cair, os outros ainda respondem.
function buildMultiRelayNodeSlots(phoneNodeIds, n, prefix = 'node') {
  if (!phoneNodeIds.length) throw new Error('preciso de pelo menos 1 nodeId de celular');
  return Array.from({ length: n }, (_, i) => ({
    nodeId: `${prefix}-${i}`,
    relayTo: phoneNodeIds[i % phoneNodeIds.length],
  }));
}

module.exports = { encodeAndUpload, deriveFileId, buildSingleNodeSlots, buildSingleRelayNodeSlots, buildMultiRelayNodeSlots };
