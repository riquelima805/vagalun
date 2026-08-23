// Puxa periodicamente a conta ProviderRecord (on-chain) de cada wallet
// conhecida e converte o avanço em total_shards_proven em pontos no ledger
// off-chain. Isso é o que faz uma prova real de armazenamento valer muito
// mais que só "ficar online" — total_shards_proven só sobe quando o
// contrato aceitou uma prova de posse de shard de verdade.

const { Connection, PublicKey } = require('@solana/web3.js');
const points = require('./points');

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const PROGRAM_ID = process.env.STORAGE_PROGRAM_ID || 'FPpM2qXfpddkNxuUNqoF2UZg7MJiwF4Un96EWKhVecS6';
const POLL_INTERVAL_MS = Number(process.env.PROOF_POLL_INTERVAL_MS || 5 * 60_000); // 5 min

let connection = null;
let programId = null;

function init() {
  connection = new Connection(RPC_URL, 'confirmed');
  programId = new PublicKey(PROGRAM_ID);
}

function providerRecordPda(providerPubkeyBase58) {
  if (!programId) init();
  const providerKey = new PublicKey(providerPubkeyBase58);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('provider_record'), providerKey.toBuffer()],
    programId
  );
  return pda;
}

/**
 * Decodifica a struct ProviderRecord (layout Anchor):
 *   8 bytes  discriminador
 *   32 bytes provider (Pubkey)
 *   8 bytes  total_shards_proven (u64 LE)
 *   8 bytes  last_proof_unix (i64 LE)
 */
function decodeProviderRecord(data) {
  if (!data || data.length < 8 + 32 + 8 + 8) return null;
  const totalShardsProven = data.readBigUInt64LE(8 + 32);
  const lastProofUnix = data.readBigInt64LE(8 + 32 + 8);
  return { totalShardsProven, lastProofUnix };
}

/** Roda uma passada: checa todas as wallets conhecidas e soma pontos de prova novos. */
async function pollOnce() {
  if (!connection) init();
  const pubkeys = points.getAllPubkeys();
  if (pubkeys.length === 0) return;

  for (const pubkey of pubkeys) {
    try {
      const pda = providerRecordPda(pubkey);
      const accountInfo = await connection.getAccountInfo(pda);
      if (!accountInfo) continue; // wallet ainda não tem ProviderRecord on-chain

      const decoded = decodeProviderRecord(accountInfo.data);
      if (!decoded) continue;

      const entry = points.getEntry(pubkey);
      const seen = BigInt(entry.provenShardsSeen || 0);
      const total = decoded.totalShardsProven;

      if (total > seen) {
        const newProofs = Number(total - seen);
        points.addProofPoints(pubkey, newProofs);
        points.setProvenShardsSeen(pubkey, Number(total));
        console.log(`[proof-points] ${pubkey}: +${newProofs} provas novas (total ${total})`);
      }
    } catch (e) {
      console.error(`[proof-points] falha ao checar ${pubkey}:`, e.message);
    }
  }
}

function start() {
  init();
  pollOnce(); // roda uma vez logo de cara, sem esperar o primeiro intervalo
  setInterval(pollOnce, POLL_INTERVAL_MS);
  console.log(`[proof-points] poller iniciado (a cada ${POLL_INTERVAL_MS / 1000}s, programa ${PROGRAM_ID})`);
}

module.exports = { start, pollOnce, providerRecordPda, decodeProviderRecord };
