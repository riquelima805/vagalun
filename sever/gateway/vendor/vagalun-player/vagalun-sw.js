// Service worker do Vagalun — versão DISTRIBUÍDA.
//
// 1) (igual a antes) guarda o player em cache, stale-while-revalidate.
// 2) NOVO: serve sites por /site/<domínio>/<caminho> escolhendo o gateway mais rápido, SEM confiar
//    nele (verifica assinatura do manifesto e o fileId do conteúdo — ver vagalun-gateway-pool.js) e
//    com fallback em cascata:
//        gateway mais perto  ->  próximos gateways (hedge)  ->  cache verificado  ->  P2P (via página)
//
// Não toca em: métodos != GET, outras origens, /raw /p2p /metrics /admin /gw /sync (passam direto).
// Pedidos com Range (vídeo/áudio) de sites também passam pelo pool (failover), mas sem conferir o
// arquivo inteiro — o P2P do player já confere o hash de cada shard.
//
// Subrecursos com caminho absoluto ("/app.js") de uma página aberta em /site/<domínio>/ são
// reescritos pro mesmo domínio (o SW descobre o domínio pelo cliente que fez o pedido).
//
// Config (página -> SW): navigator.serviceWorker.controller.postMessage({ type:'vgl-config', seeds:[...], strict:true })

importScripts('/__vgl/vagalun-gateway-pool.js');

const CACHE = 'vagalun-player-v2';
const SITE_CACHE = 'vagalun-sites-v1';
const PIN_CACHE = 'vagalun-pins-v1';
const CFG_KEY = 'https://vgl.local/config';
const PLAYER_ASSETS = ['/__vgl/vagalun-player.iife.js', '/__vgl/vagalun-player.css'];
const RESERVED = ['/__vgl/', '/gw/', '/raw/', '/p2p/', '/sync/', '/metrics/', '/admin/', '/site/'];

// ---- pins (dono/versão por domínio) guardados no Cache API: o SW não tem localStorage ----
const pinStore = {
  async get(k) {
    const c = await caches.open(PIN_CACHE);
    const r = await c.match('https://vgl.local/pin/' + encodeURIComponent(k));
    return r ? r.json() : null;
  },
  async set(k, v) {
    const c = await caches.open(PIN_CACHE);
    await c.put('https://vgl.local/pin/' + encodeURIComponent(k), new Response(JSON.stringify(v)));
  },
};

let poolPromise = null;
async function getPool() {
  if (!poolPromise) {
    poolPromise = (async () => {
      let cfg = {};
      try { const c = await caches.open(PIN_CACHE); const r = await c.match(CFG_KEY); if (r) cfg = await r.json(); } catch (_) {}
      const pool = new VagalunPool.Pool({
        seeds: [self.location.origin, ...(cfg.seeds || [])], store: pinStore, strict: !!cfg.strict,
      });
      pool.refresh().catch(() => {}); // aprende gateways e mede RTT em segundo plano
      return pool;
    })();
  }
  return poolPromise;
}

self.addEventListener('message', (event) => {
  const d = event.data || {};
  if (d.type !== 'vgl-config') return;
  event.waitUntil((async () => {
    const c = await caches.open(PIN_CACHE);
    await c.put(CFG_KEY, new Response(JSON.stringify({ seeds: d.seeds || [], strict: !!d.strict })));
    poolPromise = null; // recria com a config nova
  })());
});

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => Promise.all(PLAYER_ASSETS.map((u) => cache.add(u).catch(() => {})))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('vagalun-player-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ---- decide se este pedido é "de site" e de qual domínio ----
async function siteTarget(event, url) {
  if (url.pathname.startsWith('/site/')) {
    const rest = url.pathname.slice('/site/'.length);
    const i = rest.indexOf('/');
    if (i === -1) return null; // /site/dominio sem barra: o gateway faz o redirect
    return { domain: rest.slice(0, i).toLowerCase(), path: decodeURIComponent(rest.slice(i)) || '/' };
  }
  if (RESERVED.some((p) => url.pathname.startsWith(p)) || url.pathname === '/vagalun-sw.js') return null;
  const id = event.clientId || event.resultingClientId;
  if (!id) return null;
  try {
    const client = await self.clients.get(id);
    if (!client) return null;
    const cu = new URL(client.url);
    if (cu.origin !== self.location.origin || !cu.pathname.startsWith('/site/')) return null;
    const dom = cu.pathname.slice('/site/'.length).split('/')[0].toLowerCase();
    return dom ? { domain: dom, path: url.pathname } : null;
  } catch (_) { return null; }
}

// ---- fallback P2P: o SW não tem WebRTC; pede pra uma página aberta baixar ----
async function askPage(msg, timeoutMs = 25000) {
  const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: false });
  for (const c of cs) {
    try {
      const ch = new MessageChannel();
      const reply = new Promise((resolve) => { ch.port1.onmessage = (e) => resolve(e.data); setTimeout(() => resolve(null), timeoutMs); });
      c.postMessage(msg, [ch.port2]);
      const r = await reply;
      if (r && r.ok) return r;
    } catch (_) { /* tenta o próximo cliente */ }
  }
  return null;
}

function siteResponse(r, extra = {}) {
  return new Response(r.bytes, {
    status: 200,
    headers: {
      'Content-Type': r.contentType || 'application/octet-stream',
      'X-Vagalun-Verified': r.verified,
      'X-Vagalun-Gateway': r.gateway || '',
      'X-Vagalun-Version': String(r.version ?? ''),
      ...extra,
    },
  });
}

async function handleSite(event, target) {
  const req = event.request;
  const pool = await getPool();
  const cache = await caches.open(SITE_CACHE);
  const cacheKey = new Request(`https://vgl.local/site/${target.domain}${target.path}`);

  // Range (vídeo): failover entre gateways, sem conferir o arquivo inteiro.
  if (req.headers.has('range')) {
    try {
      const m = await pool.getSiteManifest(target.domain);
      const route = m.routes.find((r) => r.path === target.path) || m.routes.find((r) => r.path === '/');
      if (!route) return new Response('rota não encontrada', { status: 404 });
      const { value } = await pool.fetchRaw(route.fileId, { headers: { Range: req.headers.get('range') } });
      return value;
    } catch (e) {
      return new Response('todos os gateways falharam: ' + e.message, { status: 502 });
    }
  }

  try {
    const r = await pool.fetchSite(target.domain, target.path);
    const res = siteResponse(r);
    event.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch (e) {
    // 2) cache de uma visita anterior (já verificado quando entrou)
    const cached = await cache.match(cacheKey);
    if (cached) {
      const h = new Headers(cached.headers); h.set('X-Vagalun-Stale', '1');
      return new Response(await cached.arrayBuffer(), { status: 200, headers: h });
    }
    // 3) P2P direto dos celulares (a página baixa e devolve os bytes)
    try {
      const pm = await pool.getSiteManifest(target.domain).catch(() => null);
      const route = pm && (pm.routes.find((x) => x.path === target.path) || pm.routes.find((x) => x.path === '/'));
      if (route) {
        const gateways = pool.ranked().map((g) => g.url);
        const p2p = await askPage({ type: 'vgl-p2p-fetch', fileId: route.fileId, gateways });
        if (p2p && p2p.bytes) {
          const bytes = new Uint8Array(p2p.bytes);
          const ok = await VagalunPool.fileIdMatches(route.fileId, target.domain, route.path, bytes);
          if (ok) return siteResponse({ bytes, contentType: route.contentType, verified: 'yes', gateway: 'p2p', version: pm.version });
        }
      }
    } catch (_) { /* cai no 502 */ }
    return new Response('Nenhum gateway respondeu e o P2P não achou o arquivo: ' + (e && e.message), { status: 502 });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (PLAYER_ASSETS.includes(url.pathname) && !req.headers.has('range')) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const refresh = fetch(req).then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
        if (cached) { event.waitUntil(refresh); return cached; }
        return (await refresh) || new Response('player indisponível', { status: 503 });
      })
    );
    return;
  }

  event.respondWith((async () => {
    const target = await siteTarget(event, url);
    if (!target) return fetch(req); // não é de site: passa direto, como antes
    return handleSite(event, target);
  })());
});
