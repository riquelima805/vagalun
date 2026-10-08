// signalingClient.js — cliente de signaling FEDERADO.
//
// Mesma API pública do SignalingClient antigo (connect/disconnect/sendSignal/
// sendRelay/sendRelayResponse/connected + callbacks onSignal, onPeerList,
// onPeerJoined, onPeerLeft, onRelayRequest, onRelayResponse, onError,
// onStateChange), então P2PManager / WebRtcManager não mudam.
//
// O que muda por baixo:
//   - mantém até `maxActive` conexões ao MESMO TEMPO (default 3), pegando os
//     primeiros signalers saudáveis da lista (a ordem é igual pra todos => overlap);
//   - link caiu -> backoff nele e promove o próximo da lista, sem o resto perceber;
//   - envia signal por todos os links que conhecem o destino; o receptor deduplica
//     por _mid (WebRTC não gosta de offer duplicada);
//   - relay vai por UM link e faz retry em outro se vier relay_error;
//   - peers: união dos links. peer_left só dispara quando NENHUM link vê o peer.
//     Link que cai NÃO gera peer_left (o canal WebRTC já aberto não depende do signaler).

import { SignalerList, DEFAULT_SEEDS } from './signalerList.js';

export const SIGNALING_URL = 'wss://signal.vagalun.shop'; // mantido por compat

const DEDUPE_MAX = 1000;
const RELAY_TTL_MS = 30_000;

function bytesToB64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const rnd = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export class SignalingClient {
  /**
   * @param {object} o
   * @param {string} o.selfNodeId
   * @param {string|string[]} [o.url]        URL(s) preferida(s), ex.: a do bilhete /p2p do gateway. Entram NA FRENTE
   *                                          dos seeds padrão, então o failover continua valendo. (fixed:true = só elas)
   * @param {boolean} [o.fixed]
   * @param {SignalerList} [o.list]          lista dinâmica (seeds + remoto + aprendidos)
   * @param {number} [o.maxActive]           quantos signalers usar simultaneamente
   * @param {() => object} [o.registerExtra] campos extras no register (pubkey/sig quando houver wallet)
   * @param {typeof WebSocket} [o.WebSocketImpl]
   */
  constructor({ selfNodeId, url, list, fixed = false, maxActive = 3, registerExtra, WebSocketImpl, debug = false } = {}) {
    if (!selfNodeId) throw new Error('SignalingClient: selfNodeId é obrigatório');
    this.selfNodeId = selfNodeId;
    this.maxActive = Math.max(1, maxActive);
    this.registerExtra = registerExtra || null;
    this.WS = WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this._log = debug ? (...a) => console.log('[signaling]', ...a) : () => {};

    if (list) this.list = list;
    else if (url) {
      const arr = (Array.isArray(url) ? url : [url]);
      this.list = fixed
        ? new SignalerList({ seeds: arr, remoteLists: [], storage: null })
        : new SignalerList({ seeds: [...arr, ...DEFAULT_SEEDS] });
    } else this.list = new SignalerList();
    this.list.onChange = () => this._reconcile();

    this.onSignal = null; this.onStateChange = null; this.onPeerList = null;
    this.onPeerJoined = null; this.onPeerLeft = null; this.onRelayRequest = null;
    this.onRelayResponse = null; this.onError = null;

    this._links = new Map();       // url -> { url, ws, open, failures, nextTry, peers:Set }
    this._known = new Map();       // peerId -> Set(url)
    this._seen = new Map();        // _mid -> ts
    this._pendingSig = new Map();  // to -> { sent, offline, t }
    this._pendingRelay = new Map();// requestId -> { to, header, payload, tried:Set, t }
    this._relayOrigin = new Map(); // `${from}:${requestId}` -> url
    this._timer = null;
    this._closed = true;
    this._wasConnected = false;
  }

  /** URLs com conexão aberta agora (debug/painel). */
  activeUrls() { return [...this._links.values()].filter((l) => l.open).map((l) => l.url); }

  get connected() { return this.activeUrls().length > 0; }

  connect() {
    if (!this._closed) return;
    this._closed = false;
    this._reconcile();
    this._timer = setInterval(() => this._reconcile(), 3000);
    if (this._timer.unref) this._timer.unref();
    // lista remota em segundo plano: não bloqueia a primeira conexão (seeds já bastam)
    this.list.refreshRemote().catch(() => {});
  }

  disconnect() {
    this._closed = true;
    clearInterval(this._timer);
    for (const l of this._links.values()) { try { l.ws && l.ws.close(1000, 'bye'); } catch (_) {} }
    this._links.clear();
    this._known.clear();
    this._emitState();
  }

  // ---------- gerência de links ----------

  _reconcile() {
    if (this._closed || !this.WS) return;
    const now = Date.now();
    const urls = this.list.urls();
    let active = [...this._links.values()].filter((l) => l.open || l.connecting).length;
    for (const url of urls) {
      if (active >= this.maxActive) break;
      let l = this._links.get(url);
      if (!l) { l = { url, ws: null, open: false, connecting: false, failures: 0, nextTry: 0, peers: new Set() }; this._links.set(url, l); }
      if (l.open || l.connecting || l.nextTry > now) continue;
      this._openLink(l);
      active++;
    }
    this._prune(now);
  }

  _openLink(l) {
    l.connecting = true;
    let ws;
    try { ws = new this.WS(l.url); } catch (e) { this._linkDown(l, ws); return; }
    l.ws = ws;
    ws.onopen = () => {
      if (l.ws !== ws) return;
      l.open = true; l.connecting = false; l.failures = 0;
      const extra = this.registerExtra ? this.registerExtra() : {};
      ws.send(JSON.stringify({ type: 'register', nodeId: this.selfNodeId, ...extra }));
      this._log('link aberto', l.url);
      this._emitState();
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      this._onMessage(l, m);
    };
    ws.onclose = () => this._linkDown(l, ws);
    ws.onerror = () => {};
  }

  _linkDown(l, ws) {
    if (ws && l.ws !== ws) return;
    const wasOpen = l.open;
    l.open = false; l.connecting = false; l.ws = null;
    l.failures += 1;
    l.nextTry = Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(l.failures, 6)) + Math.random() * 500;
    // esquece este link como fonte de peers (sem emitir peer_left — ver cabeçalho)
    for (const [id, srcs] of this._known) { srcs.delete(l.url); if (!srcs.size) this._known.delete(id); }
    l.peers.clear();
    this._log('link caiu', l.url, 'falhas', l.failures);
    if (wasOpen) this._emitState();
    this._reconcile(); // promove o próximo da lista imediatamente
  }

  _emitState() {
    const now = this.connected;
    if (now !== this._wasConnected) { this._wasConnected = now; this.onStateChange && this.onStateChange(now); }
  }

  // ---------- recepção ----------

  _addSource(id, url) {
    let s = this._known.get(id);
    const isNew = !s;
    if (!s) { s = new Set(); this._known.set(id, s); }
    s.add(url);
    return isNew;
  }

  _onMessage(l, m) {
    switch (m.type) {
      case 'peers': {
        const fresh = [];
        for (const id of Array.isArray(m.nodeIds) ? m.nodeIds : []) {
          if (id === this.selfNodeId) continue;
          l.peers.add(id);
          if (this._addSource(id, l.url)) fresh.push(id);
        }
        if (fresh.length && this.onPeerList) this.onPeerList(fresh);
        break;
      }
      case 'peer_joined':
        if (m.nodeId && m.nodeId !== this.selfNodeId && this._addSource(m.nodeId, l.url)) this.onPeerJoined && this.onPeerJoined(m.nodeId);
        break;
      case 'peer_left': {
        const s = this._known.get(m.nodeId);
        if (!s) break;
        s.delete(l.url);
        if (!s.size) { this._known.delete(m.nodeId); this.onPeerLeft && this.onPeerLeft(m.nodeId); }
        break;
      }
      case 'signal': {
        const p = m.payload;
        if (p && typeof p === 'object' && p._mid) {
          if (this._seen.has(p._mid)) break;           // cópia que chegou por outro signaler
          this._seen.set(p._mid, Date.now());
          const { _mid, ...clean } = p;
          this.onSignal && this.onSignal(m.from, clean);
        } else this.onSignal && this.onSignal(m.from, p);
        break;
      }
      case 'relay':
        this._relayOrigin.set(`${m.from}:${m.requestId}`, l.url);
        this.onRelayRequest && this.onRelayRequest(m.from, m.requestId, m.header, m.payloadBase64 ? b64ToBytes(m.payloadBase64) : null);
        break;
      case 'relay_response':
        this._pendingRelay.delete(m.requestId);
        this.onRelayResponse && this.onRelayResponse(m.from, m.requestId, m.header, m.payloadBase64 ? b64ToBytes(m.payloadBase64) : null);
        break;
      case 'relay_error': {
        const pr = this._pendingRelay.get(m.requestId);
        if (pr && this._resendRelay(m.requestId, pr)) break;   // outro signaler tentou
        this._pendingRelay.delete(m.requestId);
        this.onError && this.onError(m.reason || 'relay_error', m.requestId ?? null);
        break;
      }
      case 'error': {
        if (m.reason === 'peer_offline' && m.to) {
          const p = this._pendingSig.get(m.to);
          if (p) { p.offline += 1; if (p.offline < p.sent) break; this._pendingSig.delete(m.to); }
        }
        this.onError && this.onError(m.reason || 'erro_desconhecido', m.detail || m.to || null);
        break;
      }
      case 'signalers':
        this.list.addLearned(m.urls);
        break;
      default: break;
    }
  }

  // ---------- envio ----------

  _open() { return [...this._links.values()].filter((l) => l.open); }
  _raw(l, obj) { try { l.ws.send(JSON.stringify(obj)); return true; } catch (_) { return false; } }

  /** links que conhecem `to`; se nenhum conhece (lista ainda não chegou), todos os abertos. */
  _targetsFor(to) {
    const open = this._open();
    const knowing = open.filter((l) => (this._known.get(to) || new Set()).has(l.url));
    return knowing.length ? knowing : open;
  }

  sendSignal(to, payload) {
    const targets = this._targetsFor(to);
    if (!targets.length) return;
    const body = payload && typeof payload === 'object' ? { ...payload, _mid: rnd() } : payload;
    let sent = 0;
    for (const l of targets) if (this._raw(l, { type: 'signal', to, from: this.selfNodeId, payload: body })) sent++;
    const p = this._pendingSig.get(to) || { sent: 0, offline: 0, t: 0 };
    p.sent += sent; p.t = Date.now();
    this._pendingSig.set(to, p);
  }

  sendRelay(to, requestId, header, payload) {
    const entry = { to, header, payload, tried: new Set(), t: Date.now() };
    this._pendingRelay.set(requestId, entry);
    if (!this._resendRelay(requestId, entry)) {
      this._pendingRelay.delete(requestId);
      this.onError && this.onError('no_signaler', null);
    }
  }

  _resendRelay(requestId, e) {
    const l = this._targetsFor(e.to).find((x) => !e.tried.has(x.url)) || this._open().find((x) => !e.tried.has(x.url));
    if (!l) return false;
    e.tried.add(l.url);
    const msg = { type: 'relay', to: e.to, requestId, header: e.header };
    if (e.payload) msg.payloadBase64 = bytesToB64(e.payload);
    return this._raw(l, msg);
  }

  sendRelayResponse(to, requestId, header, payload) {
    const origin = this._relayOrigin.get(`${to}:${requestId}`);
    this._relayOrigin.delete(`${to}:${requestId}`);
    const l = (origin && this._links.get(origin) && this._links.get(origin).open && this._links.get(origin)) || this._targetsFor(to)[0];
    if (!l) return;
    const msg = { type: 'relay_response', to, requestId, header };
    if (payload) msg.payloadBase64 = bytesToB64(payload);
    this._raw(l, msg);
  }

  _prune(now) {
    if (this._seen.size > DEDUPE_MAX) {
      const cut = [...this._seen.entries()].sort((a, b) => a[1] - b[1]).slice(0, this._seen.size - DEDUPE_MAX / 2);
      for (const [k] of cut) this._seen.delete(k);
    }
    for (const [k, v] of this._pendingSig) if (now - v.t > 10_000) this._pendingSig.delete(k);
    for (const [k, v] of this._pendingRelay) if (now - v.t > RELAY_TTL_MS) this._pendingRelay.delete(k);
    if (this._relayOrigin.size > 2000) this._relayOrigin.clear();
  }
}
