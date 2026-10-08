import { encodeChunks, decodeChunk, Reassembler, TYPE_REQUEST, TYPE_RESPONSE } from './shardFrame.js';

// Mesmos STUNs públicos do browser Android — sem TURN, não precisa.
export function defaultIceServers() {
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];
}

const REQUEST_TIMEOUT_MS = 20000;

// Não deixa mais que ~2MB de chunks enfileirados no buffer do SCTP de uma
// vez — acima disso, espera baixar antes de mandar o próximo chunk. Mesmo
// watermark do WebRtcTransport.kt (node Android).
const BUFFERED_AMOUNT_HIGH_WATERMARK = 2 * 1024 * 1024;
const BACKPRESSURE_POLL_MS = 15;

/** Espera dc.bufferedAmount cair abaixo do watermark antes de liberar o próximo chunk. */
function waitForBufferedAmountBelowWatermark(dc) {
  if (dc.bufferedAmount <= BUFFERED_AMOUNT_HIGH_WATERMARK) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (dc.readyState !== 'open' || dc.bufferedAmount <= BUFFERED_AMOUNT_HIGH_WATERMARK) {
        resolve();
        return;
      }
      setTimeout(check, BACKPRESSURE_POLL_MS);
    };
    check();
  });
}

/** Manda todos os chunks de um frame lógico, em ordem, com backpressure. @returns {Promise<boolean>} false se o canal caiu no meio do envio. */
async function sendChunks(dc, chunks, log) {
  for (const chunk of chunks) {
    if (dc.readyState !== 'open') {
      log('canal não está mais "open" no meio do envio dos chunks (readyState:', dc.readyState, ')');
      return false;
    }
    await waitForBufferedAmountBelowWatermark(dc);
    try {
      dc.send(chunk);
    } catch (e) {
      log('dc.send() lançou erro mandando chunk:', e && e.message);
      return false;
    }
  }
  return true;
}

/** Transport de um peer conectado — fala o mesmo protocolo binário de
 * request/response do WebRtcTransport.kt em cima do RTCDataChannel, com
 * fatiamento automático de frames grandes (ver shardFrame.js). */
class WebRtcTransport {
  constructor(peerNodeId, dataChannel, { onIncomingRequest, debug = false } = {}) {
    this.peerNodeId = peerNodeId;
    this.dc = dataChannel;
    this._nextRequestId = 0;
    this._pending = new Map(); // requestId -> {resolve, reject, timer}
    this._reassembler = new Reassembler();
    this._onIncomingRequest = onIncomingRequest || null;
    this._log = debug ? (...a) => console.log('[vagalun-p2p][transport]', peerNodeId, ...a) : () => {};
    this.dc.binaryType = 'arraybuffer';
    this.dc.onmessage = (evt) => this._onMessage(evt);
  }

  get open() {
    return this.dc && this.dc.readyState === 'open';
  }

  _onMessage(evt) {
    const byteLen = evt.data && evt.data.byteLength;
    let chunk;
    try {
      chunk = decodeChunk(evt.data);
    } catch (e) {
      this._log('FALHA AO DECODIFICAR chunk recebido (', byteLen, 'bytes ) — provável descompasso de protocolo com o peer:', e && e.message);
      return;
    }
    this._log('chunk recebido —', byteLen, 'bytes — type:', chunk.type === TYPE_RESPONSE ? 'RESPONSE' : 'REQUEST', 'requestId:', chunk.requestId, `chunk ${chunk.chunkIndex + 1}/${chunk.totalChunks}`);

    let decoded;
    try {
      decoded = this._reassembler.accept(chunk);
    } catch (e) {
      this._log('falha remontando frame — requestId', chunk.requestId, ':', e && e.message);
      return;
    }
    if (!decoded) return; // ainda faltam chunks desse frame, espera o resto chegar

    this._log('frame remontado — type:', decoded.type === TYPE_RESPONSE ? 'RESPONSE' : 'REQUEST', 'requestId:', decoded.requestId, 'header:', decoded.header, 'payload bytes:', decoded.payload ? decoded.payload.byteLength : 0);

    if (decoded.type === TYPE_RESPONSE) {
      const pending = this._pending.get(decoded.requestId);
      if (!pending) {
        this._log('resposta chegou pro requestId', decoded.requestId, 'mas não tem ninguém esperando esse id (já deu timeout antes, ou requestId não bate)');
        return;
      }
      clearTimeout(pending.timer);
      this._pending.delete(decoded.requestId);
      pending.resolve(decoded);
    } else if (this._onIncomingRequest) {
      this._handleIncomingRequest(decoded);
    }
  }

  async _handleIncomingRequest(decoded) {
    let respHeader;
    let respPayload = null;
    try {
      const result = await this._onIncomingRequest(decoded.header, decoded.payload);
      respHeader = (result && result.header) || { ok: false };
      respPayload = (result && result.payload) || null;
    } catch (e) {
      respHeader = { ok: false, error: String((e && e.message) || e) };
    }
    const chunks = encodeChunks(TYPE_RESPONSE, decoded.requestId, respHeader, respPayload);
    const ok = await sendChunks(this.dc, chunks, this._log);
    if (!ok) {
      this._log('resposta pro requestId', decoded.requestId, 'NÃO foi entregue por completo — peer deve ter perdido a conexão no meio do envio');
    }
  }

  _sendAndAwait(header, payloadBytes, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.open) {
      this._log('_sendAndAwait chamado mas data channel não está open (readyState:', this.dc && this.dc.readyState, ') — nem tenta mandar');
      return Promise.resolve(null);
    }
    const requestId = ++this._nextRequestId;
    const chunks = encodeChunks(TYPE_REQUEST, requestId, header, payloadBytes);
    this._log('mandando request', requestId, '—', header, `(${chunks.length} chunk(s))`);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._log('TIMEOUT esperando resposta do request', requestId, `(${timeoutMs}ms) — peer nunca respondeu esse requestId específico`);
        this._pending.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this._pending.set(requestId, { resolve, timer });
      sendChunks(this.dc, chunks, this._log).then((sent) => {
        if (!sent) {
          this._log('falha mandando chunks do request', requestId, '— desiste sem esperar timeout');
          clearTimeout(timer);
          this._pending.delete(requestId);
          resolve(null);
        }
      });
    });
  }

  async getShard(shardKey) {
    this._log('getShard() —', shardKey);
    const resp = await this._sendAndAwait({ op: 'get', shardKey }, null);
    if (!resp) {
      this._log('getShard() —', shardKey, '→ sem resposta (timeout ou erro de envio, ver logs acima)');
      return null;
    }
    if (!resp.header.ok) {
      this._log('getShard() —', shardKey, '→ peer respondeu ok:false. header completo:', resp.header);
      return null;
    }
    this._log('getShard() —', shardKey, '→ sucesso,', resp.payload ? resp.payload.byteLength : 0, 'bytes');
    return resp.payload;
  }

  async getShardRange(shardKey, offset, length) {
    const resp = await this._sendAndAwait({ op: 'get_range', shardKey, offset, length }, null);
    if (!resp || !resp.header.ok) return null;
    return resp.payload;
  }

  async status() {
    const resp = await this._sendAndAwait({ op: 'status' }, null);
    return resp ? resp.header : null;
  }

  async gossip(payload) {
    const resp = await this._sendAndAwait({ ...payload, op: 'gossip' }, null);
    return resp ? resp.header : null;
  }

  close() {
    this._pending.forEach((p) => clearTimeout(p.timer));
    this._pending.clear();
    this._reassembler.clear();
    try {
      this.dc.close();
    } catch {}
  }
}

/**
 * Porta de WebRtcManager.kt: sobe RTCPeerConnection + DataChannel "shard" por
 * peer, negociando offer/answer/ice pelo mesmo SignalingClient (signal
 * embutido no player, wss://signal.vagalun.shop, sem fallback http).
 */
export class WebRtcManager {
  constructor(signalingClient, { onTransportReady, onTransportClosed, onIncomingRequest, iceServers, debug = false } = {}) {
    this.signaling = signalingClient;
    this.onTransportReady = onTransportReady || (() => {});
    this.onTransportClosed = onTransportClosed || (() => {});
    this.onIncomingRequest = onIncomingRequest || null;
    this.iceServers = iceServers || defaultIceServers();
    this.sessions = new Map(); // peerNodeId -> session
    this.debug = debug;
    this._log = debug ? (...a) => console.log('[vagalun-p2p][rtc]', ...a) : () => {};
    if (debug && !iceServers) {
      this._log('AVISO: usando só STUN (defaultIceServers), sem TURN. Se o peer estiver atrás de NAT simétrico/CGNAT, a conexão pode nunca fechar — isso aparece como iceConnectionState preso em "checking" ou indo direto pra "failed" abaixo.');
    }

    this.signaling.onSignal = (from, payload) => this.handleSignal(from, payload);
  }

  handleSignal(fromNodeId, payload) {
    switch (payload && payload.kind) {
      case 'offer':
        this._onOfferReceived(fromNodeId, payload.sdp);
        break;
      case 'answer':
        this._onAnswerReceived(fromNodeId, payload.sdp);
        break;
      case 'ice':
        this._onIceReceived(fromNodeId, payload);
        break;
      default:
        break;
    }
  }

  connectToPeer(peerNodeId) {
    if (this.sessions.has(peerNodeId)) return; // já conectando/conectado
    this._log('connectToPeer', peerNodeId, '— criando offer');
    const session = this._newSession(peerNodeId, true);
    const pc = session.pc;

    const dc = pc.createDataChannel('shard', { ordered: true });
    this._wireDataChannel(peerNodeId, session, dc);

    pc.createOffer()
      .then((desc) => pc.setLocalDescription(desc).then(() => desc))
      .then((desc) => {
        this._log('offer criada e setada localmente pra', peerNodeId, '— enviando via signaling');
        this.signaling.sendSignal(peerNodeId, { kind: 'offer', sdp: desc.sdp });
      })
      .catch((e) => {
        this._log('createOffer/setLocalDescription falhou pra', peerNodeId, ':', e && e.message);
        this._teardown(peerNodeId);
      });
  }

  _newSession(peerNodeId, isInitiator) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const session = {
      pc,
      dataChannel: null,
      transport: null,
      pendingRemoteCandidates: [],
      remoteDescSet: false,
      isInitiator
    };
    this.sessions.set(peerNodeId, session);

    pc.onicecandidate = (evt) => {
      if (!evt.candidate) {
        this._log('ICE gathering completo pra', peerNodeId);
        return;
      }
      this._log('candidato ICE local pra', peerNodeId, '— type:', evt.candidate.type, 'protocol:', evt.candidate.protocol);
      this.signaling.sendSignal(peerNodeId, {
        kind: 'ice',
        candidate: evt.candidate.candidate,
        sdpMid: evt.candidate.sdpMid,
        sdpMLineIndex: evt.candidate.sdpMLineIndex
      });
    };

    pc.ondatachannel = (evt) => {
      this._log('data channel recebido do peer', peerNodeId);
      this._wireDataChannel(peerNodeId, session, evt.channel);
    };

    pc.oniceconnectionstatechange = () => {
      this._log('iceConnectionState com', peerNodeId, '→', pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
        this._log('ICE falhou/fechou com', peerNodeId, '— se ficou "checking" antes de "failed", é sinal clássico de faltar TURN pra esse par de NATs.');
        this._teardown(peerNodeId);
      }
    };

    return session;
  }

  async _onOfferReceived(fromNodeId, sdp) {
    this._log('offer recebida de', fromNodeId);
    let session = this.sessions.get(fromNodeId);
    if (!session) session = this._newSession(fromNodeId, false);
    const pc = session.pc;
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      session.remoteDescSet = true;
      await this._flushPendingCandidates(pc, session);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this._log('answer criada pra', fromNodeId, '— enviando via signaling');
      this.signaling.sendSignal(fromNodeId, { kind: 'answer', sdp: answer.sdp });
    } catch (e) {
      this._log('falha processando offer de', fromNodeId, ':', e && e.message);
      this._teardown(fromNodeId);
    }
  }

  async _onAnswerReceived(fromNodeId, sdp) {
    this._log('answer recebida de', fromNodeId);
    const session = this.sessions.get(fromNodeId);
    if (!session) return;
    try {
      await session.pc.setRemoteDescription({ type: 'answer', sdp });
      session.remoteDescSet = true;
      await this._flushPendingCandidates(session.pc, session);
    } catch (e) {
      this._log('falha processando answer de', fromNodeId, ':', e && e.message);
      this._teardown(fromNodeId);
    }
  }

  async _onIceReceived(fromNodeId, payload) {
    const session = this.sessions.get(fromNodeId);
    if (!session) return;
    const candidate = new RTCIceCandidate({
      candidate: payload.candidate,
      sdpMid: payload.sdpMid,
      sdpMLineIndex: payload.sdpMLineIndex
    });
    if (session.remoteDescSet) {
      try {
        await session.pc.addIceCandidate(candidate);
      } catch {}
    } else {
      session.pendingRemoteCandidates.push(candidate);
    }
  }

  async _flushPendingCandidates(pc, session) {
    const pending = session.pendingRemoteCandidates.splice(0);
    for (const c of pending) {
      try {
        await pc.addIceCandidate(c);
      } catch {}
    }
  }

  _wireDataChannel(peerNodeId, session, dc) {
    session.dataChannel = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      this._log('data channel ABERTO com', peerNodeId, '— pronto pra pedir shards');
      if (!session.transport) {
        const transport = new WebRtcTransport(peerNodeId, dc, { onIncomingRequest: this.onIncomingRequest, debug: this.debug });
        session.transport = transport;
        this.onTransportReady(peerNodeId, transport);
      }
    };
    dc.onclose = () => {
      this._log('data channel fechado com', peerNodeId);
      this._teardown(peerNodeId);
    };
  }

  _teardown(peerNodeId) {
    const session = this.sessions.get(peerNodeId);
    if (!session) return;
    this.sessions.delete(peerNodeId);
    try {
      session.transport?.close();
    } catch {}
    try {
      session.pc.close();
    } catch {}
    this.onTransportClosed(peerNodeId);
  }

  disconnect(peerNodeId) {
    this._teardown(peerNodeId);
  }

  disconnectAll() {
    Array.from(this.sessions.keys()).forEach((id) => this._teardown(id));
  }
}