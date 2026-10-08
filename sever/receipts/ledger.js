'use strict';

/**
 * Agregação de recibos por época + tetos anti-abuso.
 *
 * Modelo de ameaça (importante): o nó e o viewer podem ser a mesma pessoa, e
 * as chaves efêmeras do player são de graça. Mas o dinheiro NÃO é criado aqui:
 * cada byte aceito vira cobrança no saldo do DONO DO SITE (ver settle), e o nó
 * recebe uma fração do que foi cobrado. Então:
 *   - dono == atacante: gasta US$ 1, recebe de volta US$ 0,70 (NODE_SHARE). Prejuízo.
 *   - atacante != dono (o caso perigoso): um nó malicioso que guarda o arquivo de
 *     OUTRA pessoa forja recibos pra drenar o saldo dela pra si. Por isso os tetos:
 *       bilhete  -> no máx. tamanho do arquivo × TICKET_OVERHEAD, só pros nós listados
 *       viewer   -> MAX_VIEWER_BYTES por época
 *       IP       -> MAX_TICKETS_PER_IP, MAX_IP_BYTES e MAX_IP_NODE_BYTES por época
 *     e, no hosting, um teto diário de gasto por dono (DELIVERY_DAILY_CAP_USD).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { verifyTicket, verifyReceiptSig, epochOf } = require('./receipt');
const { writeJsonAtomic } = require('./deliveryLedger');

const num = (k, d) => Number(process.env[k] || d);
const LIMITS = () => ({
  ticketOverhead: num('RECEIPT_TICKET_OVERHEAD', 1.25),
  maxViewerBytes: num('RECEIPT_MAX_VIEWER_BYTES', 20e9),
  maxTicketsPerIp: num('RECEIPT_MAX_TICKETS_PER_IP', 2000),
  maxIpBytes: num('RECEIPT_MAX_IP_BYTES', 50e9),
  maxIpNodeBytes: num('RECEIPT_MAX_IP_NODE_BYTES', 10e9),
  maxReceiptsPerSubmit: 32,
});

class ReceiptLedger {
  constructor({ dir, secret, now = () => Date.now() }) {
    this.dir = dir; this.secret = secret; this.now = now;
    this.file = path.join(dir, 'receipts-state.json');
    this.state = { epochs: {}, meta: { seq: 0, pending: null } };
    try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* começa vazio */ }
    this._dirty = false;
  }

  _epoch(e) {
    return (this.state.epochs[e] ||= { tickets: {}, viewers: {}, ips: {}, usage: {} });
  }
  save() { if (this._dirty) { writeJsonAtomic(this.file, this.state); this._dirty = false; } }
  _touch() { this._dirty = true; }

  /** Chamado quando o gateway emite um bilhete. false = IP estourou o teto (sem bilhete = sem pagamento). */
  noteTicketIssued(ip) {
    const ep = this._epoch(epochOf(this.now()));
    const row = (ep.ips[ip] ||= { tickets: 0, bytes: 0, byNode: {} });
    if (row.tickets >= LIMITS().maxTicketsPerIp) return false;
    row.tickets++; this._touch();
    return true;
  }

  /**
   * @param {string} token  bilhete emitido pelo gateway
   * @param {{node:string, bytes:number, sig:string}[]} receipts  cumulativos, assinados pela vk do bilhete
   */
  accept(token, receipts, ip) {
    const L = LIMITS();
    const out = { accepted: [], rejected: [] };
    let t;
    try { t = verifyTicket(this.secret, token, this.now()); } catch (e) { out.error = e.message; return out; }
    if (t.epoch < epochOf(this.now()) - 1) { out.error = 'época encerrada'; return out; }
    if (!Array.isArray(receipts) || receipts.length === 0) { out.error = 'sem recibos'; return out; }

    const ep = this._epoch(t.epoch);
    const tk = (ep.tickets[t.id] ||= { nodes: {}, total: 0, domain: t.domain, fileId: t.fileId });
    const ipRow = (ep.ips[ip] ||= { tickets: 0, bytes: 0, byNode: {} });
    const budget = t.size * L.ticketOverhead;

    for (const r of receipts.slice(0, L.maxReceiptsPerSubmit)) {
      const rej = (reason) => out.rejected.push({ node: r && r.node, reason });
      if (!r || typeof r.node !== 'string' || !Number.isSafeInteger(r.bytes) || r.bytes <= 0) { rej('malformado'); continue; }
      if (!t.nodes.includes(r.node)) { rej('nó fora do bilhete'); continue; }
      if (!verifyReceiptSig(t, r)) { rej('assinatura inválida'); continue; }
      const prev = tk.nodes[r.node] || 0;
      if (r.bytes <= prev) { rej('duplicado/antigo'); continue; }      // cumulativo: só vale se cresceu
      const delta = r.bytes - prev;
      if (tk.total + delta > budget) { rej('acima do tamanho do arquivo'); continue; }
      if ((ep.viewers[t.vk] || 0) + delta > L.maxViewerBytes) { rej('teto do viewer'); continue; }
      if (ipRow.bytes + delta > L.maxIpBytes) { rej('teto do IP'); continue; }
      if ((ipRow.byNode[r.node] || 0) + delta > L.maxIpNodeBytes) { rej('teto IP→nó'); continue; }

      tk.nodes[r.node] = r.bytes; tk.total += delta;
      ep.viewers[t.vk] = (ep.viewers[t.vk] || 0) + delta;
      ipRow.bytes += delta; ipRow.byNode[r.node] = (ipRow.byNode[r.node] || 0) + delta;
      const key = `${r.node}\u0001${t.domain || ''}\u0001${t.fileId}`;
      const u = (ep.usage[key] ||= { node: r.node, domain: t.domain || '', fileId: t.fileId, bytes: 0, settled: 0 });
      u.bytes += delta;
      out.accepted.push({ node: r.node, deltaBytes: delta });
    }
    if (out.accepted.length) this._touch();
    return out;
  }

  /** Monta (ou reaproveita) o lote pendente. Persistir o lote ANTES de chamar o hosting é o que
   *  torna a retentativa idempotente: mesmo batchId => o hosting não cobra duas vezes. */
  buildBatch() {
    if (this.state.meta.pending) return this.state.meta.pending;
    const lines = [];
    for (const [e, ep] of Object.entries(this.state.epochs)) {
      for (const [key, u] of Object.entries(ep.usage)) {
        if (u.bytes > u.settled) lines.push({ e, key, node: u.node, domain: u.domain, fileId: u.fileId, bytes: u.bytes - u.settled });
      }
    }
    if (!lines.length) return null;
    const id = `b${Date.now().toString(36)}-${this.state.meta.seq++}-${crypto.randomBytes(3).toString('hex')}`;
    this.state.meta.pending = { id, lines };
    this._touch(); this.save();
    return this.state.meta.pending;
  }

  commitBatch(batch) {
    for (const l of batch.lines) {
      const u = this.state.epochs[l.e] && this.state.epochs[l.e].usage[l.key];
      if (u) u.settled += l.bytes;
    }
    this.state.meta.pending = null;
    // poda épocas antigas totalmente liquidadas
    const cur = epochOf(this.now());
    for (const [e, ep] of Object.entries(this.state.epochs)) {
      if (Number(e) < cur - 3 && Object.values(ep.usage).every((u) => u.settled >= u.bytes)) delete this.state.epochs[e];
    }
    this._touch(); this.save();
  }
}

module.exports = { ReceiptLedger, LIMITS };
