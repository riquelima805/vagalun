import { SignalingClient, SIGNALING_URL } from './signalingClient.js';
import { WebRtcManager } from './webrtcManager.js';

// IMPORTANTE: o prefixo tem que ser exatamente "viewer-" — é o que
// server.js (isInfraNodeId) reconhece como "visitante anônimo do player web,
// sem wallet" e isenta da exigência de assinatura Ed25519 (pubkey+sig) que
// existe pra nó de armazenamento de verdade provar posse do nodeId. Usar
// qualquer outro prefixo (ex.: "player-") cai no caminho normal do
// anti-hijack, o servidor devolve `register_unauthorized` (sem pubkey/sig
// pra mandar), o register nunca completa, e o player nunca aparece na lista
// de peers de ninguém — é o bug "P2P sempre cai pra HTTP" na causa raiz.
function randomNodeId() {
  return `viewer-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

// Log de debug: DESLIGADO por padrão (senão todo visitante do site polui o console).
// Liga com ?vglDebug=1 na URL ou localStorage.setItem('vgl:debug', '1').
function debugEnabledByDefault() {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('vglDebug') === '1') return true;
  } catch (_) { /* sem location (SSR/worker) */ }
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('vgl:debug') === '1') return true;
  } catch (_) { /* localStorage bloqueado */ }
  return false;
}

/**
 * Gerencia a conexão P2P do player: um SignalingClient (wss fixo) + um
 * WebRtcManager (mesmo protocolo do browser Android). Fica vivo entre trocas
 * de fonte pra não reconectar/renegociar do zero a cada vídeo.
 *
 * `fetchShard(shardKey)` busca UM shard *como está armazenado no peer*
 * (mesmo `op:"get"` do ShardRequestHandler.kt) — é o primitivo de baixo
 * nível usado tanto pelo modo legado (shard único) quanto, bloco a bloco,
 * pelo modo manifesto multi-bloco (ver src/p2p/p2pFile.js, que faz a
 * reconstrução de arquivo inteiro: busca cada bloco, descriptografa
 * AES-256-GCM e concatena). Essa classe aqui não sabe nada de blocos,
 * criptografia ou manifesto — só fala WebRTC/protocolo binário com os peers.
 */
export class P2PManager {
  constructor({ nodeId, signalingUrl = SIGNALING_URL, debug = debugEnabledByDefault(), iceServers } = {}) {
    this.nodeId = nodeId || randomNodeId();
    this.debug = debug;
    this.peers = new Set();      // peers pra quem JÁ discamos
    this._known = new Set();     // peers que o signaling listou (discados ou não)
    this._lazy = false;          // true depois de setPreferredPeers(): só disca quem importa
    this._wanted = new Set();
    this.transports = new Map(); // peerNodeId -> WebRtcTransport
    this._connectPromise = null;
    this._log = debug ? (...a) => console.log('[vagalun-p2p]', ...a) : () => {};
    if (debug) this._log('instância criada — nodeId:', this.nodeId, 'signalingUrl:', signalingUrl);

    this.signaling = new SignalingClient({ selfNodeId: this.nodeId, url: signalingUrl, debug });
    this.rtc = new WebRtcManager(this.signaling, {
      debug,
      iceServers, // undefined = usa defaultIceServers() (só STUN); passe TURN aqui quando tiver
      onTransportReady: (peerId, transport) => {
        this.transports.set(peerId, transport);
        this._log('transport pronto com', peerId, '— total de peers com canal aberto:', this.transports.size);
      },
      onTransportClosed: (peerId) => {
        this.transports.delete(peerId);
        this._log('transport fechado com', peerId);
      }
    });

    this.signaling.onPeerList = (nodeIds) => {
      this._log('peers conhecidos:', nodeIds);
      nodeIds.forEach((id) => this._addPeer(id));
    };
    this.signaling.onPeerJoined = (id) => this._addPeer(id);
    this.signaling.onPeerLeft = (id) => {
      this.peers.delete(id);
      this._known.delete(id);
      this.rtc.disconnect(id);
    };
    this.signaling.onError = (reason, detail) => {
      this._log('erro do signaling:', reason, detail);
    };
    this.signaling.onStateChange = (connected) => {
      this._log(connected ? 'conectado ao signaling' : 'desconectado do signaling');
    };
  }

  _addPeer(id) {
    if (id === this.nodeId) return;
    this._known.add(id);
    if (this._lazy && !this._wanted.has(id)) return; // fora do topo da lista: só disca se precisar
    this._dial(id);
  }

  _dial(id) {
    if (this.peers.has(id)) return;
    this.peers.add(id);
    this._log('discou pro peer', id, '(via signaling)');
    this.rtc.connectToPeer(id);
  }

  /**
   * Passa a discar só os `max` primeiros da lista (os mais perto, na ordem do bilhete
   * /p2p) em vez de TODOS que o signaling listar. Os demais ficam sob demanda
   * (ensurePeer), quando o fallback precisar deles.
   * @param {string[]} peerIds relayNodeId dos candidates, do mais perto ao mais longe
   */
  setPreferredPeers(peerIds, { max = 3 } = {}) {
    this._lazy = true;
    for (const id of peerIds.slice(0, max)) this.ensurePeer(id);
  }

  /** Garante que estamos discando esse peer (se o signaling já o conhece, disca agora; senão, quando ele entrar). */
  ensurePeer(id) {
    this._wanted.add(id);
    if (this._known.has(id)) this._dial(id);
  }

  /** Garante que o signaling está conectado. Idempotente. */
  connect() {
    if (!this._connectPromise) {
      this._log('connect() chamado, subindo signaling...');
      this._connectPromise = new Promise((resolve) => {
        if (this.signaling.connected) return resolve();
        const prev = this.signaling.onStateChange;
        this.signaling.onStateChange = (connected) => {
          prev?.(connected);
          if (connected) resolve();
        };
        this.signaling.connect();
      });
    }
    return this._connectPromise;
  }

  /**
   * Busca um shard/arquivo pelos peers atualmente conectados, em paralelo,
   * usando o primeiro que responder com sucesso.
   * @param {string} shardKey
   * @param {{ timeoutMs?: number, waitForPeersMs?: number }} [opts]
   * @returns {Promise<Uint8Array|null>}
   */
  async fetchShard(shardKey, { timeoutMs = 12000, waitForPeersMs = 4000, peerId = null } = {}) {
    // Com peerId: pede SÓ àquele celular (o escolhido pelo gateway por proximidade) em vez de
    // perguntar a todos e ficar com o 1º que responder. Sem canal aberto com ele, devolve null
    // e quem chamou tenta o próximo candidate.
    if (peerId) {
      await this.connect();
      this.ensurePeer(peerId);
      const t = await this._waitForPeer(peerId, waitForPeersMs);
      if (!t) {
        this._log('fetchShard() —', shardKey, '→ sem canal aberto com', peerId, '(offline ou ICE não fechou)');
        return null;
      }
      const one = await raceFirstSuccess([t.getShard(shardKey)], timeoutMs);
      this._log('fetchShard() fim —', shardKey, 'via', peerId, one ? `sucesso, ${one.byteLength} bytes` : 'sem resposta');
      return one;
    }
    this._log('fetchShard() início —', shardKey, `(espera até ${waitForPeersMs}ms por peer, timeout total ${timeoutMs}ms)`);
    await this.connect();
    this._log('signaling conectado?', this.signaling.connected, '— peers conhecidos até agora:', this.peers.size);
    await this._waitForAnyPeer(waitForPeersMs);

    const candidates = Array.from(this.transports.values()).filter((t) => t.open);
    this._log('candidatos com data channel aberto:', candidates.length, 'de', this.transports.size, 'sessões WebRTC totais e', this.peers.size, 'peers conhecidos pelo signaling');
    if (!candidates.length) {
      if (this.peers.size === 0) {
        this._log('DIAGNÓSTICO: signaling não retornou nenhum peer pra', shardKey, '— ou não tem ninguém com esse fileId anunciado, ou o signaling em si não conectou (confere connected acima).');
      } else {
        this._log('DIAGNÓSTICO: signaling achou', this.peers.size, 'peer(s), mas o WebRTC nunca abriu data channel com nenhum — provável falha de ICE (NAT/sem TURN). Confere oniceconnectionstatechange nos logs acima.');
      }
      return null;
    }

    const result = await raceFirstSuccess(
      candidates.map((t) => t.getShard(shardKey)),
      timeoutMs
    );
    this._log('fetchShard() fim —', shardKey, result ? `sucesso, ${result.byteLength} bytes` : 'nenhum candidato respondeu com o shard (peer conectado mas não tinha esse fileId, ou deu timeout)');
    return result;
  }

  /** Espera o data channel com UM peer abrir (até maxWaitMs). Resolve o transport ou null. */
  _waitForPeer(peerId, maxWaitMs) {
    const get = () => { const t = this.transports.get(peerId); return t && t.open ? t : null; };
    const now = get();
    if (now) return Promise.resolve(now);
    return new Promise((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const t = get();
        if (t || Date.now() - start > maxWaitMs) { clearInterval(timer); resolve(t); }
      }, 100);
    });
  }

  _waitForAnyPeer(maxWaitMs) {
    if (Array.from(this.transports.values()).some((t) => t.open)) return Promise.resolve();
    return new Promise((resolve) => {
      const start = Date.now();
      const timer = setInterval(() => {
        const hasOpen = Array.from(this.transports.values()).some((t) => t.open);
        if (hasOpen || Date.now() - start > maxWaitMs) {
          clearInterval(timer);
          resolve();
        }
      }, 150);
    });
  }

  disconnect() {
    this.rtc.disconnectAll();
    this.signaling.disconnect();
    this._connectPromise = null;
  }
}

async function raceFirstSuccess(promises, timeoutMs) {
  return new Promise((resolve) => {
    let remaining = promises.length;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, timeoutMs);

    promises.forEach((p) => {
      p.then((result) => {
        remaining -= 1;
        if (!settled && result) {
          settled = true;
          clearTimeout(timer);
          resolve(result);
        } else if (!settled && remaining === 0) {
          settled = true;
          clearTimeout(timer);
          resolve(null);
        }
      }).catch(() => {
        remaining -= 1;
        if (!settled && remaining === 0) {
          settled = true;
          clearTimeout(timer);
          resolve(null);
        }
      });
    });
  });
}

/** Monta uma Blob URL reproduzível a partir dos bytes buscados. */
export function bytesToObjectUrl(bytes, mimeType = 'video/mp4') {
  const blob = new Blob([bytes], { type: mimeType });
  return URL.createObjectURL(blob);
}
