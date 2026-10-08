'use strict';

/**
 * Crédito de entrega por pubkey, no mesmo molde do points.js (cursor
 * "acumulado − já pago"). Dois arquivos, cada um com UM escritor, pra gateway
 * e epochJob poderem rodar em processos diferentes sem sobrescrever um ao outro:
 *   delivery-accrued.json  — escrito só pelo gateway (settle)
 *   delivery-paid.json     — escrito só pelo epochJob (depois da tx confirmar)
 */

const fs = require('fs');
const path = require('path');

const DIR = () => process.env.RECEIPTS_DIR || path.join(__dirname, '..', 'data', 'receipts');
const ACC = () => path.join(DIR(), 'delivery-accrued.json');
const PAID = () => path.join(DIR(), 'delivery-paid.json');
const round = (n) => Math.round(n * 1e9) / 1e9;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// ---- lado do gateway ----
/** Aplica um lote inteiro de uma vez, de forma idempotente por batchId (retry após queda não credita duas vezes). */
function applyBatch(batchId, byPubkey, byUnclaimedNode) {
  const d = readJson(ACC(), { accrued: {}, unclaimed: {}, batches: [] });
  d.batches ||= [];
  if (d.batches.includes(batchId)) return false;
  for (const [k, usd] of Object.entries(byPubkey)) d.accrued[k] = round((d.accrued[k] || 0) + usd);
  // nó cuja identidade não é uma pubkey de pagamento (ex.: nodeId do app ≠ wallet): guarda, não paga.
  for (const [k, usd] of Object.entries(byUnclaimedNode)) d.unclaimed[k] = round((d.unclaimed[k] || 0) + usd);
  d.batches = [...d.batches, batchId].slice(-200);
  writeJsonAtomic(ACC(), d);
  return true;
}

// ---- lado do epochJob ----
function getAllPubkeys() { return Object.keys(readJson(ACC(), { accrued: {} }).accrued); }
function getUnpaidUsd(pubkey) {
  const acc = readJson(ACC(), { accrued: {} }).accrued[pubkey] || 0;
  const paid = readJson(PAID(), { paid: {} }).paid[pubkey] || 0;
  return Math.max(0, round(acc - paid));
}
function markPaid(pubkey, usd) {
  const d = readJson(PAID(), { paid: {} });
  d.paid[pubkey] = round((d.paid[pubkey] || 0) + usd);
  writeJsonAtomic(PAID(), d);
}

module.exports = { applyBatch, getAllPubkeys, getUnpaidUsd, markPaid, writeJsonAtomic, readJson };
