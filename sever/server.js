const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8787;

const METERED_API_KEY = process.env.METERED_API_KEY || 'COLOQUE_SUA_KEY_AQUI';
const METERED_APP_NAME = process.env.METERED_APP_NAME || 'adla';


let turnCache = null;
let turnCacheExpiresAt = 0;
const TURN_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

async function fetchTurnCredentials() {
  const now = Date.now();
  if (turnCache && now < turnCacheExpiresAt) {
    return turnCache;
  }

  const url = `https://${METERED_APP_NAME}.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Metered respondeu ${res.status}`);
  }
  const iceServers = await res.json();

  turnCache = iceServers;
  turnCacheExpiresAt = now + TURN_CACHE_TTL_MS;
  return iceServers;
}

// ---- Servidor HTTP (só a rota de credenciais TURN) ----
const httpServer = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/ice-servers') {
    try {
      const iceServers = await fetchTurnCredentials();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*', 
      });
      res.end(JSON.stringify(iceServers));
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'falha ao buscar credenciais TURN', detail: e.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end();
});

// ---- WebSocket signaling (igual ao que já tinha) ----
const wss = new WebSocket.Server({ server: httpServer });

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

httpServer.listen(PORT, () => {
  console.log(`Signaling server rodando na porta ${PORT} (ws://0.0.0.0:${PORT})`);
  console.log(`Endpoint de credenciais TURN: http://0.0.0.0:${PORT}/ice-servers`);
});
