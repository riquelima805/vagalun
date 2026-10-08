// Métricas em memória do gateway (zeram num restart). Alimentam:
//   GET  /metrics/public   -> números pro painel/pitch (JSON, CORS aberto)
//   POST /metrics/player   -> beacon do player (quantos bytes vieram direto dos celulares)
//
// Nada aqui guarda IP nem nodeId real de celular: só região aproximada e apelido curto.

const geo = require('./geo');

const startedAt = Date.now();

const counters = {
  requests: { raw: 0, site: 0, p2pManifest: 0 },
  status: { ok: 0, notModified: 0, error: 0 },
  cache: { HIT: 0, 'HIT-EDGE': 0, MISS: 0 },
  bytesServedByGateway: 0,   // bytes que passaram pela VPS (/raw e sites)
  bytesPulledFromNodes: 0,   // bytes que a VPS puxou dos celulares pra servir isso
  p2pBytesReported: 0,       // bytes que o navegador pegou DIRETO dos celulares (beacon)
  p2pSessionsReported: 0,
  p2pEdgeBlocksReported: 0,
  p2pBlocksReported: 0,
  edge: { created: 0, failed: 0, evicted: 0, viaP2P: 0, viaGateway: 0, p2pFallback: 0 },
};

const byNode = new Map();    // alias -> { bytesViaGateway, bytesDirect, requests, region, edge }
const byRegion = new Map();  // região do VISITANTE -> { requests, ttfb: [amostras], hits, p2pSessions }

const SAMPLES = 200;
const MAX_KEYS = 500;

function pushSample(arr, v) {
  arr.push(v);
  if (arr.length > SAMPLES) arr.shift();
}

function percentile(arr, p) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
}

function regionRow(region) {
  const key = region || 'desconhecida';
  let row = byRegion.get(key);
  if (!row) {
    if (byRegion.size >= MAX_KEYS) return { requests: 0, ttfb: [], hits: 0, p2pSessions: 0 }; // descarta, não cresce sem limite
    row = { requests: 0, ttfb: [], hits: 0, p2pSessions: 0 };
    byRegion.set(key, row);
  }
  return row;
}

function nodeRow(alias, extra = {}) {
  let row = byNode.get(alias);
  if (!row) {
    if (byNode.size >= MAX_KEYS) return { bytesViaGateway: 0, bytesDirect: 0, requests: 0 };
    row = { bytesViaGateway: 0, bytesDirect: 0, requests: 0, region: null, edge: false };
    byNode.set(alias, row);
  }
  Object.assign(row, extra);
  return row;
}

/** Uma resposta de /raw ou de site foi servida (ou falhou). */
function recordServe({ kind, status, bytes, ttfbMs, visitor, ctx, cache }) {
  counters.requests[kind === 'site' ? 'site' : 'raw']++;
  if (status === 304) { counters.status.notModified++; return; }
  if (status >= 400) { counters.status.error++; return; }
  counters.status.ok++;
  counters.bytesServedByGateway += bytes || 0;
  if (cache) counters.cache[cache] = (counters.cache[cache] || 0) + 1;

  const row = regionRow(visitor && visitor.region);
  row.requests++;
  if (cache === 'HIT' || cache === 'HIT-EDGE') row.hits++;
  if (ttfbMs != null) pushSample(row.ttfb, ttfbMs);

  if (ctx) {
    for (const nb of Object.values(ctx.bytesByNode)) {
      counters.bytesPulledFromNodes += nb.bytes;
      const r = nodeRow(nb.alias, { region: nb.region, edge: nb.edge });
      r.bytesViaGateway += nb.bytes;
      r.requests++;
    }
  }
}

/** /p2p/:fileId respondeu um bilhete. */
function recordManifest(visitor) {
  counters.requests.p2pManifest++;
  regionRow(visitor && visitor.region); // garante a linha da região
}

/** Beacon do player: { fileId, bytes, blocks, edgeBlocks, ms, nodes: { relayNodeId: blocos } } */
function recordPlayerBeacon(b, visitor) {
  const num = (v, max) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(Number(v), max)) : 0);
  const bytes = num(b.bytes, 20 * 1024 * 1024 * 1024);
  const blocks = num(b.blocks, 1e6);
  const edgeBlocks = Math.min(num(b.edgeBlocks, 1e6), blocks);
  if (bytes === 0 && blocks === 0) return false;

  counters.p2pBytesReported += bytes;
  counters.p2pBlocksReported += blocks;
  counters.p2pEdgeBlocksReported += edgeBlocks;
  counters.p2pSessionsReported++;
  regionRow(visitor && visitor.region).p2pSessions++;

  if (b.nodes && typeof b.nodes === 'object') {
    const entries = Object.entries(b.nodes).slice(0, 20);
    const totalBlocks = entries.reduce((a, [, n]) => a + num(n, 1e6), 0) || 1;
    for (const [relayNodeId, n] of entries) {
      const share = num(n, 1e6) / totalBlocks;
      const r = nodeRow(geo.alias(String(relayNodeId).slice(0, 128)));
      r.bytesDirect += Math.round(bytes * share); // aproximação: bytes divididos pelos blocos de cada nó
    }
  }
  return true;
}

function edgeEvent(kind) {
  if (counters.edge[kind] != null) counters.edge[kind]++;
}

function snapshot(registry) {
  const gw = counters.bytesServedByGateway;
  const p2p = counters.p2pBytesReported;
  const totalDelivered = gw + p2p;
  const cacheTotal = counters.cache.HIT + counters.cache['HIT-EDGE'] + counters.cache.MISS;

  const regions = [...byRegion.entries()]
    .map(([region, r]) => ({
      region,
      requests: r.requests,
      p2pSessions: r.p2pSessions,
      cacheHitRate: r.requests ? Math.round((r.hits / r.requests) * 1000) / 1000 : null,
      ttfbP50Ms: percentile(r.ttfb, 50),
      ttfbP95Ms: percentile(r.ttfb, 95),
    }))
    .sort((a, b) => (b.requests + b.p2pSessions) - (a.requests + a.p2pSessions))
    .slice(0, 30);

  const nodes = [...byNode.entries()]
    .map(([node, r]) => ({ node, region: r.region, edge: !!r.edge, bytesViaGateway: r.bytesViaGateway, bytesDirectP2P: r.bytesDirect, requests: r.requests }))
    .sort((a, b) => (b.bytesViaGateway + b.bytesDirectP2P) - (a.bytesViaGateway + a.bytesDirectP2P))
    .slice(0, 30);

  // réplicas de borda ativas agora (sem nodeId real: só apelido + região)
  const edgeReplicas = [];
  if (registry) {
    for (const fileId of registry.listFiles()) {
      for (const rep of registry.getEdgeReplicas(fileId)) {
        edgeReplicas.push({
          fileId: fileId.slice(0, 12),
          node: geo.alias(rep.relayNodeId || rep.nodeId),
          region: rep.region || null,
          online: geo.isOnline(rep.relayNodeId),
          ageSec: Math.floor((Date.now() - rep.createdAt) / 1000),
          idleSec: Math.floor((Date.now() - rep.lastHitAt) / 1000),
          bytes: rep.bytes || null,
        });
      }
    }
  }

  return {
    ok: true,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    requests: counters.requests,
    status: counters.status,
    cache: {
      ...counters.cache,
      hitRate: cacheTotal ? Math.round(((counters.cache.HIT + counters.cache['HIT-EDGE']) / cacheTotal) * 1000) / 1000 : null,
    },
    traffic: {
      bytesServedByGateway: gw,
      bytesPulledFromNodes: counters.bytesPulledFromNodes,
      bytesDirectP2P: p2p,
      // fatia da entrega que NÃO passou pela banda da VPS (reportada pelos players)
      p2pShare: totalDelivered ? Math.round((p2p / totalDelivered) * 1000) / 1000 : null,
      p2pSessions: counters.p2pSessionsReported,
      p2pBlocksFromEdge: counters.p2pEdgeBlocksReported,
      p2pBlocks: counters.p2pBlocksReported,
    },
    presence: { onlineNodes: geo.onlineNodes().length, known: geo.presenceKnown() },
    edge: { ...counters.edge, activeReplicas: edgeReplicas.length, replicas: edgeReplicas.slice(0, 50) },
    regions,
    nodes,
  };
}

module.exports = { recordServe, recordManifest, recordPlayerBeacon, edgeEvent, snapshot };
