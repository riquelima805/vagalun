'use strict';

const crypto = require('crypto');
const NodeMediaServer = require('node-media-server');

/**
 * Camada de live streaming do nó de PC. Faz o nó aceitar RTMP ingest
 * (quem transmite) e servir HTTP-FLV (quem assiste) — os mesmos dois
 * protocolos que o app de live (PHP) já sabe montar URL pra consumir
 * (RTMP push + HTTP-FLV/HLS pull, com auth_key assinado).
 *
 * Esquema de assinatura usado (nativo do node-media-server v4):
 *   sign = md5(streamPath + "-" + exp + "-" + secret)
 *   URL  = .../streamPath?sign=exp-sign
 *
 * Isso é o "protocolo de referência" que o app PHP deve seguir do lado
 * dele (escrevendo uma PrivateKey_vagalun() no mesmo formato) pra
 * autenticar contra qualquer nó de PC que estiver rodando essa camada.
 */
function createMediaLayer({ rtmpPort, httpPort, secret, pushRequiresAuth, onLog, onStreamChange }) {
  const config = {
    rtmp: { port: rtmpPort, chunk_size: 60000, gop_cache: true, ping: 30, ping_timeout: 60 },
    http: { port: httpPort, allow_origin: '*' },
    auth: {
      publish: pushRequiresAuth,
      play: false, // assistir é livre — só quem PUBLICA (transmite) precisa de chave assinada
      secret,
    },
  };

  const nms = new NodeMediaServer(config);
  const liveStreams = new Map(); // streamPath -> { startedAt, ip }

  // ------------------------------------------------------------------
  // Contagem de bytes servidos (ingest RTMP + egress HTTP-FLV), pra
  // alimentar liveBytesSinceLastBeat no heartbeat. node-media-server
  // não conta isso nativamente, mas cada sessão carrega um socket TCP
  // de verdade (net.Socket ou http.ServerResponse), que o próprio Node
  // já conta sozinho via bytesRead/bytesWritten — só precisamos somar
  // na hora que a sessão fecha (senão perderíamos o total quando o
  // socket já foi destruído).
  // ------------------------------------------------------------------
  let bytesServedTotal = 0; // soma de sessões já ENCERRADAS
  const activeSockets = new Set(); // sockets de sessões ainda em andamento

  // ------------------------------------------------------------------
  // Saúde por live ativa — pra alimentar o score de capacidade no
  // backend. Não é o node "se autoavaliando": é uma medição crua de
  // bitrate real de saída (bytesWritten/segundo) por streamPath, que o
  // backend depois cruza com histórico pra decidir se esse nó aguenta
  // mais uma live ou já está degradando as que tem.
  // ------------------------------------------------------------------
  const streamHealth = new Map(); // streamPath -> { lastBytesWritten, lastCheckAt, kbps }

  function socketOf(session) {
    return session.socket || (session.res && (session.res.socket || session.res._socket)) || null;
  }

  function currentTotal() {
    // total encerrado + o que as sessões ainda ao vivo já acumularam
    // (senão uma live de horas ficaria em 0 até ela terminar)
    let live = 0;
    for (const sock of activeSockets) {
      live += (sock.bytesRead || 0) + (sock.bytesWritten || 0);
    }
    return bytesServedTotal + live;
  }

  // A cada 5s, mede o bitrate real de saída de cada live publicando
  // (soma de todos os espectadores daquele streamPath), usando o
  // contador nativo bytesWritten do socket — não é estimativa.
  const healthTimer = setInterval(() => {
    for (const [streamPath, info] of liveStreams.entries()) {
      const sockets = [...activeSockets].filter((s) => info.sockets && info.sockets.has(s));
      const totalBytesNow = sockets.reduce((sum, s) => sum + (s.bytesWritten || 0), 0);
      const prev = streamHealth.get(streamPath);
      const now = Date.now();
      const kbps = prev ? Math.max(0, ((totalBytesNow - prev.lastBytesWritten) * 8) / 1024 / ((now - prev.lastCheckAt) / 1000)) : 0;
      streamHealth.set(streamPath, { lastBytesWritten: totalBytesNow, lastCheckAt: now, kbps });
    }
    // limpa lives que já encerraram
    for (const streamPath of streamHealth.keys()) {
      if (!liveStreams.has(streamPath)) streamHealth.delete(streamPath);
    }
  }, 5000);
  healthTimer.unref?.();

  nms.on('prePublish', (session) => {
    onLog('media', `tentativa de transmissão: ${session.streamPath} (${session.ip})`);
  });
  nms.on('postPublish', (session) => {
    liveStreams.set(session.streamPath, { startedAt: new Date().toISOString(), ip: session.ip, sockets: new Set() });
    const sock = socketOf(session);
    if (sock) activeSockets.add(sock);
    onLog('media', `AO VIVO: ${session.streamPath} (${session.ip})`);
    // avisa na hora — sem isso o server central só saberia dessa live no
    // próximo heartbeat periódico (até 20s de atraso), o que é inaceitável
    // pra failover de "poucos segundos" quando o publisher migra de node.
    onStreamChange?.('started', session.streamPath);
  });
  nms.on('donePublish', (session) => {
    liveStreams.delete(session.streamPath);
    const sock = socketOf(session);
    if (sock) {
      bytesServedTotal += (sock.bytesRead || 0) + (sock.bytesWritten || 0);
      activeSockets.delete(sock);
    }
    onLog('media', `encerrou: ${session.streamPath}`);
    onStreamChange?.('ended', session.streamPath);
  });
  nms.on('postPlay', (session) => {
    const sock = socketOf(session);
    if (sock) {
      activeSockets.add(sock);
      const info = liveStreams.get(session.streamPath);
      if (info) info.sockets.add(sock);
    }
  });
  nms.on('donePlay', (session) => {
    const sock = socketOf(session);
    if (sock) {
      bytesServedTotal += (sock.bytesWritten || 0);
      activeSockets.delete(sock);
      const info = liveStreams.get(session.streamPath);
      if (info) info.sockets.delete(sock);
    }
  });

  return {
    nms,
    liveStreams,
    get bytesServedTotal() { return currentTotal(); },
    // snapshot cru pro heartbeat: quantas lives ativas + bitrate real de
    // cada uma (kbps) — o backend decide o que fazer com isso, o node
    // só mede e reporta.
    getHealthSnapshot() {
      return {
        activeLiveCount: liveStreams.size,
        streams: [...streamHealth.entries()].map(([streamPath, h]) => ({ streamPath, kbps: Math.round(h.kbps) })),
      };
    },
    start() { return nms.run(); },
    stop() { return nms.stop(); },
  };
}

/**
 * Gera uma URL de push (RTMP, pra transmitir) ou pull (HTTP-FLV, pra
 * assistir) já assinada — útil pro painel mostrar um exemplo pronto
 * pra testar com OBS/ffmpeg, e é exatamente a fórmula que o backend
 * PHP precisa reproduzir do lado dele.
 */
function signStreamUrl({ host, rtmpPort, httpPort, secret, streamPath, ttlSec = 3600, kind }) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const hash = crypto.createHash('md5').update(`${streamPath}-${exp}-${secret}`).digest('hex');
  const sign = `${exp}-${hash}`;
  if (kind === 'push') return `rtmp://${host}:${rtmpPort}${streamPath}?sign=${sign}`;
  return `http://${host}:${httpPort}${streamPath}.flv?sign=${sign}`;
}

module.exports = { createMediaLayer, signStreamUrl };