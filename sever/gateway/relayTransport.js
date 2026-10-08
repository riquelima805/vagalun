// Fala com um nó (celular) que está atrás de NAT/rede móvel, através do
// mesmo servidor de signaling/relay que o app já usa (sever/server.js).
// O celular NUNCA aceita conexão de entrada — ele que abre o WebSocket pro
// signaling e fica esperando mensagens `relay` chegarem (ver
// MainActivity.kt: sc.onRelayRequest -> reqHandler.handle(...)).
//
// Aqui o gateway/publisher entra como só mais um "nodeId" registrado nesse
// mesmo signaling, e manda `relay` pro nodeId do celular — exatamente como
// dois celulares fariam entre si quando o WebRTC direto não abre.

const WebSocket = require('ws');

// Conecta no signaling como um nó próprio (ex: "gateway-1") e devolve um
// client com `.request(toNodeId, header, payload)` que resolve quando a
// relay_response correspondente chega.
function connectRelay(signalingUrl, selfNodeId, onDisconnect) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(signalingUrl);
    const pending = new Map();
    let reqCounter = 0;
    let opened = false;
    let notified = false;

    // Avisa quem pediu essa conexão que ela morreu (caiu depois de aberta OU
    // nunca chegou a abrir), pra quem guarda essa promise em cache (content.js)
    // saber que precisa descartá-la e reconectar na próxima chamada, em vez de
    // ficar preso pra sempre com um client morto.
    function notifyDisconnect(reason) {
      if (notified) return;
      notified = true;
      if (typeof onDisconnect === 'function') {
        try { onDisconnect(reason); } catch (e) { /* nunca deixa isso derrubar o processo */ }
      }
    }

    ws.on('open', () => {
      opened = true;
      ws.send(JSON.stringify({ type: 'register', nodeId: selfNodeId }));
      resolve(client);
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

      if (msg.type === 'relay_response') {
        const p = pending.get(msg.requestId);
        if (!p) return;
        pending.delete(msg.requestId);
        const payload = msg.payloadBase64 ? Buffer.from(msg.payloadBase64, 'base64') : null;
        p.resolve({ header: msg.header, payload });
      } else if (msg.type === 'relay_error' || msg.type === 'error') {
        const p = pending.get(msg.requestId);
        if (p) {
          pending.delete(msg.requestId);
          p.reject(new Error(msg.reason || 'erro no relay'));
        }
      }
    });

    ws.on('error', (e) => {
      if (!opened) reject(e);
      notifyDisconnect(e);
    });
    ws.on('close', () => {
      for (const p of pending.values()) p.reject(new Error('conexão com o signaling caiu'));
      pending.clear();
      notifyDisconnect(new Error('conexão com o signaling caiu'));
    });

    const client = {
      request(toNodeId, header, payload, timeoutMs = 20000) {
        return new Promise((res, rej) => {
          const requestId = ++reqCounter;
          const timer = setTimeout(() => {
            pending.delete(requestId);
            rej(new Error(`timeout esperando resposta de ${toNodeId} (celular offline/fora de alcance?)`));
          }, timeoutMs);

          pending.set(requestId, {
            resolve: (v) => { clearTimeout(timer); res(v); },
            reject: (e) => { clearTimeout(timer); rej(e); },
          });

          const msg = { type: 'relay', to: toNodeId, requestId, header };
          if (payload) msg.payloadBase64 = payload.toString('base64');
          ws.send(JSON.stringify(msg));
        });
      },
      close() { ws.close(); },
    };
  });
}

async function putShardViaRelay(client, toNodeId, shardKey, data) {
  const resp = await client.request(toNodeId, { op: 'put', shardKey }, data);
  return !!(resp.header && resp.header.ok);
}

// Mesmo `op: 'gossip'` que GossipRegistry.handleIncomingGossip (Kotlin) já entende —
// o payload aceito é { peers, files, sites }, todos opcionais. `extra` deixa passar
// `files` além de `sites` (ver announceFilesToMesh em meshBridge.js — mesmo bug dos
// sites existia pros arquivos: handlePut só grava o shard em disco, nunca registra
// a FileMeta no GossipRegistry, então o arquivo nunca entrava no gossip mesmo com o
// site já propagado).
async function gossipViaRelay(client, toNodeId, sitesJsonArray, extra = {}) {
  const header = { op: 'gossip', sites: sitesJsonArray, ...extra };
  const resp = await client.request(toNodeId, header, null);
  return resp.header || null;
}

module.exports = { connectRelay, putShardViaRelay, gossipViaRelay };
