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

// Mesmo conjunto/regra de sever/hosting/server.js::isInfraNodeId — duplicado
// aqui de propósito (o gateway não importa server.js, são processos
// separados), pra usar o MESMO env var e o MESMO padrão de prefixo. Existe
// pra impedir a causa raiz do bug "node-1 apontando pro próprio gateway":
// nada barrava um /admin/peers com relayNodeId = 'gateway-1' (o próprio
// processo gateway, conectado ao signaling como infra) virar destino de
// shard — um slot lógico (node-0/node-1/...) ficava "vinculado" a um peer
// que nunca deveria receber shard nenhum.
const INFRA_NODE_IDS = new Set(
  (process.env.GATEWAY_RELAY_NODE_ID || 'gateway-1').split(',').map((s) => s.trim()).filter(Boolean)
);
function isInfraNodeId(nodeId) {
  return INFRA_NODE_IDS.has(nodeId) || nodeId.startsWith('publisher-') || nodeId.startsWith('hosting-platform-') || nodeId.startsWith('gateway-');
}

// Hook opcional: registryBackup.js (Camada 2) se registra aqui pra saber
// toda vez que o estado muda e replicar pros nós de confiança — registry.js
// não conhece registryBackup.js (evita dependência circular), é o outro
// lado que se inscreve.
let onDataSaved = null;
function setOnDataSaved(fn) { onDataSaved = fn; }

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
// Camada 1 do item 12 (backup/replicação do registry): antes de pensar em
// tirar cópia pra fora da VPS, o mínimo é não deixar uma escrita pela
// metade destruir o único arquivo que sabe onde cada shard está. Duas
// coisas resolvem isso sem depender de nada externo:
//   (a) escrita atômica: grava num .tmp e só troca pro nome final com
//       rename() (atômico no mesmo filesystem) — um crash no meio da
//       escrita nunca deixa o arquivo principal pela metade.
//   (b) snapshots rotativos com timestamp, pra poder voltar pra "a versão
//       de 10 minutos atrás" se algo salvar dado errado (não protege
//       contra perder a VPS inteira — só contra escrita ruim/corrupção).
const BACKUP_DIR = path.join(path.dirname(DATA_FILE), 'backups');
const MAX_LOCAL_SNAPSHOTS = Number(process.env.GATEWAY_MAX_LOCAL_SNAPSHOTS || 10);

function pruneLocalSnapshots() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('gateway-data.') && f.endsWith('.json'))
      .sort(); // nomes começam com timestamp ISO, ordem lexicográfica = ordem cronológica
    const excess = files.length - MAX_LOCAL_SNAPSHOTS;
    for (let i = 0; i < excess; i++) fs.unlinkSync(path.join(BACKUP_DIR, files[i]));
  } catch (e) {
    console.error('[registry] falha ao podar snapshots locais:', e.message);
  }
}

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
      const json = JSON.stringify(out);

      const tmpFile = `${DATA_FILE}.tmp`;
      fs.writeFileSync(tmpFile, json);
      fs.renameSync(tmpFile, DATA_FILE); // atômico: nunca fica um arquivo principal pela metade

      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(path.join(BACKUP_DIR, `gateway-data.${stamp}.json`), json);
      pruneLocalSnapshots();

      onDataSaved?.(json); // Camada 2 (registryBackup.js) se inscreve aqui pra replicar pra fora
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
  // FIX: sem isso, POST /admin/peers com relayNodeId='gateway-1' (ou qualquer
  // outro nodeId de infra) era aceito de boas — e depois o meshBridge/player
  // tentava buscar um shard P2P direto do próprio processo gateway, que nunca
  // teve esse shard. O placement resolvia pra um destino que nunca poderia
  // servir, e caía sempre em HTTP.
  if (isInfraNodeId(relayNodeId)) {
    throw new Error(
      `relayNodeId '${relayNodeId}' é um nodeId de infraestrutura (gateway/publisher/hosting-platform), não um celular — registro recusado`
    );
  }
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
  // item 10: sem hash por shard não dá pra detectar corrupção silenciosa
  // na leitura — em vez de aceitar um manifesto "capenga" e descobrir
  // isso só depois (na hora de servir), falha aqui, no publish, onde é
  // barato de corrigir.
  for (const block of meta.blocks) {
    for (const p of block.placements || []) {
      if (typeof p.shardHash !== 'string' || p.shardHash.length !== 64) {
        throw new Error(
          `manifesto inválido: bloco ${block.blockIndex} shard ${p.shardIndex} sem shardHash (sha256 hex de 64 chars)`
        );
      }
    }
  }
  // Mesmo campo/regra do GossipRegistry.kt (FileMeta.updatedAt) e do
  // registerSite abaixo: toda publicação/republicação local carimba "agora",
  // pra que meshBridge.buildFileGossipEntry() empurre um updatedAt real (e
  // não dependa do fallback Date.now() só na hora do push) e pra que uma
  // republicação sempre vença o que a malha P2P já tinha aprendido antes.
  meta.updatedAt = Date.now();
  // Republicar o mesmo fileId (mesmos bytes) não deve esquecer as réplicas de borda
  // já espalhadas: os shards continuam nos celulares.
  const prev = files.get(meta.fileId);
  if (prev && Array.isArray(prev.edgeReplicas) && prev.edgeReplicas.length && !meta.edgeReplicas) {
    meta.edgeReplicas = prev.edgeReplicas;
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

// Dono por domínio: o primeiro publish grava o dono; os seguintes só valem se assinados
// pela MESMA chave. Quando há SiteRecord on-chain, o gateway confere a chain ANTES de
// chamar isto (ver siteVerify.js) — aqui fica a regra local, que vale mesmo sem chain.
//
// Dois formatos de manifesto:
//   v1 (legado, `version` ausente): assina `domain\npath|fileId|contentType...`. Tem 3 furos
//      conhecidos (ordem localeCompare != Kotlin, '|' ambíguo, fileKey fora da assinatura).
//      Continua aceito SÓ pra domínios que nunca tiveram v2.
//   v2 (`version` inteiro >= 1): ver chain/siteManifest.js. Versão estritamente crescente
//      (anti-rollback) e NUNCA volta pra v1 (anti-downgrade).
const { canonicalManifestV2 } = require('../chain/siteManifest');

function registerSite(domain, ownerPubkeyB58, routes, signatureB64, version = null, legacySignatureB64 = null) {
  if (!domain || !ownerPubkeyB58 || !Array.isArray(routes) || !signatureB64) {
    throw new Error('manifesto de site incompleto (domain, ownerPubkey, routes, signature)');
  }
  const existing = sites.get(domain);
  if (existing && existing.ownerPubkeyB58 !== ownerPubkeyB58) {
    throw new Error('domínio já registrado com outra chave — dono não confere');
  }
  const isV2 = version !== null && version !== undefined;
  let message;
  if (isV2) {
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('version inválida');
    if (existing && (existing.version || 0) >= version) {
      throw new Error(`versão ${version} não é mais nova que a registrada (${existing.version}) — rollback recusado`);
    }
    message = canonicalManifestV2(domain, version, routes); // lança se tiver '|', quebra de linha, rota duplicada...
  } else {
    if (existing && (existing.version || 0) > 0) throw new Error('downgrade pra manifesto v1 recusado');
    message = canonicalManifest(domain, routes);
  }
  if (!verifyEd25519(message, signatureB64, ownerPubkeyB58)) {
    throw new Error('assinatura do manifesto inválida');
  }
  // Transição sem "flag day": site v2 pode carregar TAMBÉM a assinatura v1 (mesmas rotas), pra
  // apps antigos — que só sabem verificar v1 — continuarem aceitando o site via gossip.
  if (isV2 && legacySignatureB64 && !verifyEd25519(canonicalManifest(domain, routes), legacySignatureB64, ownerPubkeyB58)) {
    throw new Error('assinatura legada (v1) inválida');
  }
  const routeMap = new Map(
    routes.map((r) => [r.path, { fileId: r.fileId, contentType: r.contentType || 'application/octet-stream' }])
  );
  // Guarda a assinatura e as rotas "cruas" (não só o Map) — o gateway confia nela uma
  // vez aqui, mas cada nó da malha P2P precisa poder re-verificar sozinho quando essa
  // mesma assinatura chegar via gossip (ver GossipRegistry.mergeSites no app).
  sites.set(domain, {
    ownerPubkeyB58, routes: routeMap, routesRaw: routes, signatureB64,
    version: isV2 ? version : 0, legacySignatureB64: isV2 ? (legacySignatureB64 || null) : null, updatedAt: Date.now(),
  });
  scheduleSave();
}

function resolveSite(domain, path) {
  const site = sites.get(domain);
  if (!site) return null;
  return site.routes.get(path) || site.routes.get('/') || null;
}

function listSites() { return [...sites.keys()]; }
function getSiteFull(domain) { return sites.get(domain) || null; }

// ---- Cache de borda (edge.js): cópias extras de um arquivo k=1 em celulares perto de
// quem pede. Ficam NO registro do arquivo (file.edgeReplicas) e não em block.placements
// de propósito: placements é o contrato do publish (e vai pro gossip da malha); réplica
// de borda é efêmera e gerenciada só pelo gateway.
//   edgeReplicas: [{ nodeId (peer lógico), relayNodeId, shardIndex, createdAt, lastHitAt, region, bytes }]
// Cada réplica guarda TODOS os blocos, com a chave `${fileId}_b${i}_s${shardIndex}`.
function getEdgeReplicas(fileId) {
  const f = files.get(fileId);
  return (f && f.edgeReplicas) || [];
}
function addEdgeReplica(fileId, rep) {
  const f = files.get(fileId);
  if (!f) throw new Error('arquivo não encontrado pra registrar réplica de borda');
  f.edgeReplicas = (f.edgeReplicas || []).filter((r) => r.nodeId !== rep.nodeId);
  f.edgeReplicas.push(rep);
  scheduleSave();
}
function removeEdgeReplica(fileId, nodeId) {
  const f = files.get(fileId);
  if (!f || !f.edgeReplicas) return false;
  const before = f.edgeReplicas.length;
  f.edgeReplicas = f.edgeReplicas.filter((r) => r.nodeId !== nodeId);
  if (f.edgeReplicas.length === before) return false;
  scheduleSave();
  return true;
}
// Só em memória (não grava disco a cada visita); vai no próximo save de qualquer outra coisa.
function touchEdgeReplica(fileId, nodeId) {
  const r = getEdgeReplicas(fileId).find((x) => x.nodeId === nodeId);
  if (r) r.lastHitAt = Date.now();
}
// Acha (ou cria) o peer lógico do registry que corresponde a esse celular.
function ensureRelayPeer(relayNodeId) {
  for (const p of peers.values()) {
    if (p.transport === 'relay' && p.relayNodeId === relayNodeId) return p;
  }
  addRelayPeer(`edge-${relayNodeId}`, relayNodeId);
  return peers.get(`edge-${relayNodeId}`);
}

module.exports = {
  addPeer, addRelayPeer, getPeer, listPeers, removePeer,
  registerFile, getFile, listFiles, deleteFile,
  getEdgeReplicas, addEdgeReplica, removeEdgeReplica, touchEdgeReplica, ensureRelayPeer,
  registerSite, resolveSite, listSites, getSiteFull, canonicalManifest,
  setOnDataSaved, DATA_FILE,
};
