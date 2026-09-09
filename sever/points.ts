const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dgram = require('dgram');
const net = require('net');
const WebSocket = require('ws');
const { Connection, PublicKey } = require('@solana/web3.js');
const points = require('./points');
const proofPoints = require('./proofPoints');
const nodeCapacity = require('./nodeCapacity');

// ------------------------------------------------------------------
// Faucet de devnet: node de PC nasce com wallet local zerada de SOL —
// sem gas nenhum, ele nem consegue assinar a transação de claim/saque
// mais pra frente. Em devnet dá pra resolver de graça, usando o faucet
// nativo do próprio RPC (connection.requestAirdrop), sem precisar de
// treasury nem chave própria da plataforma. (Em mainnet isso NÃO
// existe — lá teria que ser uma wallet-treasury de verdade mandando.)
// ------------------------------------------------------------------
const FAUCET_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const FAUCET_AIRDROP_LAMPORTS = Number(process.env.FAUCET_AIRDROP_LAMPORTS || 0.02 * 1e9); // ~0.02 SOL, dá pra várias transações de gas
const faucetConnection = new Connection(FAUCET_RPC_URL, 'confirmed');
const faucetedPubkeys = new Set(); // evita pedir airdrop de novo pro mesmo node a cada heartbeat

/**
 * Manda uma migalha de SOL devnet pra wallet do node de PC, só na
 * primeira vez que aquele pubkey aparece. Nunca trava o heartbeat —
 * se o faucet falhar (rate limit do devnet é comum), tenta de novo
 * no próximo heartbeat, sem derrubar o registro do node.
 */
async function faucetIfNeeded(pubkeyBase58) {
  if (!pubkeyBase58 || faucetedPubkeys.has(pubkeyBase58)) return;
  faucetedPubkeys.add(pubkeyBase58); // marca já ANTES de tentar, pra não martelar o faucet em paralelo
  try {
    const pubkey = new PublicKey(pubkeyBase58);
    const balance = await faucetConnection.getBalance(pubkey);
    if (balance > 0) return; // já tem SOL (recebeu de outro jeito, ou já foi fauceteado antes)
    const sig = await faucetConnection.requestAirdrop(pubkey, FAUCET_AIRDROP_LAMPORTS);
    await faucetConnection.confirmTransaction(sig, 'confirmed');
    console.log(`[faucet] devnet airdrop de ${FAUCET_AIRDROP_LAMPORTS / 1e9} SOL pra node de PC ${pubkeyBase58}`);
  } catch (err) {
    faucetedPubkeys.delete(pubkeyBase58); // libera pra tentar de novo no próximo heartbeat
    console.log(`[faucet] falhou pra ${pubkeyBase58} (tenta de novo depois): ${err.message}`);
  }
}

const PORT = process.env.PORT || 8787;
const ADMIN_TOKEN = process.env.SIGNALING_ADMIN_TOKEN || null;

// ============ NÓS DE INFRAESTRUTURA (gateway/publisher) ============
// gateway-1 (sever/gateway/content.js) e hosting-platform-<timestamp>
// (hosting/gateway-client/publish.cjs) se registram aqui só pra poder
// mandar `relay` DIRETO a um nodeId específico (celular real) — eles não
// são peers de verdade, não sabem responder handshake WebRTC (signal),
// e não devem aparecer na descoberta de peers de ninguém. Sem esse
// filtro, cada registro/desconexão de infra vira peer_joined/peer_left
// pra TODOS os celulares reais conectados, que tentam negociar WebRTC
// com eles e ficam travando em timeout à toa (era a causa do bug
// "timeout esperando resposta de gateway-1").
const INFRA_NODE_IDS = new Set(
  (process.env.GATEWAY_RELAY_NODE_ID || 'gateway-1').split(',').map((s) => s.trim()).filter(Boolean)
);
function isInfraNodeId(nodeId) {
  return INFRA_NODE_IDS.has(nodeId) || nodeId.startsWith('publisher-') || nodeId.startsWith('hosting-platform-');
}

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
    'Access-Control-Allow-Origin': '*', // o painel web roda num domínio/porta diferente
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
  });
  res.end(JSON.stringify(body));
}

function readJsonBody(req, maxBytes = 1024 * 16) {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) { reject(new Error('body grande demais')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ============ DIRETÓRIO DE NÓS DE PC (signaling+STUN/TURN) ============
// Cada nó de PC (vagalun-pc-node) manda um "heartbeat" periódico aqui
// avisando que tá online, com o endereço/credenciais que os celulares
// devem usar pra falar com ele. O app mobile/gateway consulta
// GET /directory/nodes pra descobrir nós de PC disponíveis ANTES de
// cair pra este servidor (VPS) como fallback — a VPS só é usada de
// verdade se a lista vier vazia ou nenhum nó de PC responder.
const DIRECTORY_TTL_MS = Number(process.env.DIRECTORY_TTL_MS || 45_000); // sem heartbeat por esse tempo = considerado offline
const pcDirectory = new Map(); // nodeId (do diretório) -> { ...info, lastSeen }

function pruneDirectory() {
  const now = Date.now();
  for (const [id, info] of pcDirectory) {
    if (now - info.lastSeen > DIRECTORY_TTL_MS) pcDirectory.delete(id);
  }
}
setInterval(pruneDirectory, 10_000);

/**
 * Testa se host:port (o TURN de um nó de PC) responde de verdade a uma
 * requisição de fora — é o teste mais confiável que existe, porque a
 * VPS é um ponto de vista genuinamente externo (o próprio nó não
 * consegue se auto-testar de forma confiável, já que qualquer coisa
 * rodando nele mesmo não passa pelo NAT/roteador de verdade).
 *
 * Manda um STUN Binding Request (RFC 5389) via UDP — node-turn responde
 * STUN nativamente, então "veio resposta" = porta alcançável de fora.
 */
function probeStunReachability(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    // host pode vir em IPv4 ou IPv6 (ex.: nó de PC atrás de operadora que só
    // dá IPv6 público, tipo Claro/FLN) — socket fixo 'udp4' falhava seco
    // (erro síncrono no send) sempre que o host era IPv6, e o probe nunca
    // dava certo, então o nó nunca saía de "checando" pra "live".
    const isV6 = net.isIPv6(host);
    const socket = dgram.createSocket(isV6 ? 'udp6' : 'udp4');
    const transactionId = crypto.randomBytes(12);
    const packet = Buffer.alloc(20);
    packet.writeUInt16BE(0x0001, 0);        // tipo: Binding Request
    packet.writeUInt16BE(0x0000, 2);        // tamanho do corpo (nenhum atributo)
    packet.writeUInt32BE(0x2112A442, 4);    // magic cookie (STUN)
    transactionId.copy(packet, 8);

    let done = false;
    const finish = (reachable) => {
      if (done) return;
      done = true;
      try { socket.close(); } catch (_) {}
      resolve(reachable);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);

    socket.on('message', (msg) => {
      clearTimeout(timer);
      // resposta STUN válida começa com 0x0101 (Binding Success) ou
      // 0x0111 (Binding Error) — qualquer um dos dois já prova que
      // algo respondeu na porta de verdade, o que já basta pro nosso
      // propósito (existência de um serviço STUN/TURN vivo ali).
      const type = msg.length >= 2 ? msg.readUInt16BE(0) : 0;
      finish(type === 0x0101 || type === 0x0111);
    });
    socket.on('error', () => { clearTimeout(timer); finish(false); });

    try {
      socket.send(packet, port, host);
    } catch (_) {
      clearTimeout(timer);
      finish(false);
    }
  });
}

/**
 * Teste de alcance genérico via TCP puro — usado pra portas que não
 * falam STUN (ex.: RTMP da camada de live streaming). Só tenta abrir
 * a conexão TCP; se conectar, a porta está alcançável de fora.
 */
function probeTcpReachability(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (reachable) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch (_) {}
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    try {
      socket.connect(port, host);
    } catch (_) {
      finish(false);
    }
  });
}

const httpServer = http.createServer((req, res) => {
  // Preflight CORS PRECISA ser respondido antes de qualquer checagem de rota
  // ou de admin token — senão o navegador nunca chega a mandar a requisição
  // real (GET /nodes etc.), porque o preflight (OPTIONS) não manda o header
  // X-Admin-Token, cairia no isAdmin() das rotas abaixo, tomaria 401 sem os
  // headers de CORS corretos, e o navegador bloqueia tudo por CORS — mesmo
  // com o servidor 100% no ar (era a causa do "não foi possível conectar
  // ao signaling server" no painel, quando VITE_SIGNALING_ADMIN_TOKEN está
  // configurado).
  if (req.method === 'OPTIONS') return jsonResponse(res, 204, {});

  // ---- Diretório de nós de PC (signaling+STUN/TURN descentralizado) ----
  if (req.url === '/directory/probe-turn' && req.method === 'POST') {
    readJsonBody(req).then(async (body) => {
      const host = String(body.host || '').trim().slice(0, 255);
      const port = Number(body.port);
      if (!host || !port) return jsonResponse(res, 400, { ok: false, error: 'campos obrigatórios: host, port' });
      const reachable = await probeStunReachability(host, port);
      return jsonResponse(res, 200, { ok: true, reachable });
    }).catch((err) => jsonResponse(res, 400, { ok: false, error: err.message }));
    return;
  }

  if (req.url === '/directory/probe-tcp' && req.method === 'POST') {
    readJsonBody(req).then(async (body) => {
      const host = String(body.host || '').trim().slice(0, 255);
      const port = Number(body.port);
      if (!host || !port) return jsonResponse(res, 400, { ok: false, error: 'campos obrigatórios: host, port' });
      const reachable = await probeTcpReachability(host, port);
      return jsonResponse(res, 200, { ok: true, reachable });
    }).catch((err) => jsonResponse(res, 400, { ok: false, error: err.message }));
    return;
  }

  if (req.url === '/directory/heartbeat' && req.method === 'POST') {
    readJsonBody(req).then((body) => {
      const nodeId = String(body.nodeId || '').trim().slice(0, 128);
      const publicHost = String(body.publicHost || '').trim().slice(0, 255);
      const httpPort = Number(body.httpPort);
      const turnPort = Number(body.turnPort);
      const turnUser = String(body.turnUser || '').slice(0, 128);
      const turnSecret = String(body.turnSecret || '').slice(0, 128);
      const turnCapable = body.turnCapable === true; // o próprio nó já fez o probe antes de mandar
      const mediaCapable = body.mediaCapable === true;
      const mediaRtmpPort = Number(body.mediaRtmpPort) || null;
      const mediaHttpPort = Number(body.mediaHttpPort) || null;

      if (!nodeId || !publicHost || !httpPort || !turnPort || !turnUser || !turnSecret) {
        return jsonResponse(res, 400, { ok: false, error: 'campos obrigatórios: nodeId, publicHost, httpPort, turnPort, turnUser, turnSecret' });
      }
      const remoteIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();

      pcDirectory.set(nodeId, {
        nodeId, publicHost, httpPort, turnPort, turnUser, turnSecret, turnCapable,
        mediaCapable, mediaRtmpPort, mediaHttpPort,
        remoteIp,
        firstSeen: pcDirectory.get(nodeId)?.firstSeen || new Date().toISOString(),
        lastSeen: Date.now(),
      });

      // ---- pontos por BANDA (não uptime) + score de capacidade ----
      // pubkey/sig são OPCIONAIS: sem eles o node ainda funciona e aparece
      // no diretório normalmente, só não pontua banda (mesmo princípio já
      // usado no 'register' do WebSocket pro mobile, mais abaixo).
      let verifiedPubkey = null;
      if (typeof body.pubkey === 'string' && typeof body.sig === 'string') {
        // mensagem assinada = "heartbeat:<nodeId>:<seq>" — o seq evita
        // que uma assinatura antiga capturada seja reenviada pra sempre
        const expectedMsg = `heartbeat:${nodeId}:${body.seq || ''}`;
        if (points.verifyOwnership(body.pubkey, expectedMsg, body.sig)) {
          verifiedPubkey = body.pubkey;
        } else {
          console.log(`[directory] assinatura inválida pro node de PC ${nodeId} — heartbeat aceito, sem pontuar banda`);
        }
      }
      if (verifiedPubkey) {
        const relayDelta = Number(body.turnRelayBytesSinceLastBeat) || 0;
        const liveDelta = Number(body.liveBytesSinceLastBeat) || 0;
        points.addRelayBandwidth(verifiedPubkey, relayDelta);
        points.addLiveBandwidth(verifiedPubkey, liveDelta);
        // fire-and-forget: não atrasa a resposta do heartbeat esperando
        // a confirmação da transação de airdrop (pode levar alguns segundos)
        faucetIfNeeded(verifiedPubkey).catch(() => {});
      }

      // score de capacidade: sempre calculado aqui a partir do que o
      // node MEDIU e reportou (cpuLoadPercent, activeLiveCount,
      // liveStreamsHealth) — o node nunca manda um "aguento X lives"
      // pronto, só os sinais crus.
      const capacitySnapshot = nodeCapacity.recordHeartbeat(nodeId, {
        cpuLoadPercent: Number(body.cpuLoadPercent) || 0,
        activeLiveCount: Number(body.activeLiveCount) || 0,
        liveStreamsHealth: Array.isArray(body.liveStreamsHealth) ? body.liveStreamsHealth : [],
      });

      return jsonResponse(res, 200, { ok: true, ttlMs: DIRECTORY_TTL_MS, pointed: !!verifiedPubkey, capacity: capacitySnapshot });
    }).catch((err) => jsonResponse(res, 400, { ok: false, error: err.message }));
    return;
  }

  if (req.url.startsWith('/directory/heartbeat') && req.method === 'DELETE') {
    readJsonBody(req).then((body) => {
      const nodeId = String(body.nodeId || '').trim();
      if (nodeId) pcDirectory.delete(nodeId);
      return jsonResponse(res, 200, { ok: true });
    }).catch(() => jsonResponse(res, 200, { ok: true }));
    return;
  }

  if (req.url === '/directory/nodes') {
    pruneDirectory();
    const nodes = [...pcDirectory.values()]
      .sort(() => Math.random() - 0.5) // embaralha pra distribuir carga entre nós de PC
      .map(({ nodeId, publicHost, httpPort, turnPort, turnUser, turnSecret, turnCapable, mediaCapable, mediaRtmpPort, mediaHttpPort, lastSeen }) => ({
        nodeId, publicHost, httpPort, turnPort, turnUser, turnSecret, turnCapable,
        mediaCapable, mediaRtmpPort, mediaHttpPort,
        ageSec: Math.floor((Date.now() - lastSeen) / 1000),
      }));
    return jsonResponse(res, 200, { count: nodes.length, nodes });
  }

  if (req.url === '/directory/capacity') {
    // painel/debug: score de capacidade calculado de TODOS os nodes de PC
    return jsonResponse(res, 200, { nodes: nodeCapacity.getAllSnapshots() });
  }

  if (req.url === '/directory/best-node-for-live') {
    // é isso que o GATEWAY chama na hora de decidir onde rotear uma live
    // nova: entre os nodes de PC online agora (mediaCapable=true), devolve
    // o de maior folga real, sem estar em cooldown por penalidade de
    // qualidade. Nunca aceita "quero esse" do cliente — quem escolhe é
    // sempre o backend, com base em histórico medido.
    pruneDirectory();
    const onlineMediaCapable = [...pcDirectory.values()].filter((n) => n.mediaCapable).map((n) => n.nodeId);
    const best = nodeCapacity.pickBestNodeForLive(onlineMediaCapable);
    if (!best) return jsonResponse(res, 200, { ok: false, reason: 'nenhum node de PC com folga disponível agora' });
    const nodeInfo = pcDirectory.get(best.nodeId);
    return jsonResponse(res, 200, { ok: true, node: nodeInfo, capacity: best });
  }

  if (req.url === '/nodes') {
    if (!isAdmin(req)) return jsonResponse(res, 401, { ok: false, error: 'token de admin inválido ou ausente (header X-Admin-Token)' });
    const now = Date.now();
    const active = [...registry.keys()].filter((id) => !isInfraNodeId(id)).map((nodeId) => {
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

  // (checagem de OPTIONS já feita no topo do handler — ver comentário lá)

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

        // Diz ao cliente recém-registrado quem já está online (sem infra —
        // celular não precisa nem deveria tentar WebRTC com gateway/publisher)
        const others = [...registry.keys()].filter((id) => id !== selfNodeId && !isInfraNodeId(id));
        send(ws, { type: 'peers', nodeIds: others });

        // Avisa os outros que este cliente entrou — só se for um peer de
        // verdade. Infra entrando/saindo não deveria gerar peer_joined pra
        // ninguém (é ruído puro, ninguém faz WebRTC com gateway-1).
        if (!isInfraNodeId(selfNodeId)) {
          for (const [id, sock] of registry) {
            if (id !== selfNodeId && !isInfraNodeId(id)) {
              send(sock, { type: 'peer_joined', nodeId: selfNodeId });
            }
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
      if (!isInfraNodeId(selfNodeId)) {
        for (const sock of registry.values()) {
          send(sock, { type: 'peer_left', nodeId: selfNodeId });
        }
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
