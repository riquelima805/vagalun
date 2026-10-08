// Ledger de pontos, estilo Grass: acumula pontos off-chain por contribuição
// real (uptime verificado + provas on-chain), sem custar SOL a cada ponto.
// Isso é só o ACÚMULO — a conversão pra token real acontece depois, num
// snapshot + merkle tree + claim on-chain (fora do escopo deste arquivo).

const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');

const LEDGER_PATH = process.env.POINTS_LEDGER_PATH || path.join(__dirname, 'points-ledger.json');
const SAVE_INTERVAL_MS = 30_000;

// 1 ponto a cada 60s online e conectado de verdade (WAN/relay), com prova de
// posse da wallet. Ajuste este número livremente — é só a fórmula off-chain,
// não tem custo on-chain nenhum trocar depois.
const POINTS_PER_MINUTE_ONLINE = 1;

/** @type {Map<string, {points: number, uptimeSeconds: number, lastSeen: number, sessions: number}>} */
const ledger = new Map();

function loadLedger() {
  try {
    const raw = fs.readFileSync(LEDGER_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    for (const [pubkey, entry] of Object.entries(parsed)) {
      ledger.set(pubkey, entry);
    }
    console.log(`[points] ledger carregado: ${ledger.size} wallets`);
  } catch (e) {
    console.log('[points] nenhum ledger anterior encontrado, começando do zero');
  }
}

function saveLedger() {
  try {
    const obj = Object.fromEntries(ledger.entries());
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error('[points] falha ao salvar ledger:', e.message);
  }
}

/**
 * Verifica se `sigBase64` é uma assinatura ed25519 válida de `message`,
 * feita pela chave privada correspondente a `pubkeyBase58`. Isso prova que
 * quem está se conectando realmente controla essa wallet Solana — sem isso,
 * qualquer um poderia declarar a pubkey de outra pessoa e roubar pontos.
 */
function verifyOwnership(pubkeyBase58, message, sigBase64) {
  try {
    const pubkeyBytes = bs58.decode(pubkeyBase58);
    const sigBytes = Buffer.from(sigBase64, 'base64');
    const msgBytes = Buffer.from(message, 'utf8');
    if (pubkeyBytes.length !== 32 || sigBytes.length !== 64) return false;
    return nacl.sign.detached.verify(msgBytes, sigBytes, pubkeyBytes);
  } catch (e) {
    return false;
  }
}

function ensureEntry(pubkey) {
  if (!ledger.has(pubkey)) {
    ledger.set(pubkey, {
      points: 0,
      uptimeSeconds: 0,
      lastSeen: Date.now(),
      sessions: 0,
      // quantas provas (total_shards_proven) já foram convertidas em pontos
      // até agora — evita contar a mesma prova duas vezes a cada poll.
      provenShardsSeen: 0,
      // quantos `points` já entraram em alguma epoch tree PUBLICADA on-chain.
      // `points` só cresce (nunca é decrementado direto) — o job de epoch
      // olha a diferença (points - pointsPaidOut) pra saber o que ainda não
      // foi ofertado num claim. Quem fica abaixo do mínimo de saque numa
      // época simplesmente não tem esse cursor avançado, e entra inteiro
      // na próxima (rollover automático, sem perder ponto).
      pointsPaidOut: 0
    });
  }
  const entry = ledger.get(pubkey);
  if (entry.pointsPaidOut === undefined) entry.pointsPaidOut = 0; // migração de ledger salvo antes desse campo existir
  return entry;
}

/**
 * Chamado pelo job de epoch DEPOIS que o `publish_epoch_root` confirmar
 * on-chain (nunca antes — se a tx falhar, os pontos precisam continuar
 * "não pagos" pra entrar na tentativa seguinte).
 */
function markPointsPaid(pubkey, amount) {
  const entry = ensureEntry(pubkey);
  entry.pointsPaidOut += amount;
}

/** Quanto ainda não foi incluído em nenhuma epoch tree publicada. */
function getUnpaidPoints(pubkey) {
  const entry = ensureEntry(pubkey);
  return Math.max(0, entry.points - entry.pointsPaidOut);
}

/** Chamado quando uma sessão verificada conecta. */
function onSessionStart(pubkey) {
  const entry = ensureEntry(pubkey);
  entry.sessions += 1;
  entry.lastSeen = Date.now();
}

/** Chamado quando a sessão termina — soma o tempo online real aos pontos. */
function onSessionEnd(pubkey, connectedAtMs) {
  const entry = ensureEntry(pubkey);
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - connectedAtMs) / 1000));
  entry.uptimeSeconds += elapsedSeconds;
  entry.points += Math.floor((elapsedSeconds / 60) * POINTS_PER_MINUTE_ONLINE);
  entry.lastSeen = Date.now();
  return entry;
}

/** Pontos extras por prova on-chain de armazenamento (vale bem mais que uptime). */
const POINTS_PER_PROOF = 50;
function addProofPoints(pubkey, proofCount) {
  if (proofCount <= 0) return;
  const entry = ensureEntry(pubkey);
  entry.points += proofCount * POINTS_PER_PROOF;
  entry.lastSeen = Date.now();
}

// ------------------------------------------------------------------
// Pontos de BANDA — fonte separada de uptime, é o que paga o node de
// PC (STUN/TURN relay + tráfego de live). Mobile ganha por uptime,
// PC ganha por bytes de verdade que passaram por ele. Guardamos os
// dois tipos de banda separados (relay vs live) porque no futuro cada
// um pode ter um preço/epoch diferente (você já falou em 70/30 vindo
// de fontes diferentes: hospedagem vs live vs relay TURN).
// ------------------------------------------------------------------
const POINTS_PER_GB_RELAY = Number(process.env.POINTS_PER_GB_RELAY || 10);
const POINTS_PER_GB_LIVE = Number(process.env.POINTS_PER_GB_LIVE || 10);
const BYTES_PER_GB = 1024 * 1024 * 1024;

function ensureBandwidthEntry(pubkey) {
  const entry = ensureEntry(pubkey);
  if (!entry.bandwidth) {
    entry.bandwidth = { relayBytesTotal: 0, liveBytesTotal: 0, isPcNode: true };
  }
  return entry;
}

/**
 * Credita bytes relayados via TURN por um node de PC. `deltaBytes` é
 * SEMPRE um delta desde o último heartbeat confirmado (nunca o total
 * acumulado), pra não contar 2x se o heartbeat repetir. Quem chama
 * isso é a rota /directory/heartbeat, depois de validar a assinatura
 * da wallet do node de PC (verifyOwnership).
 */
function addRelayBandwidth(pubkey, deltaBytes) {
  if (!deltaBytes || deltaBytes <= 0) return;
  const entry = ensureBandwidthEntry(pubkey);
  entry.bandwidth.relayBytesTotal += deltaBytes;
  entry.points += (deltaBytes / BYTES_PER_GB) * POINTS_PER_GB_RELAY;
  entry.lastSeen = Date.now();
}

/** Igual acima, mas pra tráfego de live (RTMP ingest + HTTP-FLV egress). */
function addLiveBandwidth(pubkey, deltaBytes) {
  if (!deltaBytes || deltaBytes <= 0) return;
  const entry = ensureBandwidthEntry(pubkey);
  entry.bandwidth.liveBytesTotal += deltaBytes;
  entry.points += (deltaBytes / BYTES_PER_GB) * POINTS_PER_GB_LIVE;
  entry.lastSeen = Date.now();
}

/** Lista de wallets já conhecidas (que já conectaram ao menos uma vez). */
function getAllPubkeys() {
  return [...ledger.keys()];
}

/** Marca até onde (em total_shards_proven) já convertemos pontos pra essa wallet. */
function setProvenShardsSeen(pubkey, n) {
  const entry = ensureEntry(pubkey);
  entry.provenShardsSeen = n;
}

function getEntry(pubkey) {
  return ledger.get(pubkey) || { points: 0, uptimeSeconds: 0, lastSeen: 0, sessions: 0 };
}

function getLeaderboard(limit = 20) {
  return [...ledger.entries()]
    .map(([pubkey, entry]) => ({ pubkey, ...entry }))
    .sort((a, b) => b.points - a.points)
    .slice(0, limit);
}

loadLedger();
setInterval(saveLedger, SAVE_INTERVAL_MS);
process.on('SIGINT', () => { saveLedger(); process.exit(0); });
process.on('SIGTERM', () => { saveLedger(); process.exit(0); });

module.exports = {
  verifyOwnership,
  onSessionStart,
  onSessionEnd,
  addProofPoints,
  addRelayBandwidth,
  addLiveBandwidth,
  markPointsPaid,
  getUnpaidPoints,
  getEntry,
  getAllPubkeys,
  setProvenShardsSeen,
  getLeaderboard,
  saveLedger
};
