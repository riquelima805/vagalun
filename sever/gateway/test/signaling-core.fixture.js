'use strict';

/**
 * signaling-core.js — núcleo ÚNICO do signaling do Vagalun.
 *
 * Fala exatamente o protocolo do sever/server.js (o que app, browser e player
 * já esperam):
 *   cliente -> servidor : register{nodeId,pubkey?,sig?}, signal{to,payload},
 *                         relay{to,requestId,header,payloadBase64?},
 *                         relay_response{...}
 *   servidor -> cliente : peers{nodeIds}, peer_joined{nodeId}, peer_left{nodeId},
 *                         signal{from,payload}, relay{...}, relay_response{...},
 *                         error{reason,to?}, relay_error{reason,requestId}
 *   NOVO (aditivo)      : signalers{urls}  — outros signalers que ESTE conhece.
 *                         Clientes antigos ignoram tipos desconhecidos.
 *
 * Quem for signaler (VPS, PC node, ...) só chama attachSignaling(wss, opts).
 * Assim todo signaler é intercambiável pro cliente — pré-requisito do failover.
 */

const WebSocket = require('ws');

function makeLimiter() {
  const buckets = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (now - b.start > 60_000) buckets.delete(k);
  }, 30_000).unref();
  return function limited(key, max, windowMs) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.start > windowMs) { b = { start: now, n: 0 }; buckets.set(key, b); }
    b.n += 1;
    return b.n > max;
  };
}

/**
 * Verificador "auto-certificante": nodeId === pubkey (base58) e sig = Ed25519
 * detached sobre o nodeId (UTF-8), em base64. Não precisa de estado nem de TOFU,
 * então vale IGUAL em todos os signalers (ninguém consegue "squattar" o nodeId
 * de outro num signaler que ainda não o viu). É o caso do PC node, cujo nodeId
 * já é a pubkey da wallet local.
 */
function selfCertifyingVerifier({ nacl, bs58 }) {
  return function verify(msg) {
    try {
      if (typeof msg.pubkey !== 'string' || typeof msg.sig !== 'string') {
        return { ok: false, error: 'pubkey e sig são obrigatórios' };
      }
      if (msg.nodeId !== msg.pubkey) return { ok: false, error: 'nodeId deve ser a própria pubkey' };
      const pk = bs58.decode(msg.pubkey);
      const sig = Buffer.from(msg.sig, 'base64');
      const ok = nacl.sign.detached.verify(Buffer.from(msg.nodeId, 'utf8'), sig, pk);
      return ok ? { ok: true, pubkey: msg.pubkey } : { ok: false, error: 'assinatura inválida' };
    } catch (e) {
      return { ok: false, error: 'verificação falhou' };
    }
  };
}

/**
 * Verificador TOFU: nodeId qualquer, mas exige Ed25519(sig) sobre o nodeId e
 * "trava" nodeId -> pubkey na primeira prova. É o que o app Android usa hoje
 * (nodeId em SharedPreferences, pubkey da wallet). LIMITE: a trava é LOCAL a
 * cada signaler — num signaler que ainda não viu o nodeId, outro dono pode
 * pegá-lo primeiro. Cura definitiva: nodeId = pubkey (selfCertifyingVerifier).
 * `store` é opcional ({get(nodeId), set(nodeId, pubkey)}) pra persistir a trava.
 */
function tofuVerifier({ nacl, bs58, store }) {
  const mem = new Map();
  const get = store ? (id) => store.get(id) : (id) => mem.get(id);
  const set = store ? (id, pk) => store.set(id, pk) : (id, pk) => mem.set(id, pk);
  return function verify(msg) {
    try {
      if (typeof msg.pubkey !== 'string' || typeof msg.sig !== 'string') {
        return { ok: false, error: 'pubkey e sig são obrigatórios' };
      }
      const ok = nacl.sign.detached.verify(Buffer.from(msg.nodeId, 'utf8'), Buffer.from(msg.sig, 'base64'), bs58.decode(msg.pubkey));
      if (!ok) return { ok: false, error: 'assinatura inválida' };
      const bound = get(msg.nodeId);
      if (bound && bound !== msg.pubkey) return { ok: false, error: 'nodeId já pertence a outra chave' };
      if (!bound) set(msg.nodeId, msg.pubkey);
      return { ok: true, pubkey: msg.pubkey };
    } catch (e) {
      return { ok: false, error: 'verificação falhou' };
    }
  };
}

/**
 * @param {import('ws').WebSocketServer} wss
 * @param {object} [opts]
 * @param {(nodeId:string)=>boolean} [opts.isInfra]      ids que não aparecem na lista de peers e não exigem prova
 * @param {(msg:object, ctx:{ip:string})=>{ok:boolean,pubkey?:string,error?:string}} [opts.verifyRegister]
 *        chamado só pra não-infra. Default: aceita tudo (use selfCertifyingVerifier em produção).
 * @param {string[]|(()=>string[])} [opts.announceSignalers] URLs públicas (wss://...) de OUTROS signalers
 * @param {(nodeId:string, ctx:object)=>object|null} [opts.onRegistered] objeto extra a enviar como {type:'registered', ...}
 * @param {(event:string, data:object)=>void} [opts.onEvent] 'peer_joined' | 'peer_left' | 'relay_bytes'
 * @param {boolean} [opts.trustProxy]
 */
function attachSignaling(wss, opts = {}) {
  const isInfra = opts.isInfra || (() => false);
  const verifyRegister = opts.verifyRegister || ((msg) => ({ ok: true, pubkey: msg.pubkey }));
  const emit = opts.onEvent || (() => {});
  const limited = makeLimiter();

  /** nodeId -> { ws, nodeId, ip, connectedAt, pubkey, infra } */
  const peers = new Map();

  function send(ws, obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  const visibleIds = (except) => [...peers.values()].filter((p) => !p.infra && p.nodeId !== except).map((p) => p.nodeId);
  function signalersList() {
    const v = typeof opts.announceSignalers === 'function' ? opts.announceSignalers() : opts.announceSignalers;
    return Array.isArray(v) ? v.filter((u) => typeof u === 'string' && /^wss?:\/\//.test(u)).slice(0, 8) : [];
  }
  function ipOf(req) {
    if (opts.trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
    return req.socket.remoteAddress || '';
  }

  wss.on('connection', (ws, req) => {
    let selfId = null;
    const ip = ipOf(req);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (!msg || typeof msg !== 'object') return;

      switch (msg.type) {
        case 'register': {
          if (typeof msg.nodeId !== 'string' || !msg.nodeId || msg.nodeId.length > 128) return;
          const infra = isInfra(msg.nodeId);
          let pubkey = null;
          if (!infra) {
            const r = verifyRegister(msg, { ip });
            if (!r || !r.ok) {
              send(ws, { type: 'error', reason: 'register_unauthorized', detail: (r && r.error) || null });
              return;
            }
            pubkey = r.pubkey || null;
          }
          selfId = msg.nodeId;
          peers.set(selfId, { ws, nodeId: selfId, ip, connectedAt: new Date().toISOString(), pubkey, infra });

          const extra = opts.onRegistered && opts.onRegistered(selfId, { ip, pubkey });
          if (extra) send(ws, { type: 'registered', nodeId: selfId, ...extra });

          send(ws, { type: 'peers', nodeIds: visibleIds(selfId) });
          const sg = signalersList();
          if (sg.length) send(ws, { type: 'signalers', urls: sg });

          if (!infra) {
            for (const p of peers.values()) if (p.nodeId !== selfId && !p.infra) send(p.ws, { type: 'peer_joined', nodeId: selfId });
            emit('peer_joined', { nodeId: selfId, ip, pubkey });
          }
          break;
        }

        case 'signal': {
          if (!selfId || typeof msg.to !== 'string') return;
          const payload = msg.payload !== undefined ? msg.payload : msg.data; // aceita o formato antigo do PC node
          if (!payload) return;
          if (limited(`signal:${selfId}:${ip}`, 300, 10_000)) { send(ws, { type: 'error', reason: 'rate_limited', to: msg.to }); return; }
          const t = peers.get(msg.to);
          if (!t) { send(ws, { type: 'error', reason: 'peer_offline', to: msg.to }); return; }
          send(t.ws, { type: 'signal', from: selfId, payload });
          break;
        }

        case 'relay':
        case 'relay_response': {
          if (!selfId || typeof msg.to !== 'string') return;
          const isReq = msg.type === 'relay';
          if (isReq && limited(`relay:${selfId}:${ip}`, 400, 10_000)) {
            send(ws, { type: 'relay_error', reason: 'rate_limited', requestId: msg.requestId });
            return;
          }
          const t = peers.get(msg.to);
          if (!t) {
            if (isReq) send(ws, { type: 'relay_error', reason: 'peer_offline', requestId: msg.requestId });
            return;
          }
          send(t.ws, {
            type: msg.type, from: selfId, requestId: msg.requestId,
            header: msg.header, payloadBase64: msg.payloadBase64,
          });
          if (msg.payloadBase64) emit('relay_bytes', { from: selfId, to: msg.to, bytes: Math.floor(msg.payloadBase64.length * 0.75) });
          break;
        }

        default: break;
      }
    });

    ws.on('close', () => {
      if (selfId && peers.get(selfId) && peers.get(selfId).ws === ws) {
        const was = peers.get(selfId);
        peers.delete(selfId);
        if (!was.infra) {
          for (const p of peers.values()) if (!p.infra) send(p.ws, { type: 'peer_left', nodeId: selfId });
          emit('peer_left', { nodeId: selfId });
        }
      }
    });
    ws.on('error', () => {});
  });

  return {
    peers,
    peerIds: () => visibleIds(null),
    get: (id) => peers.get(id) || null,
    /** Re-anuncia a lista de signalers pra quem já está conectado (ex.: lista mudou). */
    broadcastSignalers() {
      const sg = signalersList();
      if (!sg.length) return;
      for (const p of peers.values()) send(p.ws, { type: 'signalers', urls: sg });
    },
  };
}

module.exports = { attachSignaling, selfCertifyingVerifier, tofuVerifier };
