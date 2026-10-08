// Geo do gateway: "onde está o visitante" + "onde estão (e quais estão online) os celulares".
//
//  - Visitante: geoip-lite (base local, offline) pelo IP da requisição. Pra demo/teste
//    dá pra forçar a posição com ?geo=lat,lon (ou header X-Vagalun-Geo) — ex.: mostrar
//    a ordem dos candidatos mudando "como se" o visitante estivesse em Lisboa.
//    Desligue em produção com GATEWAY_ALLOW_GEO_OVERRIDE=0.
//  - Celulares: o signaling (sever/server.js) expõe GET /directory/geo com todo celular
//    online + cidade/lat/lon aproximados. Aqui a gente copia isso a cada ~15s.
//    Estar na lista = online agora. Isso permite (1) ordenar por distância e (2) mandar
//    pro fim da fila quem caiu, em vez de gastar timeout nele.
//
// Sem geo (IP privado, base sem o range, signaling fora do ar) nada quebra: a ordem
// original dos candidatos é mantida (ordenação estável) — nunca excluímos ninguém só
// por falta de geo.

const http = require('http');
const https = require('https');
const crypto = require('crypto');

let geoip = null;
try {
  geoip = require('geoip-lite');
} catch (e) {
  console.warn('[geo] geoip-lite não encontrado — visitante sem geo (ordem original dos candidatos). npm i geoip-lite');
}

const GEO_REFRESH_MS = parseInt(process.env.GATEWAY_GEO_REFRESH_MS || '15000', 10);
const PRESENCE_STALE_MS = parseInt(process.env.GATEWAY_GEO_STALE_MS || '60000', 10);
const ALLOW_OVERRIDE = process.env.GATEWAY_ALLOW_GEO_OVERRIDE !== '0';

function signalingHttpBase() {
  if (process.env.GATEWAY_SIGNALING_HTTP_URL) return process.env.GATEWAY_SIGNALING_HTTP_URL.replace(/\/+$/, '');
  const ws = process.env.GATEWAY_SIGNALING_URL || 'ws://localhost:8787';
  return ws.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:').replace(/\/+$/, '');
}

// ---------- matemática ----------
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function regionLabel(city, country) {
  if (city) return `${city}, ${country || '?'}`;
  return country || null;
}

// ---------- visitante ----------
function geoOfIp(ip) {
  if (!geoip || !ip) return null;
  const clean = String(ip).replace(/^::ffff:/, '');
  let g = null;
  try { g = geoip.lookup(clean); } catch { g = null; }
  if (!g || !Array.isArray(g.ll)) return null;
  return { lat: g.ll[0], lon: g.ll[1], region: regionLabel(g.city, g.country) };
}

function parseLatLon(str) {
  if (typeof str !== 'string') return null;
  const m = str.trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) return null;
  return { lat, lon };
}

/**
 * Posição do visitante. Devolve { lat, lon, region, source } onde source é
 * 'override' | 'ip' | 'none' (lat/lon null quando 'none').
 */
function visitorGeo(req, searchParams, ipOf) {
  if (ALLOW_OVERRIDE) {
    const raw = (searchParams && searchParams.get && searchParams.get('geo')) || req.headers['x-vagalun-geo'];
    const o = parseLatLon(raw || '');
    if (o) return { ...o, region: `${o.lat.toFixed(1)}, ${o.lon.toFixed(1)} (manual)`, source: 'override' };
  }
  const ip = ipOf ? ipOf(req) : (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const g = geoOfIp(ip);
  if (g) return { ...g, source: 'ip' };
  return { lat: null, lon: null, region: null, source: 'none' };
}

// ---------- presença/geo dos celulares (cópia do /directory/geo do signaling) ----------
let nodeGeo = new Map(); // relayNodeId -> { lat, lon, region, ... }
let lastOkAt = 0;
let timer = null;

function setNodeGeo(obj) {
  nodeGeo = new Map(Object.entries(obj || {}));
  lastOkAt = Date.now();
}

function getJson(urlStr, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }
    const lib = u.protocol === 'https:' ? https : http;
    const headers = { Accept: 'application/json' };
    if (process.env.GATEWAY_GEO_TOKEN) headers['X-Geo-Token'] = process.env.GATEWAY_GEO_TOKEN; // = SIGNALING_GEO_TOKEN no signaling
    const req = lib.get(u, { timeout: timeoutMs, headers }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function refreshNodeGeo() {
  try {
    const json = await getJson(`${signalingHttpBase()}/directory/geo`);
    if (json && json.ok && json.nodes) setNodeGeo(json.nodes);
    return true;
  } catch (e) {
    // signaling fora do ar / rota ainda não deployada: segue com o que tinha; depois de
    // PRESENCE_STALE_MS sem sucesso a presença vira "desconhecida" (não "offline").
    return false;
  }
}

function startPolling() {
  if (timer) return;
  refreshNodeGeo();
  timer = setInterval(refreshNodeGeo, GEO_REFRESH_MS);
  timer.unref();
}

function stopPolling() {
  if (timer) { clearInterval(timer); timer = null; }
}

function presenceKnown() {
  return Date.now() - lastOkAt < PRESENCE_STALE_MS;
}

/** true = online, false = offline, null = não sei (signaling inacessível/dado velho). */
function isOnline(relayNodeId) {
  if (!relayNodeId) return null;
  if (!presenceKnown()) return null;
  return nodeGeo.has(relayNodeId);
}

function nodeInfo(relayNodeId) {
  return nodeGeo.get(relayNodeId) || null;
}

/** Celulares online agora com geo conhecida: [{ relayNodeId, lat, lon, region }] */
function onlineNodes() {
  if (!presenceKnown()) return [];
  const out = [];
  for (const [relayNodeId, g] of nodeGeo) {
    if (g && g.lat != null && g.lon != null) out.push({ relayNodeId, lat: g.lat, lon: g.lon, region: g.region || null });
  }
  return out;
}

function distanceBetweenKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  return haversineKm(a.lat, a.lon, b.lat, b.lon);
}

/**
 * Ordena `items` do mais perto ao mais longe do visitante.
 *  - offline conhecido (online === false) vai pro fim, sempre;
 *  - sem distância (sem geo do visitante ou do celular) fica depois dos que têm,
 *    mantendo a ordem original entre si (sort estável).
 * Devolve [{ item, distanceKm, region, online }] — `item` é o objeto original.
 */
function rank(items, visitor, relayIdOf) {
  const hasVisitor = visitor && visitor.lat != null && visitor.lon != null;
  const rows = items.map((item, i) => {
    const rid = relayIdOf(item);
    const info = rid ? nodeInfo(rid) : null;
    let distanceKm = null;
    if (hasVisitor && info && info.lat != null) {
      distanceKm = Math.round(haversineKm(visitor.lat, visitor.lon, info.lat, info.lon));
    }
    return { item, i, distanceKm, region: (info && info.region) || null, online: isOnline(rid) };
  });
  rows.sort((a, b) => {
    const offA = a.online === false ? 1 : 0, offB = b.online === false ? 1 : 0;
    if (offA !== offB) return offA - offB;
    const da = a.distanceKm == null ? Infinity : a.distanceKm;
    const db = b.distanceKm == null ? Infinity : b.distanceKm;
    if (da !== db) return da < db ? -1 : 1;
    return a.i - b.i;
  });
  return rows.map(({ item, distanceKm, region, online }) => ({ item, distanceKm, region, online }));
}

/**
 * Apelido curto e estável de um nó pra expor em header/métricas sem vazar o nodeId
 * real do celular. TCP/dev (sem relayNodeId) usa o nodeId lógico como está.
 */
function alias(id) {
  if (!id) return 'unknown';
  if (/^s?node-\d{1,4}$/.test(String(id))) return String(id); // rótulo lógico do publish (node-0, snode-1)
  return 'n-' + crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 8);
}

module.exports = {
  haversineKm, regionLabel, geoOfIp, parseLatLon, visitorGeo,
  setNodeGeo, refreshNodeGeo, startPolling, stopPolling,
  presenceKnown, isOnline, nodeInfo, onlineNodes, distanceBetweenKm, rank, alias,
};
