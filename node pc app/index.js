#!/usr/bin/env node
'use strict';

// ---- Rede de segurança contra "abre e fecha na hora" -------------------
// Quando dá duplo-clique no .exe, o Windows abre uma janela de terminal
// nova; se o processo travar com um erro, a janela fecha JUNTO com o
// processo — rápido demais pra ler o que aconteceu. Isso instala um
// gravador de erro ANTES de qualquer outra coisa carregar, pra qualquer
// falha (erro de módulo faltando, porta ocupada, etc.) ficar registrada
// num arquivo do lado do .exe e a janela esperar você apertar ENTER em
// vez de sumir sozinha.
installCrashLogger();

function installCrashLogger() {
  const fs = require('fs');
  const path = require('path');
  const logPath = path.join(
    process.pkg ? path.dirname(process.execPath) : __dirname,
    'vagalun-node-error.log'
  );
  function logAndHalt(label, err) {
    const msg = `[${new Date().toISOString()}] ${label}: ${err && err.stack ? err.stack : err}\n`;
    try { fs.appendFileSync(logPath, msg); } catch (_) { /* disco só-leitura, sem sorte — ainda mostra no console */ }
    console.error('\n' + msg);
    console.error(`(erro também salvo em: ${logPath})`);
    if (process.stdin.isTTY) {
      console.error('\nPressione ENTER pra fechar esta janela...');
      try { fs.readSync(0, Buffer.alloc(1), 0, 1, null); } catch (_) { /* stdin sem TTY (ex: rodando como serviço) */ }
    }
    process.exit(1);
  }
  process.on('uncaughtException', (err) => logAndHalt('erro não tratado', err));
  process.on('unhandledRejection', (err) => logAndHalt('promise rejeitada sem tratamento', err));
}

/**
 * VAGALUN — Nó de PC
 * ---------------------------------------------------------------
 * Um único processo/exe que faz SÓ duas coisas de infraestrutura:
 *   1) Signaling  (WebSocket, porta HTTP_PORT)  — troca offer/answer/ICE
 *      entre celulares pra abrir conexão WebRTC direta.
 *   2) STUN/TURN  (porta TURN_PORT, padrão 3478) — ajuda os celulares
 *      atrás de NAT/CGNAT a se enxergarem, e faz relay de mídia quando
 *      a conexão direta não rola.
 *
 * Além disso sobe um painel visual local (HTTP + WebSocket) em
 * http://localhost:HTTP_PORT/  pra você ver em tempo real:
 *   - se o TURN e o signaling estão no ar
 *   - quantos nós (celulares) estão conectados agora
 *   - quantas sessões TURN de relay estão ativas
 *   - log ao vivo de eventos
 *
 * A VPS continua existindo só como fallback: se nenhum nó de PC
 * estiver online, o app mobile cai pro endereço da VPS.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dgram = require('dgram');
const WebSocket = require('ws');
const Turn = require('node-turn');
const nacl = require('tweetnacl');
const bs58 = require('bs58').default || require('bs58');
const { Connection, PublicKey } = require('@solana/web3.js');
const { tryUpnpMap } = require('./natUpnp');
const { createMediaLayer, signStreamUrl } = require('./media');
const { createOwnerLink } = require('./ownerLink');
const { createRelayManager } = require('./relay');

// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------
const HTTP_PORT = Number(process.env.VAGALUN_HTTP_PORT || 8787);
const TURN_PORT = Number(process.env.VAGALUN_TURN_PORT || 3478);
const TURN_USER = process.env.VAGALUN_TURN_USER || 'vagalun';
const TURN_SECRET = process.env.VAGALUN_TURN_SECRET || crypto.randomBytes(9).toString('base64url');
const ADMIN_TOKEN = process.env.VAGALUN_ADMIN_TOKEN || null;
const PUBLIC_DIR = path.join(__dirname, 'public');

// VPS usada como diretório (descoberta) e como fallback caso nenhum nó
// de PC esteja online. Sem isso configurado, o nó ainda funciona
// normalmente — só não aparece pra nenhum celular te encontrar sozinho.
// Fallback pro backend oficial (registry) caso a env var não seja setada —
// isso é o que faz o painel/claim funcionar "out of the box" sem precisar
// configurar nada. Pra rodar contra outro backend (staging, etc.) basta
// setar VAGALUN_DIRECTORY_URL; pra desligar de vez, setar VAGALUN_DIRECTORY_URL=off.
const DIRECTORY_URL_RAW = process.env.VAGALUN_DIRECTORY_URL || 'https://signal.vagalun.shop';
const DIRECTORY_URL = DIRECTORY_URL_RAW.toLowerCase() === 'off' ? null : DIRECTORY_URL_RAW;
const HEARTBEAT_INTERVAL_MS = Number(process.env.VAGALUN_HEARTBEAT_MS || 20_000);

// Program id do contrato Anchor (storage_market) publicado on-chain. Igual
// ao [programs.devnet] do Anchor.toml — mantido como env var pra poder
// trocar pra mainnet só setando VAGALUN_PROGRAM_ID, sem editar código.
// Este é o ÚNICO lugar que define o program id: /api/status expõe ele pro
// painel e pro claim.html, então nunca fica dessincronizado entre os dois.
const PROGRAM_ID = process.env.VAGALUN_PROGRAM_ID || '7CAZvZmgbUES9pzr9H1i1EDk7b1mjX2wib8JTVSt7kGk';
const SOLANA_CLUSTER = process.env.VAGALUN_SOLANA_CLUSTER || 'devnet'; // 'devnet' | 'mainnet-beta'

// Live streaming (RTMP ingest + HTTP-FLV delivery) — opcional, desligado
// por padrão. Só faz sentido ligar em nós que conseguem receber conexão
// de entrada (mesma exigência do TURN). Ver checkNatAndReachability().
const MEDIA_ENABLED = process.env.VAGALUN_MEDIA_ENABLED !== '0';
const MEDIA_RTMP_PORT = Number(process.env.VAGALUN_MEDIA_RTMP_PORT || 1935);
const MEDIA_HTTP_PORT = Number(process.env.VAGALUN_MEDIA_HTTP_PORT || 8000);
const MEDIA_PUSH_REQUIRES_AUTH = process.env.VAGALUN_MEDIA_PUSH_AUTH !== '0'; // por padrão exige auth_key pra transmitir

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) { try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) {} }
const configFile = path.join(dataDir, 'node-config.json');

function loadOrCreateConfig() {
  try {
    if (fs.existsSync(configFile)) {
      const cfg = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      // migração: configs criados antes da camada de mídia existir não têm mediaSecret
      if (!cfg.mediaSecret) {
        cfg.mediaSecret = crypto.randomBytes(16).toString('hex');
        try { fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2)); } catch (_) {}
      }
      return cfg;
    }
  } catch (_) {}
  const cfg = {
    nodeName: os.hostname() || 'vagalun-pc-node',
    turnUser: TURN_USER,
    turnSecret: TURN_SECRET,
    mediaSecret: crypto.randomBytes(16).toString('hex'),
    createdAt: new Date().toISOString(),
  };
  try { fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2)); } catch (_) {}
  return cfg;
}
const config = loadOrCreateConfig();

// ------------------------------------------------------------------
// Wallet Solana LOCAL do node de PC — não é a wallet pessoal do dono
// (Phantom), é uma identidade própria do processo, gerada e guardada
// em disco (mesmo padrão do turnSecret/mediaSecret). Ela assina os
// heartbeats sozinha, sem precisar de navegador/app externo aberto —
// Phantom não dá pra usar aqui porque só assina com aba aberta e
// aprovação manual, inviável pra processo 24/7 em background.
//
// O dono liga essa wallet do nó à wallet pessoal dele depois, num
// passo separado (fora deste arquivo), só pra apontar pra onde vai
// o pagamento final — não pra autenticar cada heartbeat.
// ------------------------------------------------------------------
const walletFile = path.join(dataDir, 'node-wallet.json');
function loadOrCreateWallet() {
  try {
    if (fs.existsSync(walletFile)) {
      const raw = JSON.parse(fs.readFileSync(walletFile, 'utf-8'));
      return {
        publicKey: raw.publicKey,
        secretKey: Uint8Array.from(Buffer.from(raw.secretKey, 'base64')),
      };
    }
  } catch (_) {}
  const kp = nacl.sign.keyPair();
  const wallet = {
    publicKey: bs58.encode(Buffer.from(kp.publicKey)),
    secretKey: Buffer.from(kp.secretKey).toString('base64'),
  };
  try { fs.writeFileSync(walletFile, JSON.stringify(wallet, null, 2)); } catch (_) {}
  return { publicKey: wallet.publicKey, secretKey: Uint8Array.from(kp.secretKey) };
}
const wallet = loadOrCreateWallet();

// Link com a wallet PESSOAL do dono (ex.: Phantom), feito à parte via
// painel (rotas plugadas em handleHttp mais abaixo). Enquanto o dono
// não linkar, ownerLink.getOwnerPubkey() retorna null e o heartbeat
// manda isso mesmo assim — o backend trata null como "sem payout
// configurado ainda", não como erro.
const ownerLink = createOwnerLink(dataDir);

// Só leitura — pra mostrar no painel se o faucet do backend já mandou o
// gas de devnet pra essa wallet (útil pra debugar sem sair do painel).
// Default do RPC segue SOLANA_CLUSTER: se alguém trocar VAGALUN_SOLANA_CLUSTER
// pra mainnet-beta sem setar SOLANA_RPC_URL, ainda aponta pro cluster certo
// em vez de continuar batendo (por acidente) no devnet.
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || (
  SOLANA_CLUSTER === 'mainnet-beta' ? 'https://api.mainnet-beta.solana.com' : 'https://api.devnet.solana.com'
);
const solanaConnection = new Connection(SOLANA_RPC_URL, 'confirmed');

/** Assina "heartbeat:<nodeId>:<seq>" — o backend valida com points.verifyOwnership(). */
function signHeartbeat(nodeId, seq) {
  const msg = Buffer.from(`heartbeat:${nodeId}:${seq}`, 'utf8');
  const sig = nacl.sign.detached(msg, wallet.secretKey);
  return Buffer.from(sig).toString('base64');
}

// ------------------------------------------------------------------
// Estado em memória (o que o painel visual mostra)
// ------------------------------------------------------------------
const startedAt = Date.now();
const state = {
  turnStatus: 'starting',   // starting | online | error
  signalingStatus: 'starting',
  directoryStatus: DIRECTORY_URL ? 'starting' : 'disabled', // starting | online | error | disabled
  natStatus: 'checking',    // checking | upnp-ok | upnp-failed | unreachable | reachable
  turnCapable: false,       // só vira true depois do probe de fora confirmar
  mediaStatus: MEDIA_ENABLED ? 'starting' : 'disabled', // starting | online | error | disabled
  mediaCapable: false,      // igual turnCapable, mas pra alcance da porta RTMP
  liveStreams: [],
  peers: new Map(),         // nodeId -> { connectedAt, ip }
  turnSessions: 0,
  bytesRelayed: 0,          // total agregado (todas as sessões)
  relayCreditByUser: {},    // username efêmero -> bytes relayados (pra atribuir turnRelayCredit por sessão)
  log: [],                  // últimas linhas de log (mais novo primeiro)
};

// ------------------------------------------------------------------
// Credenciais TURN efêmeras (padrão "TURN REST API", RFC-style):
//   username = "<expiry_unix>:<label>"
//   password = base64(HMAC-SHA1(turnSecret, username))
// Cada sessão pede sua própria credencial em vez de usar um usuário
// fixo global — isso permite saber DE QUEM foi cada byte relayado
// (necessário pro turnRelayCredit por live/sessão, não só um total cego).
// ------------------------------------------------------------------
function issueEphemeralTurnCredential(label, ttlSec) {
  const expiry = Math.floor(Date.now() / 1000) + (ttlSec || 3600);
  const username = `${expiry}:${label || 'anon'}`;
  const password = crypto.createHmac('sha1', config.turnSecret).update(username).digest('base64');
  turnServer.addUser(username, password);
  // limpa sozinho quando expira, pra não acumular usuário pra sempre
  setTimeout(() => { try { turnServer.removeUser(username); } catch (_) {} }, (ttlSec || 3600) * 1000 + 5000);
  return { username, password, expiresAt: expiry };
}

const dashboardClients = new Set();

function pushLog(kind, msg) {
  const line = { t: new Date().toISOString(), kind, msg };
  state.log.unshift(line);
  if (state.log.length > 300) state.log.length = 300;
  console.log(`[${kind}] ${msg}`);
  broadcastDashboard();
}

// ------------------------------------------------------------------
// 1) STUN/TURN embutido (node-turn)
// ------------------------------------------------------------------
const turnServer = new Turn({
  authMech: 'long-term',
  credentials: {
    [config.turnUser]: config.turnSecret,
  },
  listeningPort: TURN_PORT,
  minPort: Number(process.env.VAGALUN_TURN_MIN_PORT || 49152),
  maxPort: Number(process.env.VAGALUN_TURN_MAX_PORT || 49452),
  debugLevel: 'ERROR',
});

let mediaLayer = null; // declarado cedo — dashboardSnapshot() já roda antes do bloco de mídia começar de verdade
let relayManager = null; // idem — só existe quando MEDIA_ENABLED

try {
  turnServer.start();
  state.turnStatus = 'online';
  pushLog('turn', `STUN/TURN no ar na porta ${TURN_PORT} (usuário: ${config.turnUser})`);
} catch (err) {
  state.turnStatus = 'error';
  pushLog('turn', `falha ao subir TURN: ${err.message}`);
}

// node-turn não expõe contagem de sessões nativamente em todas as
// versões — mantemos um contador aproximado via eventos de log dele.
if (turnServer && typeof turnServer.on === 'function') {
  turnServer.on('allocation', () => {
    state.turnSessions += 1;
    broadcastDashboard();
  });
}

// ------------------------------------------------------------------
// Contagem real de bytes relayados, por sessão (username efêmero).
// A lib node-turn não emite evento nativo de "dado relayado" — todo o
// caminho de mídia (ChannelData) acontece dentro de dgram sockets
// internos que ela cria sozinha. Como este processo só usa UDP pro
// TURN (a mídia RTMP/FLV é TCP, tratada à parte pelo node-media-server),
// é seguro instrumentar globalmente o Socket.prototype.send do dgram:
// cada byte que sai por um socket UDP neste processo é relay de TURN.
// ------------------------------------------------------------------
(function instrumentRelayBytes() {
  const originalSend = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function (data, ...rest) {
    try {
      const len = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data));
      state.bytesRelayed += len;
      // tenta atribuir à sessão certa: cada allocation guarda o username
      // que autenticou aquela alocação (allocation.user.username)
      for (const key in turnServer.allocations) {
        const alloc = turnServer.allocations[key];
        if (alloc && alloc.sockets && alloc.sockets.includes(this)) {
          const uname = alloc.user && alloc.user.username;
          if (uname) state.relayCreditByUser[uname] = (state.relayCreditByUser[uname] || 0) + len;
          break;
        }
      }
    } catch (_) { /* nunca deixa a instrumentação derrubar o relay real */ }
    return originalSend.call(this, data, ...rest);
  };
})();

// ------------------------------------------------------------------
// 1b) Live streaming (RTMP ingest + HTTP-FLV delivery) — opcional
// ------------------------------------------------------------------
// TODO(tls-node): RTMP ingest e HTTP-FLV aqui rodam sem TLS (rtmp:// e
// http:// puro). Isso é o "último salto" node->espectador que fica sem
// criptografia própria enquanto TLS por node não for decidido — ver
// TODO(tls-node) mais completo perto de httpServer.listen(), mais abaixo.
// Debounce curto: se vários eventos de publish/donePublish chegarem em
// rajada (ex.: encoder tentando e falhando várias vezes seguidas), isso
// colapsa numa única chamada extra de heartbeat em vez de martelar o
// server central um heartbeat por evento.
let forcedHeartbeatTimer = null;
function forceImmediateHeartbeat() {
  clearTimeout(forcedHeartbeatTimer);
  forcedHeartbeatTimer = setTimeout(() => sendHeartbeat(), 250);
}

if (MEDIA_ENABLED) {
  mediaLayer = createMediaLayer({
    rtmpPort: MEDIA_RTMP_PORT,
    httpPort: MEDIA_HTTP_PORT,
    secret: config.mediaSecret,
    pushRequiresAuth: MEDIA_PUSH_REQUIRES_AUTH,
    onLog: (kind, msg) => pushLog(kind, msg),
    // sem isso, o server central só saberia que essa live começou/acabou
    // no próximo heartbeat periódico (até HEARTBEAT_INTERVAL_MS de
    // atraso) — inaceitável pra failover de "poucos segundos".
    onStreamChange: () => forceImmediateHeartbeat(),
  });
  mediaLayer.start()
    .then(() => {
      state.mediaStatus = 'online';
      pushLog('media', `RTMP ingest na porta ${MEDIA_RTMP_PORT}, HTTP-FLV na porta ${MEDIA_HTTP_PORT}${MEDIA_PUSH_REQUIRES_AUTH ? ' (transmitir exige auth_key assinado)' : ' (transmitir SEM autenticação — cuidado)'}`);
      broadcastDashboard();
    })
    .catch((err) => {
      state.mediaStatus = 'error';
      pushLog('media', `falha ao subir camada de mídia: ${err.message}`);
      broadcastDashboard();
    });
  // Relay: quando o server central detecta que essa live não tem mais
  // folga em quem já serve ela, ele manda (na resposta do heartbeat)
  // "puxe de tal URL e republique" — é o relayManager que executa isso
  // de fato (ver relay.js). Sem ffmpeg instalado, essa camada simplesmente
  // nunca ativa; publicar/assistir direto continua funcionando normal.
  relayManager = createRelayManager({
    localRtmpPort: MEDIA_RTMP_PORT,
    mediaSecret: config.mediaSecret,
    signStreamUrl,
    publicHost,
    onLog: (kind, msg) => pushLog(kind, msg),
  });
} else {
  pushLog('media', 'camada de live streaming desligada (VAGALUN_MEDIA_ENABLED=0)');
}

// ------------------------------------------------------------------
// 2) Signaling (WebSocket) — versão enxuta do sever/server.js,
//    focada só em: registrar nó, listar peers, repassar signal.
// ------------------------------------------------------------------
const httpServer = http.createServer(handleHttp);
const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });

function broadcastPeerList() {
  const list = Array.from(state.peers.keys());
  for (const [, info] of state.peers) {
    if (info.ws && info.ws.readyState === WebSocket.OPEN) {
      info.ws.send(JSON.stringify({ type: 'peers', peers: list.filter((id) => id !== info.nodeId) }));
    }
  }
}

wss.on('connection', (ws, req) => {
  // conexões do painel visual usam /ws?dash=1 — não entram na malha de nós
  const url = new URL(req.url, 'http://localhost');
  if (url.searchParams.get('dash') === '1') {
    dashboardClients.add(ws);
    ws.on('close', () => dashboardClients.delete(ws));
    sendDashboardSnapshot(ws);
    return;
  }

  let nodeId = null;
  const ip = req.socket.remoteAddress;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    if (msg.type === 'register') {
      nodeId = String(msg.nodeId || crypto.randomUUID()).slice(0, 128);
      state.peers.set(nodeId, { ws, nodeId, connectedAt: new Date().toISOString(), ip });
      // credencial efêmera por sessão (não o turnUser/turnSecret fixo) —
      // assim dá pra saber depois quantos bytes cada nodeId consumiu de relay
      const cred = issueEphemeralTurnCredential(nodeId, 3600);
      ws.send(JSON.stringify({
        type: 'registered',
        nodeId,
        turn: { url: `turn:${publicHost()}:${TURN_PORT}`, username: cred.username, credential: cred.password },
        stun: { url: `stun:${publicHost()}:${TURN_PORT}` },
      }));
      pushLog('signaling', `nó conectado: ${nodeId} (${ip})`);
      broadcastPeerList();
      return;
    }

    // repassa offer/answer/ice pro destinatário certo
    if (msg.type === 'signal' && msg.to) {
      const target = state.peers.get(msg.to);
      if (target && target.ws.readyState === WebSocket.OPEN) {
        target.ws.send(JSON.stringify({ type: 'signal', from: nodeId, data: msg.data }));
      }
      return;
    }
  });

  ws.on('close', () => {
    if (nodeId) {
      state.peers.delete(nodeId);
      pushLog('signaling', `nó desconectado: ${nodeId}`);
      broadcastPeerList();
    }
  });
});
state.signalingStatus = 'online';

function publicHost() {
  return process.env.VAGALUN_PUBLIC_HOST || 'SEU_IP_OU_DOMINIO';
}

// ------------------------------------------------------------------
// UPnP + probe de alcançabilidade real (via VPS) — decide se este nó
// pode se anunciar como TURN. Sem ngrok, sem serviço de terceiro: só
// abre porta sozinho quando dá (UPnP) e só se anuncia como TURN
// quando um teste de FORA (feito pela VPS) confirma que funciona.
// ------------------------------------------------------------------
async function checkNatAndReachability() {
  if (!DIRECTORY_URL) {
    // sem diretório configurado não tem quem faça o probe externo — o
    // nó ainda funciona localmente/em LAN, só não se anuncia via VPS.
    pushLog('nat', 'sem VAGALUN_DIRECTORY_URL configurado — pulando checagem de UPnP/alcance externo');
    return;
  }

  pushLog('nat', 'tentando abrir a porta do TURN no roteador via UPnP...');
  const upnp = await tryUpnpMap(TURN_PORT);
  if (upnp.ok) {
    state.natStatus = 'upnp-ok';
    pushLog('nat', `UPnP mapeou a porta ${TURN_PORT} com sucesso${upnp.externalHost ? ` (IP externo detectado: ${upnp.externalHost})` : ''}`);
  } else {
    state.natStatus = 'upnp-failed';
    pushLog('nat', `UPnP não conseguiu mapear a porta (${upnp.error || 'sem gateway UPnP encontrado'}) — seguindo pro teste de alcance mesmo assim, pode já estar aberta manualmente`);
  }
  broadcastDashboard();

  // pede pra VPS testar de fora, batendo STUN na porta pública
  const host = publicHost();
  if (host === 'SEU_IP_OU_DOMINIO') {
    state.natStatus = 'unreachable';
    state.turnCapable = false;
    pushLog('nat', 'VAGALUN_PUBLIC_HOST não configurado — não dá pra testar alcance nem anunciar TURN de verdade');
    broadcastDashboard();
    return;
  }

  try {
    const result = await probeViaDirectory(host, TURN_PORT);
    state.turnCapable = !!result.reachable;
    state.natStatus = state.turnCapable ? 'reachable' : 'unreachable';
    pushLog('nat', state.turnCapable
      ? `alcançável de fora — este nó vai se anunciar como TURN capaz (turnCapable=true)`
      : `NÃO alcançável de fora (provavelmente CGNAT ou porta fechada) — nó continua funcionando, mas só como signaling, sem TURN próprio`);
  } catch (err) {
    state.turnCapable = false;
    state.natStatus = 'unreachable';
    pushLog('nat', `falha ao testar alcance via VPS: ${err.message}`);
  }
  broadcastDashboard();

  // mesma lógica pra porta do RTMP (mídia), se a camada estiver ligada
  if (MEDIA_ENABLED) {
    pushLog('nat', 'tentando abrir a porta do RTMP no roteador via UPnP...');
    const upnpMedia = await tryUpnpMap(MEDIA_RTMP_PORT);
    if (upnpMedia.ok) {
      pushLog('nat', `UPnP mapeou a porta do RTMP (${MEDIA_RTMP_PORT}) com sucesso`);
    } else {
      pushLog('nat', `UPnP não conseguiu mapear a porta do RTMP (${upnpMedia.error || 'sem gateway UPnP'})`);
    }
    try {
      const resultMedia = await probeTcpViaDirectory(host, MEDIA_RTMP_PORT);
      state.mediaCapable = !!resultMedia.reachable;
      pushLog('media', state.mediaCapable
        ? 'RTMP alcançável de fora — este nó vai se anunciar como capaz de receber lives (mediaCapable=true)'
        : 'RTMP NÃO alcançável de fora — camada de mídia continua rodando localmente, mas não vai receber transmissão de fora');
    } catch (err) {
      state.mediaCapable = false;
      pushLog('media', `falha ao testar alcance do RTMP via VPS: ${err.message}`);
    }
    broadcastDashboard();
  }
}

function probeViaDirectory(host, port) {
  return probeGeneric('/directory/probe-turn', host, port);
}

function probeTcpViaDirectory(host, port) {
  return probeGeneric('/directory/probe-tcp', host, port);
}

function probeGeneric(routePath, host, port) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ host, port });
    const url = new URL(routePath, DIRECTORY_URL);
    const lib = url.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 8000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout no probe')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ------------------------------------------------------------------
// Medição CRUA de carga (CPU) — nunca um "score" inventado aqui, só o
// número observado. O backend é quem decide o que fazer com isso.
// os.loadavg() no Windows sempre retorna [0,0,0] (não suportado pela
// libuv nesse SO) — nesse caso caímos pro cálculo manual via os.cpus(),
// comparando os acumuladores de tempo ocioso entre duas leituras.
// ------------------------------------------------------------------
let _prevCpuTimes = null;
function readCpuLoadPercent() {
  if (process.platform !== 'win32') {
    const load1 = os.loadavg()[0];
    const cores = os.cpus().length || 1;
    return Math.min(100, Math.round((load1 / cores) * 100));
  }
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  if (!_prevCpuTimes) { _prevCpuTimes = { idle, total }; return 0; }
  const idleDelta = idle - _prevCpuTimes.idle;
  const totalDelta = total - _prevCpuTimes.total;
  _prevCpuTimes = { idle, total };
  if (totalDelta <= 0) return 0;
  return Math.min(100, Math.round(100 - (idleDelta / totalDelta) * 100));
}

// ------------------------------------------------------------------
// Heartbeat pro diretório (VPS) — é isso que faz o celular achar este
// PC sozinho, sem precisar de ninguém digitar IP na mão. Sem
// VAGALUN_DIRECTORY_URL configurado, esse bloco todo fica desligado
// e o nó funciona normalmente do mesmo jeito (só não é "descobrível").
// ------------------------------------------------------------------
function sendHeartbeat() {
  if (!DIRECTORY_URL) return;
  const nodeId = config.nodeName + '-' + config.turnUser;
  const seq = Date.now();
  const payload = JSON.stringify({
    nodeId,
    publicHost: publicHost(),
    httpPort: HTTP_PORT,
    turnPort: TURN_PORT,
    turnUser: config.turnUser,
    turnSecret: config.turnSecret,
    turnCapable: state.turnCapable,
    mediaCapable: MEDIA_ENABLED && state.mediaCapable,
    mediaRtmpPort: MEDIA_RTMP_PORT,
    mediaHttpPort: MEDIA_HTTP_PORT,
    // faltava antes: sem isso o backend não consegue gerar URL de live
    // assinada pra esse nó (sign = md5(streamPath-exp-mediaSecret))
    mediaSecret: config.mediaSecret,
    // crédito de relay TURN acumulado desde o último heartbeat — o
    // backend soma isso no ledger de pontos (turnRelayCredit) e zera
    // a contagem local depois de confirmar recebimento
    turnRelayBytesSinceLastBeat: state.bytesRelayed - (state._bytesRelayedReportedSoFar || 0),
    liveBytesSinceLastBeat: (mediaLayer && typeof mediaLayer.bytesServedTotal === 'number')
      ? mediaLayer.bytesServedTotal - (state._liveBytesReportedSoFar || 0)
      : 0,
    // sinais crus de capacidade — o node NUNCA declara "aguento X lives",
    // só manda o que está medindo agora. Quem decide capacidade/score é
    // o backend, olhando o histórico disso ao longo do tempo.
    cpuLoadPercent: readCpuLoadPercent(),
    activeLiveCount: mediaLayer ? mediaLayer.getHealthSnapshot().activeLiveCount : 0,
    liveStreamsHealth: mediaLayer ? mediaLayer.getHealthSnapshot().streams : [],
    // identidade + prova de posse — sem isso o backend ainda registra o
    // nó no diretório normalmente, só não credita pontos de banda
    pubkey: wallet.publicKey,
    // wallet PESSOAL (Phantom) linkada via painel — pra onde o backend
    // deve montar a folha da epoch tree. null enquanto o dono não linkar
    // ainda (o backend trata null como "sem payout configurado", não erro).
    ownerPubkey: ownerLink.getOwnerPubkey(),
    seq,
    sig: signHeartbeat(nodeId, seq),
  });
  const url = new URL('/directory/heartbeat', DIRECTORY_URL);
  const lib = url.protocol === 'https:' ? require('https') : require('http');
  const req = lib.request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    timeout: 8000,
  }, (res) => {
    let raw = '';
    res.on('data', (chunk) => { raw += chunk; });
    res.on('end', () => {
      if (res.statusCode === 200) {
        if (state.directoryStatus !== 'online') pushLog('directory', `registrado no diretório (${DIRECTORY_URL})`);
        state.directoryStatus = 'online';
        // só marca como "já reportado" depois do backend confirmar (200) —
        // se falhar, o próximo heartbeat tenta reportar esses bytes de novo
        state._bytesRelayedReportedSoFar = state.bytesRelayed;
        if (mediaLayer && typeof mediaLayer.bytesServedTotal === 'number') {
          state._liveBytesReportedSoFar = mediaLayer.bytesServedTotal;
        }
        // "vire relay de tal live" — vem embutido na própria resposta do
        // heartbeat (ver ensureRelayCapacity no server central).
        if (relayManager) {
          try {
            const parsed = JSON.parse(raw || '{}');
            relayManager.reconcile(parsed.relayAssignments || []);
          } catch (_) { /* resposta sem corpo JSON válido: ignora, tenta de novo no próximo heartbeat */ }
        }
      } else {
        state.directoryStatus = 'error';
        pushLog('directory', `heartbeat rejeitado (status ${res.statusCode})`);
      }
      broadcastDashboard();
    });
  });
  req.on('timeout', () => req.destroy());
  req.on('error', (err) => {
    if (state.directoryStatus !== 'error') pushLog('directory', `falha no heartbeat: ${err.message}`);
    state.directoryStatus = 'error';
    broadcastDashboard();
  });
  req.write(payload);
  req.end();
}

function deregisterFromDirectory() {
  if (!DIRECTORY_URL) return;
  try {
    const payload = JSON.stringify({ nodeId: config.nodeName + '-' + config.turnUser });
    const url = new URL('/directory/heartbeat', DIRECTORY_URL);
    const lib = url.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request(url, { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 3000 });
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch (_) {}
}

if (DIRECTORY_URL) {
  // primeiro checa UPnP/alcance, só manda o primeiro heartbeat depois
  // (senão ele iria pro diretório com turnCapable ainda indefinido)
  checkNatAndReachability().finally(() => {
    sendHeartbeat();
    setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  });
  // reavalia alcance de tempos em tempos — rede doméstica muda de IP,
  // roteador reinicia, etc. Bem mais espaçado que o heartbeat normal.
  setInterval(checkNatAndReachability, Number(process.env.VAGALUN_NAT_RECHECK_MS || 10 * 60_000));
}

// ------------------------------------------------------------------
// 3) Painel visual (serve public/ + snapshot em JSON + push via WS)
// ------------------------------------------------------------------
function dashboardSnapshot() {
  return {
    type: 'snapshot',
    nodeName: config.nodeName,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    turnStatus: state.turnStatus,
    signalingStatus: state.signalingStatus,
    directoryStatus: state.directoryStatus,
    directoryUrl: DIRECTORY_URL,
    natStatus: state.natStatus,
    turnCapable: state.turnCapable,
    mediaStatus: state.mediaStatus,
    mediaCapable: state.mediaCapable,
    mediaRtmpPort: MEDIA_RTMP_PORT,
    mediaHttpPort: MEDIA_HTTP_PORT,
    liveStreams: mediaLayer ? [...mediaLayer.liveStreams.entries()].map(([path, info]) => ({ path, ...info })) : [],
    exampleUrls: mediaLayer ? {
      push: signStreamUrl({ host: publicHost(), rtmpPort: MEDIA_RTMP_PORT, httpPort: MEDIA_HTTP_PORT, secret: config.mediaSecret, streamPath: '/live/teste', kind: 'push' }),
      pull: signStreamUrl({ host: publicHost(), rtmpPort: MEDIA_RTMP_PORT, httpPort: MEDIA_HTTP_PORT, secret: config.mediaSecret, streamPath: '/live/teste', kind: 'pull' }),
    } : null,
    turnPort: TURN_PORT,
    httpPort: HTTP_PORT,
    turnUser: config.turnUser,
    walletPubkey: wallet.publicKey,
    ownerPubkey: ownerLink.getOwnerPubkey(),
    programId: PROGRAM_ID,
    solanaCluster: SOLANA_CLUSTER,
    bytesRelayed: state.bytesRelayed,               // total de relay TURN desde que o processo subiu
    liveBytesServed: mediaLayer ? mediaLayer.bytesServedTotal : 0, // idem, pra live (RTMP+FLV)
    peers: Array.from(state.peers.values()).map((p) => ({ nodeId: p.nodeId, ip: p.ip, connectedAt: p.connectedAt })),
    peerCount: state.peers.size,
    turnSessions: state.turnSessions,
    log: state.log.slice(0, 50),
  };
}

function sendDashboardSnapshot(ws) {
  try { ws.send(JSON.stringify(dashboardSnapshot())); } catch (_) {}
}

function broadcastDashboard() {
  const payload = JSON.stringify(dashboardSnapshot());
  for (const ws of dashboardClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}
setInterval(broadcastDashboard, 3000);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function handleHttp(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (ownerLink.handleOwnerLinkRoutes(req, res, url, readBody)) return;

  if (url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(dashboardSnapshot()));
    return;
  }

  if (url.pathname === '/api/rotate-secret' && req.method === 'POST') {
    if (ADMIN_TOKEN && req.headers['x-admin-token'] !== ADMIN_TOKEN) {
      res.writeHead(401); res.end('unauthorized'); return;
    }
    config.turnSecret = crypto.randomBytes(9).toString('base64url');
    try { fs.writeFileSync(configFile, JSON.stringify(config, null, 2)); } catch (_) {}
    turnServer.stop();
    turnServer.credentials = { [config.turnUser]: config.turnSecret };
    turnServer.start();
    pushLog('turn', 'segredo do TURN rotacionado');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === '/api/wallet/balance') {
    // só leitura — mostra se o faucet/backend já creditou SOL nessa wallet
    // efêmera (rede = SOLANA_CLUSTER, não fixo em 'devnet').
    solanaConnection.getBalance(new PublicKey(wallet.publicKey))
      .then((lamports) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pubkey: wallet.publicKey, lamports, sol: lamports / 1e9, network: SOLANA_CLUSTER }));
      })
      .catch((err) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pubkey: wallet.publicKey, error: err.message }));
      });
    return;
  }

  if (url.pathname === '/api/turn-credential') {
    const label = (url.searchParams.get('label') || 'anon').slice(0, 64);
    const cred = issueEphemeralTurnCredential(label, 3600);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      urls: [`turn:${publicHost()}:${TURN_PORT}`, `stun:${publicHost()}:${TURN_PORT}`],
      username: cred.username,
      credential: cred.password,
      expiresAt: cred.expiresAt,
    }));
    return;
  }

  // arquivos estáticos do painel
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(PUBLIC_DIR, path.normalize(filePath).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// TODO(tls-node): terminação TLS por PC node não implementada.
// Este httpServer serve, sem TLS, tanto o painel (HTTP_PORT) quanto o
// signaling (/ws no mesmo HTTP_PORT) — e o mediaLayer acima serve RTMP+
// HTTP-FLV também sem TLS, em MEDIA_HTTP_PORT/MEDIA_RTMP_PORT. Decisão
// pendente entre:
//   (a) domínio próprio por node + DNS-01 centralizado na VPS (wildcard)
//   (b) self-signed + fingerprint pinning via /directory/nodes assinado
//       (o backend na VPS já tem domínio+cert normal, então dá pra
//       assinar o fingerprint do node ali e o client validar contra isso)
//   (c) CA interna (step-ca) com root distribuída nos clients
// signaling node->VPS (DIRECTORY_URL) já é seguro (client-side, https/wss
// normal); o que falta é o sentido inverso: peer/espectador -> este node.
// Revisar depois de: heartbeat, register, SSRF, rate limit (já feitos).
httpServer.listen(HTTP_PORT, () => {
  pushLog('http', `painel visual em http://localhost:${HTTP_PORT}`);
  pushLog('http', `signaling (WebSocket) em ws://localhost:${HTTP_PORT}/ws`);
  // Simplificado: nada de janela nativa (webview-bin) nem tentativa de
  // abrir navegador sozinho — isso é o que ficava abrindo/fechando em
  // servidores sem WebView2/WebKitGTK (ex.: Windows Server sem Runtime).
  // O painel fica disponível só em localhost; quem quiser ver, acessa
  // manualmente (ou via túnel/RDP) http://localhost:PORTA.
  if (process.env.VAGALUN_NO_OPEN !== '1' && process.platform !== 'win32' && !process.env.VAGALUN_HEADLESS) {
    // fora de servidor (uso normal em desktop), ainda tenta abrir no
    // navegador padrão do usuário — bem mais simples que webview.
    const { exec } = require('child_process');
    const cmd = process.platform === 'darwin' ? `open "http://localhost:${HTTP_PORT}"` : `xdg-open "http://localhost:${HTTP_PORT}"`;
    exec(cmd, () => {});
  }
});

process.on('SIGINT', () => {
  pushLog('sistema', 'encerrando nó de PC...');
  deregisterFromDirectory();
  try { turnServer.stop(); } catch (_) {}
  if (relayManager) { try { relayManager.stopAll(); } catch (_) {} }
  if (mediaLayer) { try { mediaLayer.stop(); } catch (_) {} }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});