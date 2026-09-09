'use strict';

/**
 * Vínculo node_pubkey (efêmero, sem gas) -> owner_pubkey (wallet pessoal,
 * Phantom). Sem isso, o backend não tem pra onde mandar o epoch payout
 * desse node — a wallet efêmera nunca vai conseguir pagar o gas de um
 * `claim_epoch` sozinha (é só assinatura de heartbeat, não tem SOL).
 *
 * Confiança aqui é local: só quem já está na máquina (acessando o painel
 * em localhost) consegue setar isso — é o mesmo nível de confiança que
 * `/api/rotate-secret` já assume. O backend, ao receber o heartbeat com
 * `ownerPubkey`, é quem decide se aceita re-vincular ou não (ex.: pode
 * exigir confirmação assinada da wallet pessoal do lado dele antes de
 * migrar o link de um node já vinculado a outro dono — não é feito aqui).
 */

const fs = require('fs');
const path = require('path');

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function createOwnerLink(dataDir) {
  const linkFile = path.join(dataDir, 'owner-link.json');

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(linkFile, 'utf-8'));
      return typeof raw.ownerPubkey === 'string' ? raw.ownerPubkey : null;
    } catch (_) {
      return null;
    }
  }

  let ownerPubkey = load();

  function getOwnerPubkey() {
    return ownerPubkey;
  }

  function setOwnerPubkey(pubkeyBase58) {
    if (!BASE58_RE.test(pubkeyBase58)) {
      throw new Error('pubkey inválida (esperado base58, 32-44 chars)');
    }
    ownerPubkey = pubkeyBase58;
    fs.writeFileSync(linkFile, JSON.stringify({ ownerPubkey, linkedAt: new Date().toISOString() }, null, 2));
    return ownerPubkey;
  }

  /**
   * @returns {boolean} true se tratou a rota
   *   GET  /api/owner            -> { ownerPubkey: string | null }
   *   POST /api/owner  { ownerPubkey } -> { ok: true, ownerPubkey }
   */
  function handleOwnerLinkRoutes(req, res, url, readBody) {
    if (url.pathname !== '/api/owner') return false;

    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ownerPubkey: getOwnerPubkey() }));
      return true;
    }

    if (req.method === 'POST') {
      readBody(req)
        .then((bodyStr) => {
          const body = JSON.parse(bodyStr || '{}');
          const linked = setOwnerPubkey(String(body.ownerPubkey || ''));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ownerPubkey: linked }));
        })
        .catch((err) => {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        });
      return true;
    }

    res.writeHead(405); res.end('method not allowed');
    return true;
  }

  return { getOwnerPubkey, setOwnerPubkey, handleOwnerLinkRoutes };
}

module.exports = { createOwnerLink };
