const registry = require('./registry');
const { fetchShardsMultiSource } = require('./multiSource');
const shardTransport = require('./shardTransport');
const reedSolomon = require('./reedSolomon');
const { decryptBlock } = require('./crypto');
const { LRUCache } = require('./cache');
const { connectRelay, putShardViaRelay } = require('./relayTransport');
const { connectFederatedRelay } = require('./federatedRelay');
const { verifyShard } = require('./shardHash');
const geo = require('./geo');

const blockCache = new LRUCache(parseInt(process.env.GATEWAY_CACHE_BLOCKS || '256', 10));

// Só os k celulares mais perto recebem pedido de cara. Se o mais perto demorar mais que
// RESERVE_MS, entra mais um (reserva); se ainda não juntou k em HEDGE_MS, entra o resto.
const RESERVE_MS = parseInt(process.env.GATEWAY_RESERVE_MS || '400', 10);
const HEDGE_MS = parseInt(process.env.GATEWAY_HEDGE_MS || '1500', 10);

// Contexto de UMA requisição: onde está o visitante e o que aconteceu em cada bloco.
// O gateway usa pra montar X-Cache / X-Vagalun-Node / Server-Timing e as métricas.
function newCtx(visitor) {
  return { geo: visitor || null, startedAt: Date.now(), blocks: [], bytesByNode: {} };
}
// blocks[i] = { cache: 'HIT'|'MISS', nodeId, alias, edge, distanceKm, region, ms }
function summarizeCtx(ctx) {
  const b = ctx && ctx.blocks[0];
  if (!b) return { cache: 'MISS', node: null };
  if (b.cache === 'HIT') return { cache: 'HIT', node: null };
  return { cache: b.edge ? 'HIT-EDGE' : 'MISS', node: b };
}

// Conexão única e persistente com o signaling, usada só quando algum peer é
// do tipo 'relay' (celular atrás de NAT/rede móvel). Conecta sob demanda na
// primeira leitura que precisar dela, e reutiliza depois.
const GATEWAY_SIGNALING_URL = process.env.GATEWAY_SIGNALING_URL || 'ws://localhost:8787';
const GATEWAY_RELAY_NODE_ID = process.env.GATEWAY_RELAY_NODE_ID || 'gateway-1';
let relayClientPromise = null;
// Federado: GATEWAY_SIGNALING_URLS="wss://a,wss://b,wss://c" => vários signalers ao mesmo tempo, com
// failover (ver federatedRelay.js). Sem a env, comportamento antigo (1 URL, GATEWAY_SIGNALING_URL).
const GATEWAY_SIGNALING_URLS = (process.env.GATEWAY_SIGNALING_URLS || '').split(',').map((x) => x.trim()).filter(Boolean);
let federatedClient = null;
function getRelayClient() {
  if (GATEWAY_SIGNALING_URLS.length) {
    if (!federatedClient) {
      federatedClient = connectFederatedRelay({ urls: GATEWAY_SIGNALING_URLS, selfNodeId: GATEWAY_RELAY_NODE_ID });
    }
    return Promise.resolve(federatedClient); // nunca fica "preso" num client morto: ele mesmo reconecta/promove
  }
  if (!GATEWAY_SIGNALING_URL) {
    throw new Error('peer relay encontrado, mas GATEWAY_SIGNALING_URL não está configurado no gateway');
  }
  if (!relayClientPromise) {
    relayClientPromise = connectRelay(GATEWAY_SIGNALING_URL, GATEWAY_RELAY_NODE_ID, () => {
      // a conexão com o signaling caiu (ou nunca chegou a abrir) — descarta o
      // client em cache. Sem isso, depois da primeira queda o gateway fica
      // pra sempre "conectado" nessa promise morta e todo pedido de shard via
      // relay falha com "0 de N shards" mesmo com o nó/celular online, porque
      // ninguém tentava reconectar de novo.
      if (relayClientPromise) relayClientPromise = null;
    });
    // Se a PRIMEIRA tentativa de conexão falhar (reject, ex: signaling não
    // respondeu a tempo), o onDisconnect acima já roda (ver ws.on('error')),
    // mas o catch aqui é a rede de segurança: garante que ninguém fique preso
    // numa promise rejeitada em cache, mesmo que o motivo da rejeição não
    // passe por ws.on('close')/ws.on('error').
    relayClientPromise.catch(() => { relayClientPromise = null; });
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

async function putShardToPeer(peer, shardKey, data) {
  if (peer.transport === 'relay') {
    const client = await getRelayClient();
    return putShardViaRelay(client, peer.relayNodeId, shardKey, data);
  }
  return shardTransport.putShard(peer.host, peer.port, shardKey, data);
}


// Pede ao celular ALVO que busque os blocos direto de outro celular (peer a peer) e confira
// o sha256 de cada um — os bytes não passam pela VPS. Op `replicate_from` do app Android
// (EdgeReplicator.kt). Resposta: { ok, via: 'webrtc'|'relay' } ou { ok:false, code, error }.
// App antigo, sem a op, responde { ok:false, error:'op desconhecida' } sem `code` -> o chamador
// trata como "não suportado" e cai no caminho pelo gateway.
async function replicateViaPeer(targetPeer, sourceRelayNodeId, blocksSpec, timeoutMs = 120000) {
  if (!targetPeer || targetPeer.transport !== 'relay') return { ok: false, code: 'unsupported', error: 'alvo sem relay' };
  if (!sourceRelayNodeId) return { ok: false, code: 'unsupported', error: 'origem sem relayNodeId' };
  const client = await getRelayClient();
  const resp = await client.request(
    targetPeer.relayNodeId,
    { op: 'replicate_from', source: sourceRelayNodeId, blocks: blocksSpec },
    null,
    timeoutMs
  );
  const h = resp.header || {};
  if (h.ok) return { ok: true, via: h.via || 'p2p', blocks: h.blocks };
  return { ok: false, code: h.code || 'unsupported', error: h.error || 'sem detalhe' };
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

async function fetchBlockPlaintext(file, block, ctx = null) {
  const cacheKey = `${file.fileId}:${block.blockIndex}`;
  const cached = blockCache.get(cacheKey);
  if (cached) {
    if (ctx) ctx.blocks.push({ cache: 'HIT', ms: 0 });
    return cached;
  }

  const placements = block.placements
    .map((p) => {
      const peer = registry.getPeer(p.nodeId);
      if (!peer) return null;
      return { shardIndex: p.shardIndex, nodeId: p.nodeId, shardHash: p.shardHash, peer, edge: false };
    })
    .filter(Boolean);

  // Réplicas de borda (edge.js) entram como mais uma fonte, só pra k=1 (cada shard é
  // cópia completa do bloco). O hash esperado é o do placement de mesmo shardIndex.
  if (file.k === 1) {
    for (const rep of registry.getEdgeReplicas(file.fileId)) {
      const peer = registry.getPeer(rep.nodeId);
      const src = block.placements.find((p) => p.shardIndex === rep.shardIndex);
      if (!peer || !src) continue;
      placements.push({ shardIndex: rep.shardIndex, nodeId: rep.nodeId, shardHash: src.shardHash, peer, edge: true });
    }
  }

  if (placements.length < file.k) {
    throw new Error(
      `bloco ${block.blockIndex}: só ${placements.length} peer(s) conhecido(s) de ${block.placements.length} placements, precisa de ${file.k}`
    );
  }

  // Do mais perto ao mais longe do visitante; offline conhecido vai pro fim (só entra
  // como reserva). Sem geo do visitante, mantém a ordem original.
  const relayIdOf = (p) => (p.peer.transport === 'relay' ? p.peer.relayNodeId : null);
  const ordered = geo.rank(placements, ctx && ctx.geo, relayIdOf).map((r) => {
    r.item.distanceKm = r.distanceKm;
    r.item.region = r.region;
    return r.item;
  });

  let winner = null; // 1º shard bom a chegar = quem "serviu" esse bloco
  const t0 = Date.now();

  const shards = await fetchShardsMultiSource(ordered, file.k, async (p) => {
    let data;
    try {
      data = await getShardRangeFromPeer(
        p.peer, shardKeyFor(file.fileId, block.blockIndex, p.shardIndex), 0, block.shardSize
      );
    } catch (e) {
      return null;
    }
    if (!data) return null;
    // O shard chegou, mas bate com o hash gravado no publish? Se não, trata como "peer
    // não respondeu" — o multiSource pula pro próximo. Vale logar quem foi: é sinal pra
    // um futuro self-healing considerar esse peer suspeito.
    if (!verifyShard(data, p.shardHash)) {
      console.error(
        `[content] shard corrompido: fileId=${file.fileId} bloco=${block.blockIndex} shardIndex=${p.shardIndex} nodeId=${p.nodeId} (hash não bate)`
      );
      return null;
    }
    if (ctx) {
      const acc = ctx.bytesByNode[p.nodeId] || (ctx.bytesByNode[p.nodeId] = {
        bytes: 0, alias: geo.alias(p.peer.relayNodeId || p.nodeId), edge: p.edge, region: p.region || null,
      });
      acc.bytes += data.length; // banda REAL puxada desse celular (inclui reserva que perdeu a corrida)
    }
    if (!winner) winner = { p, ms: Date.now() - t0 };
    return data;
  }, { initial: file.k, reserveMs: RESERVE_MS, hedgeMs: HEDGE_MS });

  if (ctx && winner) {
    const w = winner.p;
    ctx.blocks.push({
      cache: 'MISS',
      nodeId: w.nodeId,
      alias: geo.alias(w.peer.relayNodeId || w.nodeId),
      edge: !!w.edge,
      distanceKm: w.distanceKm == null ? null : w.distanceKm,
      region: w.region || null,
      ms: winner.ms,
    });
    if (w.edge) registry.touchEdgeReplica(file.fileId, w.nodeId);
  }

  const ciphertext = reedSolomon.decode(shards, block.plainLength, block.shardSize, file.k, file.m);

  if (!file.fileKeyB64) {
    throw new Error('arquivo não publicado para acesso via gateway (sem chave associada)');
  }
  const plaintext = decryptBlock(ciphertext, block.iv, block.authTag, Buffer.from(file.fileKeyB64, 'base64'));

  blockCache.set(cacheKey, plaintext);
  return plaintext;
}


async function* rangeChunks(file, start, end, ctx = null) {
  for (const block of coveringBlocks(file, start, end)) {
    const plaintext = await fetchBlockPlaintext(file, block, ctx);
    const blockStart = block.blockIndex * file.blockSize;
    const from = Math.max(start, blockStart) - blockStart;
    const to = Math.min(end, blockStart + block.plainLength - 1) - blockStart;
    yield plaintext.subarray(from, to + 1);
  }
}

async function getRangeBuffer(file, start, end, ctx = null) {
  const parts = [];
  for await (const chunk of rangeChunks(file, start, end, ctx)) parts.push(chunk);
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
    // réplicas de borda também somem junto
    for (const rep of registry.getEdgeReplicas(file.fileId)) {
      const peer = registry.getPeer(rep.nodeId);
      if (!peer) continue;
      const shardKey = shardKeyFor(file.fileId, block.blockIndex, rep.shardIndex);
      try {
        if (await deleteShardFromPeer(peer, shardKey)) results.deleted++;
      } catch (e) {
        results.failed.push({ shardKey, nodeId: rep.nodeId, error: e.message });
      }
    }
  }
  return results;
}

module.exports = {
  coveringBlocks, fetchBlockPlaintext, rangeChunks, getRangeBuffer, blockCache, shardKeyFor, deleteFileFromNodes,
  newCtx, summarizeCtx, getShardRangeFromPeer, putShardToPeer, deleteShardFromPeer, replicateViaPeer,
};
