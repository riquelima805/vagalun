'use strict';

/**
 * gatewayNode.js — liga um GATEWAY COMPLETO dentro de outro processo (o PC node: `--gateway`).
 *
 * Em vez de reescrever o gateway, reaproveita o http.Server de gateway.js e encaminha pra ele só as
 * rotas que ele deve responder (allowlist). O que NUNCA é encaminhado: /admin/* (publicar/apagar é
 * coisa do gateway "primário"; uma réplica só lê e sincroniza).
 *
 *   const gw = startGatewayNode({ dataDir, nodeId, publicUrl, seeds, signalerUrls });
 *   // no handler HTTP do hospedeiro:
 *   if (gw.tryHandle(req, res)) return;
 */

const path = require('path');
const fs = require('fs');

const OWNED_PREFIXES = ['/raw/', '/p2p/', '/site/', '/sync/', '/gw/', '/__vgl/', '/metrics/'];
const OWNED_EXACT = new Set(['/vagalun-sw.js']);

function startGatewayNode({
  dataDir, nodeId = 'node', publicUrl = '', seeds = [], signalerUrls = [], publicSignalerUrls = [],
  syncIntervalMs = 60_000, strict = false, verify = true, log = console.log,
} = {}) {
  if (!dataDir) throw new Error('startGatewayNode: dataDir é obrigatório');
  fs.mkdirSync(dataDir, { recursive: true });

  // gateway.js/registry.js/content.js leem env NA CARGA — define antes do require.
  const short = String(nodeId).replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'pc';
  const set = (k, v) => { if (v !== undefined && v !== '') process.env[k] = String(v); };
  set('GATEWAY_DATA_FILE', path.join(dataDir, 'gateway-data.json'));
  set('GATEWAY_RELAY_NODE_ID', `gateway-pc-${short}`);
  set('GATEWAY_KIND', 'pc');
  set('GATEWAY_ALLOW_GEO_OVERRIDE', '0');
  if (signalerUrls.length) set('GATEWAY_SIGNALING_URLS', signalerUrls.join(','));
  if (publicSignalerUrls.length) set('GATEWAY_SIGNALING_PUBLIC_URLS', publicSignalerUrls.join(','));
  else if (signalerUrls.length) set('GATEWAY_SIGNALING_PUBLIC_URLS', signalerUrls.filter((u) => u.startsWith('wss://')).join(','));

  const { server } = require('./gateway');
  const registry = require('./registry');
  const gwDirectory = require('./gwDirectory');
  const { SyncLoop } = require('./registrySync');

  gwDirectory.setSelf(publicUrl);
  gwDirectory.learn(seeds, 'seed');

  const loop = new SyncLoop({ seeds, intervalMs: syncIntervalMs, strict, verify, log });
  loop.start();

  // Se temos URL pública, nos apresentamos aos seeds (eles confirmam o controle da URL).
  const announceTimer = publicUrl ? setInterval(announce, 30 * 60_000) : null;
  if (announceTimer) announceTimer.unref();
  function announce() {
    for (const seed of seeds) {
      fetch(`${seed.replace(/\/$/, '')}/gw/announce`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: publicUrl }),
      }).catch(() => {});
    }
  }
  if (publicUrl) setTimeout(announce, 2000).unref();
  const sweepTimer = setInterval(() => gwDirectory.sweep().catch(() => {}), 10 * 60_000);
  sweepTimer.unref();

  function owns(req) {
    let pathname;
    try { pathname = new URL(req.url, 'http://internal').pathname; } catch (_) { return false; }
    if (pathname.startsWith('/admin/')) return false;
    if (OWNED_EXACT.has(pathname) || OWNED_PREFIXES.some((p) => pathname.startsWith(p))) return true;
    // Host de um site que ESTE gateway conhece (alguém apontou DNS pra cá): serve; senão deixa pro hospedeiro.
    const host = (req.headers.host || '').split(':')[0].toLowerCase();
    return !!host && host.includes('.') && !!registry.resolveSite(host, pathname);
  }

  return {
    tryHandle(req, res) {
      if (!owns(req)) return false;
      server.emit('request', req, res);
      return true;
    },
    status: () => ({
      nodeId, publicUrl: publicUrl || null, sync: loop.status(),
      sites: registry.listSites().length, files: registry.listFiles().length,
      gateways: gwDirectory.list(),
    }),
    syncNow: () => loop.roundOnce(),
    stop() { loop.stop(); clearInterval(announceTimer); clearInterval(sweepTimer); },
  };
}

module.exports = { startGatewayNode, OWNED_PREFIXES };
