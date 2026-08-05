// Estado em memória do gateway. NÃO é o GossipRegistry do app (esse roda dentro do
// processo Android) — é um espelho: nós/donos de arquivo publicam aqui via /admin/*
// os metadados necessários (FileMeta no mesmo shape do GossipRegistry.serializeFiles(),
// mais uma chave de arquivo opcional pra permitir o gateway decifrar e servir por HTTP).
//
// Publicar fileKeyB64 é uma decisão explícita de quem sobe o arquivo: só faz sentido
// pra conteúdo que já é público por natureza (ex: um site estático). Arquivo privado
// nunca deveria ter a chave publicada aqui — sem ela o gateway consegue reconstruir o
// ciphertext (RS) mas não decifrar, então fica opaco pra ele por padrão.

const { verifyEd25519 } = require('./crypto');

const peers = new Map();
const files = new Map();
const sites = new Map();

function addPeer(nodeId, host, port) {
  if (!nodeId || !host || !port) throw new Error('peer precisa de nodeId, host e port');
  peers.set(nodeId, { nodeId, host, port });
}
function getPeer(nodeId) { return peers.get(nodeId); }
function listPeers() { return [...peers.values()]; }
function removePeer(nodeId) { peers.delete(nodeId); }

function registerFile(meta) {
  if (!meta || !meta.fileId || !Array.isArray(meta.blocks)) {
    throw new Error('manifesto de arquivo inválido (faltando fileId ou blocks)');
  }
  if (typeof meta.k !== 'number' || typeof meta.m !== 'number' || typeof meta.blockSize !== 'number') {
    throw new Error('manifesto de arquivo inválido (faltando k/m/blockSize)');
  }
  files.set(meta.fileId, meta);
}
function getFile(fileId) { return files.get(fileId); }
function listFiles() { return [...files.keys()]; }

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
}

function resolveSite(domain, path) {
  const site = sites.get(domain);
  if (!site) return null;
  return site.routes.get(path) || site.routes.get('/') || null;
}

function listSites() { return [...sites.keys()]; }

module.exports = {
  addPeer, getPeer, listPeers, removePeer,
  registerFile, getFile, listFiles,
  registerSite, resolveSite, listSites, canonicalManifest,
};
