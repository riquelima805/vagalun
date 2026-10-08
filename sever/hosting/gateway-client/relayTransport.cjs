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
function connectRelay(signalingUrl, selfNodeId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(signalingUrl);
    const pending = new Map();
    let reqCounter = 0;
    let opened = false;

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

    ws.on('error', (e) => { if (!opened) reject(e); });
    ws.on('close', () => {
      for (const p of pending.values()) p.reject(new Error('conexão com o signaling caiu'));
      pending.clear();
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

module.exports = { connectRelay, putShardViaRelay };
