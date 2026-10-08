const ue = "wss://signal.vagalun.shop";
class ve {
  /**
   * @param {object} opts
   * @param {string} opts.selfNodeId
   * @param {string} [opts.url] - default SIGNALING_URL (fixo)
   * @param {boolean} [opts.autoReconnect]
   */
  constructor({ selfNodeId: e, url: t = ue, autoReconnect: s = !0, debug: n = !1 } = {}) {
    if (!e) throw new Error("SignalingClient: selfNodeId é obrigatório");
    this.url = t, this.selfNodeId = e, this.autoReconnect = s, this.ws = null, this._reconnectAttempt = 0, this._reconnectTimer = null, this._closedByUser = !1, this._log = n ? (...r) => console.log("[vagalun-p2p][signaling]", ...r) : () => {
    }, this.onSignal = null, this.onStateChange = null, this.onPeerList = null, this.onPeerJoined = null, this.onPeerLeft = null, this.onRelayRequest = null, this.onRelayResponse = null, this.onError = null;
  }
  connect() {
    this._closedByUser = !1, this._open();
  }
  _open() {
    this._log("abrindo WebSocket pra", this.url, "(tentativa", this._reconnectAttempt + 1, ")");
    let e;
    try {
      e = new WebSocket(this.url);
    } catch (t) {
      this._log("new WebSocket() lançou erro síncrono:", t && t.message), this._scheduleReconnect();
      return;
    }
    this.ws = e, e.onopen = () => {
      var t;
      this._log("WebSocket aberto, enviando register com nodeId", this.selfNodeId), this._reconnectAttempt = 0, this._send({ type: "register", nodeId: this.selfNodeId }), (t = this.onStateChange) == null || t.call(this, !0);
    }, e.onmessage = (t) => {
      let s;
      try {
        s = JSON.parse(t.data);
      } catch (n) {
        this._log("mensagem não-JSON recebida, ignorando:", t.data);
        return;
      }
      this._log("mensagem recebida:", s.type, s), this._handleMessage(s);
    }, e.onclose = (t) => {
      var s;
      this._log("WebSocket fechado — code:", t.code, "reason:", t.reason || "(vazio)", "wasClean:", t.wasClean), (s = this.onStateChange) == null || s.call(this, !1), this._closedByUser || this._scheduleReconnect();
    }, e.onerror = (t) => {
      this._log("WebSocket onerror (detalhe real geralmente só vem no onclose logo depois):", t);
    };
  }
  _handleMessage(e) {
    var t, s, n, r, a, c, o;
    switch (e.type) {
      case "signal":
        (t = this.onSignal) == null || t.call(this, e.from, e.payload);
        break;
      case "peers":
        (s = this.onPeerList) == null || s.call(this, Array.isArray(e.nodeIds) ? e.nodeIds : []);
        break;
      case "peer_joined":
        (n = this.onPeerJoined) == null || n.call(this, e.nodeId);
        break;
      case "peer_left":
        (r = this.onPeerLeft) == null || r.call(this, e.nodeId);
        break;
      case "relay": {
        const l = e.payloadBase64 ? ie(e.payloadBase64) : null;
        (a = this.onRelayRequest) == null || a.call(this, e.from, e.requestId, e.header, l);
        break;
      }
      case "relay_response": {
        const l = e.payloadBase64 ? ie(e.payloadBase64) : null;
        (c = this.onRelayResponse) == null || c.call(this, e.from, e.requestId, e.header, l);
        break;
      }
      case "error":
      case "relay_error":
        (o = this.onError) == null || o.call(this, e.reason || "erro_desconhecido", e.detail || null);
        break;
    }
  }
  _scheduleReconnect() {
    if (!this.autoReconnect || this._closedByUser) return;
    clearTimeout(this._reconnectTimer);
    const e = Math.min(15e3, 1e3 * 2 ** this._reconnectAttempt);
    this._log("reconectando em", e, "ms"), this._reconnectAttempt += 1, this._reconnectTimer = setTimeout(() => this._open(), e);
  }
  sendSignal(e, t) {
    this._send({ type: "signal", to: e, from: this.selfNodeId, payload: t });
  }
  sendRelay(e, t, s, n) {
    const r = { type: "relay", to: e, requestId: t, header: s };
    n && (r.payloadBase64 = ne(n)), this._send(r);
  }
  sendRelayResponse(e, t, s, n) {
    const r = { type: "relay_response", to: e, requestId: t, header: s };
    n && (r.payloadBase64 = ne(n)), this._send(r);
  }
  _send(e) {
    this.ws && this.ws.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify(e));
  }
  get connected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }
  disconnect() {
    var e;
    this._closedByUser = !0, clearTimeout(this._reconnectTimer);
    try {
      (e = this.ws) == null || e.close(1e3, "bye");
    } catch (t) {
    }
    this.ws = null;
  }
}
function ne(i) {
  let e = "";
  const t = i instanceof Uint8Array ? i : new Uint8Array(i);
  for (let s = 0; s < t.length; s++) e += String.fromCharCode(t[s]);
  return btoa(e);
}
function ie(i) {
  const e = atob(i), t = new Uint8Array(e.length);
  for (let s = 0; s < e.length; s++) t[s] = e.charCodeAt(s);
  return t;
}
const we = 0, D = 1, K = 15 * 1024, be = 17, ke = new TextEncoder(), Ee = new TextDecoder();
function Se(i) {
  if (i instanceof Uint8Array) return i;
  if (i instanceof ArrayBuffer) return new Uint8Array(i);
  throw new Error("payload precisa ser Uint8Array ou ArrayBuffer");
}
function Te(i, e) {
  const t = ke.encode(JSON.stringify(i || {})), s = e ? Se(e) : new Uint8Array(0), n = new Uint8Array(4 + t.length + s.length);
  return new DataView(n.buffer).setUint32(0, t.length, !1), n.set(t, 4), n.set(s, 4 + t.length), n;
}
function re(i, e, t, s) {
  const n = Te(t, s), r = n.length, a = Math.max(1, Math.ceil(r / K)), c = [];
  for (let o = 0; o < a; o++) {
    const l = o * K, d = Math.min(l + K, r), m = d - l, f = new ArrayBuffer(be + m), y = new DataView(f);
    let u = 0;
    y.setUint8(u, i), u += 1, y.setInt32(u, e, !1), u += 4, y.setInt32(u, o, !1), u += 4, y.setInt32(u, a, !1), u += 4, y.setInt32(u, r, !1), u += 4, m > 0 && new Uint8Array(f, u, m).set(n.subarray(l, d)), c.push(f);
  }
  return c;
}
function Ae(i) {
  const e = new DataView(i);
  let t = 0;
  const s = e.getUint8(t);
  t += 1;
  const n = e.getInt32(t, !1);
  t += 4;
  const r = e.getInt32(t, !1);
  t += 4;
  const a = e.getInt32(t, !1);
  t += 4;
  const c = e.getInt32(t, !1);
  if (t += 4, a < 1 || a > 1e6)
    throw new Error(`totalChunks inválido: ${a}`);
  if (c < 0 || c > 256 * 1024 * 1024)
    throw new Error(`totalLength inválido: ${c}`);
  if (r < 0 || r >= a)
    throw new Error(`chunkIndex fora do range: ${r}/${a}`);
  const o = new Uint8Array(i, t).slice();
  return { type: s, requestId: n, chunkIndex: r, totalChunks: a, totalLength: c, chunkBytes: o };
}
function Me(i) {
  const t = new DataView(i.buffer, i.byteOffset, i.byteLength).getUint32(0, !1);
  if (t < 0 || t > 4 * 1024 * 1024)
    throw new Error(`header de tamanho inválido: ${t}`);
  const s = i.subarray(4, 4 + t), n = JSON.parse(Ee.decode(s)), r = i.subarray(4 + t), a = r.length > 0 ? r.slice() : null;
  return { header: n, payload: a };
}
class Pe {
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
    let r = 0;
    for (const o of s.chunks)
      n.set(o, r), r += o.length;
    const { header: a, payload: c } = Me(n);
    return { type: e.type, requestId: e.requestId, header: a, payload: c };
  }
  /** Descarta transferências incompletas — chamar no close() do transport. */
  clear() {
    this._inProgress.clear();
  }
}
function xe() {
  return [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" }
  ];
}
const Le = 2e4, ae = 2 * 1024 * 1024, Ie = 15;
function Ce(i) {
  return i.bufferedAmount <= ae ? Promise.resolve() : new Promise((e) => {
    const t = () => {
      if (i.readyState !== "open" || i.bufferedAmount <= ae) {
        e();
        return;
      }
      setTimeout(t, Ie);
    };
    t();
  });
}
async function oe(i, e, t) {
  for (const s of e) {
    if (i.readyState !== "open")
      return t('canal não está mais "open" no meio do envio dos chunks (readyState:', i.readyState, ")"), !1;
    await Ce(i);
    try {
      i.send(s);
    } catch (n) {
      return t("dc.send() lançou erro mandando chunk:", n && n.message), !1;
    }
  }
  return !0;
}
class Re {
  constructor(e, t, { onIncomingRequest: s, debug: n = !1 } = {}) {
    this.peerNodeId = e, this.dc = t, this._nextRequestId = 0, this._pending = /* @__PURE__ */ new Map(), this._reassembler = new Pe(), this._onIncomingRequest = s || null, this._log = n ? (...r) => console.log("[vagalun-p2p][transport]", e, ...r) : () => {
    }, this.dc.binaryType = "arraybuffer", this.dc.onmessage = (r) => this._onMessage(r);
  }
  get open() {
    return this.dc && this.dc.readyState === "open";
  }
  _onMessage(e) {
    const t = e.data && e.data.byteLength;
    let s;
    try {
      s = Ae(e.data);
    } catch (r) {
      this._log("FALHA AO DECODIFICAR chunk recebido (", t, "bytes ) — provável descompasso de protocolo com o peer:", r && r.message);
      return;
    }
    this._log("chunk recebido —", t, "bytes — type:", s.type === D ? "RESPONSE" : "REQUEST", "requestId:", s.requestId, `chunk ${s.chunkIndex + 1}/${s.totalChunks}`);
    let n;
    try {
      n = this._reassembler.accept(s);
    } catch (r) {
      this._log("falha remontando frame — requestId", s.requestId, ":", r && r.message);
      return;
    }
    if (n)
      if (this._log("frame remontado — type:", n.type === D ? "RESPONSE" : "REQUEST", "requestId:", n.requestId, "header:", n.header, "payload bytes:", n.payload ? n.payload.byteLength : 0), n.type === D) {
        const r = this._pending.get(n.requestId);
        if (!r) {
          this._log("resposta chegou pro requestId", n.requestId, "mas não tem ninguém esperando esse id (já deu timeout antes, ou requestId não bate)");
          return;
        }
        clearTimeout(r.timer), this._pending.delete(n.requestId), r.resolve(n);
      } else this._onIncomingRequest && this._handleIncomingRequest(n);
  }
  async _handleIncomingRequest(e) {
    let t, s = null;
    try {
      const a = await this._onIncomingRequest(e.header, e.payload);
      t = a && a.header || { ok: !1 }, s = a && a.payload || null;
    } catch (a) {
      t = { ok: !1, error: String(a && a.message || a) };
    }
    const n = re(D, e.requestId, t, s);
    await oe(this.dc, n, this._log) || this._log("resposta pro requestId", e.requestId, "NÃO foi entregue por completo — peer deve ter perdido a conexão no meio do envio");
  }
  _sendAndAwait(e, t, s = Le) {
    if (!this.open)
      return this._log("_sendAndAwait chamado mas data channel não está open (readyState:", this.dc && this.dc.readyState, ") — nem tenta mandar"), Promise.resolve(null);
    const n = ++this._nextRequestId, r = re(we, n, e, t);
    return this._log("mandando request", n, "—", e, `(${r.length} chunk(s))`), new Promise((a) => {
      const c = setTimeout(() => {
        this._log("TIMEOUT esperando resposta do request", n, `(${s}ms) — peer nunca respondeu esse requestId específico`), this._pending.delete(n), a(null);
      }, s);
      this._pending.set(n, { resolve: a, timer: c }), oe(this.dc, r, this._log).then((o) => {
        o || (this._log("falha mandando chunks do request", n, "— desiste sem esperar timeout"), clearTimeout(c), this._pending.delete(n), a(null));
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
class Ue {
  constructor(e, { onTransportReady: t, onTransportClosed: s, onIncomingRequest: n, iceServers: r, debug: a = !1 } = {}) {
    this.signaling = e, this.onTransportReady = t || (() => {
    }), this.onTransportClosed = s || (() => {
    }), this.onIncomingRequest = n || null, this.iceServers = r || xe(), this.sessions = /* @__PURE__ */ new Map(), this.debug = a, this._log = a ? (...c) => console.log("[vagalun-p2p][rtc]", ...c) : () => {
    }, a && !r && this._log('AVISO: usando só STUN (defaultIceServers), sem TURN. Se o peer estiver atrás de NAT simétrico/CGNAT, a conexão pode nunca fechar — isso aparece como iceConnectionState preso em "checking" ou indo direto pra "failed" abaixo.'), this.signaling.onSignal = (c, o) => this.handleSignal(c, o);
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
    this._wireDataChannel(e, t, n), s.createOffer().then((r) => s.setLocalDescription(r).then(() => r)).then((r) => {
      this._log("offer criada e setada localmente pra", e, "— enviando via signaling"), this.signaling.sendSignal(e, { kind: "offer", sdp: r.sdp });
    }).catch((r) => {
      this._log("createOffer/setLocalDescription falhou pra", e, ":", r && r.message), this._teardown(e);
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
    return this.sessions.set(e, n), s.onicecandidate = (r) => {
      if (!r.candidate) {
        this._log("ICE gathering completo pra", e);
        return;
      }
      this._log("candidato ICE local pra", e, "— type:", r.candidate.type, "protocol:", r.candidate.protocol), this.signaling.sendSignal(e, {
        kind: "ice",
        candidate: r.candidate.candidate,
        sdpMid: r.candidate.sdpMid,
        sdpMLineIndex: r.candidate.sdpMLineIndex
      });
    }, s.ondatachannel = (r) => {
      this._log("data channel recebido do peer", e), this._wireDataChannel(e, n, r.channel);
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
      const r = await n.createAnswer();
      await n.setLocalDescription(r), this._log("answer criada pra", e, "— enviando via signaling"), this.signaling.sendSignal(e, { kind: "answer", sdp: r.sdp });
    } catch (r) {
      this._log("falha processando offer de", e, ":", r && r.message), this._teardown(e);
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
      } catch (r) {
      }
    else
      s.pendingRemoteCandidates.push(n);
  }
  async _flushPendingCandidates(e, t) {
    const s = t.pendingRemoteCandidates.splice(0);
    for (const n of s)
      try {
        await e.addIceCandidate(n);
      } catch (r) {
      }
  }
  _wireDataChannel(e, t, s) {
    t.dataChannel = s, s.binaryType = "arraybuffer", s.onopen = () => {
      if (this._log("data channel ABERTO com", e, "— pronto pra pedir shards"), !t.transport) {
        const n = new Re(e, s, { onIncomingRequest: this.onIncomingRequest, debug: this.debug });
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
function $e() {
  return `viewer-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}
function Be() {
  return !0;
}
class ce {
  constructor({ nodeId: e, signalingUrl: t = ue, debug: s = Be(), iceServers: n } = {}) {
    this.nodeId = e || $e(), this.debug = s, this.peers = /* @__PURE__ */ new Set(), this.transports = /* @__PURE__ */ new Map(), this._connectPromise = null, this._log = s ? (...r) => console.log("[vagalun-p2p]", ...r) : () => {
    }, s && this._log("instância criada — nodeId:", this.nodeId, "signalingUrl:", t), this.signaling = new ve({ selfNodeId: this.nodeId, url: t, debug: s }), this.rtc = new Ue(this.signaling, {
      debug: s,
      iceServers: n,
      // undefined = usa defaultIceServers() (só STUN); passe TURN aqui quando tiver
      onTransportReady: (r, a) => {
        this.transports.set(r, a), this._log("transport pronto com", r, "— total de peers com canal aberto:", this.transports.size);
      },
      onTransportClosed: (r) => {
        this.transports.delete(r), this._log("transport fechado com", r);
      }
    }), this.signaling.onPeerList = (r) => {
      this._log("peers conhecidos:", r), r.forEach((a) => this._addPeer(a));
    }, this.signaling.onPeerJoined = (r) => this._addPeer(r), this.signaling.onPeerLeft = (r) => {
      this.peers.delete(r), this.rtc.disconnect(r);
    }, this.signaling.onError = (r, a) => {
      this._log("erro do signaling:", r, a);
    }, this.signaling.onStateChange = (r) => {
      this._log(r ? "conectado ao signaling" : "desconectado do signaling");
    };
  }
  _addPeer(e) {
    e === this.nodeId || this.peers.has(e) || (this.peers.add(e), this._log("discou pro peer", e, "(via signaling)"), this.rtc.connectToPeer(e));
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
  async fetchShard(e, { timeoutMs: t = 12e3, waitForPeersMs: s = 4e3 } = {}) {
    this._log("fetchShard() início —", e, `(espera até ${s}ms por peer, timeout total ${t}ms)`), await this.connect(), this._log("signaling conectado?", this.signaling.connected, "— peers conhecidos até agora:", this.peers.size), await this._waitForAnyPeer(s);
    const n = Array.from(this.transports.values()).filter((a) => a.open);
    if (this._log("candidatos com data channel aberto:", n.length, "de", this.transports.size, "sessões WebRTC totais e", this.peers.size, "peers conhecidos pelo signaling"), !n.length)
      return this.peers.size === 0 ? this._log("DIAGNÓSTICO: signaling não retornou nenhum peer pra", e, "— ou não tem ninguém com esse fileId anunciado, ou o signaling em si não conectou (confere connected acima).") : this._log("DIAGNÓSTICO: signaling achou", this.peers.size, "peer(s), mas o WebRTC nunca abriu data channel com nenhum — provável falha de ICE (NAT/sem TURN). Confere oniceconnectionstatechange nos logs acima."), null;
    const r = await Oe(
      n.map((a) => a.getShard(e)),
      t
    );
    return this._log("fetchShard() fim —", e, r ? `sucesso, ${r.byteLength} bytes` : "nenhum candidato respondeu com o shard (peer conectado mas não tinha esse fileId, ou deu timeout)"), r;
  }
  _waitForAnyPeer(e) {
    return Array.from(this.transports.values()).some((t) => t.open) ? Promise.resolve() : new Promise((t) => {
      const s = Date.now(), n = setInterval(() => {
        (Array.from(this.transports.values()).some((a) => a.open) || Date.now() - s > e) && (clearInterval(n), t());
      }, 150);
    });
  }
  disconnect() {
    this.rtc.disconnectAll(), this.signaling.disconnect(), this._connectPromise = null;
  }
}
async function Oe(i, e) {
  return new Promise((t) => {
    let s = i.length, n = !1;
    const r = setTimeout(() => {
      n || (n = !0, t(null));
    }, e);
    i.forEach((a) => {
      a.then((c) => {
        s -= 1, !n && c ? (n = !0, clearTimeout(r), t(c)) : !n && s === 0 && (n = !0, clearTimeout(r), t(null));
      }).catch(() => {
        s -= 1, !n && s === 0 && (n = !0, clearTimeout(r), t(null));
      });
    });
  });
}
function qe(i, e = "video/mp4") {
  const t = new Blob([i], { type: e });
  return URL.createObjectURL(t);
}
function fe(i, e, t) {
  return `${i}_b${e}_s${t}`;
}
function U(i) {
  const e = atob(i), t = new Uint8Array(e.length);
  for (let s = 0; s < e.length; s++) t[s] = e.charCodeAt(s);
  return t;
}
function pe(i) {
  if (!crypto.subtle)
    throw new Error("crypto.subtle indisponível — página precisa estar em HTTPS (ou localhost) pra descriptografar via Web Crypto");
  if (i.length !== 32)
    throw new Error(`fileKeyB64 do manifesto tem ${i.length} bytes decodificados, esperado 32 (AES-256) — manifesto corrompido ou vazio`);
  return crypto.subtle.importKey("raw", i, { name: "AES-GCM" }, !1, ["decrypt"]);
}
async function me(i, e, t, s) {
  const n = new Uint8Array(e.length + s.length);
  n.set(e, 0), n.set(s, e.length);
  const r = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: t, tagLength: 128 },
    i,
    n
  );
  return new Uint8Array(r);
}
async function Ne(i) {
  const e = await fetch(i, { cache: "no-store" });
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
  return t;
}
async function Fe(i, e, t = {}) {
  const {
    onProgress: s = () => {
    },
    onLog: n = () => {
    },
    perBlockTimeoutMs: r = 15e3,
    waitForPeersMs: a = 4e3
  } = t;
  if (!e.fileKeyB64)
    throw new Error("manifesto sem fileKeyB64 — arquivo não publicado com chave pra acesso via gateway/P2P");
  const c = await pe(U(e.fileKeyB64)), o = e.blocks.slice().sort((h, p) => h.blockIndex - p.blockIndex), l = o.length, d = new Array(l);
  let m = 0;
  for (const h of o) {
    let p = null, v = null, k = null;
    for (const _ of e.candidates) {
      const b = fe(e.fileId, h.blockIndex, _.shardIndex);
      n("bloco", h.blockIndex, "de", l, "— tentando", b, "via", _.relayNodeId);
      const S = await i.fetchShard(b, {
        timeoutMs: r,
        // só espera peer "aparecer" no signaling no 1º bloco — dos demais
        // em diante a sessão WebRTC já deve estar de pé.
        waitForPeersMs: m === 0 ? a : 500
      });
      if (S) {
        p = S.subarray(0, h.plainLength), v = _.shardIndex, k = _.relayNodeId;
        break;
      }
    }
    if (!p)
      throw new Error(
        `bloco ${h.blockIndex}/${l}: nenhum candidato respondeu (tentados: ${e.candidates.map((_) => _.relayNodeId).join(", ")})`
      );
    n("bloco", h.blockIndex, "— recebido de", k, `shardIndex ${v} (${p.length} bytes cifrados), descriptografando...`);
    try {
      d[h.blockIndex] = await me(
        c,
        p,
        U(h.iv),
        U(h.authTag)
      );
    } catch (_) {
      throw new Error(`bloco ${h.blockIndex}/${l}: falha ao descriptografar (chave/iv/authTag não batem com o shard recebido) — ${_ && _.message}`);
    }
    m += 1, s(m, l);
  }
  let f = 0;
  for (const h of d) f += h.length;
  const y = new Uint8Array(f);
  let u = 0;
  for (const h of d)
    y.set(h, u), u += h.length;
  return y;
}
class De {
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
    var n, r, a, c, o;
    this.p2p = e, this.manifest = t, this.onLog = s.onLog || (() => {
    }), this.onBlock = s.onBlock || (() => {
    }), this.perBlockTimeoutMs = (n = s.perBlockTimeoutMs) != null ? n : 15e3, this.waitForPeersMs = (r = s.waitForPeersMs) != null ? r : 4e3, this.maxAttempts = (a = s.maxAttempts) != null ? a : 3, this.prefetchBlocks = (c = s.prefetchBlocks) != null ? c : 3, this.cacheBlocks = (o = s.cacheBlocks) != null ? o : this.prefetchBlocks + 6, this._cache = /* @__PURE__ */ new Map(), this._candidates = t.candidates.slice(), this._gotOne = !1, this._destroyed = !1, this.fetched = 0;
  }
  async init() {
    if (!this.manifest.fileKeyB64)
      throw new Error("manifesto sem fileKeyB64 — arquivo não publicado com chave pra acesso via gateway/P2P");
    this.cryptoKey = await pe(U(this.manifest.fileKeyB64)), this.blocks = this.manifest.blocks.slice().sort((e, t) => e.blockIndex - t.blockIndex), this.offsets = new Array(this.blocks.length + 1), this.offsets[0] = 0;
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
    const s = this.blockAt(e), n = this.blockAt(t - 1), r = [];
    for (let l = s; l <= n; l++) r.push(this._get(l));
    this.prefetch(n + 1);
    const a = await Promise.all(r);
    if (s === n) return a[0].subarray(e - this.offsets[s], t - this.offsets[s]);
    const c = new Uint8Array(t - e);
    let o = 0;
    for (let l = 0; l < a.length; l++) {
      const d = s + l, m = Math.max(e, this.offsets[d]) - this.offsets[d], f = Math.min(t, this.offsets[d + 1]) - this.offsets[d];
      c.set(a[l].subarray(m, f), o), o += f - m;
    }
    return c;
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
    for (let r = 0; r < this.maxAttempts; r++) {
      for (const a of this._candidates.slice()) {
        if (this._destroyed) throw new Error("leitor P2P destruído");
        const c = fe(this.manifest.fileId, t.blockIndex, a.shardIndex), o = await this.p2p.fetchShard(c, {
          timeoutMs: this.perBlockTimeoutMs,
          waitForPeersMs: this._gotOne ? 500 : this.waitForPeersMs
        });
        if (o)
          try {
            const l = await me(
              this.cryptoKey,
              o.subarray(0, t.plainLength),
              U(t.iv),
              U(t.authTag)
            );
            return this._gotOne = !0, this._candidates = [a, ...this._candidates.filter((d) => d !== a)], this.fetched += 1, this.onBlock(this.fetched, s), l;
          } catch (l) {
            n = l, this.onLog("bloco", e, "falha ao descriptografar via", a.relayNodeId, l && l.message);
          }
      }
      await new Promise((a) => setTimeout(a, 300 * (r + 1)));
    }
    throw new Error(
      `bloco ${e}/${s}: nenhum candidato respondeu após ${this.maxAttempts} tentativas` + (n ? ` (último erro: ${n.message})` : "")
    );
  }
  destroy() {
    this._destroyed = !0, this._cache.clear();
  }
}
const He = (i, e) => i[e], ze = (i, e) => i[e] << 8 | i[e + 1], T = (i, e) => (i[e] << 24 | i[e + 1] << 16 | i[e + 2] << 8 | i[e + 3]) >>> 0, X = (i, e) => T(i, e) * 4294967296 + T(i, e + 4), Y = (i, e) => String.fromCharCode(i[e], i[e + 1], i[e + 2], i[e + 3]), ge = (i) => i.toString(16).padStart(2, "0").toUpperCase(), H = (i) => i.toString(16).padStart(2, "0");
function B(i, e = 0, t = i.length) {
  if (e + 8 > t) return null;
  let s = T(i, e);
  const n = Y(i, e + 4);
  let r = 8;
  if (s === 1) {
    if (e + 16 > t) return null;
    s = X(i, e + 8), r = 16;
  } else s === 0 && (s = null);
  return { type: n, size: s, hdr: r };
}
function* J(i, e = 0, t = i.length) {
  let s = e;
  for (; s + 8 <= t; ) {
    const n = B(i, s, t);
    if (!n) return;
    const r = n.size === null ? t - s : n.size;
    if (r < n.hdr || s + r > t) return;
    yield { type: n.type, start: s, end: s + r, payload: s + n.hdr }, s += r;
  }
}
function R(i, e, t) {
  for (const s of J(i, e.payload, e.end)) if (s.type === t) return s;
  return null;
}
function Ve(i, e, ...t) {
  let s = e;
  for (const n of t) {
    if (!s) return null;
    s = R(i, s, n);
  }
  return s;
}
function O(i, e, t, s) {
  for (let n = e; n + 4 <= t; n++)
    if (i[n] === s.charCodeAt(0) && i[n + 1] === s.charCodeAt(1) && i[n + 2] === s.charCodeAt(2) && i[n + 3] === s.charCodeAt(3))
      return n;
  return -1;
}
function We(i, e, t) {
  const s = O(i, e, t, "avcC");
  if (s < 0) return null;
  const n = s + 4;
  return `avc1.${H(i[n + 1])}${H(i[n + 2])}${H(i[n + 3])}`;
}
function je(i) {
  let e = 0;
  for (let t = 0; t < 32; t++)
    e = e << 1 | i >>> t & 1;
  return e >>> 0;
}
function Qe(i, e, t, s) {
  const n = O(i, e, t, "hvcC");
  if (n < 0) return null;
  const r = n + 4, a = i[r + 1] >> 6, c = i[r + 1] >> 5 & 1, o = i[r + 1] & 31, l = je(T(i, r + 2)).toString(16).toUpperCase(), d = i[r + 12], m = [];
  for (let u = 0; u < 6; u++) m.push(i[r + 6 + u]);
  for (; m.length && m[m.length - 1] === 0; ) m.pop();
  const f = ["", "A", "B", "C"][a], y = m.length ? "." + m.map(ge).join(".") : "";
  return `${s}.${f}${o}.${l}.${c ? "H" : "L"}${d}${y}`;
}
function Ke(i, e, t) {
  const s = O(i, e, t, "av1C");
  if (s < 0) return null;
  const n = s + 4, r = i[n + 1] >> 5, a = i[n + 1] & 31, c = i[n + 2] >> 7 & 1, o = i[n + 2] >> 6 & 1, d = i[n + 2] >> 5 & 1 ? 12 : o ? 10 : 8;
  return `av01.${r}.${String(a).padStart(2, "0")}${c ? "H" : "M"}.${String(d).padStart(2, "0")}`;
}
function Ge(i, e, t) {
  const s = O(i, e, t, "vpcC");
  if (s < 0) return null;
  const n = s + 4 + 4, r = i[n], a = i[n + 1], c = i[n + 2] >> 4;
  return `vp09.${String(r).padStart(2, "0")}.${String(a).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}
function G(i, e) {
  let t = 0, s = 0;
  for (; s < 4; s++) {
    const n = i[e + s];
    if (t = t << 7 | n & 127, !(n & 128)) {
      s++;
      break;
    }
  }
  return { len: t, n: s };
}
function Xe(i, e, t) {
  const s = O(i, e, t, "esds");
  if (s < 0) return "mp4a.40.2";
  let n = s + 4 + 4;
  const r = t;
  if (i[n] !== 3) return "mp4a.40.2";
  let a = G(i, n + 1);
  if (n += 1 + a.n + 3, i[n] !== 4) return "mp4a.40.2";
  a = G(i, n + 1), n += 1 + a.n;
  const c = i[n];
  if (n += 13, c === 107 || c === 105) return `mp4a.${ge(c)}`;
  let o = 2;
  return n < r && i[n] === 5 && (a = G(i, n + 1), o = i[n + 1 + a.n] >> 3, o === 31 && (o = 32 + ((i[n + 1 + a.n] & 7) << 3 | i[n + 2 + a.n] >> 5))), `mp4a.${H(c)}.${o}`;
}
function Je(i, e) {
  const t = e.type, s = e.payload, n = e.end;
  switch (t) {
    case "avc1":
    case "avc3":
      return We(i, s, n);
    case "hvc1":
    case "hev1":
      return Qe(i, s, n, t);
    case "av01":
      return Ke(i, s, n);
    case "vp09":
      return Ge(i, s, n);
    case "mp4a":
      return Xe(i, s, n);
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
function Ye(i) {
  const e = B(i, 0);
  if (!e || e.type !== "moov") throw new Error("não é uma box moov");
  const t = { payload: e.hdr, end: e.size === null ? i.length : e.size }, s = [];
  for (const n of J(i, t.payload, t.end)) {
    if (n.type !== "trak") continue;
    const r = R(i, n, "tkhd"), a = R(i, n, "mdia");
    if (!r || !a) continue;
    const c = i[r.payload], o = T(i, r.payload + (c === 1 ? 20 : 12)), l = R(i, a, "mdhd"), d = R(i, a, "hdlr"), m = l ? i[l.payload] : 0, f = l ? T(i, l.payload + (m === 1 ? 20 : 12)) : 1, y = d ? Y(i, d.payload + 8) : "", u = Ve(i, a, "minf", "stbl", "stsd");
    let h = null, p = null;
    if (u)
      for (const v of J(i, u.payload + 8, u.end)) {
        p = v.type, h = Je(i, v);
        break;
      }
    s.push({ id: o, timescale: f, handler: y, codec: h, entry: p });
  }
  return { hasMvex: !!R(i, t, "mvex"), tracks: s };
}
function Ze(i, e) {
  const t = B(i, 0);
  if (!t || t.type !== "sidx") throw new Error("não é uma box sidx");
  let s = t.hdr;
  const n = He(i, s);
  s += 4;
  const r = T(i, s);
  s += 4;
  const a = T(i, s);
  s += 4;
  let c, o;
  n === 0 ? (c = T(i, s), s += 4, o = T(i, s), s += 4) : (c = X(i, s), s += 8, o = X(i, s), s += 8), s += 2;
  const l = ze(i, s);
  s += 2;
  const d = [];
  let m = !1;
  for (let h = 0; h < l; h++) {
    const p = T(i, s), v = p >>> 31, k = p & 2147483647, _ = T(i, s + 4), b = T(i, s + 8) >>> 31;
    v === 1 && (m = !0), d.push({ size: k, dur: _, sap: b }), s += 12;
  }
  let f = e + o, y = c;
  const u = d.map((h) => {
    const p = { start: f, end: f + h.size, t: y / a, dur: h.dur / a, sap: !!h.sap };
    return f += h.size, y += h.dur, p;
  });
  return { referenceId: r, timescale: a, hierarchical: m, units: u, duration: y / a };
}
function et(i) {
  if (i.length < 16) return 0;
  const e = i.length;
  return Y(i, e - 12) !== "mfro" ? 0 : T(i, e - 4);
}
function tt(...i) {
  const e = i.reduce((n, r) => n + r.length, 0), t = new Uint8Array(e);
  let s = 0;
  for (const n of i)
    t.set(n, s), s += n.length;
  return t;
}
class P extends Error {
  /** @param {string} message @param {'no-mse'|'not-fragmented'|'codec'|'init'} code */
  constructor(e, t) {
    super(e), this.name = "MseUnsupportedError", this.code = t;
  }
}
const st = 32 * 1024 * 1024, nt = 0.3;
class z {
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
    }), this.aheadTargetS = (t = e.aheadTargetS) != null ? t : 60, this.backBufferS = (s = e.backBufferS) != null ? s : 30, this.reader = e.reader || new De(e.p2p, e.manifest, {
      onLog: this.onLog,
      onBlock: (n, r) => this.onEvent("p2p:block", { done: n, total: r }),
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
    if (!z.isSupported()) throw new P("MediaSource indisponível neste navegador", "no-mse");
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
    const t = await this.reader.read(Math.max(0, e - 16), e), s = et(t);
    this._mediaEnd = s > 0 && s < e ? e - s : e;
    let n = 0, r = null, a = null;
    const c = [];
    let o = null;
    for (let f = 0; f < 64 && n < e; f++) {
      const y = await this.reader.read(n, Math.min(n + 16, e)), u = B(y, 0);
      if (!u) break;
      const h = u.size === null ? e - n : u.size;
      if (u.type === "moof" || u.type === "mdat") {
        o = n;
        break;
      }
      if (u.type === "ftyp" || u.type === "moov" || u.type === "sidx") {
        if (h > st) throw new P(`box ${u.type} grande demais (${h} bytes)`, "init");
        const p = await this.reader.read(n, n + h);
        u.type === "ftyp" ? r = p : u.type === "moov" ? a = p : c.push({ bytes: p, endAbs: n + h });
      }
      if (h <= 0) break;
      n += h;
    }
    if (!a || o === null)
      throw new P("arquivo sem moov antes dos dados (mp4 não fragmentado / moov no fim)", "not-fragmented");
    const l = Ye(a);
    if (!l.hasMvex)
      throw new P("mp4 não fragmentado (moov sem mvex) — republique com frag_keyframe+empty_moov", "not-fragmented");
    const d = l.tracks.filter((f) => f.handler === "vide" || f.handler === "soun");
    if (!d.length) throw new P("nenhuma trilha de áudio/vídeo no moov", "init");
    const m = d.find((f) => !f.codec);
    if (m) throw new P(`codec não reconhecido (entrada "${m.entry}")`, "codec");
    if (this.mime = `video/mp4; codecs="${d.map((f) => f.codec).join(",")}"`, !window.MediaSource.isTypeSupported(this.mime))
      throw new P(`navegador não suporta ${this.mime}`, "codec");
    return this._init = r ? tt(r, a) : a, await this._buildIndex(l, c, o), this._probed = !0, this.onLog("mse probe ok —", this.mode, this.mime, `${this._units.length} unidades`, this.duration ? `${this.duration.toFixed(1)}s` : ""), { mode: this.mode, mime: this.mime, duration: this.duration, units: this._units.length };
  }
  async _buildIndex(e, t, s) {
    const n = e.tracks.find((o) => o.handler === "vide") || e.tracks[0], r = t.find((o) => o.bytes.length >= 16 && this._sidxRef(o.bytes) === n.id) || t[0];
    if (r)
      try {
        const o = Ze(r.bytes, r.endAbs);
        if (!o.hierarchical && o.units.length) {
          const l = o.units[0], d = o.units[o.units.length - 1], m = l.start >= s && d.end <= this._mediaEnd + 1, f = await this.reader.read(l.start, l.start + 8), y = await this.reader.read(d.start, d.start + 8), u = (h) => h.length >= 8 && String.fromCharCode(h[4], h[5], h[6], h[7]) === "moof";
          if (m && u(f) && u(y)) {
            this.mode = "indexed", this._units = o.units, this.duration = o.duration, this._tol = Math.min(0.25, Math.max(0.01, o.duration / o.units.length / 4));
            return;
          }
        }
      } catch (o) {
        this.onLog("sidx inválido, caindo pro modo sequencial —", o && o.message);
      }
    this.mode = "sequential";
    const a = this.reader, c = [];
    for (let o = a.blockAt(s); o < a.blocks.length; o++) {
      const l = Math.max(a.offsets[o], s), d = Math.min(a.offsets[o + 1], this._mediaEnd);
      d > l && c.push({ start: l, end: d, t: 0, dur: 0 });
    }
    this._units = c, this.duration = Number.isFinite(this.manifest.duration) ? this.manifest.duration : null;
  }
  _sidxRef(e) {
    const s = B(e, 0).hdr + 4;
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
    if (this._ms = s, this._url = URL.createObjectURL(s), e.src = this._url, await new Promise((n, r) => {
      const a = setTimeout(() => r(new Error("MediaSource não abriu (sourceopen)")), 1e4);
      s.addEventListener("sourceopen", () => {
        clearTimeout(a), n();
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
      this._firstAppend = it(), this._run(), await this._firstAppend.promise;
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
      if (e >= t.start(s) - nt && e <= t.end(s)) return { start: t.start(s), end: t.end(s) };
    return null;
  }
  _unitIndexAtTime(e) {
    const t = this._units;
    let s = 0, n = t.length - 1;
    for (; s < n; ) {
      const r = s + n + 1 >> 1;
      t[r].t <= e ? s = r : n = r - 1;
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
      const r = () => {
        n.removeEventListener("updateend", a), n.removeEventListener("abort", a), n.removeEventListener("error", c);
      }, a = () => {
        r(), t();
      }, c = () => {
        r(), s(new Error("erro no SourceBuffer (dados rejeitados pelo decoder)"));
      };
      n.addEventListener("updateend", a), n.addEventListener("abort", a), n.addEventListener("error", c);
      try {
        e(n);
      } catch (o) {
        r(), s(o);
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
    const n = (this._video.currentTime || 0) - (e ? Math.min(5, this.backBufferS) : this.backBufferS), r = t.buffered.start(0);
    return n - r < (e ? 1 : 10) ? !1 : (await this._enqueue((a) => a.remove(0, n)), !0);
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
function it() {
  let i, e;
  const t = new Promise((s, n) => {
    i = s, e = n;
  });
  return t.catch(() => {
  }), { promise: t, resolve: i, reject: e };
}
const rt = 9e3, at = 2, ot = 48 * 1024 * 1024, le = /* @__PURE__ */ new Map();
function he(i) {
  const e = i || "__default__";
  let t = le.get(e);
  return t || (t = i ? new ce({ signalingUrl: i }) : new ce(), le.set(e, t)), t;
}
function ct(i, e) {
  return e === "p2p";
}
function lt(i, e) {
  return e === "hls" ? !0 : e === "mp4" || e === "progressive" || !i ? !1 : i.split("?")[0].toLowerCase().endsWith(".m3u8") || i.includes("mpegurl") || i.includes("type=application/x-mpegurl");
}
function ht(i) {
  return i.canPlayType("application/vnd.apple.mpegurl") !== "";
}
class dt {
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
    this._teardownHls(), this._teardownMse(), this.onEvent("source:trying", { index: e, src: t.src }), ct(t.src, t.type) ? this._loadP2P(t) : lt(t.src, t.type) ? this._loadHls(t) : this._loadProgressive(t);
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
    var n, r;
    const s = await he(e.p2pSignalingUrl).fetchShard(e.src, {
      timeoutMs: (n = e.p2pTimeoutMs) != null ? n : 12e3,
      waitForPeersMs: (r = e.p2pWaitForPeersMs) != null ? r : 4e3
    });
    if (!(this._destroyed || this.sourceIndex !== this.sources.indexOf(e))) {
      if (!s) throw new Error("nenhum peer respondeu");
      this._setP2PBlobSource(e, s);
    }
  }
  async _loadP2PManifest(e) {
    var a, c, o;
    const t = await Ne(e.p2pManifestUrl);
    if (this._isStale(e)) return;
    const s = he(t.signalingUrl || e.p2pSignalingUrl);
    if (this.onEvent("p2p:manifest", { fileId: t.fileId, blocks: t.blocks.length }), e.p2pStreaming !== !1 && z.isSupported())
      try {
        await this._startP2PStream(e, t, s);
        return;
      } catch (l) {
        if (!(l instanceof P)) throw l;
        this._teardownMse(), console.warn("[vagalun-p2p] streaming MSE indisponível —", l.message), this.onEvent("p2p:stream-unsupported", { reason: l.message, code: l.code });
      }
    if (this._isStale(e)) return;
    const n = (a = e.p2pBlobMaxBytes) != null ? a : ot;
    if (t.originalLength > n)
      throw new Error(
        `arquivo de ${(t.originalLength / 1048576).toFixed(0)}MB não é mp4 fragmentado — baixar tudo via P2P travaria o início; usando a próxima fonte (republique o vídeo pra habilitar streaming P2P)`
      );
    const r = await Fe(s, t, {
      perBlockTimeoutMs: (c = e.p2pTimeoutMs) != null ? c : 15e3,
      waitForPeersMs: (o = e.p2pWaitForPeersMs) != null ? o : 4e3,
      onProgress: (l, d) => this.onEvent("p2p:block", { done: l, total: d }),
      onLog: s._log
    });
    this._isStale(e) || this._setP2PBlobSource(e, r, t.contentType);
  }
  _isStale(e) {
    return this._destroyed || this.sourceIndex !== this.sources.indexOf(e);
  }
  async _startP2PStream(e, t, s) {
    var r, a;
    const n = new z({
      p2p: s,
      manifest: t,
      onLog: s._log,
      aheadTargetS: e.p2pAheadSeconds,
      backBufferS: e.p2pBackBufferSeconds,
      perBlockTimeoutMs: (r = e.p2pTimeoutMs) != null ? r : 15e3,
      waitForPeersMs: (a = e.p2pWaitForPeersMs) != null ? a : 4e3,
      prefetchBlocks: e.p2pPrefetchBlocks,
      onEvent: (c, o) => {
        this._mse === n && this.onEvent(c, o);
      },
      onFatal: (c) => {
        this._mse !== n || this._isStale(e) || (console.error("[vagalun-p2p] stream P2P falhou —", c), this.onEvent("error", { fatal: !1, reason: `p2p stream: ${c && c.message}`, shardKey: e.src }), this._advanceToNextSource());
      }
    });
    this._mse = n;
    try {
      const c = await n.probe();
      if (this._isStale(e)) {
        n.destroy();
        return;
      }
      this.onEvent("p2p:stream", c), await n.attach(this.video, { resumeTime: this._resumeTime });
    } catch (c) {
      throw this._mse === n && !(c instanceof P) && (n.destroy(), this._mse = null), c;
    }
    this._isStale(e) || this.onEvent("p2p:ready", { shardKey: e.src, streaming: !0, mode: n.mode });
  }
  _setP2PBlobSource(e, t, s) {
    this._activeObjectUrl && URL.revokeObjectURL(this._activeObjectUrl);
    const n = qe(t, s || e.mimeType || "video/mp4");
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
    if (ht(this.video)) {
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
        const r = (n.levels || []).map((a, c) => ({
          index: c,
          height: a.height,
          bitrate: a.bitrate,
          label: a.height ? `${a.height}p` : `${Math.round(a.bitrate / 1e3)}kbps`
        }));
        if (this.onQualityLevels(r), this._resumeTime > 1)
          try {
            this.video.currentTime = this._resumeTime;
          } catch (a) {
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
              } catch (r) {
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
      if (this._retries += 1, this._retries > at)
        this._advanceToNextSource();
      else {
        const e = this.video.currentTime;
        this._resumeTime = e, this._loadSourceAt(this.sourceIndex);
      }
    }, rt)));
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
function de(i) {
  (!isFinite(i) || i < 0) && (i = 0);
  const e = Math.floor(i / 3600), t = Math.floor(i % 3600 / 60), s = Math.floor(i % 60), n = e > 0 ? String(t).padStart(2, "0") : String(t), r = String(s).padStart(2, "0");
  return e > 0 ? `${e}:${n}:${r}` : `${n}:${r}`;
}
function L(i) {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">${{
    play: '<path d="M8 5v14l11-7z"/>',
    pause: '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
    volume: '<path d="M4 9v6h4l5 5V4L8 9H4z"/>',
    mute: '<path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M19 8l-4 4m0-4l4 4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
    fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    exitFullscreen: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
    pip: '<path d="M4 5h16v14H4zM12 12h6v5h-6z" fill="none" stroke="currentColor" stroke-width="2"/>',
    settings: '<path d="M12 8a4 4 0 100 8 4 4 0 000-8zm8.4 4a7.4 7.4 0 01-.1 1.2l2 1.6-2 3.4-2.4-1a7.5 7.5 0 01-2 1.2l-.4 2.6h-4l-.4-2.6a7.5 7.5 0 01-2-1.2l-2.4 1-2-3.4 2-1.6A7.4 7.4 0 013.6 12c0-.4 0-.8.1-1.2l-2-1.6 2-3.4 2.4 1a7.5 7.5 0 012-1.2L8.5 2h4l.4 2.6a7.5 7.5 0 012 1.2l2.4-1 2 3.4-2 1.6c.1.4.1.8.1 1.2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>'
  }[i] || ""}</svg>`;
}
function ut({ root: i, video: e, engine: t, playerId: s }) {
  const n = document.createElement("div");
  n.className = "vgl-controls";
  const r = document.createElement("div");
  r.className = "vgl-progress", r.setAttribute("role", "slider"), r.setAttribute("aria-label", "Progresso do vídeo"), r.tabIndex = 0;
  const a = document.createElement("div");
  a.className = "vgl-progress-buffered";
  const c = document.createElement("div");
  c.className = "vgl-progress-played";
  const o = document.createElement("div");
  o.className = "vgl-progress-scrubber", r.append(a, c, o);
  const l = document.createElement("div");
  l.className = "vgl-controls-row";
  const d = document.createElement("button");
  d.className = "vgl-btn vgl-play", d.type = "button", d.setAttribute("aria-label", "Reproduzir"), d.innerHTML = L("play");
  const m = document.createElement("button");
  m.className = "vgl-btn vgl-volume-btn", m.type = "button", m.setAttribute("aria-label", "Volume"), m.innerHTML = L("volume");
  const f = document.createElement("input");
  f.type = "range", f.min = "0", f.max = "1", f.step = "0.05", f.value = "1", f.className = "vgl-volume-slider", f.setAttribute("aria-label", "Nível de volume");
  const y = document.createElement("div");
  y.className = "vgl-time", y.textContent = "0:00 / 0:00";
  const u = document.createElement("div");
  u.className = "vgl-spacer";
  const h = document.createElement("button");
  h.className = "vgl-btn vgl-settings-btn", h.type = "button", h.setAttribute("aria-label", "Configurações"), h.innerHTML = L("settings");
  const p = document.createElement("div");
  p.className = "vgl-settings-menu", p.hidden = !0;
  const v = document.createElement("button");
  v.className = "vgl-btn vgl-pip-btn", v.type = "button", v.setAttribute("aria-label", "Picture-in-picture"), v.innerHTML = L("pip"), document.pictureInPictureEnabled || (v.style.display = "none");
  const k = document.createElement("button");
  k.className = "vgl-btn vgl-fs-btn", k.type = "button", k.setAttribute("aria-label", "Tela cheia"), k.innerHTML = L("fullscreen"), l.append(d, m, f, y, u, h, v, k), n.append(r, l, p), i.appendChild(n);
  const _ = document.createElement("div");
  _.className = "vgl-spinner", _.hidden = !0, i.appendChild(_);
  const b = document.createElement("button");
  b.className = "vgl-big-play", b.type = "button", b.setAttribute("aria-label", "Reproduzir vídeo"), b.innerHTML = '<svg viewBox="0 0 68 48" width="68" height="48"><path d="M66.5 7.7c-.8-2.9-2.6-5.2-5-6C56.9 0 34 0 34 0S11.1 0 6.5 1.7c-2.4.8-4.2 3.1-5 6C0 12.4 0 24 0 24s0 11.6 1.5 16.3c.8 2.9 2.6 5.1 5 6C11.1 48 34 48 34 48s22.9 0 27.5-1.7c2.4-.9 4.2-3.1 5-6C68 35.6 68 24 68 24s0-11.6-1.5-16.3z" fill="rgba(0,0,0,.55)"/><path d="M27 14l19 10-19 10V14z" fill="#fff"/></svg>', i.appendChild(b);
  const S = document.createElement("div");
  S.className = "vgl-error", S.hidden = !0, i.appendChild(S);
  const x = (g) => `vgl:${s || "default"}:${g}`;
  function V(g) {
    d.innerHTML = L(g ? "pause" : "play"), d.setAttribute("aria-label", g ? "Pausar" : "Reproduzir"), b.hidden = g;
  }
  function W() {
    if (!e.duration) return;
    const g = e.currentTime / e.duration * 100;
    if (c.style.width = `${g}%`, o.style.left = `${g}%`, y.textContent = `${de(e.currentTime)} / ${de(e.duration)}`, e.buffered.length) {
      const w = e.buffered.end(e.buffered.length - 1);
      a.style.width = `${Math.min(100, w / e.duration * 100)}%`;
    }
  }
  function Z(g) {
    const w = r.getBoundingClientRect(), E = Math.min(1, Math.max(0, (g - w.left) / w.width));
    e.duration && (e.currentTime = E * e.duration);
  }
  let j = !1;
  r.addEventListener("pointerdown", (g) => {
    j = !0, Z(g.clientX);
  }), window.addEventListener("pointermove", (g) => {
    j && Z(g.clientX);
  }), window.addEventListener("pointerup", () => {
    j = !1;
  }), r.addEventListener("keydown", (g) => {
    g.key === "ArrowRight" && (e.currentTime = Math.min(e.duration || 0, e.currentTime + 5)), g.key === "ArrowLeft" && (e.currentTime = Math.max(0, e.currentTime - 5));
  });
  function q() {
    e.paused ? e.play().catch(() => {
    }) : e.pause();
  }
  d.addEventListener("click", q), b.addEventListener("click", q), e.addEventListener("click", q), e.addEventListener("play", () => V(!0)), e.addEventListener("pause", () => V(!1)), e.addEventListener("timeupdate", W), e.addEventListener("loadedmetadata", W), e.addEventListener("progress", W);
  const ee = localStorage.getItem(x("volume"));
  ee !== null && (e.volume = parseFloat(ee)), localStorage.getItem(x("muted")) === "1" && (e.muted = !0), f.value = String(e.volume);
  function N() {
    m.innerHTML = L(e.muted || e.volume === 0 ? "mute" : "volume");
  }
  N(), m.addEventListener("click", () => {
    e.muted = !e.muted, localStorage.setItem(x("muted"), e.muted ? "1" : "0"), N();
  }), f.addEventListener("input", () => {
    e.volume = parseFloat(f.value), e.muted = e.volume === 0, localStorage.setItem(x("volume"), f.value), localStorage.setItem(x("muted"), e.muted ? "1" : "0"), N();
  }), e.addEventListener("waiting", () => {
    _.hidden = !1;
  }), e.addEventListener("playing", () => {
    _.hidden = !0;
  }), e.addEventListener("canplay", () => {
    _.hidden = !0;
  });
  let F = [], C = -1;
  const ye = [0.5, 0.75, 1, 1.25, 1.5, 2];
  function $() {
    if (p.innerHTML = "", F.length > 1) {
      const w = document.createElement("div");
      w.className = "vgl-settings-header", w.textContent = "Qualidade", p.appendChild(w);
      const E = document.createElement("button");
      E.type = "button", E.className = "vgl-settings-item" + (C === -1 ? " active" : ""), E.textContent = "Automática", E.addEventListener("click", () => {
        C = -1, t.setQualityLevel(-1), localStorage.setItem(x("quality"), "-1"), $();
      }), p.appendChild(E), F.slice().sort((A, I) => (I.height || 0) - (A.height || 0)).forEach((A) => {
        const I = document.createElement("button");
        I.type = "button", I.className = "vgl-settings-item" + (C === A.index ? " active" : ""), I.textContent = A.label, I.addEventListener("click", () => {
          C = A.index, t.setQualityLevel(A.index), localStorage.setItem(x("quality"), String(A.index)), $();
        }), p.appendChild(I);
      });
    }
    const g = document.createElement("div");
    g.className = "vgl-settings-header", g.textContent = "Velocidade", p.appendChild(g), ye.forEach((w) => {
      const E = document.createElement("button");
      E.type = "button", E.className = "vgl-settings-item" + (e.playbackRate === w ? " active" : ""), E.textContent = w === 1 ? "Normal" : `${w}x`, E.addEventListener("click", () => {
        e.playbackRate = w, $();
      }), p.appendChild(E);
    });
  }
  $(), h.addEventListener("click", (g) => {
    g.stopPropagation(), p.hidden = !p.hidden;
  }), document.addEventListener("click", () => {
    p.hidden = !0;
  }), v.addEventListener("click", async () => {
    try {
      document.pictureInPictureElement ? await document.exitPictureInPicture() : await e.requestPictureInPicture();
    } catch (g) {
    }
  });
  function Q() {
    return document.fullscreenElement === i || document.webkitFullscreenElement === i;
  }
  k.addEventListener("click", async () => {
    try {
      Q() ? document.exitFullscreen ? await document.exitFullscreen() : document.webkitExitFullscreen && document.webkitExitFullscreen() : i.requestFullscreen ? await i.requestFullscreen() : i.webkitRequestFullscreen ? i.webkitRequestFullscreen() : e.webkitEnterFullscreen && e.webkitEnterFullscreen();
    } catch (g) {
    }
  }), document.addEventListener("fullscreenchange", () => {
    k.innerHTML = L(Q() ? "exitFullscreen" : "fullscreen"), i.classList.toggle("vgl-fullscreen", Q());
  });
  let te = null;
  function se() {
    i.classList.remove("vgl-idle"), clearTimeout(te), te = setTimeout(() => {
      e.paused || i.classList.add("vgl-idle");
    }, 2600);
  }
  return ["mousemove", "pointerdown", "keydown", "touchstart"].forEach((g) => i.addEventListener(g, se)), se(), i.tabIndex = i.tabIndex || 0, i.addEventListener("keydown", (g) => {
    var w;
    if (!["INPUT", "BUTTON"].includes((w = document.activeElement) == null ? void 0 : w.tagName))
      switch (g.key) {
        case " ":
        case "k":
          g.preventDefault(), q();
          break;
        case "m":
          e.muted = !e.muted, N();
          break;
        case "f":
          k.click();
          break;
        case "ArrowRight":
          e.currentTime = Math.min(e.duration || 0, e.currentTime + 5);
          break;
        case "ArrowLeft":
          e.currentTime = Math.max(0, e.currentTime - 5);
          break;
        case "ArrowUp":
          g.preventDefault(), e.volume = Math.min(1, e.volume + 0.1), f.value = String(e.volume);
          break;
        case "ArrowDown":
          g.preventDefault(), e.volume = Math.max(0, e.volume - 0.1), f.value = String(e.volume);
          break;
      }
  }), {
    setQualityLevels(g) {
      F = g || [];
      const w = localStorage.getItem(x("quality"));
      w !== null && F.some((E) => String(E.index) === w) && (C = parseInt(w, 10), t.setQualityLevel(C)), $();
    },
    showError(g, w) {
      S.innerHTML = "";
      const E = document.createElement("p");
      if (E.textContent = g || "Não foi possível carregar o vídeo.", S.appendChild(E), w) {
        const A = document.createElement("button");
        A.type = "button", A.textContent = "Tentar novamente", A.className = "vgl-btn vgl-error-retry", A.addEventListener("click", w), S.appendChild(A);
      }
      S.hidden = !1;
    },
    hideError() {
      S.hidden = !0;
    },
    setPlayingIcon: V,
    elements: { wrap: n, playBtn: d, bigPlay: b, spinner: _, errorBox: S, settingsMenu: p }
  };
}
function ft(i) {
  if (!i) return;
  const e = i.replace(/\[CACHEBUSTER\]/g, String(Date.now())).replace(/\[TIMESTAMP\]/g, (/* @__PURE__ */ new Date()).toISOString());
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
function M(i) {
  (Array.isArray(i) ? i : i ? [i] : []).forEach(ft);
}
async function _e(i, e = 0) {
  var h, p, v, k;
  if (e > 3) throw new Error("cadeia de VAST Wrapper longa demais");
  const s = await (await fetch(i)).text(), n = new DOMParser().parseFromString(s, "application/xml"), r = (p = (h = n.querySelector("Wrapper > VASTAdTagURI")) == null ? void 0 : h.textContent) == null ? void 0 : p.trim();
  if (r)
    return _e(r, e + 1);
  const a = n.querySelector("Linear");
  if (!a) throw new Error("VAST sem creative Linear (só anúncios lineares são suportados)");
  const c = [...n.querySelectorAll("MediaFile")].map((_) => ({ url: _.textContent.trim(), type: _.getAttribute("type") || "" })).filter((_) => _.url), o = c.find((_) => _.type.includes("mp4")) || c[0];
  if (!o) throw new Error("VAST sem MediaFile utilizável");
  const l = (k = (v = n.querySelector("ClickThrough")) == null ? void 0 : v.textContent) == null ? void 0 : k.trim(), d = [...n.querySelectorAll("ClickTracking")].map((_) => _.textContent.trim()), m = [...n.querySelectorAll("Impression")].map((_) => _.textContent.trim()), f = a.getAttribute("skipoffset");
  let y = 5;
  if (f && /^\d\d:\d\d:\d\d$/.test(f)) {
    const [_, b, S] = f.split(":").map(Number);
    y = _ * 3600 + b * 60 + S;
  }
  const u = {};
  return n.querySelectorAll("TrackingEvents > Tracking").forEach((_) => {
    const b = _.getAttribute("event");
    b && (u[b] || (u[b] = [])).push(_.textContent.trim());
  }), {
    videoUrl: o.url,
    clickUrl: l,
    skipAfter: y,
    tracking: {
      impression: m,
      click: d,
      start: u.start,
      complete: u.complete,
      firstQuartile: u.firstQuartile,
      midpoint: u.midpoint,
      thirdQuartile: u.thirdQuartile,
      skip: u.skip
    }
  };
}
class pt {
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
      const r = document.createElement("div");
      r.className = "vgl-ad-badge", r.textContent = "Anúncio";
      const a = document.createElement("button");
      a.className = "vgl-ad-skip", a.type = "button", a.disabled = !0;
      const c = (u = e.skipAfter) != null ? u : 5;
      a.textContent = c > 0 ? `Pular em ${c}s` : "Pular anúncio", s.append(n, r, a), this.root.appendChild(s);
      let o = !1, l = { first: !1, mid: !1, third: !1 };
      const d = (h) => {
        var p, v;
        o || (o = !0, clearInterval(y), M(h ? (p = e.tracking) == null ? void 0 : p.skip : (v = e.tracking) == null ? void 0 : v.complete), s.remove(), t());
      }, m = () => {
        var h;
        e.clickUrl && (M((h = e.tracking) == null ? void 0 : h.click), this.emit("ad:click", { videoUrl: e.videoUrl, clickUrl: e.clickUrl }), window.open(e.clickUrl, "_blank", "noopener"));
      };
      n.addEventListener("click", m), n.addEventListener("timeupdate", () => {
        var p, v, k;
        if (!n.duration) return;
        const h = n.currentTime / n.duration;
        h >= 0.25 && !l.first && (l.first = !0, M((p = e.tracking) == null ? void 0 : p.firstQuartile)), h >= 0.5 && !l.mid && (l.mid = !0, M((v = e.tracking) == null ? void 0 : v.midpoint)), h >= 0.75 && !l.third && (l.third = !0, M((k = e.tracking) == null ? void 0 : k.thirdQuartile));
      }), n.addEventListener("ended", () => d(!1)), n.addEventListener("error", () => d(!0));
      let f = c;
      const y = setInterval(() => {
        f -= 1, f > 0 ? a.textContent = `Pular em ${f}s` : (a.disabled = !1, a.textContent = "Pular anúncio ▸", clearInterval(y));
      }, 1e3);
      c <= 0 && (a.disabled = !1, a.textContent = "Pular anúncio ▸", clearInterval(y)), a.addEventListener("click", (h) => {
        h.stopPropagation(), a.disabled || d(!0);
      }), n.addEventListener("playing", () => {
        var h, p;
        M((h = e.tracking) == null ? void 0 : h.impression), M((p = e.tracking) == null ? void 0 : p.start), this.emit("ad:impression", { videoUrl: e.videoUrl });
      }, { once: !0 });
    });
  }
  async playFromVast(e) {
    try {
      const t = await _e(e);
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
    var c, o;
    if (!e || !e.imageUrl && !e.html) return;
    this.hideOverlay();
    const t = document.createElement("div");
    t.className = "vgl-ad-overlay";
    const s = document.createElement("button");
    s.className = "vgl-ad-overlay-close", s.type = "button", s.setAttribute("aria-label", "Fechar anúncio"), s.textContent = "✕";
    const n = document.createElement("a");
    if (n.className = "vgl-ad-overlay-content", n.href = e.clickUrl || "#", n.target = "_blank", n.rel = "noopener", e.imageUrl) {
      const l = document.createElement("img");
      l.src = e.imageUrl, l.alt = e.alt || "Anúncio", n.appendChild(l);
    } else e.html && (n.innerHTML = e.html);
    const r = document.createElement("span");
    r.className = "vgl-ad-overlay-label", r.textContent = "Publicidade", n.appendChild(r), n.addEventListener("click", (l) => {
      var d;
      if (!e.clickUrl) {
        l.preventDefault();
        return;
      }
      M((d = e.tracking) == null ? void 0 : d.click), this.emit("ad:click", { overlay: !0, clickUrl: e.clickUrl });
    }), s.addEventListener("click", (l) => {
      l.preventDefault(), l.stopPropagation(), this.hideOverlay();
    }), t.append(n, s), this.root.appendChild(t), this._overlayEl = t, M((c = e.tracking) == null ? void 0 : c.impression), this.emit("ad:impression", { overlay: !0 });
    const a = (o = e.showFor) != null ? o : 8;
    a > 0 && (this._overlayTimer = setTimeout(() => this.hideOverlay(), a * 1e3), t.addEventListener("mouseenter", () => clearTimeout(this._overlayTimer)), t.addEventListener("mouseleave", () => {
      this._overlayTimer = setTimeout(() => this.hideOverlay(), a * 1e3);
    }));
  }
  hideOverlay() {
    clearTimeout(this._overlayTimer), this._overlayEl && (this._overlayEl.remove(), this._overlayEl = null);
  }
  destroy() {
    this.hideOverlay();
  }
}
const mt = "1.0.0";
function gt() {
  return `vgl-${Math.random().toString(36).slice(2, 9)}`;
}
class _t {
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
    if (this.options = t, this.playerId = t.playerId || gt(), this._listeners = {}, this._midrollTimes = t.ads && t.ads.midroll || [], this._midrollsFired = /* @__PURE__ */ new Set(), this._destroyed = !1, this.root = document.createElement("div"), this.root.className = "vgl-root", this.root.tabIndex = 0, this.video = document.createElement("video"), this.video.className = "vgl-video", this.video.playsInline = !0, this.video.preload = t.preload || "metadata", t.poster && (this.video.poster = t.poster), t.loop && (this.video.loop = !0), t.muted && (this.video.muted = !0), t.autoplay && (this.video.autoplay = !0), this.root.appendChild(this.video), s.innerHTML = "", s.appendChild(this.root), this.ads = new pt({
      root: this.root,
      onEvent: (r, a) => this._emit(r, a)
    }), this.engine = new dt(this.video, {
      onEvent: (r, a) => this._handleEngineEvent(r, a),
      onQualityLevels: (r) => this.controls && this.controls.setQualityLevels(r)
    }), this.controls = ut({
      root: this.root,
      video: this.video,
      engine: this.engine,
      playerId: this.playerId
    }), this._onTimeUpdate = () => this._checkMidrolls(), this.video.addEventListener("timeupdate", this._onTimeUpdate), t.sources && this.setSources(t.sources, { resumeTime: t.resumeTime }), t.ads && t.ads.overlay) {
      const r = (n = t.ads.overlay.delay) != null ? n : 4;
      this._overlayTimer = setTimeout(() => {
        this._destroyed || this.ads.showOverlay(t.ads.overlay);
      }, r * 1e3);
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
_t.VERSION = mt;
export {
  _t as default
};
