// Responde a pergunta "os sites que já publiquei no gateway vão aparecer no
// navegador P2P?": SEM isso, não — o `sites` do gateway (registry.js) e o `sites`
// do GossipRegistry.kt (dentro do app) são dois mapas completamente separados, sem
// nenhuma sincronização automática entre eles. O publisher hoje só fala com o
// gateway (POST /admin/sites), nunca com um nó de verdade.
//
// Este módulo fecha esse elo: entra no MESMO signaling que os nós já usam (como
// "só mais um nodeId", igual o publisher já faz pra enviar shard via relay — ver
// relayTransport.js) e manda um `gossip` com os sites pra UM nó vivo. Só precisa
// injetar em um: a partir daí o gossipRound() de 6 em 6s de cada nó (GossipRegistry.kt)
// espalha pro resto da malha sozinho, peer a peer — o gateway não fica no meio depois
// desse primeiro empurrão.
const { connectRelay, gossipViaRelay } = require('./relayTransport');
const registry = require('./registry');

// Formato IDÊNTICO ao que GossipRegistry.serializeSites()/mergeSites() (Kotlin)
// esperam. fileKeyB64 vem do arquivo (admin/files) — só é preenchido se quem
// publicou o site também publicou a chave (decisão deliberada, ver comentário em
// cima de `files` no topo deste arquivo).
function buildSiteGossipEntry(domain) {
  const site = registry.getSiteFull(domain);
  if (!site) return null;
  if (!site.signatureB64 || !site.routesRaw) {
    // site registrado ANTES desta mudança (sem signatureB64/routesRaw persistidos) —
    // precisa ser republicado (publishSite.js de novo) pra poder entrar na malha.
    return null;
  }
  const routes = site.routesRaw.map((r) => {
    const file = registry.getFile(r.fileId);
    return {
      path: r.path,
      fileId: r.fileId,
      // v2: exatamente o que foi assinado (vazio continua vazio); v1: o default de sempre
      contentType: site.version > 0 ? (r.contentType || '') : (r.contentType || 'application/octet-stream'),
      // v2: a fileKey faz parte do que foi ASSINADO — manda exatamente a que está em routesRaw.
      // v1 (legado): não era assinada, então segue vindo do registry de arquivos.
      fileKeyB64: site.version > 0 ? (r.fileKeyB64 || '') : ((file && file.fileKeyB64) || ''),
    };
  });
  return {
    domain,
    ownerPubkeyB58: site.ownerPubkeyB58,
    routes,
    // v1 (legado): `signatureB64` é a única. v2: `signatureB64` continua sendo a assinatura v1 (apps
    // antigos só entendem esta) e `signatureV2B64` é a nova, que cobre versão e fileKey.
    signatureB64: site.version > 0 ? (site.legacySignatureB64 || '') : site.signatureB64,
    ...(site.version > 0 ? { signatureV2B64: site.signatureB64 } : {}),
    version: site.version || 0, // 0 = manifesto v1 (legado)
    updatedAt: site.updatedAt,
  };
}

// Lista TODOS os peers relay (celular) conhecidos pelo gateway, deduplicados por
// relayNodeId (vários nodeId lógicos de placement — node-0, snode-0, ... — podem
// apontar pro MESMO celular real; não faz sentido tentar o mesmo relayNodeId duas
// vezes). Nós puramente LAN/TCP (host/port diretos) não entram aqui — dá pra falar
// TCP direto com eles (ver shardTransport.js) — mas hoje 'gossip' só existe do lado
// relay/WebRTC deste módulo.
//
// ANTES: pickRelayPeer() pegava só o PRIMEIRO peer relay do Map (ordem de inserção,
// que é a ordem em que foi carregado do disco / registrado historicamente) e nunca
// tentava outro. Resultado: um peer fantasma registrado há muito tempo (ex:
// node-221326) sempre "ganhava" a escolha, mesmo com peers novos e online
// registrados depois via /admin/peers — o gateway nem chegava a tentá-los.
function listRelayPeers() {
  const seen = new Set();
  const result = [];
  for (const p of registry.listPeers()) {
    if (p.transport !== 'relay' || !p.relayNodeId) continue;
    if (seen.has(p.relayNodeId)) continue;
    seen.add(p.relayNodeId);
    result.push(p);
  }
  return result;
}

// Tenta cada peer relay conhecido, em ordem, até um responder com sucesso.
// `send` recebe (client, peer) e deve retornar o resultado em caso de sucesso —
// erros (peer_offline, timeout, etc) fazem passar pro próximo candidato.
async function tryRelayPeers(signalingUrl, send) {
  const candidates = listRelayPeers();
  if (candidates.length === 0) {
    return { ok: false, reason: 'nenhum nó (celular) conhecido pelo gateway no momento — precisa de pelo menos um online' };
  }

  const failures = [];
  for (const peer of candidates) {
    const client = await connectRelay(signalingUrl, `hosting-platform-mesh-bridge-${Date.now()}`);
    try {
      const result = await send(client, peer);
      return { ok: true, ...result };
    } catch (e) {
      failures.push(`${peer.relayNodeId}: ${e.message}`);
    } finally {
      client.close();
    }
  }

  return {
    ok: false,
    reason: `nenhum dos ${candidates.length} peer(s) relay conhecido(s) respondeu — ${failures.join('; ')}`,
  };
}

// domains: lista de domínios pra empurrar, ou undefined/null pra empurrar TODOS os
// sites conhecidos pelo gateway (backfill de tudo que já foi publicado antes desta
// ponte existir).
async function announceSitesToMesh(signalingUrl, domains) {
  const targets = domains && domains.length ? domains : registry.listSites();
  const entries = targets.map(buildSiteGossipEntry).filter(Boolean);
  if (entries.length === 0) {
    return { ok: false, reason: 'nenhum site com signature/rotas guardadas pra empurrar (republique com publishSite.js)' };
  }

  // Precisa começar com um prefixo que o signaling reconhece como infra
  // (ver isInfraNodeId em server.js: só INFRA_NODE_IDS, 'publisher-' ou
  // 'hosting-platform-' escapam da exigência de assinatura Ed25519 no
  // register). Sem isso o server responde 'register_unauthorized' pra essa
  // conexão (silenciosamente do ponto de vista de quem chama backfill-mesh),
  // e todo 'relay' subsequente pro celular nunca sai — daí o timeout mesmo
  // com o celular 100% online. mesmo prefixo que hosting/gateway-client/
  // publish.cjs já usa com sucesso pra esse tipo de conexão.
  return tryRelayPeers(signalingUrl, async (client, peer) => {
    const header = await gossipViaRelay(client, peer.relayNodeId, entries);
    return { sentTo: peer.relayNodeId, sitesPushed: entries.length, response: header };
  });
}

// MESMO problema dos sites, mas do lado do arquivo: `putShardViaRelay` (ver
// relayTransport.js/publish.cjs) só manda os BYTES do shard pro node (op 'put'),
// que só grava em disco (ShardRequestHandler.handlePut, Kotlin) — nunca chama
// registry.registerFile(meta), então a FileMeta (blocos/placements/k/m/n) nunca
// entra no GossipRegistry.files desse node, nunca espalha via gossipRound(), e o
// navegador nunca aprende que o arquivo existe — mesmo com o SITE já lá (porque
// site e arquivo são coisas gossipadas separadamente). Formato IDÊNTICO ao que
// GossipRegistry.serializeFiles()/mergeFiles() (Kotlin) esperam; campos extras
// como shardHash são ignorados pelo parser Kotlin (org.json só lê o que pede),
// então dá pra passar o manifesto do gateway quase como está.
// Fura essa lacuna: a malha P2P Kotlin (GossipRegistry.downloadBlock, no navegador)
// faz match LITERAL de placement.nodeId contra os peers reais que aprendeu via
// gossip de peers — que são sempre identificados pelo relayNodeId (o nodeId que o
// celular usou de verdade pra se registrar no signaling), nunca pelo nodeId lógico
// que o publish.cjs usa como label de placement (ex: "node-0"). Sem essa tradução,
// o navegador nunca encontra o peer dono do shard — mesmo com a FileMeta já tendo
// chegado via gossip — e o download falha pra sempre com "só consegui 0 de N shards".
function resolvePlacementNodeId(nodeId) {
  const peer = registry.getPeer(nodeId);
  if (peer && peer.transport === 'relay' && peer.relayNodeId) return peer.relayNodeId;
  return nodeId; // peer TCP direto (host/port) ou não encontrado: mantém como está
}

function buildFileGossipEntry(fileId) {
  const file = registry.getFile(fileId);
  if (!file) return null;
  return {
    fileId: file.fileId,
    fileName: file.fileName,
    k: file.k,
    m: file.m,
    n: file.n,
    blockSize: file.blockSize,
    originalLength: file.originalLength,
    blocks: file.blocks.map((b) => ({
      ...b,
      placements: (b.placements || []).map((p) => ({ ...p, nodeId: resolvePlacementNodeId(p.nodeId) })),
    })),
    // Corresponde ao GossipRegistry.kt/mergeFiles() (fix do bug "placement travado
    // pra sempre"): sem isso o navegador nunca aceita a correção de nodeId feita
    // aqui, porque o fileId já era conhecido dele com um placement antigo. Usa
    // file.updatedAt se o registry.js já tiver esse campo; senão Date.now() garante
    // que ESTE empurrão específico sempre vença qualquer cache antigo sem o campo.
    updatedAt: file.updatedAt || Date.now(),
  };
}

// fileIds: lista de arquivos pra empurrar, ou undefined/null pra empurrar TODOS os
// arquivos conhecidos pelo gateway.
async function announceFilesToMesh(signalingUrl, fileIds) {
  const targets = fileIds && fileIds.length ? fileIds : registry.listFiles();
  const entries = targets.map(buildFileGossipEntry).filter(Boolean);
  if (entries.length === 0) {
    return { ok: false, reason: 'nenhum arquivo conhecido pelo gateway pra empurrar' };
  }

  return tryRelayPeers(signalingUrl, async (client, peer) => {
    const header = await gossipViaRelay(client, peer.relayNodeId, [], { files: entries });
    return { sentTo: peer.relayNodeId, filesPushed: entries.length, response: header };
  });
}

module.exports = { announceSitesToMesh, buildSiteGossipEntry, announceFilesToMesh, buildFileGossipEntry };
