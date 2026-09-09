'use strict';

/**
 * Rotas de consulta pra quem vai reivindicar um epoch payout (node de PC
 * ou app mobile) — leem só os snapshots já publicados por epochJob.js,
 * não tocam no ledger nem no programa. Plugar no roteador existente,
 * no mesmo padrão de `if (url.pathname === '/api/wallet/balance') { ... }`
 * que já está em index.js:
 *
 *   const { handleEpochRoutes } = require('./epochApi');
 *   // dentro do handler http existente, antes do fallback 404:
 *   if (handleEpochRoutes(req, res, url)) return;
 */

const fs = require('fs');
const path = require('path');
const { EPOCHS_DIR, currentEpochId } = require('./epochJob');

function loadEpoch(epochId) {
  const file = path.join(EPOCHS_DIR, `epoch-${epochId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function sendJson(res, status, body) {
  // CORS: essas rotas são chamadas pelo painel (index.html) rodando num
  // node de PC, ou seja, sempre de origem diferente da VPS/backend. Sem
  // esse header o browser bloqueia a leitura da resposta e o fetch() do
  // painel estoura "Failed to fetch" mesmo com o servidor respondendo ok.
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  });
  res.end(JSON.stringify(body));
}

// base58 sem 0, O, I, l — só pra validar formato antes de tentar ler arquivo
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * @returns {boolean} true se a rota foi tratada (o chamador deve parar o roteamento ali)
 */
function handleEpochRoutes(req, res, url) {
  if (req.method !== 'GET') return false;

  const proofMatch = url.pathname.match(/^\/epoch\/(\d+)\/proof\/([^/]+)$/);
  if (proofMatch) {
    const epochId = Number(proofMatch[1]);
    const pubkey = proofMatch[2];

    if (!BASE58_RE.test(pubkey)) {
      sendJson(res, 400, { error: 'pubkey com formato inválido' });
      return true;
    }

    const epoch = loadEpoch(epochId);
    if (!epoch) {
      sendJson(res, 404, { error: `época ${epochId} não encontrada ou ainda não publicada` });
      return true;
    }

    const entry = epoch.entries.find((e) => e.pubkey === pubkey);
    if (!entry) {
      sendJson(res, 404, { error: 'essa pubkey não tem payout nessa época (abaixo do mínimo de saque, ou sem contribuição no período)' });
      return true;
    }

    sendJson(res, 200, {
      epochId,
      root: epoch.root,
      amountLamports: entry.amountLamports,
      proof: entry.proof, // array de hex strings — o cliente converte pra [u8;32] antes de chamar claim_epoch
    });
    return true;
  }

  if (url.pathname === '/epoch/current') {
    const epochId = currentEpochId();
    const epoch = loadEpoch(epochId);
    sendJson(res, 200, epoch || { epochId, status: 'ainda não publicada' });
    return true;
  }

  return false;
}

module.exports = { handleEpochRoutes };