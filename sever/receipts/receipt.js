'use strict';

/**
 * Bilhete (emitido pelo gateway) + recibo (assinado pelo player).
 *
 * Por que existe o bilhete: o gateway NÃO enxerga os bytes que vão do
 * celular pro navegador (é P2P). Se o recibo valesse sozinho, qualquer um
 * assinava "recebi 10 TB do nó X". O bilhete amarra o recibo a algo que o
 * gateway viu e limitou:
 *   - foi emitido numa chamada real a /p2p/:fileId (rate-limited por IP);
 *   - fixa o arquivo, o tamanho dele e QUAIS nós podem receber crédito;
 *   - fixa a chave efêmera do viewer (vk) — só ela assina recibos desse bilhete.
 * Então o teto de um bilhete é "tamanho do arquivo" (com folga pra seek), e
 * o nº de bilhetes é limitado por IP. É um teto, não uma prova de entrega.
 *
 * Recibo (cumulativo): "neste bilhete, recebi `bytes` bytes (total até agora)
 * do nó `node`". Cumulativo + monotônico => reenvio/replay não soma duas vezes.
 */

const crypto = require('crypto');
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const TICKET_TTL_MS = Number(process.env.RECEIPT_TICKET_TTL_MS || 6 * 3600_000);
const WEEK_MS = 7 * 24 * 3600_000;
const epochOf = (ms) => Math.floor(ms / WEEK_MS); // mesma régua do currentEpochId() do epochJob

function isPubkeyB58(s) {
  try { return typeof s === 'string' && bs58.decode(s).length === 32; } catch { return false; }
}

function issueTicket(secret, { fileId, domain, size, nodes, vk, now = Date.now() }) {
  if (!isPubkeyB58(vk)) throw new Error('vk inválida (esperado ed25519 pubkey base58 de 32 bytes)');
  const payload = {
    v: 1, id: b64u(crypto.randomBytes(12)), vk, fileId, domain: domain || null,
    size: Number(size) || 0, nodes: nodes.slice(0, 64), iat: now, exp: now + TICKET_TTL_MS, epoch: epochOf(now),
  };
  const body = b64u(JSON.stringify(payload));
  const mac = b64u(crypto.createHmac('sha256', secret).update(body).digest());
  return { token: `${body}.${mac}`, payload };
}

/** @returns {object} payload; lança se adulterado/expirado */
function verifyTicket(secret, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 8192) throw new Error('bilhete inválido');
  const [body, mac] = token.split('.');
  if (!body || !mac) throw new Error('bilhete inválido');
  const want = crypto.createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new Error('bilhete adulterado');
  const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (p.v !== 1) throw new Error('versão de bilhete desconhecida');
  if (now > p.exp) throw new Error('bilhete expirado');
  return p;
}

const receiptMessage = (ticketId, fileId, node, bytes) =>
  `vagalun-receipt:v1\n${ticketId}\n${fileId}\n${node}\n${bytes}`;

function signReceipt(secretKey64, ticketPayload, node, bytes) {
  const msg = Buffer.from(receiptMessage(ticketPayload.id, ticketPayload.fileId, node, bytes), 'utf8');
  return Buffer.from(nacl.sign.detached(msg, secretKey64)).toString('base64');
}

function verifyReceiptSig(ticketPayload, { node, bytes, sig }) {
  try {
    const msg = Buffer.from(receiptMessage(ticketPayload.id, ticketPayload.fileId, node, bytes), 'utf8');
    const s = Buffer.from(String(sig), 'base64');
    if (s.length !== 64) return false;
    return nacl.sign.detached.verify(msg, s, bs58.decode(ticketPayload.vk));
  } catch { return false; }
}

module.exports = { issueTicket, verifyTicket, signReceipt, verifyReceiptSig, receiptMessage, isPubkeyB58, epochOf, TICKET_TTL_MS, WEEK_MS };
