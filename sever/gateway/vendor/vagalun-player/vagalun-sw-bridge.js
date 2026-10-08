/* vagalun-sw-bridge.js — script de PÁGINA que liga o Service Worker ao P2P do player.
 *
 *   <script src="/__vgl/vagalun-player.iife.js"></script>
 *   <script src="/__vgl/vagalun-sw-bridge.js"></script>
 *   <script>VagalunBridge.start({ seeds: ['https://outro-gateway.exemplo'] })</script>
 *
 * Registra o SW (escopo '/'), manda a lista de gateways e, quando TODOS os gateways HTTP caem, atende o
 * pedido 'vgl-p2p-fetch' do SW baixando o arquivo direto dos celulares (WebRTC não existe dentro de SW).
 * Requer um player com `VagalunPlayer.p2pFetchFile` (patch em engine.js/player.js).
 */
(function () {
  'use strict';
  const TICKET_KEY = (id) => 'vgl-ticket:' + id;

  async function ticketFor(fileId, gateways) {
    // 1) bilhete guardado de uma visita em que algum gateway ainda estava no ar
    try { const t = JSON.parse(localStorage.getItem(TICKET_KEY(fileId)) || 'null'); if (t && t.fileKeyB64) return t; } catch (_) {}
    // 2) qualquer gateway que ainda responda
    for (const gw of gateways || []) {
      try {
        const r = await fetch(gw.replace(/\/$/, '') + '/p2p/' + fileId, { cache: 'no-store' });
        if (!r.ok) continue;
        const t = await r.json();
        if (t && t.ok) { try { localStorage.setItem(TICKET_KEY(fileId), JSON.stringify(t)); } catch (_) {} return t; }
      } catch (_) { /* próximo */ }
    }
    return null;
  }

  async function onSwMessage(event) {
    const d = event.data || {};
    const port = event.ports && event.ports[0];
    if (d.type !== 'vgl-p2p-fetch' || !port) return;
    try {
      if (!window.VagalunPlayer || !window.VagalunPlayer.p2pFetchFile) throw new Error('player sem p2pFetchFile (aplique o patch do engine.js)');
      const ticket = await ticketFor(d.fileId, d.gateways);
      if (!ticket) throw new Error('sem bilhete P2P (nenhum gateway acessível e nada em cache)');
      const r = await window.VagalunPlayer.p2pFetchFile(ticket);
      const buf = r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength);
      port.postMessage({ ok: true, bytes: buf, contentType: r.contentType }, [buf]);
    } catch (e) {
      port.postMessage({ ok: false, error: String(e && e.message || e) });
    }
  }

  async function start({ seeds = [], strict = false, swUrl = '/vagalun-sw.js' } = {}) {
    if (!('serviceWorker' in navigator)) return null;
    navigator.serviceWorker.addEventListener('message', onSwMessage);
    const reg = await navigator.serviceWorker.register(swUrl, { scope: '/' });
    const ready = await navigator.serviceWorker.ready;
    (ready.active || reg.active || navigator.serviceWorker.controller)?.postMessage({ type: 'vgl-config', seeds, strict });
    return reg;
  }

  window.VagalunBridge = { start, _ticketFor: ticketFor, _onSwMessage: onSwMessage };
})();
