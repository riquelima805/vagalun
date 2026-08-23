#!/usr/bin/env node
// vagalun-node.js — "nó semente" de armazenamento, em Node.js puro.
//
// Reimplementação fiel, em JS, do protocolo TCP que o app Android fala
// (ver app/src/main/java/.../network/ShardProtocol.kt, ShardServer.kt e
// ShardRequestHandler.kt). Mesmo wire format usado pelo gateway pra falar
// com nós "TCP direto" (sever/gateway/shardTransport.js):
//
//   frame = [4 bytes tamanho, big-endian][N bytes payload]
//   toda mensagem começa com um frame JSON (o "header"); operações que
//   devolvem bytes (get / get_range) mandam um segundo frame binário depois.
//
// Por que isso existe: a rede foi desenhada pra rodar em celulares Android,
// mas nesta fase inicial não dá pra manter um aparelho ligado 24h. Este
// script faz o mesmo papel de um ShardServer.kt — guarda shards em disco,
// responde put/get/get_range/delete/challenge/status — só que rodando como
// processo Node na própria VPS que já hospeda o gateway. Pro resto da rede
// (gateway, publisher, outros nós) ele é indistinguível de um nó real: fala
// o mesmo protocolo, guarda os mesmos bytes cifrados, sem saber o que
// contêm (a criptografia ponta a ponta continua acontecendo no dispositivo
// de origem, nunca aqui).
//
// Limitação honesta: é UM nó, controlado por você, rodando na mesma
// infraestrutura do gateway — ajuda a rede a funcionar (redundância extra
// nos primeiros arquivos, sem depender só de celulares intermitentes), mas
// não é descentralização de verdade sozinho. É um item de bootstrap
// (o roadmap já previa "nós semente"), não o estado final.
//
// USO:
//   NODE_ID=seed-1 PORT=9500 DATA_DIR=./node-data \
//   CAPACITY_BYTES=5368709120 \
//   GATEWAY_ADMIN_URL=http://127.0.0.1:8788 \
//   GATEWAY_ADMIN_TOKEN=seu-token \
//   GATEWAY_HOST_FOR_PEERS=127.0.0.1 \
//   SIGNALING_URL=ws://127.0.0.1:8787 \
//     node vagalun-node.js
//
// SIGNALING_URL (opcional): se definida, este nó também se conecta ao
// signaling (sever/server.js) via WebSocket e se registra como NODE_ID —
// exatamente como o app Android faz. Isso faz o nó aparecer em GET /nodes,
// que é o que sever/hosting/server.js usa pra decidir se há nó disponível
// pra publicar (ver "hasRelay"/getOnlineRelayNodeIds). Sem SIGNALING_URL,
// o nó continua funcionando só via TCP direto (GATEWAY_NODE_HOST/PORT no
// hosting), o que também é válido — SIGNALING_URL é só mais um caminho.
// Requer o pacote "ws" instalado (já é dependência do sever/, ver package.json).
//
// Todas as env vars têm default sensato pra rodar tudo numa VPS só (veja
// abaixo). Rode com pm2 ou systemd pra ficar de pé 24h (exemplos no final
// deste arquivo, em comentário).

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');
let WebSocket = null;
try { WebSocket = require('ws'); } catch (e) { /* ver aviso no boot, mais abaixo */ }

// ---------- configuração ----------
const NODE_ID = process.env.NODE_ID || 'seed-1';
const PORT = parseInt(process.env.PORT || '9500', 10);
const DATA_DIR = path.resolve(process.env.DATA_DIR || './node-data');
const CAPACITY_BYTES = parseInt(process.env.CAPACITY_BYTES || String(5 * 1024 * 1024 * 1024), 10); // 5 GB default
const GATEWAY_ADMIN_URL = process.env.GATEWAY_ADMIN_URL || 'http://127.0.0.1:8788';
const GATEWAY_ADMIN_TOKEN = process.env.GATEWAY_ADMIN_TOKEN || null;
// Host que o GATEWAY deve usar pra alcançar este nó. Se os dois processos
// rodam na mesma VPS, 127.0.0.1 é o certo — não precisa expor a porta do
// nó pra internet, só o gateway (que já é HTTP público) precisa falar com ele.
const GATEWAY_HOST_FOR_PEERS = process.env.GATEWAY_HOST_FOR_PEERS || '127.0.0.1';
// URL ws(s):// do signaling (sever/server.js). Se configurada, este nó também
// se registra lá — igual o app Android faz — e passa a aparecer em GET /nodes,
// que é o que o hosting-platform (sever/hosting/server.js) usa pra decidir se
// tem nó disponível pra publicar (ver getOnlineRelayNodeIds/hasRelay). Sem
// isso, o nó só existe pro gateway via TCP direto (GATEWAY_NODE_HOST/PORT),
// que também funciona, mas não conta como "nó/celular conectado ao signaling".
const SIGNALING_URL = process.env.SIGNALING_URL || null;

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- wire protocol (mesmo formato do shardTransport.js) ----------
function writeFrame(socket, buf) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  socket.write(len);
  socket.write(buf);
}
function writeJson(socket, obj) {
  writeFrame(socket, Buffer.from(JSON.stringify(obj), 'utf8'));
}
class FrameReader {
  constructor(socket) {
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    socket.on('data', (chunk) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      this._drain();
    });
  }
  _drain() {
    while (this.waiters.length && this.buf.length >= this.waiters[0].need) {
      const { need, resolve } = this.waiters.shift();
      resolve(this.buf.subarray(0, need));
      this.buf = this.buf.subarray(need);
    }
  }
  readBytes(n) {
    return new Promise((resolve) => {
      this.waiters.push({ need: n, resolve });
      this._drain();
    });
  }
  async readFrame(maxSize = 64 * 1024 * 1024) {
    const lenBuf = await this.readBytes(4);
    const size = lenBuf.readUInt32BE(0);
    if (size < 0 || size > maxSize) throw new Error(`frame de tamanho inválido: ${size}`);
    return this.readBytes(size);
  }
  async readJson() {
    const bytes = await this.readFrame(1024 * 1024);
    return JSON.parse(bytes.toString('utf8'));
  }
}

// ---------- armazenamento em disco (equivalente a ShardRequestHandler.kt) ----------
function shardFile(shardKey) {
  const safe = String(shardKey).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(DATA_DIR, `${safe}.shard`);
}
function usedBytes() {
  let total = 0;
  for (const name of fs.readdirSync(DATA_DIR)) {
    try { total += fs.statSync(path.join(DATA_DIR, name)).size; } catch {}
  }
  return total;
}

function handlePut(shardKey, payload) {
  if (usedBytes() + payload.length > CAPACITY_BYTES) {
    return { ok: false, error: 'capacidade insuficiente neste nó (cota configurada)' };
  }
  fs.writeFileSync(shardFile(shardKey), payload);
  return { ok: true, size: payload.length };
}
function handleGet(shardKey) {
  const f = shardFile(shardKey);
  if (!fs.existsSync(f)) return [{ ok: false, error: 'shard não encontrado' }, null];
  return [{ ok: true }, fs.readFileSync(f)];
}
function handleGetRange(shardKey, offset, length) {
  const f = shardFile(shardKey);
  if (!fs.existsSync(f)) return [{ ok: false, error: 'shard não encontrado' }, null];
  const fileLen = fs.statSync(f).size;
  if (offset < 0 || offset >= fileLen) return [{ ok: false, error: 'offset fora do shard' }, null];
  const actualLength = Math.min(length, fileLen - offset);
  const fd = fs.openSync(f, 'r');
  const buf = Buffer.alloc(actualLength);
  fs.readSync(fd, buf, 0, actualLength, offset);
  fs.closeSync(fd);
  return [{ ok: true, offset, length: actualLength }, buf];
}
function handleDelete(shardKey) {
  const f = shardFile(shardKey);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  return { ok: true };
}
function handleChallenge(shardKey, nonce) {
  const f = shardFile(shardKey);
  if (!fs.existsSync(f)) return { ok: false, error: 'shard não encontrado' };
  const digest = crypto.createHash('sha256');
  digest.update(fs.readFileSync(f));
  digest.update(String(nonce || ''));
  return { ok: true, proof: digest.digest('hex') };
}
function handleStatus() {
  const used = usedBytes();
  return {
    nodeId: NODE_ID,
    capacityBytes: CAPACITY_BYTES,
    usedBytes: used,
    freeBytes: Math.max(CAPACITY_BYTES - used, 0),
  };
}

// ---------- servidor TCP ----------
const server = net.createServer((socket) => {
  const reader = new FrameReader(socket);
  (async () => {
    // um nó real aceita várias requisições na mesma conexão? o app Android
    // fecha a conexão a cada request (ver ShardServer.kt: socket.use { }),
    // então fazemos o mesmo: 1 header (+ payload opcional) por conexão.
    const header = await reader.readJson();
    switch (header.op) {
      case 'put': {
        const payload = await reader.readFrame();
        writeJson(socket, handlePut(header.shardKey, payload));
        break;
      }
      case 'get': {
        const [resp, payload] = handleGet(header.shardKey);
        writeJson(socket, resp);
        if (resp.ok && payload) writeFrame(socket, payload);
        break;
      }
      case 'get_range': {
        const [resp, payload] = handleGetRange(header.shardKey, header.offset, header.length);
        writeJson(socket, resp);
        if (resp.ok && payload) writeFrame(socket, payload);
        break;
      }
      case 'delete':
        writeJson(socket, handleDelete(header.shardKey));
        break;
      case 'challenge':
        writeJson(socket, handleChallenge(header.shardKey, header.nonce));
        break;
      case 'status':
        writeJson(socket, handleStatus());
        break;
      default:
        writeJson(socket, { ok: false, error: 'op desconhecida' });
    }
    socket.end();
  })().catch(() => socket.destroy());
});

server.listen(PORT, () => {
  console.log(`[${NODE_ID}] nó semente TCP escutando em :${PORT}, guardando shards em ${DATA_DIR} (capacidade ${CAPACITY_BYTES} bytes)`);
  registerWithGateway();
  connectSignaling();
});

// ---------- auto-registro no gateway (POST /admin/peers) ----------
function registerWithGateway(attempt = 1) {
  const url = new URL('/admin/peers', GATEWAY_ADMIN_URL);
  const body = JSON.stringify({ nodeId: NODE_ID, host: GATEWAY_HOST_FOR_PEERS, port: PORT });
  const mod = url.protocol === 'https:' ? https : http;
  const req = mod.request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...(GATEWAY_ADMIN_TOKEN ? { 'X-Admin-Token': GATEWAY_ADMIN_TOKEN } : {}),
    },
  }, (res) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      console.log(`[${NODE_ID}] registrado no gateway (${GATEWAY_ADMIN_URL}) como ${GATEWAY_HOST_FOR_PEERS}:${PORT}`);
    } else {
      console.error(`[${NODE_ID}] gateway respondeu ${res.statusCode} ao registrar peer — vou tentar de novo`);
      retryRegister(attempt);
    }
    res.resume();
  });
  req.on('error', (e) => {
    console.error(`[${NODE_ID}] falha ao registrar no gateway: ${e.message}`);
    retryRegister(attempt);
  });
  req.write(body);
  req.end();
}
function retryRegister(attempt) {
  const delayMs = Math.min(30000, 1000 * 2 ** attempt);
  setTimeout(() => registerWithGateway(attempt + 1), delayMs);
}

// ---------- conexão com o signaling (wss), igual ao app Android ----------
// Mesmo protocolo de sever/gateway/relayTransport.js: entra como um nodeId
// registrado (`type: 'register'`) e passa a esperar mensagens `relay` (que
// carregam o mesmo header { op, shardKey, ... } do protocolo TCP) chegarem,
// respondendo com `relay_response`. Assim este processo funciona tanto por
// TCP direto (porta PORT, gateway -> shardTransport.js) quanto por relay via
// signaling — igual um celular real faria quando está atrás de NAT.
let signalingWs = null;
let signalingAttempt = 0;
let signalingClosedByUs = false;

function connectSignaling() {
  if (!SIGNALING_URL) return;
  if (!WebSocket) {
    console.error(`[${NODE_ID}] SIGNALING_URL configurada, mas o pacote "ws" não está instalado (rode: npm install ws). Pulando conexão com o signaling.`);
    return;
  }
  const ws = new WebSocket(SIGNALING_URL);
  signalingWs = ws;

  ws.on('open', () => {
    signalingAttempt = 0;
    ws.send(JSON.stringify({ type: 'register', nodeId: NODE_ID }));
    console.log(`[${NODE_ID}] conectado ao signaling (${SIGNALING_URL}) via WebSocket, registrado como "${NODE_ID}"`);
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (msg.type !== 'relay') return; // só nos importa pedido de shard (put/get/...)

    const header = msg.header || {};
    let respHeader;
    let payloadOut = null;
    try {
      switch (header.op) {
        case 'put': {
          const payload = msg.payloadBase64 ? Buffer.from(msg.payloadBase64, 'base64') : Buffer.alloc(0);
          respHeader = handlePut(header.shardKey, payload);
          break;
        }
        case 'get': {
          const [resp, payload] = handleGet(header.shardKey);
          respHeader = resp;
          if (resp.ok && payload) payloadOut = payload;
          break;
        }
        case 'get_range': {
          const [resp, payload] = handleGetRange(header.shardKey, header.offset, header.length);
          respHeader = resp;
          if (resp.ok && payload) payloadOut = payload;
          break;
        }
        case 'delete':
          respHeader = handleDelete(header.shardKey);
          break;
        case 'challenge':
          respHeader = handleChallenge(header.shardKey, header.nonce);
          break;
        case 'status':
          respHeader = handleStatus();
          break;
        default:
          respHeader = { ok: false, error: 'op desconhecida' };
      }
    } catch (e) {
      respHeader = { ok: false, error: e.message };
    }

    const out = { type: 'relay_response', to: msg.from, requestId: msg.requestId, header: respHeader };
    if (payloadOut) out.payloadBase64 = payloadOut.toString('base64');
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(out));
  });

  ws.on('close', () => {
    signalingWs = null;
    if (signalingClosedByUs) return;
    console.error(`[${NODE_ID}] conexão com o signaling caiu — tentando reconectar...`);
    retryConnectSignaling();
  });

  ws.on('error', (e) => {
    console.error(`[${NODE_ID}] erro na conexão com o signaling: ${e.message}`);
  });
}

function retryConnectSignaling() {
  const delayMs = Math.min(30000, 1000 * 2 ** signalingAttempt);
  signalingAttempt += 1;
  setTimeout(connectSignaling, delayMs);
}

process.on('SIGINT', () => {
  console.log(`\n[${NODE_ID}] encerrando...`);
  signalingClosedByUs = true;
  if (signalingWs) signalingWs.close();
  server.close(() => process.exit(0));
});
process.on('SIGTERM', () => {
  signalingClosedByUs = true;
  if (signalingWs) signalingWs.close();
  server.close(() => process.exit(0));
});

/*
---------------------------------------------------------------------------
DEIXAR RODANDO 24H NA VPS
---------------------------------------------------------------------------

Opção A — pm2 (mais simples se o gateway já roda com pm2):

  pm2 start vagalun-node.js --name vagalun-seed-1 \
    --env NODE_ID=seed-1 --env PORT=9500 --env DATA_DIR=/var/vagalun/seed-1 \
    --env CAPACITY_BYTES=5368709120 \
    --env GATEWAY_ADMIN_URL=http://127.0.0.1:8788 \
    --env GATEWAY_ADMIN_TOKEN=seu-token
  pm2 save

Opção B — systemd (/etc/systemd/system/vagalun-seed-1.service):

  [Unit]
  Description=Vagalun seed node 1
  After=network.target

  [Service]
  Type=simple
  Environment=NODE_ID=seed-1
  Environment=PORT=9500
  Environment=DATA_DIR=/var/vagalun/seed-1
  Environment=CAPACITY_BYTES=5368709120
  Environment=GATEWAY_ADMIN_URL=http://127.0.0.1:8788
  Environment=GATEWAY_ADMIN_TOKEN=seu-token
  ExecStart=/usr/bin/node /caminho/para/vagalun-node.js
  Restart=always
  RestartSec=5
  User=vagalun

  [Install]
  WantedBy=multi-user.target

  sudo systemctl enable --now vagalun-seed-1

Depois de rodando, dá pra conferir a saúde do nó direto:
  node -e "require('./sever/gateway/shardTransport').status('127.0.0.1', 9500).then(console.log)"
---------------------------------------------------------------------------
*/
