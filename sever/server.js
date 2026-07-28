const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8787;


const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Signaling & Relay Server Online');
});


const wss = new WebSocket.Server({ server: httpServer });


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

        // Diz ao cliente recém-registrado quem já está online
        const others = [...registry.keys()].filter((id) => id !== selfNodeId);
        send(ws, { type: 'peers', nodeIds: others });

        // Avisa todos os outros que este cliente acabou de entrar
        for (const [id, sock] of registry) {
          if (id !== selfNodeId) {
            send(sock, { type: 'peer_joined', nodeId: selfNodeId });
          }
        }
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

      
      case 'relay': {
        if (!selfNodeId || typeof msg.to !== 'string') return;
        const target = registry.get(msg.to);
        if (!target) {
          send(ws, { type: 'relay_error', reason: 'peer_offline', requestId: msg.requestId });
          return;
        }
        send(target, { 
          type: 'relay', 
          from: selfNodeId, 
          requestId: msg.requestId, 
          header: msg.header, 
          payloadBase64: msg.payloadBase64 
        });
        break;
      }

      case 'relay_response': {
        if (typeof msg.to !== 'string') return;
        const target = registry.get(msg.to);
        if (target) {
          send(target, { 
            type: 'relay_response', 
            from: selfNodeId, 
            requestId: msg.requestId, 
            header: msg.header, 
            payloadBase64: msg.payloadBase64 
          });
        }
        break;
      }

      default:
        break;
    }
  });

  ws.on('close', () => {
    if (selfNodeId && registry.get(selfNodeId) === ws) {
      registry.delete(selfNodeId);
      for (const sock of registry.values()) {
        send(sock, { type: 'peer_left', nodeId: selfNodeId });
      }
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Relay server rodando na porta ${PORT} (ws://0.0.0.0:${PORT})`);
});
