const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const points = require('./points');
const proofPoints = require('./proofPoints');

const PORT = process.env.PORT || 8787;
const ADMIN_TOKEN = process.env.SIGNALING_ADMIN_TOKEN || null;

// ============ MONITORAMENTO DE NÓS ============
// O registry original só guardava Map<nodeId, ws> — quando o celular
// desconectava, a informação sumia na hora (sem histórico, sem uptime,
// sem "quantos nós já passaram pela rede"). Agora guardamos:
//  - connectedAt por nó ativo (pra calcular uptime em tempo real)
//  - histórico de sessões encerradas (connectedAt/disconnectedAt/duration),
//    persistido em disco, últimas SESSIONS_HISTORY_MAX
const dataDir = path.join(__dirname, 'data');
const sessionsFile = path.join(dataDir, 'node-sessions.json');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const SESSIONS_HISTORY_MAX = Number(process.env.SESSIONS_HISTORY_MAX || 2000);
let closedSessions = []; // [{ nodeId, connectedAt, disconnectedAt, durationSec }]
const connectedAt = new Map(); // nodeId -> ISO timestamp da conexão atual
const knownNodeIds = new Set(); // todo nodeId que já se registrou alguma vez (ativo ou não)

function loadSessions() {
  if (!fs.existsSync(sessionsFile)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(sessionsFile, 'utf-8'));
    closedSessions = raw.closedSessions || [];
    (raw.knownNodeIds || []).forEach((id) => knownNodeIds.add(id));
  } catch (e) {
    console.error('[monitor] falha ao carregar node-sessions.json:', e.message);
  }
}

let saveScheduled = false;
function scheduleSaveSessions() {
  if (saveScheduled) return;
  saveScheduled = true;
  setTimeout(() => {
    saveScheduled = false;
    try {
      fs.writeFileSync(sessionsFile, JSON.stringify({
        closedSessions: closedSessions.slice(-SESSIONS_HISTORY_MAX),
        knownNodeIds: [...knownNodeIds]
      }, null, 2));
    } catch (e) {
      console.error('[monitor] falha ao salvar node-sessions.json:', e.message);
    }
  }, 500);
}

loadSessions();

function isAdmin(req) {
  if (!ADMIN_TOKEN) return true; // modo dev
  const given = req.headers['x-admin-token'] || '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function jsonResponse(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*' // o painel web roda num domínio/porta diferente
  });
  res.end(JSON.stringify(body));
}

const httpServer = http.createServer((req, res) => {
  if (req.url === '/nodes') {
    if (!isAdmin(req)) return jsonResponse(res, 401, { ok: false, error: 'token de admin inválido ou ausente (header X-Admin-Token)' });
    const now = Date.now();
    const active = [...registry.keys()].map((nodeId) => {
      const since = connectedAt.get(nodeId);
      return {
        nodeId,
        connectedAt: since || null,
        uptimeSec: since ? Math.floor((now - new Date(since).getTime()) / 1000) : null
      };
    });
    return jsonResponse(res, 200, { online: active.map((a) => a.nodeId), active });
  }

  if (req.url.startsWith('/nodes/history')) {
    if (!isAdmin(req)) return jsonResponse(res, 401, { ok: false, error: 'token de admin inválido ou ausente (header X-Admin-Token)' });
    const url = new URL(req.url, 'http://x');
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, SESSIONS_HISTORY_MAX);
    const history = closedSessions.slice(-limit).reverse();
    return jsonResponse(res, 200, { history });
  }

  if (req.url === '/nodes/stats') {
    if (!isAdmin(req)) return jsonResponse(res, 401, { ok: false, error: 'token de admin inválido ou ausente (header X-Admin-Token)' });
    const now = Date.now();
    const activeCount = registry.size;
    const totalKnown = knownNodeIds.size;

    // Tempo médio de sessão: combina sessões já encerradas (duração real)
    // + sessões ativas agora (uptime até este instante) — dá uma média
    // que reflete tanto quem já saiu quanto quem tá online faz tempo.
    const activeUptimes = [...connectedAt.values()].map(
      (since) => Math.floor((now - new Date(since).getTime()) / 1000)
    );
    const allDurations = [...closedSessions.map((s) => s.durationSec), ...activeUptimes];
    const avgSessionSec = allDurations.length
      ? Math.round(allDurations.reduce((a, b) => a + b, 0) / allDurations.length)
      : 0;

    return jsonResponse(res, 200, {
      activeCount,
      totalKnownNodes: totalKnown,
      closedSessionsCount: closedSessions.length,
      avgSessionSec
    });
  }

  if (req.method === 'OPTIONS') return jsonResponse(res, 204, {}); // preflight CORS

  // GET /points/leaderboard e GET /points/<pubkey> — ledger de pontos
  // off-chain (sever/points.js), alimentado por uptime verificado (assinatura
  // da wallet no 'register') + provas on-chain de armazenamento (proofPoints.js).
  if (req.url.startsWith('/points/leaderboard')) {
    return jsonResponse(res, 200, { leaderboard: points.getLeaderboard(20) });
  }
  if (req.url.startsWith('/points/')) {
    const pubkey = decodeURIComponent(req.url.slice('/points/'.length));
    return jsonResponse(res, 200, { pubkey, ...points.getEntry(pubkey) });
  }

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
  let verifiedPubkey = null; // só preenchido se a assinatura da wallet bater
  let pointsSessionStartedAt = null;

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
        connectedAt.set(selfNodeId, new Date().toISOString());
        knownNodeIds.add(selfNodeId);
        scheduleSaveSessions();
        console.log(`[signaling] registrado: ${selfNodeId}  (online agora: ${[...registry.keys()].join(', ')})`);

        // Se o cliente mandou pubkey + assinatura do próprio nodeId, prova
        // posse da wallet antes de começar a contar pontos de uptime pra ela.
        // Sem isso a conexão segue normal (WebRTC/relay funcionam do mesmo
        // jeito), só não pontua — impede que alguém declare pubkey alheia.
        if (typeof msg.pubkey === 'string' && typeof msg.sig === 'string') {
          const valid = points.verifyOwnership(msg.pubkey, selfNodeId, msg.sig);
          if (valid) {
            verifiedPubkey = msg.pubkey;
            pointsSessionStartedAt = Date.now();
            points.onSessionStart(verifiedPubkey);
            console.log(`[points] sessão verificada pra ${verifiedPubkey}`);
          } else {
            console.log(`[points] assinatura inválida pra pubkey ${msg.pubkey} — sem pontos nessa sessão`);
          }
        }

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

      // Fecha a sessão: calcula duração e joga no histórico persistido.
      const since = connectedAt.get(selfNodeId);
      connectedAt.delete(selfNodeId);
      if (since) {
        const durationSec = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
        closedSessions.push({
          nodeId: selfNodeId,
          connectedAt: since,
          disconnectedAt: new Date().toISOString(),
          durationSec
        });
        if (closedSessions.length > SESSIONS_HISTORY_MAX) {
          closedSessions = closedSessions.slice(-SESSIONS_HISTORY_MAX);
        }
        scheduleSaveSessions();
      }

      console.log(`[signaling] desconectado: ${selfNodeId}  (online agora: ${[...registry.keys()].join(', ') || '(ninguém)'})`);
      for (const sock of registry.values()) {
        send(sock, { type: 'peer_left', nodeId: selfNodeId });
      }
    }
    if (verifiedPubkey && pointsSessionStartedAt) {
      const entry = points.onSessionEnd(verifiedPubkey, pointsSessionStartedAt);
      console.log(`[points] sessão encerrada pra ${verifiedPubkey} — total agora: ${entry.points} pts`);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Relay server rodando na porta ${PORT} (ws://0.0.0.0:${PORT})`);
  proofPoints.start();
});
