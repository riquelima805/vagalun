'use strict';

/**
 * anchorSite.js — grava o manifesto na chain (SiteRecord) durante o publish.
 *
 *   1) se o domínio ainda não existe on-chain: REGISTRAR (ADMIN) cria o nome apontando pra chave do site;
 *   2) a CHAVE DO SITE assina update_site(hash, version); o registrar só paga a taxa.
 *
 * Env: SITE_CHAIN_MODE (off|optional|required), VAGALUN_PROGRAM_ID, SITE_RPC_URLS (leitura, quórum),
 *      SOLANA_RPC_URL (envio), ADMIN_KEYPAIR_PATH (registrar + pagador de taxas).
 */

const fs = require('fs');
const { Connection, Keypair } = require('@solana/web3.js');
const chain = require('../chain/siteChain');
const { chainConfigFromEnv } = require('../gateway/siteVerify');

function loadRegistrar() {
  const p = process.env.ADMIN_KEYPAIR_PATH;
  if (!p) throw new Error('defina ADMIN_KEYPAIR_PATH (registrar/pagador de taxas)');
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, 'utf8'))));
}

/** Lê o registro atual (com quórum). null => ainda não existe. */
async function readCurrent(domain, cfg = chainConfigFromEnv()) {
  if (cfg.mode === 'off') return null;
  const r = await chain.resolveSiteOnChain(domain, { programId: cfg.programId, rpcUrls: cfg.rpcUrls, quorum: cfg.quorum });
  return r.record;
}

async function anchorSiteOnChain({ domain, routes, version, ownerPrivateKeyDerB64, ownerPubkeyB58, existingRecord, log = console.log }) {
  const cfg = chainConfigFromEnv();
  if (cfg.mode === 'off') return { skipped: true };
  const connection = new Connection(process.env.SOLANA_RPC_URL || cfg.rpcUrls[0], 'confirmed');
  const registrar = loadRegistrar();
  const ownerKp = chain.keypairFromPkcs8B64(ownerPrivateKeyDerB64);
  if (ownerKp.publicKey.toBase58() !== ownerPubkeyB58) throw new Error('chave do site não bate com a pubkey registrada');

  if (!existingRecord) {
    log(`  [chain] registrando ${domain} -> dono ${ownerPubkeyB58}`);
    await chain.sendRegisterSite({ connection, programId: cfg.programId, registrar, domain, owner: ownerPubkeyB58 });
  } else if (existingRecord.owner !== ownerPubkeyB58) {
    throw new Error(`on-chain o dono de ${domain} é ${existingRecord.owner}, não ${ownerPubkeyB58}`);
  }
  const mh = chain.manifestHash(domain, version, routes);
  log(`  [chain] update_site versão ${version} hash ${mh.toString('hex').slice(0, 16)}…`);
  const sig = await chain.sendUpdateSite({
    connection, programId: cfg.programId, feePayer: registrar, ownerKeypair: ownerKp, domain, manifestHash: mh, version,
  });
  return { signature: sig, version };
}

module.exports = { anchorSiteOnChain, readCurrent };
