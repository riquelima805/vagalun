// Cache de borda por demanda: "o nó de borda é o celular".
//
// Ideia: um arquivo k=1 (vídeo/site replicado inteiro) só existe nos celulares onde foi
// publicado. Se vários visitantes de OUTRA região começam a pedir o mesmo arquivo e o
// celular mais perto deles está longe, o gateway copia o arquivo pra um celular online
// daquela região. A próxima visita de lá já acha uma réplica perto no topo dos
// `candidates` do /p2p (e como fonte preferida do /raw), com `edge: true`.
//
// Fluxo (disparado a cada GET /p2p/:fileId, em background — nunca atrasa a resposta):
//   1. conta o acesso por (arquivo, célula de ~2° ≈ 220 km) numa janela deslizante;
//   2. se passou do mínimo de acessos e o holder mais perto está longe (minDistanceKm),
//      procura um celular ONLINE, que ainda não tem o arquivo, perto do visitante;
//   3. lê cada bloco de um holder, confere o sha256 gravado no publish, grava no alvo
//      (op 'put' no relay, a mesma que o publish usa) e só então registra a réplica;
//   4. varredura periódica apaga réplica sem acesso há muito tempo (op 'delete').
//
// Só k=1 (cada shard é cópia completa) e só arquivo até EDGE_MAX_BYTES, com teto de
// réplicas por arquivo — não gasta banda/armazenamento de celular de ninguém à toa.
//
// Env (todas opcionais):
//   GATEWAY_EDGE_ENABLED=0           desliga tudo
//   GATEWAY_EDGE_MIN_HITS=3          acessos da região na janela pra disparar
//   GATEWAY_EDGE_WINDOW_MS=600000    janela de contagem (10 min)
//   GATEWAY_EDGE_MIN_DISTANCE_KM=300 só replica se o holder mais perto estiver mais longe que isso
//   GATEWAY_EDGE_MIN_GAIN_KM=200     o alvo tem que ficar pelo menos isso mais perto que o holder atual
//   GATEWAY_EDGE_MAX_TARGET_KM=800   o alvo tem que estar a no máximo isso do visitante
//   GATEWAY_EDGE_MAX_BYTES=52428800  maior arquivo que vale replicar (50 MB)
//   GATEWAY_EDGE_MAX_REPLICAS=3      réplicas de borda por arquivo
//   GATEWAY_EDGE_TTL_MS=7200000      apaga réplica sem acesso por esse tempo (2 h)
//   GATEWAY_EDGE_P2P=0               desliga a cópia celular->celular (volta a copiar pela VPS)
//   GATEWAY_EDGE_P2P_TIMEOUT_MS=120000  quanto esperar o celular alvo terminar de baixar
//   GATEWAY_EDGE_P2P_FALLBACK=0      se o p2p falhar, NÃO copia pela VPS (só desiste)

const registry = require('./registry');
const content = require('./content');
const geo = require('./geo');
const metrics = require('./metrics');
const { verifyShard } = require('./shardHash');

const num = (name, def) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : def;
};

function cfg() {
  return {
    enabled: process.env.GATEWAY_EDGE_ENABLED !== '0',
    minHits: num('GATEWAY_EDGE_MIN_HITS', 3),
    windowMs: num('GATEWAY_EDGE_WINDOW_MS', 10 * 60_000),
    minDistanceKm: num('GATEWAY_EDGE_MIN_DISTANCE_KM', 300),
    minGainKm: num('GATEWAY_EDGE_MIN_GAIN_KM', 200),
    maxTargetKm: num('GATEWAY_EDGE_MAX_TARGET_KM', 800),
    maxBytes: num('GATEWAY_EDGE_MAX_BYTES', 50 * 1024 * 1024),
    maxReplicas: num('GATEWAY_EDGE_MAX_REPLICAS', 3),
    ttlMs: num('GATEWAY_EDGE_TTL_MS', 2 * 60 * 60_000),
    cooldownMs: num('GATEWAY_EDGE_COOLDOWN_MS', 2 * 60_000),
    nodeCooldownMs: num('GATEWAY_EDGE_NODE_COOLDOWN_MS', 10 * 60_000),
    p2p: process.env.GATEWAY_EDGE_P2P !== '0',
    p2pTimeoutMs: num('GATEWAY_EDGE_P2P_TIMEOUT_MS', 120_000),
    p2pFallback: process.env.GATEWAY_EDGE_P2P_FALLBACK !== '0',
  };
}

const hits = new Map();          // `${fileId}|${cell}` -> number[] (timestamps)
const inflight = new Set();      // `${fileId}|${cell}` em replicação agora
const cooldown = new Map();      // `${fileId}|${cell}` -> até quando não tenta de novo
const nodeCooldown = new Map();  // relayNodeId -> até quando não escolhe de novo (falhou/recusou)
const MAX_HIT_KEYS = 5000;

function cellOf(v) {
  return `${Math.round(v.lat / 2)}:${Math.round(v.lon / 2)}`;
}

function noteHit(key, windowMs) {
  const now = Date.now();
  let arr = hits.get(key);
  if (!arr) {
    if (hits.size >= MAX_HIT_KEYS) {
      for (const [k, a] of hits) { // poda chaves frias antes de crescer
        if (!a.length || now - a[a.length - 1] > windowMs) hits.delete(k);
      }
      if (hits.size >= MAX_HIT_KEYS) return 0;
    }
    arr = [];
    hits.set(key, arr);
  }
  arr.push(now);
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  return arr.length;
}

/**
 * Escolhe o celular que vai receber a réplica: online, com geo, que não tem o arquivo,
 * perto do visitante e bem mais perto que o holder atual. null se não houver.
 */
function pickTarget(visitor, holderRelayIds, nearestHolderKm, c) {
  const now = Date.now();
  let best = null;
  for (const n of geo.onlineNodes()) {
    if (holderRelayIds.has(n.relayNodeId)) continue;
    if ((nodeCooldown.get(n.relayNodeId) || 0) > now) continue;
    const d = geo.haversineKm(visitor.lat, visitor.lon, n.lat, n.lon);
    if (d > c.maxTargetKm) continue;
    if (d > nearestHolderKm - c.minGainKm) continue;
    if (!best || d < best.distanceKm) best = { ...n, distanceKm: Math.round(d) };
  }
  return best;
}

/**
 * Chamado a cada GET /p2p/:fileId. `ranked` = saída de geo.rank() sobre os holders
 * ({ item: { shardIndex, nodeId, relayNodeId, peer, edge }, distanceKm, region, online }).
 * Nunca lança e nunca bloqueia: a replicação roda solta, em background.
 */
function onP2PAccess(file, visitor, ranked) {
  try {
    const c = cfg();
    if (!c.enabled || !file || file.k !== 1) return;
    if (!visitor || visitor.lat == null) return;
    if (!(file.originalLength > 0) || file.originalLength > c.maxBytes) return;

    // acesso conta mesmo que não dispare nada agora
    const key = `${file.fileId}|${cellOf(visitor)}`;
    const count = noteHit(key, c.windowMs);

    // réplica de borda que serviu esse visitante: marca como "usada" (adia a faxina)
    const top = ranked.find((r) => r.online !== false);
    if (top && top.item.edge) registry.touchEdgeReplica(file.fileId, top.item.nodeId);

    if (count < c.minHits) return;
    if (inflight.has(key)) return;
    if ((cooldown.get(key) || 0) > Date.now()) return;

    const activeEdge = registry.getEdgeReplicas(file.fileId).filter((r) => geo.isOnline(r.relayNodeId) !== false);
    if (activeEdge.length >= c.maxReplicas) return;

    // holders vivos com distância conhecida; precisa de pelo menos um pra servir de fonte
    const alive = ranked.filter((r) => r.online !== false && r.distanceKm != null);
    if (!alive.length) return;
    const nearestHolderKm = alive[0].distanceKm;
    if (nearestHolderKm < c.minDistanceKm) return; // já tem celular perto o bastante

    const holderRelayIds = new Set(ranked.map((r) => r.item.relayNodeId));
    const target = pickTarget(visitor, holderRelayIds, nearestHolderKm, c);
    if (!target) {
      cooldown.set(key, Date.now() + c.cooldownMs); // ninguém online por lá; não fica reprocessando a cada visita
      return;
    }

    // fonte: o holder vivo mais perto DO ALVO (cópia mais rápida)
    let source = null, bestD = Infinity;
    for (const r of alive) {
      const info = geo.nodeInfo(r.item.relayNodeId);
      const d = info && info.lat != null ? geo.haversineKm(target.lat, target.lon, info.lat, info.lon) : Infinity;
      if (!source || d < bestD) { source = r.item; bestD = d; }
    }
    if (!source) return;

    inflight.add(key);
    replicate(file, source, target, c)
      .catch((e) => console.error(`[edge] falha replicando ${file.fileId.slice(0, 12)} -> ${geo.alias(target.relayNodeId)}:`, e.message))
      .finally(() => {
        inflight.delete(key);
        cooldown.set(key, Date.now() + c.cooldownMs);
      });
  } catch (e) {
    console.error('[edge] erro em onP2PAccess:', e.message);
  }
}

async function replicate(file, source, target, c) {
  const targetPeer = registry.ensureRelayPeer(target.relayNodeId);
  const stored = []; // shardKeys gravados no alvo pelo caminho da VPS (pra desfazer se falhar no meio)
  const t0 = Date.now();
  let via = null;

  // 1) peer a peer: o celular alvo baixa direto do celular de origem e confere o hash.
  if (c.p2p && source.relayNodeId) {
    try {
      const spec = file.blocks.map((block) => {
        const src = block.placements.find((p) => p.shardIndex === source.shardIndex);
        if (!src) throw new Error(`bloco ${block.blockIndex} sem placement do shard ${source.shardIndex}`);
        return {
          shardKey: content.shardKeyFor(file.fileId, block.blockIndex, source.shardIndex),
          shardSize: block.shardSize,
          shardHash: src.shardHash,
        };
      });
      const r = await content.replicateViaPeer(targetPeer, source.relayNodeId, spec, c.p2pTimeoutMs);
      if (r.ok) {
        via = 'p2p';
        metrics.edgeEvent('viaP2P');
      } else {
        metrics.edgeEvent('p2pFallback');
        console.warn(`[edge] p2p não rolou (${r.code}: ${r.error}) para ${geo.alias(target.relayNodeId)}${c.p2pFallback ? ' — copiando pela VPS' : ' — desistindo'}`);
      }
    } catch (e) {
      metrics.edgeEvent('p2pFallback');
      console.warn(`[edge] p2p falhou (${e.message}) para ${geo.alias(target.relayNodeId)}${c.p2pFallback ? ' — copiando pela VPS' : ' — desistindo'}`);
    }
    if (!via && !c.p2pFallback) {
      nodeCooldown.set(target.relayNodeId, Date.now() + c.nodeCooldownMs);
      metrics.edgeEvent('failed');
      throw new Error('cópia peer a peer falhou e o fallback pela VPS está desligado');
    }
  }

  // 2) último caso: lê do holder e grava no alvo pela VPS (o caminho antigo).
  if (!via) {
    try {
      for (const block of file.blocks) {
        const src = block.placements.find((p) => p.shardIndex === source.shardIndex);
        if (!src) throw new Error(`bloco ${block.blockIndex} sem placement do shard ${source.shardIndex}`);
        const key = content.shardKeyFor(file.fileId, block.blockIndex, source.shardIndex);

        const data = await content.getShardRangeFromPeer(source.peer, key, 0, block.shardSize);
        if (!data) throw new Error(`holder não devolveu o bloco ${block.blockIndex}`);
        if (!verifyShard(data, src.shardHash)) throw new Error(`bloco ${block.blockIndex} do holder não bate com o hash do publish`);

        const ok = await content.putShardToPeer(targetPeer, key, data);
        if (!ok) throw new Error(`celular de borda recusou o bloco ${block.blockIndex} (sem espaço/permissão?)`);
        stored.push(key);
      }
    } catch (e) {
      nodeCooldown.set(target.relayNodeId, Date.now() + c.nodeCooldownMs);
      metrics.edgeEvent('failed');
      for (const key of stored) { // desfaz o que já gravou; melhor esforço
        content.deleteShardFromPeer(targetPeer, key).catch(() => {});
      }
      throw e;
    }
    via = 'gateway';
    metrics.edgeEvent('viaGateway');
  }

  registry.addEdgeReplica(file.fileId, {
    nodeId: targetPeer.nodeId,
    relayNodeId: target.relayNodeId,
    shardIndex: source.shardIndex,
    createdAt: Date.now(),
    lastHitAt: Date.now(),
    region: target.region,
    bytes: file.originalLength,
    via,
  });
  metrics.edgeEvent('created');
  console.log(
    `[edge] réplica criada: ${file.fileId.slice(0, 12)} -> ${geo.alias(target.relayNodeId)} (${target.region || '?'}, via ${via}, ` +
    `${target.distanceKm} km do visitante) em ${Date.now() - t0} ms`
  );
}

/** Apaga réplicas de borda sem acesso por ttlMs. */
async function sweep() {
  const c = cfg();
  const now = Date.now();
  for (const fileId of registry.listFiles()) {
    const file = registry.getFile(fileId);
    if (!file) continue;
    for (const rep of registry.getEdgeReplicas(fileId).slice()) {
      if (now - rep.lastHitAt < c.ttlMs) continue;
      const peer = registry.getPeer(rep.nodeId);
      if (peer) {
        for (const block of file.blocks) {
          const key = content.shardKeyFor(fileId, block.blockIndex, rep.shardIndex);
          try { await content.deleteShardFromPeer(peer, key); } catch { /* celular offline: sobra órfão, sem prejuízo */ }
        }
      }
      registry.removeEdgeReplica(fileId, rep.nodeId);
      metrics.edgeEvent('evicted');
      console.log(`[edge] réplica removida por inatividade: ${fileId.slice(0, 12)} @ ${geo.alias(rep.relayNodeId || rep.nodeId)}`);
    }
  }
}

let sweeper = null;
function startSweeper(everyMs = 5 * 60_000) {
  if (sweeper) return;
  sweeper = setInterval(() => sweep().catch((e) => console.error('[edge] sweep:', e.message)), everyMs);
  sweeper.unref();
}

module.exports = { onP2PAccess, sweep, startSweeper, cellOf, _state: { hits, inflight, cooldown, nodeCooldown } };
