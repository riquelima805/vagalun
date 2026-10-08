// Recibos de entrega, lado do player.
//
// Uma chave ed25519 EFÊMERA por carregamento de página (nada de wallet nem login pro viewer). A pubkey (vk) vai
// no pedido do bilhete (/p2p/:fileId?vk=...); o gateway amarra o bilhete a ela. Depois o player assina, por nó,
// "neste bilhete recebi <bytes cumulativos> do nó <X>" — mesma mensagem que sever/receipts/receipt.js verifica.
//
// Usa WebCrypto Ed25519 (Chrome 137+, Firefox 129+, Safari 17+). Onde não existir, getSigner() devolve null e o
// vídeo toca normal — só não gera recibo (o nó não é pago por essa sessão). Melhor esforço, nunca lança.

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58encode(bytes) {
  let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) { carry += digits[j] << 8; digits[j] = carry % 58; carry = (carry / 58) | 0; }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => B58[d]).join('');
}

export const receiptMessage = (ticketId, fileId, node, bytes) =>
  `vagalun-receipt:v1\n${ticketId}\n${fileId}\n${node}\n${bytes}`;

let _signerPromise = null;
/** @returns {Promise<{vk:string, sign:(msg:string)=>Promise<string>}|null>} uma por página */
export function getSigner() {
  if (_signerPromise) return _signerPromise;
  _signerPromise = (async () => {
    try {
      const subtle = typeof crypto !== 'undefined' && crypto.subtle;
      if (!subtle) return null;
      const kp = await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
      const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
      if (raw.length !== 32) return null;
      return {
        vk: b58encode(raw),
        async sign(msg) {
          const sig = new Uint8Array(await subtle.sign({ name: 'Ed25519' }, kp.privateKey, new TextEncoder().encode(msg)));
          let s = ''; for (const b of sig) s += String.fromCharCode(b);
          return btoa(s);
        },
      };
    } catch (_) { return null; } // navegador sem Ed25519 no WebCrypto
  })();
  return _signerPromise;
}

/** Acumula bytes por nó e manda recibos cumulativos assinados. Nunca lança, nunca bloqueia a reprodução. */
export class ReceiptSender {
  constructor(manifest, signer) {
    this.signer = signer;
    this.ticket = manifest.receiptTicket || null;
    this.url = manifest._receiptsUrl || null;
    this.fileId = manifest.fileId;
    this.ticketId = null;
    try { if (this.ticket) this.ticketId = JSON.parse(atob(this.ticket.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))).id; } catch (_) {}
    this.cum = {};        // relayNodeId -> bytes cumulativos recebidos
    this.signed = {};     // relayNodeId -> { bytes, sig } (último assinado)
    this.sent = {};       // relayNodeId -> bytes já enviados
    this._timer = null; this._lastSend = 0;
  }
  get enabled() { return !!(this.signer && this.ticket && this.ticketId && this.url); }

  add(bytes, relayNodeId) {
    if (!this.enabled || !relayNodeId) return; // "último recurso" sem nó identificado: sem recibo
    this.cum[relayNodeId] = (this.cum[relayNodeId] || 0) + bytes;
    if (!this._timer) this._timer = setTimeout(() => { this._timer = null; this._presign().then(() => {
      if (Date.now() - this._lastSend > 30000) this.send();   // sessão longa: não espera só o fim
    }); }, 1500);
  }

  async _presign() {
    for (const [node, bytes] of Object.entries(this.cum)) {
      if ((this.signed[node]?.bytes || 0) >= bytes) continue;
      try { this.signed[node] = { bytes, sig: await this.signer.sign(receiptMessage(this.ticketId, this.fileId, node, bytes)) }; } catch (_) {}
    }
  }

  /** Síncrono de propósito: no pagehide só dá tempo de sendBeacon com o que JÁ está assinado (≤ ~1,5 s defasado). */
  send() {
    if (!this.enabled) return;
    const receipts = [];
    for (const [node, s] of Object.entries(this.signed)) if (s.bytes > (this.sent[node] || 0)) receipts.push({ node, bytes: s.bytes, sig: s.sig });
    if (!receipts.length) { this._presign().catch(() => {}); return; }
    const body = JSON.stringify({ ticket: this.ticket, receipts });
    try {
      const blob = new Blob([body], { type: 'text/plain' }); // CORS "simples": sendBeacon cross-origin sem preflight
      if (!(typeof navigator !== 'undefined' && navigator.sendBeacon && navigator.sendBeacon(this.url, blob))) {
        fetch(this.url, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, keepalive: true, mode: 'cors' }).catch(() => {});
      }
      for (const r of receipts) this.sent[r.node] = r.bytes;
      this._lastSend = Date.now();
    } catch (_) { /* melhor esforço */ }
    this._presign().catch(() => {}); // já deixa o próximo pronto
  }
}
