'use strict';

// Cotação SOL→USD só pra converter o total da época (USD) em lamports na
// hora de publicar. Isso é DIFERENTE do BRL_USD_RATE do doc de preços
// (que é fixo/revisão manual, pra plano e overage) — aqui, como SOL oscila
// bem mais rápido, buscamos em tempo real com fallback fixo se a API cair,
// exatamente como o §4.2 do doc de arquitetura de preços propõe.

const SOL_USD_FALLBACK = Number(process.env.SOL_USD_FALLBACK || 150);
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';

async function getSolUsdRate() {
  try {
    const res = await fetch(COINGECKO_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    const rate = data?.solana?.usd;
    if (typeof rate === 'number' && rate > 0) return rate;
    throw new Error('resposta sem campo solana.usd válido');
  } catch (err) {
    console.error(`[priceFeed] falha ao buscar cotação SOL/USD (${err.message}), usando fallback US$${SOL_USD_FALLBACK}`);
    return SOL_USD_FALLBACK;
  }
}

module.exports = { getSolUsdRate };
