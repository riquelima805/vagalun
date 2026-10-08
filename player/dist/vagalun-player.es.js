const we = ["wss://signal.vagalun.shop"], Ce = [
  "https://raw.githubusercontent.com/riquelima805/adla-nft-market/refs/heads/main/reley.json"
], oe = "vagalun.signalers.learned.v1";
function R(r) {
  if (typeof r != "string") return null;
  let e = r.trim();
  return !e || (e.startsWith("https://") ? e = "wss://" + e.slice(8) : e.startsWith("http://") && (e = "ws://" + e.slice(7)), !/^wss?:\/\/[^\s/]+/.test(e)) ? null : e.replace(/\/+$/, "");
}
function Re(r) {
  const e = [];
  if (!r || typeof r != "object") return e;
  Array.isArray(r.signalers) && e.push(...r.signalers);
  for (const t of ["signalingUrl", "url", "wss"]) typeof r[t] == "string" && e.push(r[t]);
  return e.map(R).filter(Boolean);
}
class J {
  /**
   * @param {object} [o]
   * @param {string[]} [o.seeds]
   * @param {string[]} [o.remoteLists]
   * @param {boolean}  [o.allowInsecure] aceita ws:// (PC node sem TLS). Em página https o browser bloqueia mesmo assim.
   * @param {number}   [o.maxLearned]
   * @param {Storage}  [o.storage]
   * @param {typeof fetch} [o.fetchImpl]
   */
  constructor(e = {}) {
    var t, s;
    this.allowInsecure = (t = e.allowInsecure) != null ? t : !0, this.maxLearned = (s = e.maxLearned) != null ? s : 5, this.fetchImpl = e.fetchImpl || (typeof fetch == "function" ? fetch.bind(globalThis) : null), this.storage = "storage" in e ? e.storage : typeof localStorage != "undefined" ? localStorage : null, this._seeds = (e.seeds || we).map(R).filter(Boolean), this._remoteUrls = e.remoteLists || Ce, this._remote = [], this._learned = [], this._sources = [], this.onChange = null;
    try {
      const n = this.storage && this.storage.getItem(oe);
      if (n) {
        const i = JSON.parse(n);
        this._remote = (i.remote || []).map(R).filter(Boolean), this._learned = (i.learned || []).map(R).filter(Boolean).slice(0, this.maxLearned);
      }
    } catch (n) {
    }
  }
  _ok(e) {
    return this.allowInsecure || e.startsWith("wss://");
  }
  /** Lista final, ordenada e sem duplicatas. */
  urls() {
    const e = /* @__PURE__ */ new Set(), t = [];
    for (const s of [...this._seeds, ...this._remote, ...this._learned])
      s && this._ok(s) && !e.has(s) && (e.add(s), t.push(s));
    return t;
  }
  _persist() {
    try {
      this.storage && this.storage.setItem(oe, JSON.stringify({ remote: this._remote, learned: this._learned }));
    } catch (e) {
    }
  }
  _changed() {
    this._persist(), this.onChange && this.onChange(this.urls());
  }
  /** Chamado quando um signaler anuncia outros. Só acrescenta no fim, com teto. */
  addLearned(e) {
    const t = new Set(this.urls());
    let s = !1;
    for (const n of e || []) {
      const i = R(n);
      if (!(!i || !this._ok(i) || t.has(i))) {
        if (this._learned.length >= this.maxLearned) break;
        this._learned.push(i), t.add(i), s = !0;
      }
    }
    return s && this._changed(), s;
  }
  /** Fonte extra (ex.: ler SignalerRecord on-chain). Deve devolver string[]. */
  registerSource(e) {
    this._sources.push(e);
  }
  /** Busca TODAS as listas remotas em paralelo; falha de uma não afeta as outras. */
  async refreshRemote(e = 6e3) {
    const t = [];
    if (this.fetchImpl)
      for (const o of this._remoteUrls)
        t.push((async () => {
          const a = typeof AbortController != "undefined" ? new AbortController() : null, l = a && setTimeout(() => a.abort(), e);
          try {
            const c = await this.fetchImpl(o, { signal: a && a.signal, cache: "no-store" });
            return c.ok ? Re(await c.json()) : [];
          } catch (c) {
            return [];
          } finally {
            l && clearTimeout(l);
          }
        })());
    for (const o of this._sources) t.push(Promise.resolve().then(o).then((a) => (a || []).map(R).filter(Boolean)).catch(() => []));
    const s = (await Promise.all(t)).flat();
    if (!s.length) return !1;
    const n = [...new Set(s)];
    return n.length === this._remote.length && n.every((o, a) => o === this._remote[a]) ? !1 : (this._remote = n, this._changed(), !0);
  }
}
const Ue = "wss://signal.vagalun.shop", ae = 1e3, $e = 3e4;
function le(r) {
  if (typeof Buffer != "undefined") return Buffer.from(r).toString("base64");
  let e = "";
  for (let t = 0; t < r.length; t += 32768) e += String.fromCharCode.apply(null, r.subarray(t, t + 32768));
  return btoa(e);
}
function ce(r) {
  if (typeof Buffer != "undefined") return new Uint8Array(Buffer.from(r, "base64"));
  const e = atob(r), t = new Uint8Array(e.length);
  for (let s = 0; s < e.length; s++) t[s] = e.charCodeAt(s);
  return t;
}
const Be = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
class Oe {
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
  constructor({ selfNodeId: e, url: t, list: s, fixed: n = !1, maxActive: i = 3, registerExtra: o, WebSocketImpl: a, debug: l = !1 } = {}) {
    if (!e) throw new Error("SignalingClient: selfNodeId é obrigatório");
    if (this.selfNodeId = e, this.maxActive = Math.max(1, i), this.registerExtra = o || null, this.WS = a || (typeof WebSocket != "undefined" ? WebSocket : null), this._log = l ? (...c) => console.log("[signaling]", ...c) : () => {
    }, s) this.list = s;
    else if (t) {
      const c = Array.isArray(t) ? t : [t];
      this.list = n ? new J({ seeds: c, remoteLists: [], storage: null }) : new J({ seeds: [...c, ...we] });
    } else this.list = new J();
    this.list.onChange = () => this._reconcile(), this.onSignal = null, this.onStateChange = null, this.onPeerList = null, this.onPeerJoined = null, this.onPeerLeft = null, this.onRelayRequest = null, this.onRelayResponse = null, this.onError = null, this._links = /* @__PURE__ */ new Map(), this._known = /* @__PURE__ */ new Map(), this._seen = /* @__PURE__ */ new Map(), this._pendingSig = /* @__PURE__ */ new Map(), this._pendingRelay = /* @__PURE__ */ new Map(), this._relayOrigin = /* @__PURE__ */ new Map(), this._timer = null, this._closed = !0, this._wasConnected = !1;
  }
  /** URLs com conexão aberta agora (debug/painel). */
  activeUrls() {
    return [...this._links.values()].filter((e) => e.open).map((e) => e.url);
  }
  get connected() {
    return this.activeUrls().length > 0;
  }
  connect() {
    this._closed && (this._closed = !1, this._reconcile(), this._timer = setInterval(() => this._reconcile(), 3e3), this._timer.unref && this._timer.unref(), this.list.refreshRemote().catch(() => {
    }));
  }
  disconnect() {
    this._closed = !0, clearInterval(this._timer);
    for (const e of this._links.values())
      try {
        e.ws && e.ws.close(1e3, "bye");
      } catch (t) {
      }
    this._links.clear(), this._known.clear(), this._emitState();
  }
  // ---------- gerência de links ----------
  _reconcile() {
    if (this._closed || !this.WS) return;
    const e = Date.now(), t = this.list.urls();
    let s = [...this._links.values()].filter((n) => n.open || n.connecting).length;
    for (const n of t) {
      if (s >= this.maxActive) break;
      let i = this._links.get(n);
      i || (i = { url: n, ws: null, open: !1, connecting: !1, failures: 0, nextTry: 0, peers: /* @__PURE__ */ new Set() }, this._links.set(n, i)), !(i.open || i.connecting || i.nextTry > e) && (this._openLink(i), s++);
    }
    this._prune(e);
  }
  _openLink(e) {
    e.connecting = !0;
    let t;
    try {
      t = new this.WS(e.url);
    } catch (s) {
      this._linkDown(e, t);
      return;
    }
    e.ws = t, t.onopen = () => {
      if (e.ws !== t) return;
      e.open = !0, e.connecting = !1, e.failures = 0;
      const s = this.registerExtra ? this.registerExtra() : {};
      t.send(JSON.stringify({ type: "register", nodeId: this.selfNodeId, ...s })), this._log("link aberto", e.url), this._emitState();
    }, t.onmessage = (s) => {
      let n;
      try {
        n = JSON.parse(s.data);
      } catch (i) {
        return;
      }
      this._onMessage(e, n);
    }, t.onclose = () => this._linkDown(e, t), t.onerror = () => {
    };
  }
  _linkDown(e, t) {
    if (t && e.ws !== t) return;
    const s = e.open;
    e.open = !1, e.connecting = !1, e.ws = null, e.failures += 1, e.nextTry = Date.now() + Math.min(6e4, 1e3 * 2 ** Math.min(e.failures, 6)) + Math.random() * 500;
    for (const [n, i] of this._known)
      i.delete(e.url), i.size || this._known.delete(n);
    e.peers.clear(), this._log("link caiu", e.url, "falhas", e.failures), s && this._emitState(), this._reconcile();
  }
  _emitState() {
    const e = this.connected;
    e !== this._wasConnected && (this._wasConnected = e, this.onStateChange && this.onStateChange(e));
  }
  // ---------- recepção ----------
  _addSource(e, t) {
    let s = this._known.get(e);
    const n = !s;
    return s || (s = /* @__PURE__ */ new Set(), this._known.set(e, s)), s.add(t), n;
  }
  _onMessage(e, t) {
    var s;
    switch (t.type) {
      case "peers": {
        const n = [];
        for (const i of Array.isArray(t.nodeIds) ? t.nodeIds : [])
          i !== this.selfNodeId && (e.peers.add(i), this._addSource(i, e.url) && n.push(i));
        n.length && this.onPeerList && this.onPeerList(n);
        break;
      }
      case "peer_joined":
        t.nodeId && t.nodeId !== this.selfNodeId && this._addSource(t.nodeId, e.url) && this.onPeerJoined && this.onPeerJoined(t.nodeId);
        break;
      case "peer_left": {
        const n = this._known.get(t.nodeId);
        if (!n) break;
        n.delete(e.url), n.size || (this._known.delete(t.nodeId), this.onPeerLeft && this.onPeerLeft(t.nodeId));
        break;
      }
      case "signal": {
        const n = t.payload;
        if (n && typeof n == "object" && n._mid) {
          if (this._seen.has(n._mid)) break;
          this._seen.set(n._mid, Date.now());
          const { _mid: i, ...o } = n;
          this.onSignal && this.onSignal(t.from, o);
        } else this.onSignal && this.onSignal(t.from, n);
        break;
      }
      case "relay":
        this._relayOrigin.set(`${t.from}:${t.requestId}`, e.url), this.onRelayRequest && this.onRelayRequest(t.from, t.requestId, t.header, t.payloadBase64 ? ce(t.payloadBase64) : null);
        break;
      case "relay_response":
        this._pendingRelay.delete(t.requestId), this.onRelayResponse && this.onRelayResponse(t.from, t.requestId, t.header, t.payloadBase64 ? ce(t.payloadBase64) : null);
        break;
      case "relay_error": {
        const n = this._pendingRelay.get(t.requestId);
        if (n && this._resendRelay(t.requestId, n)) break;
        this._pendingRelay.delete(t.requestId), this.onError && this.onError(t.reason || "relay_error", (s = t.requestId) != null ? s : null);
        break;
      }
      case "error": {
        if (t.reason === "peer_offline" && t.to) {
          const n = this._pendingSig.get(t.to);
          if (n) {
            if (n.offline += 1, n.offline < n.sent) break;
            this._pendingSig.delete(t.to);
          }
        }
        this.onError && this.onError(t.reason || "erro_desconhecido", t.detail || t.to || null);
        break;
      }
      case "signalers":
        this.list.addLearned(t.urls);
        break;
    }
  }
  // ---------- envio ----------
  _open() {
    return [...this._links.values()].filter((e) => e.open);
  }
  _raw(e, t) {
    try {
      return e.ws.send(JSON.stringify(t)), !0;
    } catch (s) {
      return !1;
    }
  }
  /** links que conhecem `to`; se nenhum conhece (lista ainda não chegou), todos os abertos. */
  _targetsFor(e) {
    const t = this._open(), s = t.filter((n) => (this._known.get(e) || /* @__PURE__ */ new Set()).has(n.url));
    return s.length ? s : t;
  }
  sendSignal(e, t) {
    const s = this._targetsFor(e);
    if (!s.length) return;
    const n = t && typeof t == "object" ? { ...t, _mid: Be() } : t;
    let i = 0;
    for (const a of s) this._raw(a, { type: "signal", to: e, from: this.selfNodeId, payload: n }) && i++;
    const o = this._pendingSig.get(e) || { sent: 0, offline: 0, t: 0 };
    o.sent += i, o.t = Date.now(), this._pendingSig.set(e, o);
  }
  sendRelay(e, t, s, n) {
    const i = { to: e, header: s, payload: n, tried: /* @__PURE__ */ new Set(), t: Date.now() };
    this._pendingRelay.set(t, i), this._resendRelay(t, i) || (this._pendingRelay.delete(t), this.onError && this.onError("no_signaler", null));
  }
  _resendRelay(e, t) {
    const s = this._targetsFor(t.to).find((i) => !t.tried.has(i.url)) || this._open().find((i) => !t.tried.has(i.url));
    if (!s) return !1;
    t.tried.add(s.url);
    const n = { type: "relay", to: t.to, requestId: e, header: t.header };
    return t.payload && (n.payloadBase64 = le(t.payload)), this._raw(s, n);
  }
  sendRelayResponse(e, t, s, n) {
    const i = this._relayOrigin.get(`${e}:${t}`);
    this._relayOrigin.delete(`${e}:${t}`);
    const o = i && this._links.get(i) && this._links.get(i).open && this._links.get(i) || this._targetsFor(e)[0];
    if (!o) return;
    const a = { type: "relay_response", to: e, requestId: t, header: s };
    n && (a.payloadBase64 = le(n)), this._raw(o, a);
  }
  _prune(e) {
    if (this._seen.size > ae) {
      const t = [...this._seen.entries()].sort((s, n) => s[1] - n[1]).slice(0, this._seen.size - ae / 2);
      for (const [s] of t) this._seen.delete(s);
    }
    for (const [t, s] of this._pendingSig) e - s.t > 1e4 && this._pendingSig.delete(t);
    for (const [t, s] of this._pendingRelay) e - s.t > $e && this._pendingRelay.delete(t);
    this._relayOrigin.size > 2e3 && this._relayOrigin.clear();
  }
}
const Ne = 0, H = 1, G = 15 * 1024, qe = 17, Fe = new TextEncoder(), De = new TextDecoder();
function He(r) {
  if (r instanceof Uint8Array) return r;
  if (r instanceof ArrayBuffer) return new Uint8Array(r);
  throw new Error("payload precisa ser Uint8Array ou ArrayBuffer");
}
function ze(r, e) {
  const t = Fe.encode(JSON.stringify(r || {})), s = e ? He(e) : new Uint8Array(0), n = new Uint8Array(4 + t.length + s.length);
  return new DataView(n.buffer).setUint32(0, t.length, !1), n.set(t, 4), n.set(s, 4 + t.length), n;
}
function he(r, e, t, s) {
  const n = ze(t, s), i = n.length, o = Math.max(1, Math.ceil(i / G)), a = [];
  for (let l = 0; l < o; l++) {
    const c = l * G, h = Math.min(c + G, i), m = h - c, d = new ArrayBuffer(qe + m), _ = new DataView(d);
    let u = 0;
    _.setUint8(u, r), u += 1, _.setInt32(u, e, !1), u += 4, _.setInt32(u, l, !1), u += 4, _.setInt32(u, o, !1), u += 4, _.setInt32(u, i, !1), u += 4, m > 0 && new Uint8Array(d, u, m).set(n.subarray(c, h)), a.push(d);
  }
  return a;
}
function Ve(r) {
  const e = new DataView(r);
  let t = 0;
  const s = e.getUint8(t);
  t += 1;
  const n = e.getInt32(t, !1);
  t += 4;
  const i = e.getInt32(t, !1);
  t += 4;
  const o = e.getInt32(t, !1);
  t += 4;
  const a = e.getInt32(t, !1);
  if (t += 4, o < 1 || o > 1e6)
    throw new Error(`totalChunks inválido: ${o}`);
  if (a < 0 || a > 256 * 1024 * 1024)
    throw new Error(`totalLength inválido: ${a}`);
  if (i < 0 || i >= o)
    throw new Error(`chunkIndex fora do range: ${i}/${o}`);
  const l = new Uint8Array(r, t).slice();
  return { type: s, requestId: n, chunkIndex: i, totalChunks: o, totalLength: a, chunkBytes: l };
}
function We(r) {
  const t = new DataView(r.buffer, r.byteOffset, r.byteLength).getUint32(0, !1);
  if (t < 0 || t > 4 * 1024 * 1024)
    throw new Error(`header de tamanho inválido: ${t}`);
  const s = r.subarray(4, 4 + t), n = JSON.parse(De.decode(s)), i = r.subarray(4 + t), o = i.length > 0 ? i.slice() : null;
  return { header: n, payload: o };
}
class je {
  constructor() {
    this._inProgress = /* @__PURE__ */ new Map();
  }
  /**
   * @param {{type:number, requestId:number, chunkIndex:number, totalChunks:number, totalLength:number, chunkBytes:Uint8Array}} chunk
   * @returns {{type:number, requestId:number, header:object, payload:Uint8Array|null}|null} frame completo, ou null se ainda faltam chunks
   */
  accept(e) {
    const t = `${e.type}:${e.requestId}`;
    let s = this._inProgress.get(t);
    if (s || (s = { totalLength: e.totalLength, chunks: new Array(e.totalChunks).fill(null), received: 0 }, this._inProgress.set(t, s)), e.chunkIndex < 0 || e.chunkIndex >= s.chunks.length || (s.chunks[e.chunkIndex] === null && (s.chunks[e.chunkIndex] = e.chunkBytes, s.received += 1), s.received < s.chunks.length)) return null;
    this._inProgress.delete(t);
    const n = new Uint8Array(s.totalLength);
    let i = 0;
    for (const l of s.chunks)
      n.set(l, i), i += l.length;
    const { header: o, payload: a } = We(n);
    return { type: e.type, requestId: e.requestId, header: o, payload: a };
  }
  /** Descarta transferências incompletas — chamar no close() do transport. */
  clear() {
    this._inProgress.clear();
  }
}
function Qe() {
  return [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
  ];
}
const Ke = 2e4, de = 2 * 1024 * 1024, Je = 15;
function Ge(r) {
  return r.bufferedAmount <= de ? Promise.resolve() : new Promise((e) => {
    const t = () => {
      if (r.readyState !== "open" || r.bufferedAmount <= de) {
        e();
        return;
      }
      setTimeout(t, Je);
    };
    t();
  });
}
async function ue(r, e, t) {
  for (const s of e) {
    if (r.readyState !== "open")
      return t('canal não está mais "open" no meio do envio dos chunks (readyState:', r.readyState, ")"), !1;
    await Ge(r);
    try {
      r.send(s);
    } catch (n) {
      return t("dc.send() lançou erro mandando chunk:", n && n.message), !1;
    }
  }
  return !0;
}
class Xe {
  constructor(e, t, { onIncomingRequest: s, debug: n = !1 } = {}) {
    this.peerNodeId = e, this.dc = t, this._nextRequestId = 0, this._pending = /* @__PURE__ */ new Map(), this._reassembler = new je(), this._onIncomingRequest = s || null, this._log = n ? (...i) => console.log("[vagalun-p2p][transport]", e, ...i) : () => {
    }, this.dc.binaryType = "arraybuffer", this.dc.onmessage = (i) => this._onMessage(i);
  }
  get open() {
    return this.dc && this.dc.readyState === "open";
  }
  _onMessage(e) {
    const t = e.data && e.data.byteLength;
    let s;
    try {
      s = Ve(e.data);
    } catch (i) {
      this._log("FALHA AO DECODIFICAR chunk recebido (", t, "bytes ) — provável descompasso de protocolo com o peer:", i && i.message);
      return;
    }
    this._log("chunk recebido —", t, "bytes — type:", s.type === H ? "RESPONSE" : "REQUEST", "requestId:", s.requestId, `chunk ${s.chunkIndex + 1}/${s.totalChunks}`);
    let n;
    try {
      n = this._reassembler.accept(s);
    } catch (i) {
      this._log("falha remontando frame — requestId", s.requestId, ":", i && i.message);
      return;
    }
    if (n)
      if (this._log("frame remontado — type:", n.type === H ? "RESPONSE" : "REQUEST", "requestId:", n.requestId, "header:", n.header, "payload bytes:", n.payload ? n.payload.byteLength : 0), n.type === H) {
        const i = this._pending.get(n.requestId);
        if (!i) {
          this._log("resposta chegou pro requestId", n.requestId, "mas não tem ninguém esperando esse id (já deu timeout antes, ou requestId não bate)");
          return;
        }
        clearTimeout(i.timer), this._pending.delete(n.requestId), i.resolve(n);
      } else this._onIncomingRequest && this._handleIncomingRequest(n);
  }
  async _handleIncomingRequest(e) {
    let t, s = null;
    try {
      const o = await this._onIncomingRequest(e.header, e.payload);
      t = o && o.header || { ok: !1 }, s = o && o.payload || null;
    } catch (o) {
      t = { ok: !1, error: String(o && o.message || o) };
    }
    const n = he(H, e.requestId, t, s);
    await ue(this.dc, n, this._log) || this._log("resposta pro requestId", e.requestId, "NÃO foi entregue por completo — peer deve ter perdido a conexão no meio do envio");
  }
  _sendAndAwait(e, t, s = Ke) {
    if (!this.open)
      return this._log("_sendAndAwait chamado mas data channel não está open (readyState:", this.dc && this.dc.readyState, ") — nem tenta mandar"), Promise.resolve(null);
    const n = ++this._nextRequestId, i = he(Ne, n, e, t);
    return this._log("mandando request", n, "—", e, `(${i.length} chunk(s))`), new Promise((o) => {
      const a = setTimeout(() => {
        this._log("TIMEOUT esperando resposta do request", n, `(${s}ms) — peer nunca respondeu esse requestId específico`), this._pending.delete(n), o(null);
      }, s);
      this._pending.set(n, { resolve: o, timer: a }), ue(this.dc, i, this._log).then((l) => {
        l || (this._log("falha mandando chunks do request", n, "— desiste sem esperar timeout"), clearTimeout(a), this._pending.delete(n), o(null));
      });
    });
  }
  async getShard(e) {
    this._log("getShard() —", e);
    const t = await this._sendAndAwait({ op: "get", shardKey: e }, null);
    return t ? t.header.ok ? (this._log("getShard() —", e, "→ sucesso,", t.payload ? t.payload.byteLength : 0, "bytes"), t.payload) : (this._log("getShard() —", e, "→ peer respondeu ok:false. header completo:", t.header), null) : (this._log("getShard() —", e, "→ sem resposta (timeout ou erro de envio, ver logs acima)"), null);
  }
  async getShardRange(e, t, s) {
    const n = await this._sendAndAwait({ op: "get_range", shardKey: e, offset: t, length: s }, null);
    return !n || !n.header.ok ? null : n.payload;
  }
  async status() {
    const e = await this._sendAndAwait({ op: "status" }, null);
    return e ? e.header : null;
  }
  async gossip(e) {
    const t = await this._sendAndAwait({ ...e, op: "gossip" }, null);
    return t ? t.header : null;
  }
  close() {
    this._pending.forEach((e) => clearTimeout(e.timer)), this._pending.clear(), this._reassembler.clear();
    try {
      this.dc.close();
    } catch (e) {
    }
  }
}
class Ye {
  constructor(e, { onTransportReady: t, onTransportClosed: s, onIncomingRequest: n, iceServers: i, debug: o = !1 } = {}) {
    this.signaling = e, this.onTransportReady = t || (() => {
    }), this.onTransportClosed = s || (() => {
    }), this.onIncomingRequest = n || null, this.iceServers = i || Qe(), this.sessions = /* @__PURE__ */ new Map(), this.debug = o, this._log = o ? (...a) => console.log("[vagalun-p2p][rtc]", ...a) : () => {
    }, o && !i && this._log('AVISO: usando só STUN (defaultIceServers), sem TURN. Se o peer estiver atrás de NAT simétrico/CGNAT, a conexão pode nunca fechar — isso aparece como iceConnectionState preso em "checking" ou indo direto pra "failed" abaixo.'), this.signaling.onSignal = (a, l) => this.handleSignal(a, l);
  }
  handleSignal(e, t) {
    switch (t && t.kind) {
      case "offer":
        this._onOfferReceived(e, t.sdp);
        break;
      case "answer":
        this._onAnswerReceived(e, t.sdp);
        break;
      case "ice":
        this._onIceReceived(e, t);
        break;
    }
  }
  connectToPeer(e) {
    if (this.sessions.has(e)) return;
    this._log("connectToPeer", e, "— criando offer");
    const t = this._newSession(e, !0), s = t.pc, n = s.createDataChannel("shard", { ordered: !0 });
    this._wireDataChannel(e, t, n), s.createOffer().then((i) => s.setLocalDescription(i).then(() => i)).then((i) => {
      this._log("offer criada e setada localmente pra", e, "— enviando via signaling"), this.signaling.sendSignal(e, { kind: "offer", sdp: i.sdp });
    }).catch((i) => {
      this._log("createOffer/setLocalDescription falhou pra", e, ":", i && i.message), this._teardown(e);
    });
  }
  _newSession(e, t) {
    const s = new RTCPeerConnection({ iceServers: this.iceServers }), n = {
      pc: s,
      dataChannel: null,
      transport: null,
      pendingRemoteCandidates: [],
      remoteDescSet: !1,
      isInitiator: t
    };
    return this.sessions.set(e, n), s.onicecandidate = (i) => {
      if (!i.candidate) {
        this._log("ICE gathering completo pra", e);
        return;
      }
      this._log("candidato ICE local pra", e, "— type:", i.candidate.type, "protocol:", i.candidate.protocol), this.signaling.sendSignal(e, {
        kind: "ice",
        candidate: i.candidate.candidate,
        sdpMid: i.candidate.sdpMid,
        sdpMLineIndex: i.candidate.sdpMLineIndex
      });
    }, s.ondatachannel = (i) => {
      this._log("data channel recebido do peer", e), this._wireDataChannel(e, n, i.channel);
    }, s.oniceconnectionstatechange = () => {
      this._log("iceConnectionState com", e, "→", s.iceConnectionState), (s.iceConnectionState === "failed" || s.iceConnectionState === "closed") && (this._log("ICE falhou/fechou com", e, '— se ficou "checking" antes de "failed", é sinal clássico de faltar TURN pra esse par de NATs.'), this._teardown(e));
    }, n;
  }
  async _onOfferReceived(e, t) {
    this._log("offer recebida de", e);
    let s = this.sessions.get(e);
    s || (s = this._newSession(e, !1));
    const n = s.pc;
    try {
      await n.setRemoteDescription({ type: "offer", sdp: t }), s.remoteDescSet = !0, await this._flushPendingCandidates(n, s);
      const i = await n.createAnswer();
      await n.setLocalDescription(i), this._log("answer criada pra", e, "— enviando via signaling"), this.signaling.sendSignal(e, { kind: "answer", sdp: i.sdp });
    } catch (i) {
      this._log("falha processando offer de", e, ":", i && i.message), this._teardown(e);
    }
  }
  async _onAnswerReceived(e, t) {
    this._log("answer recebida de", e);
    const s = this.sessions.get(e);
    if (s)
      try {
        await s.pc.setRemoteDescription({ type: "answer", sdp: t }), s.remoteDescSet = !0, await this._flushPendingCandidates(s.pc, s);
      } catch (n) {
        this._log("falha processando answer de", e, ":", n && n.message), this._teardown(e);
      }
  }
  async _onIceReceived(e, t) {
    const s = this.sessions.get(e);
    if (!s) return;
    const n = new RTCIceCandidate({
      candidate: t.candidate,
      sdpMid: t.sdpMid,
      sdpMLineIndex: t.sdpMLineIndex
    });
    if (s.remoteDescSet)
      try {
        await s.pc.addIceCandidate(n);
      } catch (i) {
      }
    else
      s.pendingRemoteCandidates.push(n);
  }
  async _flushPendingCandidates(e, t) {
    const s = t.pendingRemoteCandidates.splice(0);
    for (const n of s)
      try {
        await e.addIceCandidate(n);
      } catch (i) {
      }
  }
  _wireDataChannel(e, t, s) {
    t.dataChannel = s, s.binaryType = "arraybuffer", s.onopen = () => {
      if (this._log("data channel ABERTO com", e, "— pronto pra pedir shards"), !t.transport) {
        const n = new Xe(e, s, { onIncomingRequest: this.onIncomingRequest, debug: this.debug });
        t.transport = n, this.onTransportReady(e, n);
      }
    }, s.onclose = () => {
      this._log("data channel fechado com", e), this._teardown(e);
    };
  }
  _teardown(e) {
    var s;
    const t = this.sessions.get(e);
    if (t) {
      this.sessions.delete(e);
      try {
        (s = t.transport) == null || s.close();
      } catch (n) {
      }
      try {
        t.pc.close();
      } catch (n) {
      }
      this.onTransportClosed(e);
    }
  }
  disconnect(e) {
    this._teardown(e);
  }
  disconnectAll() {
    Array.from(this.sessions.keys()).forEach((e) => this._teardown(e));
  }
}
function Ze() {
  return `viewer-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
function et() {
  try {
    if (typeof location != "undefined" && new URLSearchParams(location.search).get("vglDebug") === "1") return !0;
  } catch (r) {
  }
  try {
    if (typeof localStorage != "undefined" && localStorage.getItem("vgl:debug") === "1") return !0;
  } catch (r) {
  }
  return !1;
}
class fe {
  constructor({ nodeId: e, signalingUrl: t = Ue, debug: s = et(), iceServers: n } = {}) {
    this.nodeId = e || Ze(), this.debug = s, this.peers = /* @__PURE__ */ new Set(), this._known = /* @__PURE__ */ new Set(), this._lazy = !1, this._wanted = /* @__PURE__ */ new Set(), this.transports = /* @__PURE__ */ new Map(), this._connectPromise = null, this._log = s ? (...i) => console.log("[vagalun-p2p]", ...i) : () => {
    }, s && this._log("instância criada — nodeId:", this.nodeId, "signalingUrl:", t), this.signaling = new Oe({ selfNodeId: this.nodeId, url: t, debug: s }), this.rtc = new Ye(this.signaling, {
      debug: s,
      iceServers: n,
      // undefined = usa defaultIceServers() (só STUN); passe TURN aqui quando tiver
      onTransportReady: (i, o) => {
        this.transports.set(i, o), this._log("transport pronto com", i, "— total de peers com canal aberto:", this.transports.size);
      },
      onTransportClosed: (i) => {
        this.transports.delete(i), this._log("transport fechado com", i);
      }
    }), this.signaling.onPeerList = (i) => {
      this._log("peers conhecidos:", i), i.forEach((o) => this._addPeer(o));
    }, this.signaling.onPeerJoined = (i) => this._addPeer(i), this.signaling.onPeerLeft = (i) => {
      this.peers.delete(i), this._known.delete(i), this.rtc.disconnect(i);
    }, this.signaling.onError = (i, o) => {
      this._log("erro do signaling:", i, o);
    }, this.signaling.onStateChange = (i) => {
      this._log(i ? "conectado ao signaling" : "desconectado do signaling");
    };
  }
  _addPeer(e) {
    e !== this.nodeId && (this._known.add(e), !(this._lazy && !this._wanted.has(e)) && this._dial(e));
  }
  _dial(e) {
    this.peers.has(e) || (this.peers.add(e), this._log("discou pro peer", e, "(via signaling)"), this.rtc.connectToPeer(e));
  }
  /**
   * Passa a discar só os `max` primeiros da lista (os mais perto, na ordem do bilhete
   * /p2p) em vez de TODOS que o signaling listar. Os demais ficam sob demanda
   * (ensurePeer), quando o fallback precisar deles.
   * @param {string[]} peerIds relayNodeId dos candidates, do mais perto ao mais longe
   */
  setPreferredPeers(e, { max: t = 3 } = {}) {
    this._lazy = !0;
    for (const s of e.slice(0, t)) this.ensurePeer(s);
  }
  /** Garante que estamos discando esse peer (se o signaling já o conhece, disca agora; senão, quando ele entrar). */
  ensurePeer(e) {
    this._wanted.add(e), this._known.has(e) && this._dial(e);
  }
  /** Garante que o signaling está conectado. Idempotente. */
  connect() {
    return this._connectPromise || (this._log("connect() chamado, subindo signaling..."), this._connectPromise = new Promise((e) => {
      if (this.signaling.connected) return e();
      const t = this.signaling.onStateChange;
      this.signaling.onStateChange = (s) => {
        t == null || t(s), s && e();
      }, this.signaling.connect();
    })), this._connectPromise;
  }
  /**
   * Busca um shard/arquivo pelos peers atualmente conectados, em paralelo,
   * usando o primeiro que responder com sucesso.
   * @param {string} shardKey
   * @param {{ timeoutMs?: number, waitForPeersMs?: number }} [opts]
   * @returns {Promise<Uint8Array|null>}
   */
  async fetchShard(e, { timeoutMs: t = 12e3, waitForPeersMs: s = 4e3, peerId: n = null } = {}) {
    if (n) {
      await this.connect(), this.ensurePeer(n);
      const a = await this._waitForPeer(n, s);
      if (!a)
        return this._log("fetchShard() —", e, "→ sem canal aberto com", n, "(offline ou ICE não fechou)"), null;
      const l = await pe([a.getShard(e)], t);
      return this._log("fetchShard() fim —", e, "via", n, l ? `sucesso, ${l.byteLength} bytes` : "sem resposta"), l;
    }
    this._log("fetchShard() início —", e, `(espera até ${s}ms por peer, timeout total ${t}ms)`), await this.connect(), this._log("signaling conectado?", this.signaling.connected, "— peers conhecidos até agora:", this.peers.size), await this._waitForAnyPeer(s);
    const i = Array.from(this.transports.values()).filter((a) => a.open);
    if (this._log("candidatos com data channel aberto:", i.length, "de", this.transports.size, "sessões WebRTC totais e", this.peers.size, "peers conhecidos pelo signaling"), !i.length)
      return this.peers.size === 0 ? this._log("DIAGNÓSTICO: signaling não retornou nenhum peer pra", e, "— ou não tem ninguém com esse fileId anunciado, ou o signaling em si não conectou (confere connected acima).") : this._log("DIAGNÓSTICO: signaling achou", this.peers.size, "peer(s), mas o WebRTC nunca abriu data channel com nenhum — provável falha de ICE (NAT/sem TURN). Confere oniceconnectionstatechange nos logs acima."), null;
    const o = await pe(
      i.map((a) => a.getShard(e)),
      t
    );
    return this._log("fetchShard() fim —", e, o ? `sucesso, ${o.byteLength} bytes` : "nenhum candidato respondeu com o shard (peer conectado mas não tinha esse fileId, ou deu timeout)"), o;
  }
  /** Espera o data channel com UM peer abrir (até maxWaitMs). Resolve o transport ou null. */
  _waitForPeer(e, t) {
    const s = () => {
      const i = this.transports.get(e);
      return i && i.open ? i : null;
    }, n = s();
    return n ? Promise.resolve(n) : new Promise((i) => {
      const o = Date.now(), a = setInterval(() => {
        const l = s();
        (l || Date.now() - o > t) && (clearInterval(a), i(l));
      }, 100);
    });
  }
  _waitForAnyPeer(e) {
    return Array.from(this.transports.values()).some((t) => t.open) ? Promise.resolve() : new Promise((t) => {
      const s = Date.now(), n = setInterval(() => {
        (Array.from(this.transports.values()).some((o) => o.open) || Date.now() - s > e) && (clearInterval(n), t());
      }, 150);
    });
  }
  disconnect() {
    this.rtc.disconnectAll(), this.signaling.disconnect(), this._connectPromise = null;
  }
}
async function pe(r, e) {
  return new Promise((t) => {
    let s = r.length, n = !1;
    const i = setTimeout(() => {
      n || (n = !0, t(null));
    }, e);
    r.forEach((o) => {
      o.then((a) => {
        s -= 1, !n && a ? (n = !0, clearTimeout(i), t(a)) : !n && s === 0 && (n = !0, clearTimeout(i), t(null));
      }).catch(() => {
        s -= 1, !n && s === 0 && (n = !0, clearTimeout(i), t(null));
      });
    });
  });
}
function tt(r, e = "video/mp4") {
  const t = new Blob([r], { type: e });
  return URL.createObjectURL(t);
}
function me(r, e, t) {
  return `${r}_b${e}_s${t}`;
}
function $(r) {
  const e = atob(r), t = new Uint8Array(e.length);
  for (let s = 0; s < e.length; s++) t[s] = e.charCodeAt(s);
  return t;
}
function ke(r) {
  if (!crypto.subtle)
    throw new Error("crypto.subtle indisponível — página precisa estar em HTTPS (ou localhost) pra descriptografar via Web Crypto");
  if (r.length !== 32)
    throw new Error(`fileKeyB64 do manifesto tem ${r.length} bytes decodificados, esperado 32 (AES-256) — manifesto corrompido ou vazio`);
  return crypto.subtle.importKey("raw", r, { name: "AES-GCM" }, !1, ["decrypt"]);
}
async function be(r, e, t, s) {
  const n = new Uint8Array(e.length + s.length);
  n.set(e, 0), n.set(s, e.length);
  const i = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: t, tagLength: 128 },
    r,
    n
  );
  return new Uint8Array(i);
}
async function Ee(r) {
  const e = await fetch(r, { cache: "no-store" });
  if (!e.ok) {
    let s = "";
    try {
      s = (await e.json()).error || "";
    } catch (n) {
    }
    throw new Error(`manifesto /p2p/ respondeu ${e.status}${s ? " — " + s : ""}`);
  }
  const t = await e.json();
  if (!t.ok) throw new Error(t.error || "manifesto /p2p/ retornou ok:false");
  if (!t.blocks || !t.blocks.length) throw new Error("manifesto sem blocks");
  if (!t.candidates || !t.candidates.length)
    throw new Error("manifesto sem candidatos relay — nenhum peer alcançável via WebRTC pra esse arquivo agora");
  try {
    const s = new URL(r, typeof location != "undefined" ? location.href : void 0);
    if (t.metricsUrl) {
      const n = new URL(t.metricsUrl, s), i = s.searchParams.get("geo");
      i && n.searchParams.set("geo", i), t._metricsUrl = n.href;
    }
  } catch (s) {
  }
  return t;
}
function Se(r, e, { maxDial: t = 3, onLog: s = () => {
} } = {}) {
  const n = e.candidates;
  s("candidatos (mais perto primeiro):", n.map(
    (i) => `${i.relayNodeId}${i.edge ? " [borda]" : ""}${i.region ? " " + i.region : ""}${i.distanceKm != null ? " " + i.distanceKm + "km" : ""}${i.online === !1 ? " [offline]" : ""}`
  ).join(" | ")), typeof r.setPreferredPeers == "function" && r.setPreferredPeers(n.filter((i) => i.online !== !1).map((i) => i.relayNodeId), { max: t });
}
const ge = (r, e, t) => {
  try {
    r && typeof r.addEventListener == "function" && r.addEventListener(e, t);
  } catch (s) {
  }
}, _e = (r, e, t) => {
  try {
    r && typeof r.removeEventListener == "function" && r.removeEventListener(e, t);
  } catch (s) {
  }
};
class Te {
  constructor(e) {
    this.url = e._metricsUrl || null, this.fileId = e.fileId, this.bytes = 0, this.blocks = 0, this.edgeBlocks = 0, this.nodes = {}, this.t0 = Date.now(), this._sent = !1;
  }
  add(e, t) {
    this.bytes += e, this.blocks += 1, t && t.edge && (this.edgeBlocks += 1), t && t.relayNodeId && (this.nodes[t.relayNodeId] = (this.nodes[t.relayNodeId] || 0) + 1);
  }
  flush() {
    if (!this.url || this.blocks === 0) return;
    const e = JSON.stringify({
      fileId: this.fileId,
      bytes: this.bytes,
      blocks: this.blocks,
      edgeBlocks: this.edgeBlocks,
      ms: Date.now() - this.t0,
      nodes: this.nodes
    });
    try {
      const t = new Blob([e], { type: "text/plain" });
      typeof navigator != "undefined" && navigator.sendBeacon && navigator.sendBeacon(this.url, t) || fetch(this.url, { method: "POST", body: e, headers: { "Content-Type": "text/plain" }, keepalive: !0, mode: "cors" }).catch(() => {
      });
    } catch (t) {
    }
    this.bytes = 0, this.blocks = 0, this.edgeBlocks = 0, this.nodes = {}, this.t0 = Date.now();
  }
}
async function Le(r, e, t, s, { timeoutMs: n, firstWaitMs: i, gotOne: o, onLog: a }) {
  for (let c = 0; c < s.length; c++) {
    const h = s[c], m = me(e, t.blockIndex, h.shardIndex);
    let d = o ? 500 : c === 0 ? i : Math.min(i, 2e3);
    h.online === !1 && (d = Math.min(d, 500)), a("bloco", t.blockIndex, "— tentando", m, "via", h.relayNodeId);
    const _ = await r.fetchShard(m, { timeoutMs: n, waitForPeersMs: d, peerId: h.relayNodeId });
    if (_) return { bytes: _, cand: h };
  }
  const l = /* @__PURE__ */ new Set();
  for (const c of s) {
    if (l.has(c.shardIndex)) continue;
    l.add(c.shardIndex);
    const h = me(e, t.blockIndex, c.shardIndex);
    a("bloco", t.blockIndex, "— último recurso: qualquer peer com canal aberto,", h);
    const m = await r.fetchShard(h, { timeoutMs: n, waitForPeersMs: 500 });
    if (m) return { bytes: m, cand: { ...c, relayNodeId: null, edge: !1 } };
  }
  return null;
}
async function Ie(r, e, t = {}) {
  const {
    onProgress: s = () => {
    },
    onLog: n = () => {
    },
    perBlockTimeoutMs: i = 15e3,
    waitForPeersMs: o = 4e3
  } = t;
  if (!e.fileKeyB64)
    throw new Error("manifesto sem fileKeyB64 — arquivo não publicado com chave pra acesso via gateway/P2P");
  const a = await ke($(e.fileKeyB64)), l = e.blocks.slice().sort((f, y) => f.blockIndex - y.blockIndex), c = l.length, h = new Array(c);
  let m = 0;
  Se(r, e, { onLog: n });
  const d = new Te(e);
  for (const f of l) {
    let y = null, b = null, v = null;
    const w = await Le(r, e.fileId, f, e.candidates, {
      timeoutMs: i,
      // só espera peer "aparecer" no signaling no 1º bloco — dos demais
      // em diante a sessão WebRTC já deve estar de pé.
      firstWaitMs: o,
      gotOne: m > 0,
      onLog: n
    });
    if (w && (y = w.bytes.subarray(0, f.plainLength), b = w.cand.shardIndex, v = w.cand.relayNodeId, d.add(w.bytes.byteLength, w.cand), t.onServed && t.onServed({ ...w.cand, block: f.blockIndex })), !y)
      throw d.flush(), new Error(
        `bloco ${f.blockIndex}/${c}: nenhum candidato respondeu (tentados: ${e.candidates.map((S) => S.relayNodeId).join(", ")})`
      );
    n("bloco", f.blockIndex, "— recebido de", v, `shardIndex ${b} (${y.length} bytes cifrados), descriptografando...`);
    try {
      h[f.blockIndex] = await be(
        a,
        y,
        $(f.iv),
        $(f.authTag)
      );
    } catch (S) {
      throw new Error(`bloco ${f.blockIndex}/${c}: falha ao descriptografar (chave/iv/authTag não batem com o shard recebido) — ${S && S.message}`);
    }
    m += 1, s(m, c);
  }
  d.flush();
  let _ = 0;
  for (const f of h) _ += f.length;
  const u = new Uint8Array(_);
  let p = 0;
  for (const f of h)
    u.set(f, p), p += f.length;
  return u;
}
class st {
  /**
   * @param {import('./p2pSource.js').P2PManager} p2p
   * @param {object} manifest - retorno de fetchP2PManifest()
   * @param {{
   *   onLog?: Function,
   *   onBlock?: (fetched:number, total:number) => void,
   *   perBlockTimeoutMs?: number,
   *   waitForPeersMs?: number,
   *   maxAttempts?: number,
   *   prefetchBlocks?: number,
   *   cacheBlocks?: number
   * }} [opts]
   */
  constructor(e, t, s = {}) {
    var n, i, o, a, l;
    this.p2p = e, this.manifest = t, this.onLog = s.onLog || (() => {
    }), this.onBlock = s.onBlock || (() => {
    }), this.perBlockTimeoutMs = (n = s.perBlockTimeoutMs) != null ? n : 15e3, this.waitForPeersMs = (i = s.waitForPeersMs) != null ? i : 4e3, this.maxAttempts = (o = s.maxAttempts) != null ? o : 3, this.prefetchBlocks = (a = s.prefetchBlocks) != null ? a : 3, this.cacheBlocks = (l = s.cacheBlocks) != null ? l : this.prefetchBlocks + 6, this._cache = /* @__PURE__ */ new Map(), this._candidates = t.candidates.slice(), this.onServed = s.onServed || (() => {
    }), this._lastServedNode = null, this.reporter = new Te(t), Se(e, t, { onLog: this.onLog }), this._onHide = () => this.reporter.flush(), this._onVis = () => {
      document.visibilityState === "hidden" && this._onHide();
    }, ge(typeof document != "undefined" ? document : null, "visibilitychange", this._onVis), ge(typeof window != "undefined" ? window : null, "pagehide", this._onHide), this._gotOne = !1, this._destroyed = !1, this.fetched = 0;
  }
  async init() {
    if (!this.manifest.fileKeyB64)
      throw new Error("manifesto sem fileKeyB64 — arquivo não publicado com chave pra acesso via gateway/P2P");
    this.cryptoKey = await ke($(this.manifest.fileKeyB64)), this.blocks = this.manifest.blocks.slice().sort((e, t) => e.blockIndex - t.blockIndex), this.offsets = new Array(this.blocks.length + 1), this.offsets[0] = 0;
    for (let e = 0; e < this.blocks.length; e++) {
      if (this.blocks[e].blockIndex !== e)
        throw new Error(`manifesto com blocos não contíguos (esperado blockIndex ${e}, veio ${this.blocks[e].blockIndex})`);
      this.offsets[e + 1] = this.offsets[e] + this.blocks[e].plainLength;
    }
    this.total = this.offsets[this.blocks.length];
  }
  /** Posição (índice no array) do bloco que contém o byte `offset`. */
  blockAt(e) {
    let t = 0, s = this.blocks.length - 1;
    for (; t < s; ) {
      const n = t + s + 1 >> 1;
      this.offsets[n] <= e ? t = n : s = n - 1;
    }
    return t;
  }
  /** Lê [start, end) do arquivo decifrado (busca só os blocos necessários). */
  async read(e, t) {
    if (t = Math.min(t, this.total), e < 0 || e >= t) return new Uint8Array(0);
    const s = this.blockAt(e), n = this.blockAt(t - 1), i = [];
    for (let c = s; c <= n; c++) i.push(this._get(c));
    this.prefetch(n + 1);
    const o = await Promise.all(i);
    if (s === n) return o[0].subarray(e - this.offsets[s], t - this.offsets[s]);
    const a = new Uint8Array(t - e);
    let l = 0;
    for (let c = 0; c < o.length; c++) {
      const h = s + c, m = Math.max(e, this.offsets[h]) - this.offsets[h], d = Math.min(t, this.offsets[h + 1]) - this.offsets[h];
      a.set(o[c].subarray(m, d), l), l += d - m;
    }
    return a;
  }
  /** Dispara (sem esperar) a busca dos próximos blocos a partir de `pos`. */
  prefetch(e) {
    for (let t = e; t < e + this.prefetchBlocks && t < this.blocks.length; t++)
      this._get(t).catch(() => {
      });
  }
  _get(e) {
    let t = this._cache.get(e);
    if (t)
      return this._cache.delete(e), this._cache.set(e, t), t;
    for (t = this._fetchBlock(e), this._cache.set(e, t), t.catch(() => {
      this._cache.get(e) === t && this._cache.delete(e);
    }); this._cache.size > this.cacheBlocks; )
      this._cache.delete(this._cache.keys().next().value);
    return t;
  }
  async _fetchBlock(e) {
    const t = this.blocks[e], s = this.blocks.length;
    let n = null;
    for (let i = 0; i < this.maxAttempts; i++) {
      if (this._destroyed) throw new Error("leitor P2P destruído");
      const o = await Le(this.p2p, this.manifest.fileId, t, this._candidates, {
        timeoutMs: this.perBlockTimeoutMs,
        firstWaitMs: this.waitForPeersMs,
        gotOne: this._gotOne,
        onLog: this.onLog
      });
      if (o) {
        const a = o.cand;
        try {
          const l = await be(
            this.cryptoKey,
            o.bytes.subarray(0, t.plainLength),
            $(t.iv),
            $(t.authTag)
          );
          if (this._gotOne = !0, a.relayNodeId) {
            const c = this._candidates.find((h) => h.relayNodeId === a.relayNodeId && h.shardIndex === a.shardIndex);
            c && (this._candidates = [c, ...this._candidates.filter((h) => h !== c)]);
          }
          return this.reporter.add(o.bytes.byteLength, a), a.relayNodeId !== this._lastServedNode && (this._lastServedNode = a.relayNodeId, this.onServed({ ...a, block: e })), this.fetched += 1, this.onBlock(this.fetched, s), l;
        } catch (l) {
          n = l, this.onLog("bloco", e, "falha ao descriptografar via", a.relayNodeId, l && l.message);
        }
      }
      await new Promise((a) => setTimeout(a, 300 * (i + 1)));
    }
    throw new Error(
      `bloco ${e}/${s}: nenhum candidato respondeu após ${this.maxAttempts} tentativas` + (n ? ` (último erro: ${n.message})` : "")
    );
  }
  destroy() {
    this._destroyed = !0, this._cache.clear();
    try {
      this.reporter.flush();
    } catch (e) {
    }
    _e(typeof window != "undefined" ? window : null, "pagehide", this._onHide), _e(typeof document != "undefined" ? document : null, "visibilitychange", this._onVis);
  }
}
const nt = (r, e) => r[e], it = (r, e) => r[e] << 8 | r[e + 1], T = (r, e) => (r[e] << 24 | r[e + 1] << 16 | r[e + 2] << 8 | r[e + 3]) >>> 0, Y = (r, e) => T(r, e) * 4294967296 + T(r, e + 4), te = (r, e) => String.fromCharCode(r[e], r[e + 1], r[e + 2], r[e + 3]), Pe = (r) => r.toString(16).padStart(2, "0").toUpperCase(), z = (r) => r.toString(16).padStart(2, "0");
function O(r, e = 0, t = r.length) {
  if (e + 8 > t) return null;
  let s = T(r, e);
  const n = te(r, e + 4);
  let i = 8;
  if (s === 1) {
    if (e + 16 > t) return null;
    s = Y(r, e + 8), i = 16;
  } else s === 0 && (s = null);
  return { type: n, size: s, hdr: i };
}
function* Z(r, e = 0, t = r.length) {
  let s = e;
  for (; s + 8 <= t; ) {
    const n = O(r, s, t);
    if (!n) return;
    const i = n.size === null ? t - s : n.size;
    if (i < n.hdr || s + i > t) return;
    yield { type: n.type, start: s, end: s + i, payload: s + n.hdr }, s += i;
  }
}
function U(r, e, t) {
  for (const s of Z(r, e.payload, e.end)) if (s.type === t) return s;
  return null;
}
function rt(r, e, ...t) {
  let s = e;
  for (const n of t) {
    if (!s) return null;
    s = U(r, s, n);
  }
  return s;
}
function N(r, e, t, s) {
  for (let n = e; n + 4 <= t; n++)
    if (r[n] === s.charCodeAt(0) && r[n + 1] === s.charCodeAt(1) && r[n + 2] === s.charCodeAt(2) && r[n + 3] === s.charCodeAt(3))
      return n;
  return -1;
}
function ot(r, e, t) {
  const s = N(r, e, t, "avcC");
  if (s < 0) return null;
  const n = s + 4;
  return `avc1.${z(r[n + 1])}${z(r[n + 2])}${z(r[n + 3])}`;
}
function at(r) {
  let e = 0;
  for (let t = 0; t < 32; t++)
    e = e << 1 | r >>> t & 1;
  return e >>> 0;
}
function lt(r, e, t, s) {
  const n = N(r, e, t, "hvcC");
  if (n < 0) return null;
  const i = n + 4, o = r[i + 1] >> 6, a = r[i + 1] >> 5 & 1, l = r[i + 1] & 31, c = at(T(r, i + 2)).toString(16).toUpperCase(), h = r[i + 12], m = [];
  for (let u = 0; u < 6; u++) m.push(r[i + 6 + u]);
  for (; m.length && m[m.length - 1] === 0; ) m.pop();
  const d = ["", "A", "B", "C"][o], _ = m.length ? "." + m.map(Pe).join(".") : "";
  return `${s}.${d}${l}.${c}.${a ? "H" : "L"}${h}${_}`;
}
function ct(r, e, t) {
  const s = N(r, e, t, "av1C");
  if (s < 0) return null;
  const n = s + 4, i = r[n + 1] >> 5, o = r[n + 1] & 31, a = r[n + 2] >> 7 & 1, l = r[n + 2] >> 6 & 1, h = r[n + 2] >> 5 & 1 ? 12 : l ? 10 : 8;
  return `av01.${i}.${String(o).padStart(2, "0")}${a ? "H" : "M"}.${String(h).padStart(2, "0")}`;
}
function ht(r, e, t) {
  const s = N(r, e, t, "vpcC");
  if (s < 0) return null;
  const n = s + 4 + 4, i = r[n], o = r[n + 1], a = r[n + 2] >> 4;
  return `vp09.${String(i).padStart(2, "0")}.${String(o).padStart(2, "0")}.${String(a).padStart(2, "0")}`;
}
function X(r, e) {
  let t = 0, s = 0;
  for (; s < 4; s++) {
    const n = r[e + s];
    if (t = t << 7 | n & 127, !(n & 128)) {
      s++;
      break;
    }
  }
  return { len: t, n: s };
}
function dt(r, e, t) {
  const s = N(r, e, t, "esds");
  if (s < 0) return "mp4a.40.2";
  let n = s + 4 + 4;
  const i = t;
  if (r[n] !== 3) return "mp4a.40.2";
  let o = X(r, n + 1);
  if (n += 1 + o.n + 3, r[n] !== 4) return "mp4a.40.2";
  o = X(r, n + 1), n += 1 + o.n;
  const a = r[n];
  if (n += 13, a === 107 || a === 105) return `mp4a.${Pe(a)}`;
  let l = 2;
  return n < i && r[n] === 5 && (o = X(r, n + 1), l = r[n + 1 + o.n] >> 3, l === 31 && (l = 32 + ((r[n + 1 + o.n] & 7) << 3 | r[n + 2 + o.n] >> 5))), `mp4a.${z(a)}.${l}`;
}
function ut(r, e) {
  const t = e.type, s = e.payload, n = e.end;
  switch (t) {
    case "avc1":
    case "avc3":
      return ot(r, s, n);
    case "hvc1":
    case "hev1":
      return lt(r, s, n, t);
    case "av01":
      return ct(r, s, n);
    case "vp09":
      return ht(r, s, n);
    case "mp4a":
      return dt(r, s, n);
    case "Opus":
      return "opus";
    case "fLaC":
      return "flac";
    case "ac-3":
      return "ac-3";
    case "ec-3":
      return "ec-3";
    default:
      return null;
  }
}
function ft(r) {
  const e = O(r, 0);
  if (!e || e.type !== "moov") throw new Error("não é uma box moov");
  const t = { payload: e.hdr, end: e.size === null ? r.length : e.size }, s = [];
  for (const n of Z(r, t.payload, t.end)) {
    if (n.type !== "trak") continue;
    const i = U(r, n, "tkhd"), o = U(r, n, "mdia");
    if (!i || !o) continue;
    const a = r[i.payload], l = T(r, i.payload + (a === 1 ? 20 : 12)), c = U(r, o, "mdhd"), h = U(r, o, "hdlr"), m = c ? r[c.payload] : 0, d = c ? T(r, c.payload + (m === 1 ? 20 : 12)) : 1, _ = h ? te(r, h.payload + 8) : "", u = rt(r, o, "minf", "stbl", "stsd");
    let p = null, f = null;
    if (u)
      for (const y of Z(r, u.payload + 8, u.end)) {
        f = y.type, p = ut(r, y);
        break;
      }
    s.push({ id: l, timescale: d, handler: _, codec: p, entry: f });
  }
  return { hasMvex: !!U(r, t, "mvex"), tracks: s };
}
function pt(r, e) {
  const t = O(r, 0);
  if (!t || t.type !== "sidx") throw new Error("não é uma box sidx");
  let s = t.hdr;
  const n = nt(r, s);
  s += 4;
  const i = T(r, s);
  s += 4;
  const o = T(r, s);
  s += 4;
  let a, l;
  n === 0 ? (a = T(r, s), s += 4, l = T(r, s), s += 4) : (a = Y(r, s), s += 8, l = Y(r, s), s += 8), s += 2;
  const c = it(r, s);
  s += 2;
  const h = [];
  let m = !1;
  for (let p = 0; p < c; p++) {
    const f = T(r, s), y = f >>> 31, b = f & 2147483647, v = T(r, s + 4), w = T(r, s + 8) >>> 31;
    y === 1 && (m = !0), h.push({ size: b, dur: v, sap: w }), s += 12;
  }
  let d = e + l, _ = a;
  const u = h.map((p) => {
    const f = { start: d, end: d + p.size, t: _ / o, dur: p.dur / o, sap: !!p.sap };
    return d += p.size, _ += p.dur, f;
  });
  return { referenceId: i, timescale: o, hierarchical: m, units: u, duration: _ / o };
}
function mt(r) {
  if (r.length < 16) return 0;
  const e = r.length;
  return te(r, e - 12) !== "mfro" ? 0 : T(r, e - 4);
}
function gt(...r) {
  const e = r.reduce((n, i) => n + i.length, 0), t = new Uint8Array(e);
  let s = 0;
  for (const n of r)
    t.set(n, s), s += n.length;
  return t;
}
class P extends Error {
  /** @param {string} message @param {'no-mse'|'not-fragmented'|'codec'|'init'} code */
  constructor(e, t) {
    super(e), this.name = "MseUnsupportedError", this.code = t;
  }
}
const _t = 32 * 1024 * 1024, yt = 0.3;
class V {
  /**
   * @param {{
   *   p2p: import('./p2pSource.js').P2PManager,
   *   manifest: object,
   *   onEvent?: (name:string, data:any) => void,
   *   onFatal?: (err:Error) => void,
   *   onLog?: Function,
   *   aheadTargetS?: number,   // quanto de buffer manter à frente (padrão 60s)
   *   backBufferS?: number,    // quanto manter atrás (padrão 30s)
   *   reader?: object          // injeção (testes)
   * }} o
   */
  constructor(e) {
    var t, s;
    this.manifest = e.manifest, this.onEvent = e.onEvent || (() => {
    }), this.onFatal = e.onFatal || (() => {
    }), this.onLog = e.onLog || (() => {
    }), this.aheadTargetS = (t = e.aheadTargetS) != null ? t : 60, this.backBufferS = (s = e.backBufferS) != null ? s : 30, this.reader = e.reader || new st(e.p2p, e.manifest, {
      onLog: this.onLog,
      onBlock: (n, i) => this.onEvent("p2p:block", { done: n, total: i }),
      onServed: (n) => this.onEvent("p2p:served", n),
      perBlockTimeoutMs: e.perBlockTimeoutMs,
      waitForPeersMs: e.waitForPeersMs,
      prefetchBlocks: e.prefetchBlocks
    }), this.mode = null, this.mime = null, this.duration = null, this._units = [], this._init = null, this._probed = !1, this._video = null, this._ms = null, this._sb = null, this._url = null, this._destroyed = !1, this._failed = !1, this._gen = 0, this._next = 0, this._lastIdx = -1, this._sameIdx = 0, this._ended = !1, this._q = Promise.resolve(), this._wake = null, this._firstAppend = null;
  }
  static isSupported() {
    return typeof window != "undefined" && typeof window.MediaSource != "undefined" && typeof window.MediaSource.isTypeSupported == "function";
  }
  // ------------------------------------------------------------------ probe
  /**
   * Lê o começo do arquivo (ftyp/moov/sidx), descobre codec e monta o índice.
   * Não mexe no <video>. Lança MseUnsupportedError se não der pra usar MSE.
   */
  async probe() {
    if (!V.isSupported()) throw new P("MediaSource indisponível neste navegador", "no-mse");
    await this.reader.init();
    const e = this.reader.total, t = this.reader.prefetchBlocks;
    this.reader.prefetchBlocks = 0;
    try {
      return await this._probe(e);
    } finally {
      this.reader.prefetchBlocks = t;
    }
  }
  async _probe(e) {
    const t = await this.reader.read(Math.max(0, e - 16), e), s = mt(t);
    this._mediaEnd = s > 0 && s < e ? e - s : e;
    let n = 0, i = null, o = null;
    const a = [];
    let l = null;
    for (let d = 0; d < 64 && n < e; d++) {
      const _ = await this.reader.read(n, Math.min(n + 16, e)), u = O(_, 0);
      if (!u) break;
      const p = u.size === null ? e - n : u.size;
      if (u.type === "moof" || u.type === "mdat") {
        l = n;
        break;
      }
      if (u.type === "ftyp" || u.type === "moov" || u.type === "sidx") {
        if (p > _t) throw new P(`box ${u.type} grande demais (${p} bytes)`, "init");
        const f = await this.reader.read(n, n + p);
        u.type === "ftyp" ? i = f : u.type === "moov" ? o = f : a.push({ bytes: f, endAbs: n + p });
      }
      if (p <= 0) break;
      n += p;
    }
    if (!o || l === null)
      throw new P("arquivo sem moov antes dos dados (mp4 não fragmentado / moov no fim)", "not-fragmented");
    const c = ft(o);
    if (!c.hasMvex)
      throw new P("mp4 não fragmentado (moov sem mvex) — republique com frag_keyframe+empty_moov", "not-fragmented");
    const h = c.tracks.filter((d) => d.handler === "vide" || d.handler === "soun");
    if (!h.length) throw new P("nenhuma trilha de áudio/vídeo no moov", "init");
    const m = h.find((d) => !d.codec);
    if (m) throw new P(`codec não reconhecido (entrada "${m.entry}")`, "codec");
    if (this.mime = `video/mp4; codecs="${h.map((d) => d.codec).join(",")}"`, !window.MediaSource.isTypeSupported(this.mime))
      throw new P(`navegador não suporta ${this.mime}`, "codec");
    return this._init = i ? gt(i, o) : o, await this._buildIndex(c, a, l), this._probed = !0, this.onLog("mse probe ok —", this.mode, this.mime, `${this._units.length} unidades`, this.duration ? `${this.duration.toFixed(1)}s` : ""), { mode: this.mode, mime: this.mime, duration: this.duration, units: this._units.length };
  }
  async _buildIndex(e, t, s) {
    const n = e.tracks.find((l) => l.handler === "vide") || e.tracks[0], i = t.find((l) => l.bytes.length >= 16 && this._sidxRef(l.bytes) === n.id) || t[0];
    if (i)
      try {
        const l = pt(i.bytes, i.endAbs);
        if (!l.hierarchical && l.units.length) {
          const c = l.units[0], h = l.units[l.units.length - 1], m = c.start >= s && h.end <= this._mediaEnd + 1, d = await this.reader.read(c.start, c.start + 8), _ = await this.reader.read(h.start, h.start + 8), u = (p) => p.length >= 8 && String.fromCharCode(p[4], p[5], p[6], p[7]) === "moof";
          if (m && u(d) && u(_)) {
            this.mode = "indexed", this._units = l.units, this.duration = l.duration, this._tol = Math.min(0.25, Math.max(0.01, l.duration / l.units.length / 4));
            return;
          }
        }
      } catch (l) {
        this.onLog("sidx inválido, caindo pro modo sequencial —", l && l.message);
      }
    this.mode = "sequential";
    const o = this.reader, a = [];
    for (let l = o.blockAt(s); l < o.blocks.length; l++) {
      const c = Math.max(o.offsets[l], s), h = Math.min(o.offsets[l + 1], this._mediaEnd);
      h > c && a.push({ start: c, end: h, t: 0, dur: 0 });
    }
    this._units = a, this.duration = Number.isFinite(this.manifest.duration) ? this.manifest.duration : null;
  }
  _sidxRef(e) {
    const s = O(e, 0).hdr + 4;
    return (e[s] << 24 | e[s + 1] << 16 | e[s + 2] << 8 | e[s + 3]) >>> 0;
  }
  // ----------------------------------------------------------------- attach
  /**
   * Liga o stream num <video>. Resolve quando o 1º fragmento já foi anexado
   * (ou seja: já dá pra tocar). Rejeita se falhar antes disso.
   */
  async attach(e, { resumeTime: t = 0 } = {}) {
    this._probed || await this.probe(), this._video = e;
    const s = new window.MediaSource();
    if (this._ms = s, this._url = URL.createObjectURL(s), e.src = this._url, await new Promise((n, i) => {
      const o = setTimeout(() => i(new Error("MediaSource não abriu (sourceopen)")), 1e4);
      s.addEventListener("sourceopen", () => {
        clearTimeout(o), n();
      }, { once: !0 });
    }), !this._destroyed) {
      if (this._sb = s.addSourceBuffer(this.mime), this._onSeeking = () => {
        this.mode === "indexed" && (this._gen += 1), this._poke();
      }, this._onTimeUpdate = () => this._poke(), e.addEventListener("seeking", this._onSeeking), e.addEventListener("timeupdate", this._onTimeUpdate), await this._append(this._init), this.mode === "indexed" && Number.isFinite(this.duration))
        try {
          s.duration = this.duration;
        } catch (n) {
        }
      if (t > 1)
        try {
          e.currentTime = t;
        } catch (n) {
        }
      this._firstAppend = vt(), this._run(), await this._firstAppend.promise;
    }
  }
  // -------------------------------------------------------------- main loop
  _poke() {
    if (this._wake) {
      const e = this._wake;
      this._wake = null, e();
    }
  }
  _sleep(e) {
    return new Promise((t) => {
      const s = setTimeout(() => {
        this._wake = null, t();
      }, e);
      this._wake = () => {
        clearTimeout(s), t();
      };
    });
  }
  _rangeAt(e) {
    const t = this._video.buffered;
    for (let s = 0; s < t.length; s++)
      if (e >= t.start(s) - yt && e <= t.end(s)) return { start: t.start(s), end: t.end(s) };
    return null;
  }
  _unitIndexAtTime(e) {
    const t = this._units;
    let s = 0, n = t.length - 1;
    for (; s < n; ) {
      const i = s + n + 1 >> 1;
      t[i].t <= e ? s = i : n = i - 1;
    }
    return s;
  }
  /** Decide o que fazer agora. {idx} | {wait} | {done} */
  _choose() {
    const e = this._video.currentTime || 0, t = this._rangeAt(e), s = t && t.end - e >= this.aheadTargetS;
    if (this.mode === "sequential")
      return this._next >= this._units.length ? { done: !0 } : s ? { wait: !0 } : { idx: this._next };
    let n;
    if (!t)
      n = this._unitIndexAtTime(e);
    else {
      if (t.end >= this.duration - 0.1) return { done: !0 };
      if (s) return { wait: !0 };
      n = this._unitIndexAtTime(t.end + this._tol);
    }
    return n === this._lastIdx ? (this._sameIdx += 1, this._sameIdx >= 2 && (n += 1)) : this._sameIdx = 0, n >= this._units.length ? { done: !0 } : { idx: n };
  }
  async _run() {
    try {
      for (; !this._destroyed && !this._failed; ) {
        const e = this._gen, t = this._choose();
        if (t.done) {
          await this._finish(), await this._sleep(1e3);
          continue;
        }
        if (t.wait) {
          await this._sleep(500);
          continue;
        }
        const s = this._units[t.idx], n = await this.reader.read(s.start, s.end);
        if (this._destroyed) return;
        e === this._gen && (this.mode === "indexed" && await this._evictBehind(), await this._append(n), this._ended = !1, this._lastIdx = t.idx, this.mode === "sequential" && (this._next = t.idx + 1), this._firstAppend && (this._firstAppend.resolve(), this._firstAppend = null), this.onEvent("p2p:buffer", { ahead: this._aheadSeconds() }));
      }
    } catch (e) {
      this._fail(e);
    }
  }
  _aheadSeconds() {
    const e = this._video.currentTime || 0, t = this._rangeAt(e);
    return t ? Math.max(0, t.end - e) : 0;
  }
  async _finish() {
    if (!(this._ended || !this._ms || this._ms.readyState !== "open")) {
      await this._q;
      try {
        this._ms.endOfStream(), this._ended = !0, this.onEvent("p2p:streamed", { mode: this.mode });
      } catch (e) {
        this.onLog("endOfStream falhou —", e && e.message);
      }
    }
  }
  // ------------------------------------------------------------ SourceBuffer
  _enqueue(e) {
    const t = this._q.then(() => this._runOp(e));
    return this._q = t.catch(() => {
    }), t;
  }
  _runOp(e) {
    return new Promise((t, s) => {
      const n = this._sb;
      if (!n || this._destroyed) return s(new Error("stream destruído"));
      const i = () => {
        n.removeEventListener("updateend", o), n.removeEventListener("abort", o), n.removeEventListener("error", a);
      }, o = () => {
        i(), t();
      }, a = () => {
        i(), s(new Error("erro no SourceBuffer (dados rejeitados pelo decoder)"));
      };
      n.addEventListener("updateend", o), n.addEventListener("abort", o), n.addEventListener("error", a);
      try {
        e(n);
      } catch (l) {
        i(), s(l);
      }
    });
  }
  async _append(e) {
    try {
      await this._enqueue((t) => t.appendBuffer(e));
    } catch (t) {
      if (t && t.name === "QuotaExceededError") {
        if (this.mode !== "indexed")
          throw new Error("buffer do navegador cheio e o arquivo não tem sidx (não dá pra descartar e re-buscar) — republique com global_sidx");
        if (!await this._evictBehind(!0)) throw new Error("buffer do navegador cheio (QuotaExceeded) sem nada pra descartar");
        await this._enqueue((n) => n.appendBuffer(e));
      } else
        throw t;
    }
  }
  /** Remove do buffer o que já foi assistido há mais de backBufferS. */
  async _evictBehind(e = !1) {
    const t = this._sb;
    if (!t || !t.buffered.length) return !1;
    const n = (this._video.currentTime || 0) - (e ? Math.min(5, this.backBufferS) : this.backBufferS), i = t.buffered.start(0);
    return n - i < (e ? 1 : 10) ? !1 : (await this._enqueue((o) => o.remove(0, n)), !0);
  }
  // -------------------------------------------------------------- lifecycle
  isActive() {
    return !!this._sb && !this._failed && !this._destroyed;
  }
  _fail(e) {
    this._failed || this._destroyed || (this._failed = !0, this._firstAppend && (this._firstAppend.reject(e), this._firstAppend = null), this.onFatal(e));
  }
  destroy() {
    this._destroyed = !0, this._gen += 1, this._poke(), this._firstAppend && (this._firstAppend.reject(new Error("stream destruído")), this._firstAppend = null), this._video && (this._video.removeEventListener("seeking", this._onSeeking), this._video.removeEventListener("timeupdate", this._onTimeUpdate));
    try {
      this.reader.destroy();
    } catch (e) {
    }
    this._url && (URL.revokeObjectURL(this._url), this._url = null);
  }
}
function vt() {
  let r, e;
  const t = new Promise((s, n) => {
    r = s, e = n;
  });
  return t.catch(() => {
  }), { promise: t, resolve: r, reject: e };
}
const wt = 9e3, kt = 2, bt = 48 * 1024 * 1024, ye = /* @__PURE__ */ new Map();
function ee(r) {
  const e = r || "__default__";
  let t = ye.get(e);
  return t || (t = r ? new fe({ signalingUrl: r }) : new fe(), ye.set(e, t)), t;
}
function Et(r, e) {
  return e === "p2p";
}
function St(r, e) {
  return e === "hls" ? !0 : e === "mp4" || e === "progressive" || !r ? !1 : r.split("?")[0].toLowerCase().endsWith(".m3u8") || r.includes("mpegurl") || r.includes("type=application/x-mpegurl");
}
function Tt(r) {
  return r.canPlayType("application/vnd.apple.mpegurl") !== "";
}
async function Lt(r, { signalingUrls: e, perBlockTimeoutMs: t = 15e3, waitForPeersMs: s = 6e3, onLog: n } = {}) {
  const i = typeof r == "string" ? await Ee(r) : r, o = (e && e.length ? e : i.signalingUrls) || [], a = ee(o.length ? o[0] : i.signalingUrl);
  return { bytes: await Ie(a, i, { perBlockTimeoutMs: t, waitForPeersMs: s, onLog: n || a._log }), contentType: i.contentType, fileId: i.fileId };
}
class It {
  constructor(e, { onEvent: t, onQualityLevels: s } = {}) {
    this.video = e, this.onEvent = t || (() => {
    }), this.onQualityLevels = s || (() => {
    }), this.sources = [], this.sourceIndex = -1, this.hls = null, this._hlsModPromise = null, this._stallTimer = null, this._retries = 0, this._resumeTime = 0, this._destroyed = !1, this._onWaiting = this._onWaiting.bind(this), this._onPlaying = this._onPlaying.bind(this), this._onErrorNative = this._onErrorNative.bind(this), this.video.addEventListener("waiting", this._onWaiting), this.video.addEventListener("playing", this._onPlaying), this.video.addEventListener("error", this._onErrorNative);
  }
  /** @param {Array<{src:string,type?:string,label?:string}>|string} sources */
  setSources(e, { resumeTime: t = 0 } = {}) {
    const s = Array.isArray(e) ? e : [{ src: e }];
    if (this.sources = s.filter((n) => n && n.src), this.sourceIndex = -1, this._resumeTime = t || 0, !this.sources.length) {
      this.onEvent("error", { fatal: !0, reason: "sem fontes configuradas" });
      return;
    }
    this._loadSourceAt(0);
  }
  _loadSourceAt(e) {
    if (this._destroyed) return;
    if (e >= this.sources.length) {
      this.onEvent("error", {
        fatal: !0,
        reason: "todas as fontes falharam (cache, peers e CDN indisponíveis)"
      });
      return;
    }
    this.sourceIndex = e, this._retries = 0;
    const t = this.sources[e];
    this._teardownHls(), this._teardownMse(), this.onEvent("source:trying", { index: e, src: t.src }), Et(t.src, t.type) ? this._loadP2P(t) : St(t.src, t.type) ? this._loadHls(t) : this._loadProgressive(t);
  }
  /**
   * Fonte P2P — dois modos, escolhidos pelo formato de `source`:
   *
   * 1) MANIFESTO (multi-bloco, o caso normal pra vídeo hoje): `source.src` é
   *    o fileId e `source.p2pManifestUrl` aponta pro bilhete /p2p/:fileId do
   *    gateway (JSON pequeno — candidatos relay + iv/authTag por bloco).
   *    Busca TODOS os blocos nos peers via WebRTC, descriptografa
   *    (AES-256-GCM) e concatena — 100% P2P pro peso real (a mídia); o
   *    fetch do manifesto em si é só metadata, não conta como "cair pro
   *    HTTP" no sentido que importa (banda de vídeo).
   * 2) LEGADO (shard único): sem `p2pManifestUrl`, `source.src` já É o
   *    shardKey a buscar direto — mantido pra compat com integrações mais
   *    antigas/arquivos de bloco único.
   *
   * Se o P2P falhar (nenhum peer, bloco faltando etc.), cai pra próxima
   * fonte da lista (ex.: /raw/:fileId via CDN/gateway), igual qualquer
   * outra falha de fonte — o fallback HTTP continua existindo como rede de
   * segurança, só não é mais o caminho principal.
   */
  async _loadP2P(e) {
    this.onEvent("p2p:fetching", { shardKey: e.src });
    try {
      e.p2pManifestUrl ? await this._loadP2PManifest(e) : await this._loadP2PLegacyShard(e);
    } catch (t) {
      if (console.error("[vagalun-p2p] falha carregando fonte P2P —", e.src, t), this._destroyed || this.sourceIndex !== this.sources.indexOf(e)) return;
      this.onEvent("error", {
        fatal: !1,
        reason: `p2p: ${t && t.message || "falha desconhecida"}`,
        shardKey: e.src
      }), this._advanceToNextSource();
    }
  }
  async _loadP2PLegacyShard(e) {
    var n, i;
    const s = await ee(e.p2pSignalingUrl).fetchShard(e.src, {
      timeoutMs: (n = e.p2pTimeoutMs) != null ? n : 12e3,
      waitForPeersMs: (i = e.p2pWaitForPeersMs) != null ? i : 4e3
    });
    if (!(this._destroyed || this.sourceIndex !== this.sources.indexOf(e))) {
      if (!s) throw new Error("nenhum peer respondeu");
      this._setP2PBlobSource(e, s);
    }
  }
  async _loadP2PManifest(e) {
    var o, a, l;
    const t = await Ee(e.p2pManifestUrl);
    if (this._isStale(e)) return;
    const s = ee(t.signalingUrl || e.p2pSignalingUrl);
    if (this.onEvent("p2p:manifest", { fileId: t.fileId, blocks: t.blocks.length }), e.p2pStreaming !== !1 && V.isSupported())
      try {
        await this._startP2PStream(e, t, s);
        return;
      } catch (c) {
        if (!(c instanceof P)) throw c;
        this._teardownMse(), console.warn("[vagalun-p2p] streaming MSE indisponível —", c.message), this.onEvent("p2p:stream-unsupported", { reason: c.message, code: c.code });
      }
    if (this._isStale(e)) return;
    const n = (o = e.p2pBlobMaxBytes) != null ? o : bt;
    if (t.originalLength > n)
      throw new Error(
        `arquivo de ${(t.originalLength / 1048576).toFixed(0)}MB não é mp4 fragmentado — baixar tudo via P2P travaria o início; usando a próxima fonte (republique o vídeo pra habilitar streaming P2P)`
      );
    const i = await Ie(s, t, {
      perBlockTimeoutMs: (a = e.p2pTimeoutMs) != null ? a : 15e3,
      waitForPeersMs: (l = e.p2pWaitForPeersMs) != null ? l : 4e3,
      onProgress: (c, h) => this.onEvent("p2p:block", { done: c, total: h }),
      onLog: s._log
    });
    this._isStale(e) || this._setP2PBlobSource(e, i, t.contentType);
  }
  _isStale(e) {
    return this._destroyed || this.sourceIndex !== this.sources.indexOf(e);
  }
  async _startP2PStream(e, t, s) {
    var i, o;
    const n = new V({
      p2p: s,
      manifest: t,
      onLog: s._log,
      aheadTargetS: e.p2pAheadSeconds,
      backBufferS: e.p2pBackBufferSeconds,
      perBlockTimeoutMs: (i = e.p2pTimeoutMs) != null ? i : 15e3,
      waitForPeersMs: (o = e.p2pWaitForPeersMs) != null ? o : 4e3,
      prefetchBlocks: e.p2pPrefetchBlocks,
      onEvent: (a, l) => {
        this._mse === n && this.onEvent(a, l);
      },
      onFatal: (a) => {
        this._mse !== n || this._isStale(e) || (console.error("[vagalun-p2p] stream P2P falhou —", a), this.onEvent("error", { fatal: !1, reason: `p2p stream: ${a && a.message}`, shardKey: e.src }), this._advanceToNextSource());
      }
    });
    this._mse = n;
    try {
      const a = await n.probe();
      if (this._isStale(e)) {
        n.destroy();
        return;
      }
      this.onEvent("p2p:stream", a), await n.attach(this.video, { resumeTime: this._resumeTime });
    } catch (a) {
      throw this._mse === n && !(a instanceof P) && (n.destroy(), this._mse = null), a;
    }
    this._isStale(e) || this.onEvent("p2p:ready", { shardKey: e.src, streaming: !0, mode: n.mode });
  }
  _setP2PBlobSource(e, t, s) {
    this._activeObjectUrl && URL.revokeObjectURL(this._activeObjectUrl);
    const n = tt(t, s || e.mimeType || "video/mp4");
    this._activeObjectUrl = n, this.onEvent("p2p:ready", { shardKey: e.src, bytes: t.byteLength }), this._loadProgressive({ ...e, src: n });
  }
  _loadProgressive(e) {
    if (this.video.src = e.src, this._resumeTime > 1) {
      const t = () => {
        try {
          this.video.currentTime = this._resumeTime;
        } catch (s) {
        }
        this.video.removeEventListener("loadedmetadata", t);
      };
      this.video.addEventListener("loadedmetadata", t);
    }
    this.video.load();
  }
  async _loadHls(e) {
    if (Tt(this.video)) {
      this._loadProgressive(e);
      return;
    }
    this._hlsModPromise || (this._hlsModPromise = import("./hls-_F01Ckw_.js").then((s) => s.default || s));
    let t;
    try {
      t = await this._hlsModPromise;
    } catch (s) {
      this.onEvent("error", { fatal: !1, reason: "falha ao carregar hls.js", detail: s }), this._advanceToNextSource();
      return;
    }
    if (!this._destroyed) {
      if (!t.isSupported()) {
        this._loadProgressive(e);
        return;
      }
      this.hls = new t({
        maxBufferLength: 30,
        backBufferLength: 30,
        enableWorker: !0,
        lowLatencyMode: !1
      }), this.hls.on(t.Events.MANIFEST_PARSED, (s, n) => {
        const i = (n.levels || []).map((o, a) => ({
          index: a,
          height: o.height,
          bitrate: o.bitrate,
          label: o.height ? `${o.height}p` : `${Math.round(o.bitrate / 1e3)}kbps`
        }));
        if (this.onQualityLevels(i), this._resumeTime > 1)
          try {
            this.video.currentTime = this._resumeTime;
          } catch (o) {
          }
      }), this.hls.on(t.Events.ERROR, (s, n) => {
        if (n.fatal)
          switch (n.type) {
            case t.ErrorTypes.NETWORK_ERROR:
              this.onEvent("error", { fatal: !1, reason: "erro de rede no HLS", detail: n }), this._advanceToNextSource();
              break;
            case t.ErrorTypes.MEDIA_ERROR:
              try {
                this.hls.recoverMediaError();
              } catch (i) {
                this._advanceToNextSource();
              }
              break;
            default:
              this._advanceToNextSource();
              break;
          }
      }), this.hls.loadSource(e.src), this.hls.attachMedia(this.video);
    }
  }
  setQualityLevel(e) {
    this.hls && (this.hls.currentLevel = e);
  }
  _teardownHls() {
    if (this.hls) {
      try {
        this.hls.destroy();
      } catch (e) {
      }
      this.hls = null;
    }
    clearTimeout(this._stallTimer);
  }
  _teardownMse() {
    if (this._mse) {
      const e = !!this._mse._video;
      try {
        this._mse.destroy();
      } catch (t) {
      }
      if (this._mse = null, e)
        try {
          this.video.removeAttribute("src"), this.video.load();
        } catch (t) {
        }
    }
  }
  _onWaiting() {
    this.video.currentSrc && (this.onEvent("buffering", { state: !0 }), clearTimeout(this._stallTimer), !(this._mse && this._mse.isActive()) && (this._stallTimer = setTimeout(() => {
      if (this._retries += 1, this._retries > kt)
        this._advanceToNextSource();
      else {
        const e = this.video.currentTime;
        this._resumeTime = e, this._loadSourceAt(this.sourceIndex);
      }
    }, wt)));
  }
  _onPlaying() {
    this.onEvent("buffering", { state: !1 }), clearTimeout(this._stallTimer), this._retries = 0;
  }
  _onErrorNative() {
    const e = this.video.error;
    e && (this.onEvent("error", { fatal: !1, reason: "erro no elemento <video>", code: e.code }), this._advanceToNextSource());
  }
  _advanceToNextSource() {
    this._resumeTime = this.video.currentTime || this._resumeTime, this._loadSourceAt(this.sourceIndex + 1);
  }
  destroy() {
    this._destroyed = !0, clearTimeout(this._stallTimer), this._teardownHls(), this._teardownMse(), this._activeObjectUrl && (URL.revokeObjectURL(this._activeObjectUrl), this._activeObjectUrl = null), this.video.removeEventListener("waiting", this._onWaiting), this.video.removeEventListener("playing", this._onPlaying), this.video.removeEventListener("error", this._onErrorNative);
  }
}
function ve(r) {
  (!isFinite(r) || r < 0) && (r = 0);
  const e = Math.floor(r / 3600), t = Math.floor(r % 3600 / 60), s = Math.floor(r % 60), n = e > 0 ? String(t).padStart(2, "0") : String(t), i = String(s).padStart(2, "0");
  return e > 0 ? `${e}:${n}:${i}` : `${n}:${i}`;
}
function A(r) {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">${{
    play: '<path d="M8 5v14l11-7z"/>',
    pause: '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
    volume: '<path d="M4 9v6h4l5 5V4L8 9H4z"/>',
    mute: '<path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M19 8l-4 4m0-4l4 4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
    fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    exitFullscreen: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
    pip: '<path d="M4 5h16v14H4zM12 12h6v5h-6z" fill="none" stroke="currentColor" stroke-width="2"/>',
    settings: '<path d="M12 8a4 4 0 100 8 4 4 0 000-8zm8.4 4a7.4 7.4 0 01-.1 1.2l2 1.6-2 3.4-2.4-1a7.5 7.5 0 01-2 1.2l-.4 2.6h-4l-.4-2.6a7.5 7.5 0 01-2-1.2l-2.4 1-2-3.4 2-1.6A7.4 7.4 0 013.6 12c0-.4 0-.8.1-1.2l-2-1.6 2-3.4 2.4 1a7.5 7.5 0 012-1.2L8.5 2h4l.4 2.6a7.5 7.5 0 012 1.2l2.4-1 2 3.4-2 1.6c.1.4.1.8.1 1.2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>'
  }[r] || ""}</svg>`;
}
function Pt({ root: r, video: e, engine: t, playerId: s }) {
  const n = document.createElement("div");
  n.className = "vgl-controls";
  const i = document.createElement("div");
  i.className = "vgl-progress", i.setAttribute("role", "slider"), i.setAttribute("aria-label", "Progresso do vídeo"), i.tabIndex = 0;
  const o = document.createElement("div");
  o.className = "vgl-progress-buffered";
  const a = document.createElement("div");
  a.className = "vgl-progress-played";
  const l = document.createElement("div");
  l.className = "vgl-progress-scrubber", i.append(o, a, l);
  const c = document.createElement("div");
  c.className = "vgl-controls-row";
  const h = document.createElement("button");
  h.className = "vgl-btn vgl-play", h.type = "button", h.setAttribute("aria-label", "Reproduzir"), h.innerHTML = A("play");
  const m = document.createElement("button");
  m.className = "vgl-btn vgl-volume-btn", m.type = "button", m.setAttribute("aria-label", "Volume"), m.innerHTML = A("volume");
  const d = document.createElement("input");
  d.type = "range", d.min = "0", d.max = "1", d.step = "0.05", d.value = "1", d.className = "vgl-volume-slider", d.setAttribute("aria-label", "Nível de volume");
  const _ = document.createElement("div");
  _.className = "vgl-time", _.textContent = "0:00 / 0:00";
  const u = document.createElement("div");
  u.className = "vgl-spacer";
  const p = document.createElement("button");
  p.className = "vgl-btn vgl-settings-btn", p.type = "button", p.setAttribute("aria-label", "Configurações"), p.innerHTML = A("settings");
  const f = document.createElement("div");
  f.className = "vgl-settings-menu", f.hidden = !0;
  const y = document.createElement("button");
  y.className = "vgl-btn vgl-pip-btn", y.type = "button", y.setAttribute("aria-label", "Picture-in-picture"), y.innerHTML = A("pip"), document.pictureInPictureEnabled || (y.style.display = "none");
  const b = document.createElement("button");
  b.className = "vgl-btn vgl-fs-btn", b.type = "button", b.setAttribute("aria-label", "Tela cheia"), b.innerHTML = A("fullscreen"), c.append(h, m, d, _, u, p, y, b), n.append(i, c, f), r.appendChild(n);
  const v = document.createElement("div");
  v.className = "vgl-spinner", v.hidden = !0, r.appendChild(v);
  const w = document.createElement("button");
  w.className = "vgl-big-play", w.type = "button", w.setAttribute("aria-label", "Reproduzir vídeo"), w.innerHTML = '<svg viewBox="0 0 68 48" width="68" height="48"><path d="M66.5 7.7c-.8-2.9-2.6-5.2-5-6C56.9 0 34 0 34 0S11.1 0 6.5 1.7c-2.4.8-4.2 3.1-5 6C0 12.4 0 24 0 24s0 11.6 1.5 16.3c.8 2.9 2.6 5.1 5 6C11.1 48 34 48 34 48s22.9 0 27.5-1.7c2.4-.9 4.2-3.1 5-6C68 35.6 68 24 68 24s0-11.6-1.5-16.3z" fill="rgba(0,0,0,.55)"/><path d="M27 14l19 10-19 10V14z" fill="#fff"/></svg>', r.appendChild(w);
  const S = document.createElement("div");
  S.className = "vgl-error", S.hidden = !0, r.appendChild(S);
  const x = (g) => `vgl:${s || "default"}:${g}`;
  function W(g) {
    h.innerHTML = A(g ? "pause" : "play"), h.setAttribute("aria-label", g ? "Pausar" : "Reproduzir"), w.hidden = g;
  }
  function j() {
    if (!e.duration) return;
    const g = e.currentTime / e.duration * 100;
    if (a.style.width = `${g}%`, l.style.left = `${g}%`, _.textContent = `${ve(e.currentTime)} / ${ve(e.duration)}`, e.buffered.length) {
      const k = e.buffered.end(e.buffered.length - 1);
      o.style.width = `${Math.min(100, k / e.duration * 100)}%`;
    }
  }
  function se(g) {
    const k = i.getBoundingClientRect(), E = Math.min(1, Math.max(0, (g - k.left) / k.width));
    e.duration && (e.currentTime = E * e.duration);
  }
  let Q = !1;
  i.addEventListener("pointerdown", (g) => {
    Q = !0, se(g.clientX);
  }), window.addEventListener("pointermove", (g) => {
    Q && se(g.clientX);
  }), window.addEventListener("pointerup", () => {
    Q = !1;
  }), i.addEventListener("keydown", (g) => {
    g.key === "ArrowRight" && (e.currentTime = Math.min(e.duration || 0, e.currentTime + 5)), g.key === "ArrowLeft" && (e.currentTime = Math.max(0, e.currentTime - 5));
  });
  function q() {
    e.paused ? e.play().catch(() => {
    }) : e.pause();
  }
  h.addEventListener("click", q), w.addEventListener("click", q), e.addEventListener("click", q), e.addEventListener("play", () => W(!0)), e.addEventListener("pause", () => W(!1)), e.addEventListener("timeupdate", j), e.addEventListener("loadedmetadata", j), e.addEventListener("progress", j);
  const ne = localStorage.getItem(x("volume"));
  ne !== null && (e.volume = parseFloat(ne)), localStorage.getItem(x("muted")) === "1" && (e.muted = !0), d.value = String(e.volume);
  function F() {
    m.innerHTML = A(e.muted || e.volume === 0 ? "mute" : "volume");
  }
  F(), m.addEventListener("click", () => {
    e.muted = !e.muted, localStorage.setItem(x("muted"), e.muted ? "1" : "0"), F();
  }), d.addEventListener("input", () => {
    e.volume = parseFloat(d.value), e.muted = e.volume === 0, localStorage.setItem(x("volume"), d.value), localStorage.setItem(x("muted"), e.muted ? "1" : "0"), F();
  }), e.addEventListener("waiting", () => {
    v.hidden = !1;
  }), e.addEventListener("playing", () => {
    v.hidden = !0;
  }), e.addEventListener("canplay", () => {
    v.hidden = !0;
  });
  let D = [], C = -1;
  const Me = [0.5, 0.75, 1, 1.25, 1.5, 2];
  function B() {
    if (f.innerHTML = "", D.length > 1) {
      const k = document.createElement("div");
      k.className = "vgl-settings-header", k.textContent = "Qualidade", f.appendChild(k);
      const E = document.createElement("button");
      E.type = "button", E.className = "vgl-settings-item" + (C === -1 ? " active" : ""), E.textContent = "Automática", E.addEventListener("click", () => {
        C = -1, t.setQualityLevel(-1), localStorage.setItem(x("quality"), "-1"), B();
      }), f.appendChild(E), D.slice().sort((L, M) => (M.height || 0) - (L.height || 0)).forEach((L) => {
        const M = document.createElement("button");
        M.type = "button", M.className = "vgl-settings-item" + (C === L.index ? " active" : ""), M.textContent = L.label, M.addEventListener("click", () => {
          C = L.index, t.setQualityLevel(L.index), localStorage.setItem(x("quality"), String(L.index)), B();
        }), f.appendChild(M);
      });
    }
    const g = document.createElement("div");
    g.className = "vgl-settings-header", g.textContent = "Velocidade", f.appendChild(g), Me.forEach((k) => {
      const E = document.createElement("button");
      E.type = "button", E.className = "vgl-settings-item" + (e.playbackRate === k ? " active" : ""), E.textContent = k === 1 ? "Normal" : `${k}x`, E.addEventListener("click", () => {
        e.playbackRate = k, B();
      }), f.appendChild(E);
    });
  }
  B(), p.addEventListener("click", (g) => {
    g.stopPropagation(), f.hidden = !f.hidden;
  }), document.addEventListener("click", () => {
    f.hidden = !0;
  }), y.addEventListener("click", async () => {
    try {
      document.pictureInPictureElement ? await document.exitPictureInPicture() : await e.requestPictureInPicture();
    } catch (g) {
    }
  });
  function K() {
    return document.fullscreenElement === r || document.webkitFullscreenElement === r;
  }
  b.addEventListener("click", async () => {
    try {
      K() ? document.exitFullscreen ? await document.exitFullscreen() : document.webkitExitFullscreen && document.webkitExitFullscreen() : r.requestFullscreen ? await r.requestFullscreen() : r.webkitRequestFullscreen ? r.webkitRequestFullscreen() : e.webkitEnterFullscreen && e.webkitEnterFullscreen();
    } catch (g) {
    }
  }), document.addEventListener("fullscreenchange", () => {
    b.innerHTML = A(K() ? "exitFullscreen" : "fullscreen"), r.classList.toggle("vgl-fullscreen", K());
  });
  let ie = null;
  function re() {
    r.classList.remove("vgl-idle"), clearTimeout(ie), ie = setTimeout(() => {
      e.paused || r.classList.add("vgl-idle");
    }, 2600);
  }
  return ["mousemove", "pointerdown", "keydown", "touchstart"].forEach((g) => r.addEventListener(g, re)), re(), r.tabIndex = r.tabIndex || 0, r.addEventListener("keydown", (g) => {
    var k;
    if (!["INPUT", "BUTTON"].includes((k = document.activeElement) == null ? void 0 : k.tagName))
      switch (g.key) {
        case " ":
        case "k":
          g.preventDefault(), q();
          break;
        case "m":
          e.muted = !e.muted, F();
          break;
        case "f":
          b.click();
          break;
        case "ArrowRight":
          e.currentTime = Math.min(e.duration || 0, e.currentTime + 5);
          break;
        case "ArrowLeft":
          e.currentTime = Math.max(0, e.currentTime - 5);
          break;
        case "ArrowUp":
          g.preventDefault(), e.volume = Math.min(1, e.volume + 0.1), d.value = String(e.volume);
          break;
        case "ArrowDown":
          g.preventDefault(), e.volume = Math.max(0, e.volume - 0.1), d.value = String(e.volume);
          break;
      }
  }), {
    setQualityLevels(g) {
      D = g || [];
      const k = localStorage.getItem(x("quality"));
      k !== null && D.some((E) => String(E.index) === k) && (C = parseInt(k, 10), t.setQualityLevel(C)), B();
    },
    showError(g, k) {
      S.innerHTML = "";
      const E = document.createElement("p");
      if (E.textContent = g || "Não foi possível carregar o vídeo.", S.appendChild(E), k) {
        const L = document.createElement("button");
        L.type = "button", L.textContent = "Tentar novamente", L.className = "vgl-btn vgl-error-retry", L.addEventListener("click", k), S.appendChild(L);
      }
      S.hidden = !1;
    },
    hideError() {
      S.hidden = !0;
    },
    setPlayingIcon: W,
    elements: { wrap: n, playBtn: h, bigPlay: w, spinner: v, errorBox: S, settingsMenu: f }
  };
}
function xt(r) {
  if (!r) return;
  const e = r.replace(/\[CACHEBUSTER\]/g, String(Date.now())).replace(/\[TIMESTAMP\]/g, (/* @__PURE__ */ new Date()).toISOString());
  try {
    if (navigator.sendBeacon) {
      navigator.sendBeacon(e);
      return;
    }
  } catch (t) {
  }
  try {
    fetch(e, { method: "GET", mode: "no-cors", keepalive: !0 });
  } catch (t) {
  }
}
function I(r) {
  (Array.isArray(r) ? r : r ? [r] : []).forEach(xt);
}
async function xe(r, e = 0) {
  var p, f, y, b;
  if (e > 3) throw new Error("cadeia de VAST Wrapper longa demais");
  const s = await (await fetch(r)).text(), n = new DOMParser().parseFromString(s, "application/xml"), i = (f = (p = n.querySelector("Wrapper > VASTAdTagURI")) == null ? void 0 : p.textContent) == null ? void 0 : f.trim();
  if (i)
    return xe(i, e + 1);
  const o = n.querySelector("Linear");
  if (!o) throw new Error("VAST sem creative Linear (só anúncios lineares são suportados)");
  const a = [...n.querySelectorAll("MediaFile")].map((v) => ({ url: v.textContent.trim(), type: v.getAttribute("type") || "" })).filter((v) => v.url), l = a.find((v) => v.type.includes("mp4")) || a[0];
  if (!l) throw new Error("VAST sem MediaFile utilizável");
  const c = (b = (y = n.querySelector("ClickThrough")) == null ? void 0 : y.textContent) == null ? void 0 : b.trim(), h = [...n.querySelectorAll("ClickTracking")].map((v) => v.textContent.trim()), m = [...n.querySelectorAll("Impression")].map((v) => v.textContent.trim()), d = o.getAttribute("skipoffset");
  let _ = 5;
  if (d && /^\d\d:\d\d:\d\d$/.test(d)) {
    const [v, w, S] = d.split(":").map(Number);
    _ = v * 3600 + w * 60 + S;
  }
  const u = {};
  return n.querySelectorAll("TrackingEvents > Tracking").forEach((v) => {
    const w = v.getAttribute("event");
    w && (u[w] || (u[w] = [])).push(v.textContent.trim());
  }), {
    videoUrl: l.url,
    clickUrl: c,
    skipAfter: _,
    tracking: {
      impression: m,
      click: h,
      start: u.start,
      complete: u.complete,
      firstQuartile: u.firstQuartile,
      midpoint: u.midpoint,
      thirdQuartile: u.thirdQuartile,
      skip: u.skip
    }
  };
}
class At {
  constructor({ root: e, onEvent: t }) {
    this.root = e, this.onEvent = t || (() => {
    }), this.midrollsFired = /* @__PURE__ */ new Set(), this._overlayTimer = null;
  }
  emit(e, t) {
    this.onEvent(e, t);
  }
  /**
   * Toca um "ad break" (pre-roll ou mid-roll) em vídeo, ocupando o player
   * inteiro, e retorna uma Promise que resolve quando o anúncio termina ou é
   * pulado — o chamador então retoma o conteúdo principal.
   */
  playVideoAd(e) {
    return new Promise((t) => {
      var u;
      if (!e || !e.videoUrl) {
        t();
        return;
      }
      const s = document.createElement("div");
      s.className = "vgl-ad-break";
      const n = document.createElement("video");
      n.className = "vgl-ad-video", n.src = e.videoUrl, n.autoplay = !0, n.playsInline = !0, n.muted = !1;
      const i = document.createElement("div");
      i.className = "vgl-ad-badge", i.textContent = "Anúncio";
      const o = document.createElement("button");
      o.className = "vgl-ad-skip", o.type = "button", o.disabled = !0;
      const a = (u = e.skipAfter) != null ? u : 5;
      o.textContent = a > 0 ? `Pular em ${a}s` : "Pular anúncio", s.append(n, i, o), this.root.appendChild(s);
      let l = !1, c = { first: !1, mid: !1, third: !1 };
      const h = (p) => {
        var f, y;
        l || (l = !0, clearInterval(_), I(p ? (f = e.tracking) == null ? void 0 : f.skip : (y = e.tracking) == null ? void 0 : y.complete), s.remove(), t());
      }, m = () => {
        var p;
        e.clickUrl && (I((p = e.tracking) == null ? void 0 : p.click), this.emit("ad:click", { videoUrl: e.videoUrl, clickUrl: e.clickUrl }), window.open(e.clickUrl, "_blank", "noopener"));
      };
      n.addEventListener("click", m), n.addEventListener("timeupdate", () => {
        var f, y, b;
        if (!n.duration) return;
        const p = n.currentTime / n.duration;
        p >= 0.25 && !c.first && (c.first = !0, I((f = e.tracking) == null ? void 0 : f.firstQuartile)), p >= 0.5 && !c.mid && (c.mid = !0, I((y = e.tracking) == null ? void 0 : y.midpoint)), p >= 0.75 && !c.third && (c.third = !0, I((b = e.tracking) == null ? void 0 : b.thirdQuartile));
      }), n.addEventListener("ended", () => h(!1)), n.addEventListener("error", () => h(!0));
      let d = a;
      const _ = setInterval(() => {
        d -= 1, d > 0 ? o.textContent = `Pular em ${d}s` : (o.disabled = !1, o.textContent = "Pular anúncio ▸", clearInterval(_));
      }, 1e3);
      a <= 0 && (o.disabled = !1, o.textContent = "Pular anúncio ▸", clearInterval(_)), o.addEventListener("click", (p) => {
        p.stopPropagation(), o.disabled || h(!0);
      }), n.addEventListener("playing", () => {
        var p, f;
        I((p = e.tracking) == null ? void 0 : p.impression), I((f = e.tracking) == null ? void 0 : f.start), this.emit("ad:impression", { videoUrl: e.videoUrl });
      }, { once: !0 });
    });
  }
  async playFromVast(e) {
    try {
      const t = await xe(e);
      await this.playVideoAd(t);
    } catch (t) {
      this.emit("ad:error", { reason: t.message });
    }
  }
  /**
   * Banner pequeno e não-bloqueante, ancorado no canto — nunca cobre o vídeo
   * inteiro nem a barra de controles. Some sozinho depois de `showFor`.
   */
  showOverlay(e) {
    var a, l;
    if (!e || !e.imageUrl && !e.html) return;
    this.hideOverlay();
    const t = document.createElement("div");
    t.className = "vgl-ad-overlay";
    const s = document.createElement("button");
    s.className = "vgl-ad-overlay-close", s.type = "button", s.setAttribute("aria-label", "Fechar anúncio"), s.textContent = "✕";
    const n = document.createElement("a");
    if (n.className = "vgl-ad-overlay-content", n.href = e.clickUrl || "#", n.target = "_blank", n.rel = "noopener", e.imageUrl) {
      const c = document.createElement("img");
      c.src = e.imageUrl, c.alt = e.alt || "Anúncio", n.appendChild(c);
    } else e.html && (n.innerHTML = e.html);
    const i = document.createElement("span");
    i.className = "vgl-ad-overlay-label", i.textContent = "Publicidade", n.appendChild(i), n.addEventListener("click", (c) => {
      var h;
      if (!e.clickUrl) {
        c.preventDefault();
        return;
      }
      I((h = e.tracking) == null ? void 0 : h.click), this.emit("ad:click", { overlay: !0, clickUrl: e.clickUrl });
    }), s.addEventListener("click", (c) => {
      c.preventDefault(), c.stopPropagation(), this.hideOverlay();
    }), t.append(n, s), this.root.appendChild(t), this._overlayEl = t, I((a = e.tracking) == null ? void 0 : a.impression), this.emit("ad:impression", { overlay: !0 });
    const o = (l = e.showFor) != null ? l : 8;
    o > 0 && (this._overlayTimer = setTimeout(() => this.hideOverlay(), o * 1e3), t.addEventListener("mouseenter", () => clearTimeout(this._overlayTimer)), t.addEventListener("mouseleave", () => {
      this._overlayTimer = setTimeout(() => this.hideOverlay(), o * 1e3);
    }));
  }
  hideOverlay() {
    clearTimeout(this._overlayTimer), this._overlayEl && (this._overlayEl.remove(), this._overlayEl = null);
  }
  destroy() {
    this.hideOverlay();
  }
}
const Mt = "1.0.0";
function Ct() {
  return `vgl-${Math.random().toString(36).slice(2, 9)}`;
}
class Ae {
  /**
   * @param {string|HTMLElement} target - seletor CSS ou elemento onde o player será montado
   * @param {object} options
   * @param {Array<{src:string,type?:string,label?:string}>|string} [options.sources]
   * @param {string} [options.poster]
   * @param {boolean} [options.autoplay]
   * @param {boolean} [options.muted]
   * @param {boolean} [options.loop]
   * @param {string} [options.preload]
   * @param {number} [options.resumeTime]
   * @param {string} [options.playerId] - usado pra namespacear volume/qualidade salvos no localStorage
   * @param {object} [options.ads]
   * @param {object} [options.ads.preroll] - config de anúncio em vídeo pra tocar antes do conteúdo
   * @param {string} [options.ads.prerollVast] - alternativa: URL de tag VAST pro pre-roll
   * @param {Array<number|{at:number,videoUrl?:string,vastUrl?:string}>} [options.ads.midroll] - tempos (s) ou configs de mid-roll
   * @param {object} [options.ads.overlay] - config do banner pequeno (imageUrl/html, clickUrl, showFor, delay)
   */
  constructor(e, t = {}) {
    var n;
    const s = typeof e == "string" ? document.querySelector(e) : e;
    if (!s)
      throw new Error("VagalunPlayer: elemento alvo não encontrado");
    if (this.options = t, this.playerId = t.playerId || Ct(), this._listeners = {}, this._midrollTimes = t.ads && t.ads.midroll || [], this._midrollsFired = /* @__PURE__ */ new Set(), this._destroyed = !1, this.root = document.createElement("div"), this.root.className = "vgl-root", this.root.tabIndex = 0, this.video = document.createElement("video"), this.video.className = "vgl-video", this.video.playsInline = !0, this.video.preload = t.preload || "metadata", t.poster && (this.video.poster = t.poster), t.loop && (this.video.loop = !0), t.muted && (this.video.muted = !0), t.autoplay && (this.video.autoplay = !0), this.root.appendChild(this.video), s.innerHTML = "", s.appendChild(this.root), this.ads = new At({
      root: this.root,
      onEvent: (i, o) => this._emit(i, o)
    }), this.engine = new It(this.video, {
      onEvent: (i, o) => this._handleEngineEvent(i, o),
      onQualityLevels: (i) => this.controls && this.controls.setQualityLevels(i)
    }), this.controls = Pt({
      root: this.root,
      video: this.video,
      engine: this.engine,
      playerId: this.playerId
    }), this._onTimeUpdate = () => this._checkMidrolls(), this.video.addEventListener("timeupdate", this._onTimeUpdate), t.sources && this.setSources(t.sources, { resumeTime: t.resumeTime }), t.ads && t.ads.overlay) {
      const i = (n = t.ads.overlay.delay) != null ? n : 4;
      this._overlayTimer = setTimeout(() => {
        this._destroyed || this.ads.showOverlay(t.ads.overlay);
      }, i * 1e3);
    }
    t.ads && (t.ads.preroll || t.ads.prerollVast) && this._playPreroll();
  }
  async _playPreroll() {
    const { preroll: e, prerollVast: t } = this.options.ads || {};
    try {
      this.video.pause(), t ? await this.ads.playFromVast(t) : e && await this.ads.playVideoAd(e);
    } finally {
      this._destroyed || this.video.play().catch(() => {
      });
    }
  }
  _checkMidrolls() {
    !this._midrollTimes.length || !this.video.duration || this._midrollTimes.forEach((e, t) => {
      if (this._midrollsFired.has(t)) return;
      const s = typeof e == "number" ? e : e.at;
      this.video.currentTime >= s && (this._midrollsFired.add(t), this._playMidroll(e));
    });
  }
  async _playMidroll(e) {
    try {
      this.video.pause(), e && e.vastUrl ? await this.ads.playFromVast(e.vastUrl) : await this.ads.playVideoAd(e);
    } finally {
      this._destroyed || this.video.play().catch(() => {
      });
    }
  }
  _handleEngineEvent(e, t) {
    e === "error" && t.fatal ? this.controls.showError(t.reason, () => {
      this.controls.hideError(), this.setSources(this.options.sources, { resumeTime: this.video.currentTime });
    }) : e === "source:trying" ? this.controls.hideError() : e === "buffering" && t.state === !1 && this.controls.hideError(), this._emit(e, t);
  }
  // ---- API pública ----
  setSources(e, t = {}) {
    this.options.sources = e, this._midrollsFired = /* @__PURE__ */ new Set(), this.controls.hideError(), this.engine.setSources(e, t);
  }
  play() {
    return this.video.play();
  }
  pause() {
    this.video.pause();
  }
  seek(e) {
    this.video.currentTime = e;
  }
  get currentTime() {
    return this.video.currentTime;
  }
  set currentTime(e) {
    this.video.currentTime = e;
  }
  get duration() {
    return this.video.duration;
  }
  get volume() {
    return this.video.volume;
  }
  set volume(e) {
    this.video.volume = e;
  }
  get paused() {
    return this.video.paused;
  }
  on(e, t) {
    var s;
    return ((s = this._listeners)[e] || (s[e] = [])).push(t), () => this.off(e, t);
  }
  off(e, t) {
    this._listeners[e] && (this._listeners[e] = this._listeners[e].filter((s) => s !== t));
  }
  _emit(e, t) {
    (this._listeners[e] || []).forEach((s) => {
      try {
        s(t);
      } catch (n) {
        console.error("[VagalunPlayer] erro em listener:", n);
      }
    }), (this._listeners["*"] || []).forEach((s) => {
      try {
        s(e, t);
      } catch (n) {
        console.error("[VagalunPlayer] erro em listener:", n);
      }
    });
  }
  destroy() {
    this._destroyed = !0, clearTimeout(this._overlayTimer), this.video.removeEventListener("timeupdate", this._onTimeUpdate), this.engine.destroy(), this.ads.destroy(), this.root.remove(), this._listeners = {};
  }
}
Ae.VERSION = Mt;
Ae.p2pFetchFile = Lt;
export {
  Ae as default
};
