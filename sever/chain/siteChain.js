'use strict';

/**
 * siteChain.js — cliente do SiteRecord on-chain (ver contract/site_registry.rs).
 *
 *  1. Manifesto v2: formato canônico NÃO ambíguo, com versão e fileKey assinados.
 *  2. Instruções (sem Anchor client; discriminators = sha256("global:<nome>")[0..8]).
 *  3. Leitura direta da chain com QUÓRUM entre vários RPCs (um RPC mentiroso não vence).
 *
 * Quem verifica o site (gateway, player, app) só precisa de: domínio + RPCs + programId.
 * O hash on-chain amarra o conteúdo; a chain já garantiu que o DONO assinou a tx.
 */

const crypto = require('crypto');
const {
  PublicKey, TransactionInstruction, SystemProgram, Transaction, sendAndConfirmTransaction, Keypair,
} = require('@solana/web3.js');

const SITE_SEED = Buffer.from('site');

// (manifesto v2 vive em siteManifest.js — puro, sem Solana)
const { MAGIC, MAX_DOMAIN_LEN, validateDomain, canonicalManifestV2, manifestHash, cmpUtf8, sha256 } = require('./siteManifest');

// ---------------------------------------------------------------- PDA e layout

const domainHash = (domain) => sha256(Buffer.from(domain, 'utf8'));

function findSitePda(programId, domain) {
  validateDomain(domain);
  return PublicKey.findProgramAddressSync([SITE_SEED, domainHash(domain)], new PublicKey(programId));
}

const disc = (name) => sha256(Buffer.from(`global:${name}`)).subarray(0, 8);
const ACCOUNT_DISC = sha256(Buffer.from('account:SiteRecord')).subarray(0, 8);

function u64le(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function borshString(s) { const d = Buffer.from(s, 'utf8'); const l = Buffer.alloc(4); l.writeUInt32LE(d.length); return Buffer.concat([l, d]); }

/** Decodifica a conta (layout fixo documentado em site_registry.rs). */
function decodeSiteRecord(data) {
  const buf = Buffer.from(data);
  if (buf.length < 8 + 113 + 4) throw new Error('conta curta demais');
  if (!buf.subarray(0, 8).equals(ACCOUNT_DISC)) throw new Error('discriminator não é SiteRecord');
  const o = 8;
  const len = buf.readUInt32LE(o + 113);
  if (len > MAX_DOMAIN_LEN || buf.length < o + 117 + len) throw new Error('domain corrompido');
  return {
    domainHash: buf.subarray(o, o + 32),
    owner: new PublicKey(buf.subarray(o + 32, o + 64)).toBase58(),
    manifestHash: buf.subarray(o + 64, o + 96),
    version: Number(buf.readBigUInt64LE(o + 96)),
    updatedAtUnix: Number(buf.readBigInt64LE(o + 104)),
    bump: buf[o + 112],
    domain: buf.subarray(o + 117, o + 117 + len).toString('utf8'),
  };
}

// ---------------------------------------------------------------- instruções

function registerSiteIx(programId, { registrar, domain, owner }) {
  const [site] = findSitePda(programId, domain);
  return new TransactionInstruction({
    programId: new PublicKey(programId),
    keys: [
      { pubkey: site, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(registrar), isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([disc('register_site'), borshString(domain), new PublicKey(owner).toBuffer()]),
  });
}

function updateSiteIx(programId, { owner, domain, manifestHash: mh, version }) {
  const [site] = findSitePda(programId, domain);
  if (!Buffer.isBuffer(mh) || mh.length !== 32) throw new Error('manifestHash precisa ter 32 bytes');
  return new TransactionInstruction({
    programId: new PublicKey(programId),
    keys: [
      { pubkey: site, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(owner), isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([disc('update_site'), mh, u64le(version)]),
  });
}

function transferSiteIx(programId, { owner, domain, newOwner }) {
  const [site] = findSitePda(programId, domain);
  return new TransactionInstruction({
    programId: new PublicKey(programId),
    keys: [
      { pubkey: site, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(owner), isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([disc('transfer_site'), new PublicKey(newOwner).toBuffer()]),
  });
}

/** KeyObject/DER PKCS8 (formato do publisher/site-keys.json) -> Keypair do Solana (mesma curva Ed25519). */
function keypairFromPkcs8B64(privateKeyDerB64) {
  const der = Buffer.from(privateKeyDerB64, 'base64');
  return Keypair.fromSeed(der.subarray(der.length - 32)); // PKCS8 Ed25519: a seed são os últimos 32 bytes
}

// ---------------------------------------------------------------- leitura com quórum

async function rpcGetAccount(url, pda, { fetchImpl = fetch, timeoutMs = 6000, commitment = 'confirmed' } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [pda, { encoding: 'base64', commitment }] }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || 'erro rpc');
    return j.result ? j.result.value : null;
  } finally { clearTimeout(t); }
}

/**
 * Lê o SiteRecord de vários RPCs e só aceita o que >= `quorum` deles afirmam igual.
 * - 1 RPC mentindo (inventando conta, devolvendo versão velha) não passa quando há >=3.
 * - Entre grupos com quórum, vence a MAIOR versão (RPC atrasado não faz rollback).
 * - Não protege contra a MAIORIA dos RPCs conluiada: use provedores independentes.
 *
 * @returns {Promise<{record: object|null, supporters: number, responded: number}>}
 *          record=null => quórum diz "site não existe on-chain"
 */
async function resolveSiteOnChain(domain, { programId, rpcUrls, quorum, fetchImpl, timeoutMs } = {}) {
  if (!programId || !Array.isArray(rpcUrls) || !rpcUrls.length) throw new Error('programId e rpcUrls são obrigatórios');
  const [pda] = findSitePda(programId, domain);
  const need = Math.min(quorum || 2, rpcUrls.length);

  const answers = await Promise.all(rpcUrls.map(async (url) => {
    try {
      const v = await rpcGetAccount(url, pda.toBase58(), { fetchImpl, timeoutMs });
      if (v === null) return { key: 'absent', record: null };
      if (v.owner !== new PublicKey(programId).toBase58()) return { key: 'bad-owner', record: null, bad: true };
      const rec = decodeSiteRecord(Buffer.from(v.data[0], 'base64'));
      if (rec.domain !== domain || !rec.domainHash.equals(domainHash(domain))) return { key: 'bad-record', record: null, bad: true };
      return { key: `${rec.version}|${rec.owner}|${rec.manifestHash.toString('hex')}`, record: rec };
    } catch (_) { return null; } // RPC fora do ar: não vota
  }));

  const votes = new Map();
  let responded = 0;
  for (const a of answers) {
    if (!a || a.bad) continue;
    responded++;
    const g = votes.get(a.key) || { n: 0, record: a.record };
    g.n++; votes.set(a.key, g);
  }
  const winners = [...votes.values()].filter((g) => g.n >= need);
  if (!winners.length) throw new Error(`sem quórum on-chain (${responded}/${rpcUrls.length} responderam, precisa ${need} iguais)`);
  winners.sort((a, b) => (b.record ? b.record.version : -1) - (a.record ? a.record.version : -1));
  return { record: winners[0].record, supporters: winners[0].n, responded };
}

/** O manifesto (v2) que chegou por gossip/gateway/P2P bate com o que a chain diz? */
function checkManifestAgainstRecord({ domain, version, routes }, record) {
  if (!record) return { ok: false, reason: 'site não registrado on-chain' };
  if (record.version !== version) return { ok: false, reason: `versão ${version} != on-chain ${record.version}` };
  let h;
  try { h = manifestHash(domain, version, routes); } catch (e) { return { ok: false, reason: e.message }; }
  if (!h.equals(record.manifestHash)) return { ok: false, reason: 'hash do manifesto não confere com a chain' };
  return { ok: true, owner: record.owner };
}

// ---------------------------------------------------------------- envio (publisher)

async function sendRegisterSite({ connection, programId, registrar, domain, owner }) {
  const tx = new Transaction().add(registerSiteIx(programId, { registrar: registrar.publicKey, domain, owner }));
  return sendAndConfirmTransaction(connection, tx, [registrar]);
}

/** feePayer paga as taxas (plataforma); owner (chave do site) assina o update. */
async function sendUpdateSite({ connection, programId, feePayer, ownerKeypair, domain, manifestHash: mh, version }) {
  const tx = new Transaction().add(updateSiteIx(programId, { owner: ownerKeypair.publicKey, domain, manifestHash: mh, version }));
  const signers = feePayer.publicKey.equals(ownerKeypair.publicKey) ? [feePayer] : [feePayer, ownerKeypair];
  return sendAndConfirmTransaction(connection, tx, signers);
}

module.exports = {
  MAGIC, validateDomain, canonicalManifestV2, manifestHash, cmpUtf8,
  findSitePda, domainHash, decodeSiteRecord, ACCOUNT_DISC, disc,
  registerSiteIx, updateSiteIx, transferSiteIx, keypairFromPkcs8B64,
  resolveSiteOnChain, checkManifestAgainstRecord, sendRegisterSite, sendUpdateSite,
};
