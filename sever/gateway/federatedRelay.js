'use strict';

/**
 * federatedRelay.js — o gateway fala com os celulares (relay) por VÁRIOS signalers ao mesmo tempo.
 *
 * Substitui relayTransport.connectRelay quando GATEWAY_SIGNALING_URLS tem mais de uma URL
 * (ou sempre, se preferir). Mesma interface: `client.request(toNodeId, header, payload, timeoutMs)`.
 *
 *  - mantém até `maxActive` conexões, na ordem da lista (mesma ordem dos clientes => overlap de peers);
 *  - link caiu -> backoff e o próximo da lista é promovido (nunca fica "preso numa promise morta");
 *  - cada tentativa usa requestId NOVO; erro/timeout curto -> tenta o próximo link; 1ª resposta vence;
 *  - aprende signalers anunciados (`signalers`), só no fim da lista e com teto — não expulsa os configurados.
 */

const WebSocket = require('ws');

function normalize(u) {
  if (typeof u !== 'string') return null;
  let s = u.trim();
  if (s.startsWith('https://')) s = 'wss://' + s.slice(8);
  else if (s.startsWith('http://')) s = 'ws://' + s.slice(7);
  return /^wss?:\/\/[^\s/]+/.test(s) ? s.replace(/\/+$/, '') : null;
}

function connectFederatedRelay({
  urls, selfNodeId, maxActive = 3, maxLearned = 4, attemptTimeoutMs = 8000, WebSocketImpl = WebSocket, log = () => {},
}) {
  const seeds = [...new Set((urls || []).map(normalize).filter(Boolean))];
  if (!seeds.length) throw new Error('federatedRelay: nenhuma URL de signaling válida');
  const learned = [];
  const links = new Map(); // url -> { url, ws, open, connecting, failures, nextTry }
  const pending = new Map(); // requestId -> { resolve, reject, timer, url }
  let counter = 0;
  let closed = false;
  const waiters = []; // quem pediu request() com 0 links abertos

  const allUrls = () => [...new Set([...seeds, ...learned])];
  const openLinks = () => [...links.values()].filter((l) => l.open);

  function reconcile() {
    if (closed) return;
    const now = Date.now();
    let active = [...links.values()].filter((l) => l.open || l.connecting).length;
    for (const url of allUrls()) {
      if (active >= maxActive) break;
      let l = links.get(url);
      if (!l) { l = { url, ws: null, open: false, connecting: false, failures: 0, nextTry: 0 }; links.set(url, l); }
      if (l.open || l.connecting || l.nextTry > now) continue;
      openLink(l); active++;
    }
  }

  function down(l, ws) {
    if (ws && l.ws !== ws) return;
    l.open = false; l.connecting = false; l.ws = null;
    l.failures += 1;
    l.nextTry = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(l.failures, 6)) + Math.random() * 400;
    for (const [id, p] of pending) if (p.url === l.url) { pending.delete(id); clearTimeout(p.timer); p.reject(new Error('conexão com o signaling caiu')); }
    log('link caiu', l.url);
    reconcile();
  }

  function openLink(l) {
    l.connecting = true;
    let ws;
    try { ws = new WebSocketImpl(l.url); } catch (e) { down(l, null); return; }
    l.ws = ws;
    ws.on('open', () => {
      if (l.ws !== ws) return;
      l.open = true; l.connecting = false; l.failures = 0;
      ws.send(JSON.stringify({ type: 'register', nodeId: selfNodeId }));
      log('link aberto', l.url);
      while (waiters.length) waiters.shift()();
    });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      if (m.type === 'relay_response') {
        const p = pending.get(m.requestId);
        if (!p) return;
        pending.delete(m.requestId); clearTimeout(p.timer);
        p.resolve({ header: m.header, payload: m.payloadBase64 ? Buffer.from(m.payloadBase64, 'base64') : null });
      } else if (m.type === 'relay_error') {
        const p = pending.get(m.requestId);
        if (!p) return;
        pending.delete(m.requestId); clearTimeout(p.timer);
        p.reject(new Error(m.reason || 'erro no relay'));
      } else if (m.type === 'signalers' && Array.isArray(m.urls)) {
        for (const u of m.urls.map(normalize).filter(Boolean)) {
          if (learned.length < maxLearned && !seeds.includes(u) && !learned.includes(u)) learned.push(u);
        }
      }
    });
    ws.on('close', () => down(l, ws));
    ws.on('error', () => {});
  }

  function waitForLink(ms) {
    if (openLinks().length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('nenhum signaling alcançável')), ms);
      waiters.push(() => { clearTimeout(t); resolve(); });
      reconcile();
    });
  }

  function attempt(l, toNodeId, header, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const requestId = ++counter;
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`timeout esperando resposta de ${toNodeId}`)); }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer, url: l.url });
      const msg = { type: 'relay', to: toNodeId, requestId, header };
      if (payload) msg.payloadBase64 = payload.toString('base64');
      try { l.ws.send(JSON.stringify(msg)); } catch (e) { pending.delete(requestId); clearTimeout(timer); reject(e); }
    });
  }

  const client = {
    async request(toNodeId, header, payload, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      await waitForLink(Math.min(timeoutMs, 5000));
      const tried = new Set();
      let lastErr = new Error('sem resposta');
      for (;;) {
        const l = openLinks().find((x) => !tried.has(x.url));
        if (!l) throw lastErr;
        tried.add(l.url);
        const left = deadline - Date.now();
        if (left <= 0) throw lastErr;
        // com mais de um link disponível, não gasta o orçamento todo num só
        const per = openLinks().some((x) => !tried.has(x.url)) ? Math.min(left, attemptTimeoutMs) : left;
        try { return await attempt(l, toNodeId, header, payload, per); } catch (e) { lastErr = e; }
      }
    },
    activeUrls: () => openLinks().map((l) => l.url),
    urls: allUrls,
    close() { closed = true; clearInterval(timer); for (const l of links.values()) { try { l.ws && l.ws.close(); } catch (_) {} } },
  };
  const timer = setInterval(reconcile, 3000);
  timer.unref();
  reconcile();
  return client;
}

module.exports = { connectFederatedRelay, normalize };
