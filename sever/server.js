// signaling-server/server.js
//
// Servidor de signaling WebRTC — a ÚNICA peça de infra "nova" pro P2P pela WAN.
// Não guarda nem transporta bytes de arquivo, shard, ou qualquer conteúdo do usuário:
// só faz relay de mensagens de registro e de SDP/ICE (texto, poucos KB) entre dois
// nodeIds que já se conhecem (via BootstrapPeerList no app). Qualquer instância deste
// arquivo serve — não precisa ser uma infra específica de uma empresa, e a rede
// sobrevive mesmo que um signaling específico caia, desde que os peers usem outro
// (ou já tenham trocado o necessário numa sessão anterior).
//
// Rodar: npm install && node server.js
// Variável de ambiente PORT (default 8787).

const WebSocket = require('ws');

const PORT = process.env.PORT || 8787;
const wss = new WebSocket.Server({ port: PORT });

// nodeId -> WebSocket
const registry = new Map();

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

wss.on('connection', (ws) => {
  let selfNodeId = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return; // mensagem malformada — ignora, não derruba a conexão
    }

    switch (msg.type) {
      case 'register': {
        if (typeof msg.nodeId !== 'string' || !msg.nodeId) return;
        selfNodeId = msg.nodeId;
        registry.set(selfNodeId, ws);
        break;
      }

      case 'signal': {
        // relay puro: só repassa pro destinatário se ele estiver conectado agora.
        // Não persiste nada — se o destino estiver offline, quem chamou decide o
        // que fazer (retry, avisar o usuário), igual o comentário no SignalingClient.kt.
        if (!selfNodeId || typeof msg.to !== 'string' || !msg.payload) return;
        const target = registry.get(msg.to);
        if (!target) {
          send(ws, { type: 'error', reason: 'peer_offline', to: msg.to });
          return;
        }
        send(target, { type: 'signal', from: selfNodeId, payload: msg.payload });
        break;
      }

      default:
        break; // tipo desconhecido — ignora
    }
  });

  ws.on('close', () => {
    if (selfNodeId && registry.get(selfNodeId) === ws) {
      registry.delete(selfNodeId);
    }
  });
});

console.log(`Signaling server rodando na porta ${PORT} (ws://0.0.0.0:${PORT})`);
