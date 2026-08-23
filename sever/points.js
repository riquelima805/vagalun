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
      provenShardsSeen: 0
    });
  }
  return ledger.get(pubkey);
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
  getEntry,
  getAllPubkeys,
  setProvenShardsSeen,
  getLeaderboard,
  saveLedger
};
