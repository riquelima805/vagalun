

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
      return; 
    }

    switch (msg.type) {
      case 'register': {
        if (typeof msg.nodeId !== 'string' || !msg.nodeId) return;
        selfNodeId = msg.nodeId;
        registry.set(selfNodeId, ws);
        break;
      }

      case 'signal': {
       
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
        break; 
    }
  });

  ws.on('close', () => {
    if (selfNodeId && registry.get(selfNodeId) === ws) {
      registry.delete(selfNodeId);
    }
  });
});

console.log(`Signaling server rodando na porta ${PORT} (ws://0.0.0.0:${PORT})`);
