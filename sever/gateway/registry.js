// Estado em memória do gateway. NÃO é o GossipRegistry do app (esse roda dentro do
// processo Android) — é um espelho: nós/donos de arquivo publicam aqui via /admin/*
// os metadados necessários (FileMeta no mesmo shape do GossipRegistry.serializeFiles(),
// mais uma chave de arquivo opcional pra permitir o gateway decifrar e servir por HTTP).
//
// Publicar fileKeyB64 é uma decisão explícita de quem sobe o arquivo: só faz sentido
// pra conteúdo que já é público por natureza (ex: um site estático). Arquivo privado
// nunca deveria ter a chave publicada aqui — sem ela o gateway consegue reconstruir o
// ciphertext (RS) mas não decifrar, então fica opaco pra ele por padrão.

const fs = require('fs');
const path = require('path');
const { verifyEd25519 } = require('./crypto');

const peers = new Map();
const files = new Map();
const sites = new Map();

// Persistência simples em disco pra 'files', 'sites' e 'peers' (o que sobrevive a um
// restart do processo).
//
// 'peers' É persistido (mudou — ver histórico): a princípio a ideia era que "conexão
// de nó é sempre efêmera, um celular que reconecta sempre se re-anuncia", só que na
// prática nada no projeto re-anuncia automaticamente (o único lugar que chama
// addPeer/addRelayPeer é o publisher, na hora do publish). Resultado: todo restart do
// gateway (deploy, crash, `pm2 restart`) zerava o mapeamento nodeId-do-placement ->
// peer real, e os blocos ficavam inacessíveis mesmo com o celular online — não porque
// faltava redundância (k/m), mas porque o gateway tinha "esquecido" quem servia o quê.
//
// Isso só é seguro persistir porque o nodeId do celular é estável (persistido em
// SharedPreferences no app, não muda entre reconexões) — não estamos salvando um
// endereço de rede que expira, só a associação nodeId-do-placement -> nodeId-real.
// Continua sendo "last known": se um peer for removido/substituído de propósito,
// isso é refletido no arquivo e sobrescrito no próximo addPeer/removePeer.
const DATA_FILE = process.env.GATEWAY_DATA_FILE || path.join(__dirname, 'gateway-data.json');
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const out = {
        peers: [...peers.entries()],
        files: [...files.entries()],
        sites: [...sites.entries()].map(([domain, s]) => [domain, { ...s, routes: [...s.routes.entries()] }]),
      };
      fs.writeFileSync(DATA_FILE, JSON.stringify(out));
    } catch (e) {
      console.error('[registry] falha ao salvar estado:', e.message);
    }
  }, 250);
}
function loadFromDisk() {
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const [id, peer] of raw.peers || []) peers.set(id, peer);
    for (const [id, meta] of raw.files || []) files.set(id, meta);
    for (const [domain, s] of raw.sites || []) {
      sites.set(domain, { ...s, routes: new Map(s.routes) });
    }
    console.log(`[registry] recuperado do disco: ${peers.size} peer(s), ${files.size} arquivo(s), ${sites.size} site(s)`);
  } catch (e) {
    console.error('[registry] falha ao carregar estado salvo:', e.message);
  }
}
loadFromDisk();

function addPeer(nodeId, host, port) {
  if (!nodeId || !host || !port) throw new Error('peer precisa de nodeId, host e port');
  peers.set(nodeId, { nodeId, transport: 'tcp', host, port });
  scheduleSave();
}
// Peer alcançável só via relay/signaling (celular atrás de NAT/rede móvel —
// nunca aceita conexão de entrada). relayNodeId é o nodeId que o próprio
// celular usou pra se registrar no signaling (sever/server.js).
function addRelayPeer(nodeId, relayNodeId) {
  if (!nodeId || !relayNodeId) throw new Error('peer relay precisa de nodeId e relayNodeId');
  peers.set(nodeId, { nodeId, transport: 'relay', relayNodeId });
  scheduleSave();
}
function getPeer(nodeId) { return peers.get(nodeId); }
function listPeers() { return [...peers.values()]; }
function removePeer(nodeId) { peers.delete(nodeId); scheduleSave(); }

function registerFile(meta) {
  if (!meta || !meta.fileId || !Array.isArray(meta.blocks)) {
    throw new Error('manifesto de arquivo inválido (faltando fileId ou blocks)');
  }
  if (typeof meta.k !== 'number' || typeof meta.m !== 'number' || typeof meta.blockSize !== 'number') {
    throw new Error('manifesto de arquivo inválido (faltando k/m/blockSize)');
  }
  files.set(meta.fileId, meta);
  scheduleSave();
}
function getFile(fileId) { return files.get(fileId); }
function listFiles() { return [...files.keys()]; }
function deleteFile(fileId) {
  const existed = files.delete(fileId);
  if (existed) scheduleSave();
  return existed;
}

function canonicalManifest(domain, routes) {
  const sorted = routes.slice().sort((a, b) => a.path.localeCompare(b.path));
  return `${domain}\n${sorted.map((r) => `${r.path}|${r.fileId}|${r.contentType || ''}`).join('\n')}`;
}

// TOFU (trust-on-first-use): primeiro publish de um domínio grava o dono; publishes
// seguintes só são aceitos se assinados pela mesma chave. Assinatura é Ed25519 sobre
// o manifesto canônico — a mesma curva da wallet Solana derivada no app (SLIP-10).
function registerSite(domain, ownerPubkeyB58, routes, signatureB64) {
  if (!domain || !ownerPubkeyB58 || !Array.isArray(routes) || !signatureB64) {
    throw new Error('manifesto de site incompleto (domain, ownerPubkey, routes, signature)');
  }
  const existing = sites.get(domain);
  if (existing && existing.ownerPubkeyB58 !== ownerPubkeyB58) {
    throw new Error('domínio já registrado com outra chave — dono não confere');
  }
  const message = canonicalManifest(domain, routes);
  if (!verifyEd25519(message, signatureB64, ownerPubkeyB58)) {
    throw new Error('assinatura do manifesto inválida');
  }
  const routeMap = new Map(
    routes.map((r) => [r.path, { fileId: r.fileId, contentType: r.contentType || 'application/octet-stream' }])
  );
  sites.set(domain, { ownerPubkeyB58, routes: routeMap, updatedAt: Date.now() });
  scheduleSave();
}

function resolveSite(domain, path) {
  const site = sites.get(domain);
  if (!site) return null;
  return site.routes.get(path) || site.routes.get('/') || null;
}

function listSites() { return [...sites.keys()]; }

module.exports = {
  addPeer, addRelayPeer, getPeer, listPeers, removePeer,
  registerFile, getFile, listFiles, deleteFile,
  registerSite, resolveSite, listSites, canonicalManifest,
};
