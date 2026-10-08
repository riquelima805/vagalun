'use strict';

/**
 * siteVerify.js — o gateway confere o manifesto contra o SiteRecord on-chain.
 *
 * SITE_CHAIN_MODE:
 *   off       (padrão) não consulta a chain. Comportamento antigo (TOFU local).
 *   optional  se EXISTE registro on-chain, o manifesto TEM que bater; se não existe, aceita (migração).
 *   required  exige registro on-chain e que bata. É o modo "sem DNS centralizado".
 *
 * Config: VAGALUN_PROGRAM_ID, SITE_RPC_URLS (vírgula; use provedores INDEPENDENTES), SITE_RPC_QUORUM.
 */

function chainConfigFromEnv(env = process.env) {
  const mode = (env.SITE_CHAIN_MODE || 'off').toLowerCase();
  const rpcUrls = (env.SITE_RPC_URLS || env.SOLANA_RPC_URL || '').split(',').map((x) => x.trim()).filter(Boolean);
  return {
    mode,
    programId: env.VAGALUN_PROGRAM_ID,
    rpcUrls,
    quorum: env.SITE_RPC_QUORUM ? Number(env.SITE_RPC_QUORUM) : undefined,
  };
}

/**
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string}>}
 */
async function verifySiteAgainstChain({ domain, ownerPubkey, version, routes }, cfg = chainConfigFromEnv(), deps = {}) {
  if (cfg.mode === 'off') return { ok: true, skipped: true };
  if (!['optional', 'required'].includes(cfg.mode)) return { ok: false, reason: `SITE_CHAIN_MODE inválido: ${cfg.mode}` };
  if (!cfg.programId || !cfg.rpcUrls.length) return { ok: false, reason: 'chain ligada mas falta VAGALUN_PROGRAM_ID/SITE_RPC_URLS' };

  const chain = deps.chain || require('../chain/siteChain');
  let res;
  try {
    res = await chain.resolveSiteOnChain(domain, { programId: cfg.programId, rpcUrls: cfg.rpcUrls, quorum: cfg.quorum, fetchImpl: deps.fetchImpl });
  } catch (e) {
    // sem quórum / RPCs fora: NÃO aceita em silêncio (senão derrubar RPC = desligar a verificação)
    return { ok: false, reason: `chain indisponível: ${e.message}` };
  }
  if (!res.record) {
    return cfg.mode === 'optional'
      ? { ok: true, skipped: true, reason: 'sem registro on-chain (modo optional)' }
      : { ok: false, reason: 'domínio não registrado on-chain (modo required)' };
  }
  if (res.record.owner !== ownerPubkey) return { ok: false, reason: 'dono do manifesto != dono on-chain' };
  if (version === null || version === undefined) return { ok: false, reason: 'registro on-chain exige manifesto v2 (com version)' };
  const chk = chain.checkManifestAgainstRecord({ domain, version, routes }, res.record);
  return chk.ok ? { ok: true } : { ok: false, reason: chk.reason };
}

module.exports = { verifySiteAgainstChain, chainConfigFromEnv };
