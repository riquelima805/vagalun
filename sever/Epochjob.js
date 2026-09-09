'use strict';

/**
 * Job de payout semanal (Bloco 2 da arquitetura: uptime + banda de
 * relay/live + provas free-tier, tudo já consolidado em pontos por
 * points.js). Roda 1x por época (semanal), pega quem ainda não recebeu
 * (getUnpaidPoints), converte pra lamports, publica a raiz on-chain e
 * salva o snapshot local que a API de proof (epochApi.js) vai servir
 * pro node de PC e pro app mobile.
 *
 * Rodar via cron (ex.: `0 3 * * 1 node epochJob.js`, toda segunda 03h)
 * ou chamando runEpochJob() a partir de um processo próprio.
 */

const fs = require('fs');
const path = require('path');
const { AnchorProvider, Program, Wallet, BN } = require('@coral-xyz/anchor');
const { Connection, Keypair, PublicKey, SystemProgram } = require('@solana/web3.js');

const { buildTree, getProof, leafHash } = require('./merkle');
const { getSolUsdRate } = require('./priceFeed');
const points = require('./points');

const EPOCHS_DIR = process.env.EPOCHS_DIR || path.join(__dirname, 'epochs');
if (!fs.existsSync(EPOCHS_DIR)) fs.mkdirSync(EPOCHS_DIR, { recursive: true });

// Preço manual do ponto em USD — mesma filosofia do BRL_USD_RATE do doc de
// preços (§4.2): fixo, revisão manual de tempos em tempos, não uma cotação
// em tempo real (ponto não é um ativo de mercado, é uma unidade interna).
const USD_PER_POINT = Number(process.env.USD_PER_POINT || 0.001);

// Mínimo de saque (§4.4 do doc de preços): quem não bateu isso na época
// não entra na árvore — os pontos ficam intactos (pointsPaidOut não avança)
// e rolam pra próxima automaticamente.
const MIN_CLAIM_USD = Number(process.env.MIN_CLAIM_USD || 1.0);

const PROGRAM_ID_STR = process.env.VAGALUN_PROGRAM_ID;
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const ADMIN_KEYPAIR_PATH = process.env.ADMIN_KEYPAIR_PATH; // JSON array de secretKey, formato solana-keygen

// IDL mínima — só as duas instructions/contas que esse job usa. Se vocês
// já geram o IDL completo via `anchor build`, importem esse (target/idl/*.json)
// no lugar deste literal; deixei inline pra não depender de artefato de build
// no momento de escrever isso.
const IDL = {
  version: '0.1.0',
  name: 'storage_market',
  instructions: [
    {
      name: 'publishEpochRoot',
      accounts: [
        { name: 'epochRoot', isMut: true, isSigner: false },
        { name: 'admin', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
      ],
      args: [
        { name: 'epochId', type: 'u64' },
        { name: 'merkleRoot', type: { array: ['u8', 32] } },
        { name: 'totalLamports', type: 'u64' },
      ],
    },
  ],
  accounts: [
    {
      name: 'EpochRoot',
      type: {
        kind: 'struct',
        fields: [
          { name: 'epochId', type: 'u64' },
          { name: 'merkleRoot', type: { array: ['u8', 32] } },
          { name: 'totalLamports', type: 'u64' },
          { name: 'claimedLamports', type: 'u64' },
          { name: 'publishedAtUnix', type: 'i64' },
          { name: 'bump', type: 'u8' },
        ],
      },
    },
  ],
};

function loadAdminKeypair() {
  if (!ADMIN_KEYPAIR_PATH) throw new Error('defina ADMIN_KEYPAIR_PATH (arquivo JSON gerado por solana-keygen)');
  const raw = JSON.parse(fs.readFileSync(ADMIN_KEYPAIR_PATH, 'utf8'));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/** Época semanal alinhada ao unix epoch (ajuste o corte de dia se quiser outro que não meia-noite UTC de quinta). */
function currentEpochId() {
  const WEEK_SECONDS = 7 * 24 * 60 * 60;
  return Math.floor(Date.now() / 1000 / WEEK_SECONDS);
}

function epochFilePath(epochId) {
  return path.join(EPOCHS_DIR, `epoch-${epochId}.json`);
}

async function runEpochJob(epochIdOverride) {
  const epochId = epochIdOverride ?? currentEpochId();
  const outPath = epochFilePath(epochId);

  if (fs.existsSync(outPath)) {
    console.log(`[epoch] época ${epochId} já foi publicada antes, retornando snapshot existente`);
    return JSON.parse(fs.readFileSync(outPath, 'utf8'));
  }

  const solUsdRate = await getSolUsdRate();
  const pubkeys = points.getAllPubkeys();

  const included = [];
  for (const pubkey of pubkeys) {
    const unpaidPoints = points.getUnpaidPoints(pubkey);
    if (unpaidPoints <= 0) continue;

    const usd = unpaidPoints * USD_PER_POINT;
    if (usd < MIN_CLAIM_USD) continue; // fica pra próxima época — não mexe em pointsPaidOut

    const lamports = Math.floor((usd / solUsdRate) * 1e9);
    if (lamports <= 0) continue;

    included.push({ pubkey, unpaidPoints, usd, lamports });
  }

  if (included.length === 0) {
    console.log(`[epoch] época ${epochId}: ninguém bateu o mínimo de US$${MIN_CLAIM_USD} — nada a publicar ainda`);
    return null;
  }

  const leaves = included.map((it) => leafHash(it.pubkey, it.lamports, epochId));
  const { root, layers } = buildTree(leaves);
  const totalLamports = included.reduce((sum, it) => sum + it.lamports, 0);

  const connection = new Connection(RPC_URL, 'confirmed');
  const adminKeypair = loadAdminKeypair();
  const provider = new AnchorProvider(connection, new Wallet(adminKeypair), { commitment: 'confirmed' });
  const program = new Program(IDL, new PublicKey(PROGRAM_ID_STR), provider);

  const epochIdBn = new BN(epochId);
  const [epochRootPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('epoch_root'), epochIdBn.toArrayLike(Buffer, 'le', 8)],
    new PublicKey(PROGRAM_ID_STR)
  );

  console.log(`[epoch] publicando época ${epochId}: ${included.length} pubkeys, ${totalLamports} lamports totais, raiz ${root.toString('hex')}`);

  const sig = await program.methods
    .publishEpochRoot(epochIdBn, Array.from(root), new BN(totalLamports))
    .accounts({
      epochRoot: epochRootPda,
      admin: adminKeypair.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log(`[epoch] confirmado on-chain: ${sig}`);

  // SÓ avança o cursor depois da tx confirmar — se `program.methods...rpc()`
  // lançar exceção antes daqui, nada foi marcado como pago e a próxima
  // chamada de runEpochJob() tenta de novo com os mesmos pontos.
  for (const it of included) {
    points.markPointsPaid(it.pubkey, it.unpaidPoints);
  }
  points.saveLedger();

  const snapshot = {
    epochId,
    root: root.toString('hex'),
    totalLamports,
    publishedAt: new Date().toISOString(),
    txSignature: sig,
    solUsdRateUsed: solUsdRate,
    usdPerPointUsed: USD_PER_POINT,
    entries: included.map((it, i) => ({
      pubkey: it.pubkey,
      amountLamports: it.lamports,
      amountUsd: Number(it.usd.toFixed(6)),
      proof: getProof(layers, i).map((buf) => buf.toString('hex')),
    })),
  };
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
  console.log(`[epoch] snapshot salvo em ${outPath}`);
  return snapshot;
}

module.exports = { runEpochJob, currentEpochId, epochFilePath, EPOCHS_DIR };

// Permite rodar direto: `node epochJob.js`
if (require.main === module) {
  runEpochJob()
    .then((snap) => {
      if (!snap) process.exit(0);
      console.log(`[epoch] OK — ${snap.entries.length} pubkeys pagos nessa época.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[epoch] falhou:', err);
      process.exit(1);
    });
}
