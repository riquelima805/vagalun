#!/usr/bin/env node
// Uso:
//   node publishSite.js --dir ./meusite --domain meusite.local \
//        --node-host 192.168.0.42 --node-port 9333 \
//        --gateway http://localhost:8788 [--admin-token SEGREDO] [--k 1] [--m 0]
//
// O que faz, passo a passo:
//   1. Registra o(s) nó(s) no gateway via POST /admin/peers (o celular).
//   2. Pra cada arquivo da pasta: fatia+cifra+RS-encode, envia os shards pro
//      celular via TCP (protocolo do ShardServer.kt), registra o arquivo via
//      POST /admin/files.
//   3. Monta o manifesto do site (rota -> fileId), assina com a chave
//      custodial do domínio (gerada/persistida localmente) e publica via
//      POST /admin/sites.
//
// Com 1 celular só, use --k 1 --m 0 (sem redundância, é só o teste ponta a
// ponta). Quando tiver mais de um nó, aumente k/m e passe múltiplos
// --node-host/--node-port (host:port,host:port,...).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const registry = require('../gateway/registry'); // só usado indiretamente via HTTP; não importar estado aqui
const { encodeAndUpload, deriveFileId, buildSingleNodeSlots, buildSingleRelayNodeSlots, buildMultiRelayNodeSlots } = require('./encodeAndUpload');
const { connectRelay, putShardViaRelay } = require('../gateway/relayTransport');
const { getOrCreateSiteKey } = require('./siteKeys');
const mime = require('../gateway/mime');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

function listFilesRecursive(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full, base));
    } else {
      out.push({ abs: full, rel: '/' + path.relative(base, full).split(path.sep).join('/') });
    }
  }
  return out;
}

async function httpJson(url, method, body, adminToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (adminToken) headers['X-Admin-Token'] = adminToken;
  const resp = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || json.ok === false) {
    throw new Error(`${method} ${url} -> ${resp.status}: ${json.error || JSON.stringify(json)}`);
  }
  return json;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.dir;
  const domain = args.domain;
  const gateway = (args.gateway || 'http://localhost:8788').replace(/\/$/, '');
  const adminToken = args['admin-token'] || process.env.GATEWAY_ADMIN_TOKEN;
  const k = parseInt(args.k || '1', 10);
  const m = parseInt(args.m || '0', 10);
  const n = k + m;

  const nodeHosts = args['node-host'] ? String(args['node-host']).split(',') : null;
  const nodePorts = args['node-port'] ? String(args['node-port']).split(',').map(Number) : null;
  const relayUrl = args['relay-url'];
  const relayNode = args['relay-node'];

  if (!dir || !domain) {
    console.error('uso (TCP/LAN):   node publishSite.js --dir <pasta> --domain <dominio> --node-host <ip> --node-port <porta> --gateway <url> [--admin-token tok] [--k 1] [--m 0]');
    console.error('uso (relay/celular via internet): node publishSite.js --dir <pasta> --domain <dominio> --relay-url ws://host:8787 --relay-node <nodeId-do-celular> --gateway <url> [--admin-token tok] [--k 1] [--m 0]');
    process.exit(1);
  }

  let nodes;
  let putShardFn;
  let relayClient = null;

  if (relayUrl) {
    if (!relayNode) throw new Error('--relay-node é obrigatório junto com --relay-url (nodeId(s) do(s) celular(es), separados por vírgula)');
    console.log(`\nconectando no signaling (${relayUrl}) como publisher...`);
    relayClient = await connectRelay(relayUrl, `publisher-${Date.now()}`);
    const phoneIds = String(relayNode).split(',').map((s) => s.trim()).filter(Boolean);
    nodes = phoneIds.length > 1 ? buildMultiRelayNodeSlots(phoneIds, n) : buildSingleRelayNodeSlots(phoneIds[0], n);
    putShardFn = async (node, shardKey, data) => putShardViaRelay(relayClient, node.relayTo, shardKey, data);
  } else {
    if (!nodeHosts || !nodePorts) throw new Error('passe --node-host/--node-port (LAN) ou --relay-url/--relay-node (celular via internet)');
    if (nodeHosts.length === 1 && nodePorts.length === 1) {
      nodes = buildSingleNodeSlots(nodeHosts[0], nodePorts[0], n);
    } else {
      if (nodeHosts.length !== n) throw new Error(`passei ${nodeHosts.length} hosts mas k+m=${n}`);
      nodes = nodeHosts.map((h, i) => ({ nodeId: `node-${i}`, host: h, port: nodePorts[i] }));
    }
    // putShardFn = undefined -> encodeAndUpload usa o default TCP
  }

  console.log(`\n[1/3] registrando ${nodes.length} slot(s) de nó no gateway...`);
  for (const node of nodes) {
    const body = relayUrl
      ? { nodeId: node.nodeId, relayNodeId: node.relayTo }
      : { nodeId: node.nodeId, host: node.host, port: node.port };
    await httpJson(`${gateway}/admin/peers`, 'POST', body, adminToken);
    console.log(`  ok  - ${node.nodeId} -> ${relayUrl ? `relay:${node.relayTo}` : `${node.host}:${node.port}`}`);
  }

  console.log(`\n[2/3] publicando arquivos de ${dir}...`);
  const files = listFilesRecursive(dir);
  if (files.length === 0) throw new Error('pasta vazia, nada pra publicar');

  const routes = [];
  for (const f of files) {
    const buf = fs.readFileSync(f.abs);
    const fileId = deriveFileId(buf, domain + f.rel);
    const contentType = mime.guess(f.abs);

    process.stdout.write(`  ${f.rel} (${buf.length} bytes) -> fileId ${fileId} ... `);
    const manifest = await encodeAndUpload(buf, { fileId, k, m, nodes, putShardFn });
    manifest.fileName = path.basename(f.abs);
    await httpJson(`${gateway}/admin/files`, 'POST', manifest, adminToken);
    console.log('ok');

    routes.push({ path: f.rel === '/index.html' ? '/' : f.rel, fileId, contentType });
    // garante que '/' sempre resolve pra algo, mesmo se não houver /index.html
  }
  if (!routes.some((r) => r.path === '/') && routes.some((r) => r.path === '/index.html')) {
    const idx = routes.find((r) => r.path === '/index.html');
    routes.push({ path: '/', fileId: idx.fileId, contentType: idx.contentType });
  }

  console.log(`\n[3/3] assinando e publicando manifesto do site '${domain}'...`);
  const { pubkeyB58, privateKey } = getOrCreateSiteKey(domain);
  const canonical = registry.canonicalManifest(domain, routes);
  const signature = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');

  await httpJson(`${gateway}/admin/sites`, 'POST', {
    domain, ownerPubkey: pubkeyB58, routes, signature,
  }, adminToken);

  console.log(`\npublicado! teste com:`);
  console.log(`  curl -H "Host: ${domain}" ${gateway}/`);
  console.log(`(dono do domínio, chave pública: ${pubkeyB58} — guardada em publisher/site-keys.json)`);
  if (relayClient) relayClient.close();
}

main().catch((e) => {
  console.error('\nerro:', e.message);
  process.exit(1);
});
