'use strict';

/** Cola gateway ⇄ ledger ⇄ hosting ⇄ crédito do nó. */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ReceiptLedger } = require('./ledger');
const { issueTicket, isPubkeyB58 } = require('./receipt');
const { usdForBytes, NODE_SHARE } = require('./pricing');
const delivery = require('./deliveryLedger');

function loadSecret(dir) {
  if (process.env.RECEIPT_TICKET_SECRET) return process.env.RECEIPT_TICKET_SECRET;
  const f = path.join(dir, 'ticket-secret');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch { /* gera */ }
  fs.mkdirSync(dir, { recursive: true });
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

function createReceiptService({ registry, hosting = null, dir = process.env.RECEIPTS_DIR || path.join(__dirname, '..', 'data', 'receipts'),
  resolvePayoutKey = (node) => (isPubkeyB58(node) ? node : null), now = () => Date.now() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  process.env.RECEIPTS_DIR = dir; // deliveryLedger lê daqui
  const secret = loadSecret(dir);
  const ledger = new ReceiptLedger({ dir, secret, now });

  // fileId -> domínio (índice reverso do registry, cache curto)
  let idx = null, idxAt = 0;
  function domainOfFile(fileId) {
    if (!idx || now() - idxAt > 30_000) {
      idx = new Map();
      for (const d of registry.listSites()) {
        const s = registry.getSiteFull(d);
        for (const r of (s && s.routes ? s.routes.values() : [])) if (!idx.has(r.fileId)) idx.set(r.fileId, d);
      }
      idxAt = now();
    }
    return idx.get(fileId) || null;
  }

  return {
    ledger, domainOfFile,

    /** @returns {string|null} token do bilhete (null = viewer sem vk válida, IP no teto, ou arquivo sem nós) */
    issueForP2P({ file, vk, ip, nodes }) {
      if (!vk || !nodes.length) return null;
      try {
        if (!ledger.noteTicketIssued(ip)) return null;
        return issueTicket(secret, { fileId: file.fileId, domain: domainOfFile(file.fileId), size: file.originalLength, nodes, vk, now: now() }).token;
      } catch { return null; }
    },

    submit(body, ip) {
      const r = ledger.accept(body && body.ticket, body && body.receipts, ip);
      ledger.save();
      return r;
    },

    /** Liquida o que foi aceito: cobra do dono (hosting) e credita os nós. Seguro de repetir. */
    async settleOnce() {
      if (!hosting) return { skipped: 'sem HOSTING_URL/HOSTING_INTERNAL_TOKEN' };
      const batch = ledger.buildBatch();
      if (!batch) return { settled: 0 };

      const byDomain = new Map();
      for (const l of batch.lines) {
        const d = byDomain.get(l.domain) || { domain: l.domain, bytes: 0, files: {} };
        d.bytes += l.bytes; d.files[l.fileId] = (d.files[l.fileId] || 0) + l.bytes;
        byDomain.set(l.domain, d);
      }
      const items = [...byDomain.values()].map((d) => ({ ...d, usd: usdForBytes(d.bytes) }));
      const resp = await hosting.charge(batch.id, items); // se lançar: o lote fica pendente e repete com o MESMO id
      const ratio = new Map((resp.results || []).map((r) => [r.domain, r.requestedUsd > 0 ? Math.min(1, r.chargedUsd / r.requestedUsd) : 0]));

      let paidUsd = 0;
      const byKey = {}, byUnclaimed = {};
      for (const l of batch.lines) {
        const credit = usdForBytes(l.bytes) * (ratio.get(l.domain) || 0) * NODE_SHARE; // só o que o dono REALMENTE pagou
        if (credit <= 0) continue;
        const key = resolvePayoutKey(l.node);
        if (key) byKey[key] = (byKey[key] || 0) + credit; else byUnclaimed[l.node] = (byUnclaimed[l.node] || 0) + credit;
        paidUsd += credit;
      }
      delivery.applyBatch(batch.id, byKey, byUnclaimed); // idempotente por batch.id
      ledger.commitBatch(batch);
      return { settled: batch.lines.length, creditedUsd: paidUsd };
    },
  };
}

module.exports = { createReceiptService };
