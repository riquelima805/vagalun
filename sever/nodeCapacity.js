'use strict';

/**
 * Score de capacidade de LIVE por node de PC — NUNCA declarado pelo
 * node, sempre calculado aqui a partir do histórico real reportado no
 * heartbeat (cpuLoadPercent, activeLiveCount, liveStreamsHealth[].kbps).
 *
 * Ideia central:
 *  - Todo node novo começa conservador (maxConcurrentLives = 2).
 *  - Cada heartbeat "saudável" (CPU ok, bitrate das lives ativas estável)
 *    empurra o teto um pouco pra cima ao longo do tempo — ele PROVA que
 *    aguenta antes de receber mais.
 *  - Cada heartbeat "degradado" (CPU alto E/OU bitrate de alguma live
 *    caindo enquanto tinha várias ativas) aplica uma PENALIDADE: reduz
 *    o teto imediatamente e marca um cooldown (não recebe live nova por
 *    um tempo, mesmo com score bom).
 *  - O roteamento (pickBestNodeForLive) nunca manda live pra node em
 *    cooldown ou já no teto de concorrência.
 */

const CPU_HEALTHY_MAX = Number(process.env.CAP_CPU_HEALTHY_MAX || 70);   // % — abaixo disso é "folga"
const CPU_DEGRADED_MIN = Number(process.env.CAP_CPU_DEGRADED_MIN || 90); // % — acima disso é degradação clara
const KBPS_DROP_RATIO_DEGRADED = Number(process.env.CAP_KBPS_DROP_RATIO || 0.5); // caiu mais de 50% do que já rodou = ruim
const COOLDOWN_MS = Number(process.env.CAP_COOLDOWN_MS || 10 * 60_000); // 10 min sem receber live nova após penalidade
const GROW_STEP = 1;     // quanto o teto sobe por vez que prova estabilidade
const GROW_EVERY_N_OK = 12; // precisa de N heartbeats saudáveis seguidos pra subir o teto (heartbeat ~20s => ~4min)
const MAX_CAP_CEILING = Number(process.env.CAP_MAX_CEILING || 20); // trava de segurança, mesmo que o histórico seja ótimo

const nodes = new Map(); // nodeId -> capacity record

function ensure(nodeId) {
  if (!nodes.has(nodeId)) {
    nodes.set(nodeId, {
      maxConcurrentLives: 2,
      consecutiveHealthyBeats: 0,
      cooldownUntil: 0,
      lastKbpsByStream: new Map(), // streamPath -> última leitura, pra detectar queda
      lastReport: null,
    });
  }
  return nodes.get(nodeId);
}

/**
 * Chamado a cada heartbeat do node de PC (via /directory/heartbeat).
 * `report` = { cpuLoadPercent, activeLiveCount, liveStreamsHealth: [{streamPath, kbps}] }
 */
function recordHeartbeat(nodeId, report) {
  const rec = ensure(nodeId);
  const { cpuLoadPercent = 0, activeLiveCount = 0, liveStreamsHealth = [] } = report || {};

  let degraded = cpuLoadPercent >= CPU_DEGRADED_MIN && activeLiveCount > 0;

  // detecta queda de bitrate: compara com a última leitura da mesma live.
  // Só conta como degradação se a live já tinha um bitrate de referência
  // (kbps > 0 antes) e caiu mais que o limiar — evita falso positivo no
  // início de uma transmissão (quando o bitrate ainda está subindo).
  for (const s of liveStreamsHealth) {
    const prevKbps = rec.lastKbpsByStream.get(s.streamPath);
    if (prevKbps && prevKbps > 0 && s.kbps < prevKbps * (1 - KBPS_DROP_RATIO_DEGRADED)) {
      degraded = true;
    }
    rec.lastKbpsByStream.set(s.streamPath, s.kbps);
  }
  // limpa streams que sumiram do relatório (a live encerrou)
  const currentPaths = new Set(liveStreamsHealth.map((s) => s.streamPath));
  for (const path of rec.lastKbpsByStream.keys()) {
    if (!currentPaths.has(path)) rec.lastKbpsByStream.delete(path);
  }

  if (degraded) {
    // penalidade: reduz o teto na hora (nunca abaixo de 1) e aplica cooldown
    rec.maxConcurrentLives = Math.max(1, rec.maxConcurrentLives - 1);
    rec.consecutiveHealthyBeats = 0;
    rec.cooldownUntil = Date.now() + COOLDOWN_MS;
  } else if (cpuLoadPercent <= CPU_HEALTHY_MAX) {
    rec.consecutiveHealthyBeats += 1;
    if (rec.consecutiveHealthyBeats >= GROW_EVERY_N_OK && rec.maxConcurrentLives < MAX_CAP_CEILING) {
      rec.maxConcurrentLives += GROW_STEP;
      rec.consecutiveHealthyBeats = 0;
    }
  }
  // CPU entre HEALTHY_MAX e DEGRADED_MIN: zona neutra, não sobe nem desce,
  // só não conta como heartbeat saudável (evita crescer o teto sob carga média)

  rec.lastReport = { cpuLoadPercent, activeLiveCount, ts: Date.now() };
  return snapshot(nodeId);
}

function snapshot(nodeId) {
  const rec = nodes.get(nodeId);
  if (!rec) return null;
  const inCooldown = Date.now() < rec.cooldownUntil;
  return {
    nodeId,
    maxConcurrentLives: rec.maxConcurrentLives,
    activeLiveCount: rec.lastReport ? rec.lastReport.activeLiveCount : 0,
    availableSlots: inCooldown ? 0 : Math.max(0, rec.maxConcurrentLives - (rec.lastReport ? rec.lastReport.activeLiveCount : 0)),
    inCooldown,
    cooldownRemainingMs: inCooldown ? rec.cooldownUntil - Date.now() : 0,
    lastCpuLoadPercent: rec.lastReport ? rec.lastReport.cpuLoadPercent : null,
  };
}

/**
 * Usado pelo gateway na hora de rotear uma live nova: dentre os nodeIds
 * candidatos (ex.: os que estão online agora, vindo de /directory/nodes),
 * devolve o de maior folga real (mais slots disponíveis, sem estar em
 * cooldown). Retorna null se nenhum tiver vaga.
 */
function pickBestNodeForLive(candidateNodeIds) {
  let best = null;
  for (const nodeId of candidateNodeIds) {
    const snap = snapshot(nodeId) || { availableSlots: 2, inCooldown: false }; // node nunca visto: chute conservador
    if (snap.inCooldown || snap.availableSlots <= 0) continue;
    if (!best || snap.availableSlots > best.availableSlots) best = { nodeId, ...snap };
  }
  return best;
}

function getAllSnapshots() {
  return [...nodes.keys()].map(snapshot);
}

module.exports = { recordHeartbeat, snapshot, pickBestNodeForLive, getAllSnapshots };
