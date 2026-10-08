// Reconstrói um arquivo (vídeo) que foi quebrado em N blocos na publicação
// (blockSize fixo, independente de k) inteiramente via P2P — sem passar
// pela banda do gateway/VPS em nenhum momento pro peso real (a mídia).
//
// Espelha exatamente sever/gateway/content.js (fetchBlockPlaintext), do lado
// do navegador: como o publish sempre usa k=1 pra vídeo VOD (replicado, não
// fatiado por Reed-Solomon de verdade — ver comentário em gateway.js na rota
// /p2p/:fileId), cada shard já É uma cópia inteira do bloco cifrado. Isso
// deixa reedSolomon.decode() com k=1 igual à identidade (confirmado no
// reedSolomon.js: matriz de Vandermonde com k=1 gera só multiplicadores 1,
// então decode() == pegar 1 shard qualquer e truncar em plainLength) — por
// isso essa função NÃO porta reedSolomon.js: pula direto pro shard bruto.
// Se um dia existir vídeo com k>1 de verdade, isso precisa ganhar o decode
// GF(256) completo (é outra função, separada, não misturar aqui).

function shardKeyFor(fileId, blockIndex, shardIndex) {
  return `${fileId}_b${blockIndex}_s${shardIndex}`;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function importAesKey(rawKeyBytes) {
  // FIX: sem essa checagem, contexto inseguro (HTTP em vez de HTTPS/
  // localhost) faz `crypto.subtle` vir `undefined`, e a linha de baixo
  // quebrava com "Cannot read properties of undefined (reading
  // 'importKey')" — mensagem que não diz nada sobre a causa real.
  if (!crypto.subtle) {
    throw new Error('crypto.subtle indisponível — página precisa estar em HTTPS (ou localhost) pra descriptografar via Web Crypto');
  }
  if (rawKeyBytes.length !== 32) {
    throw new Error(`fileKeyB64 do manifesto tem ${rawKeyBytes.length} bytes decodificados, esperado 32 (AES-256) — manifesto corrompido ou vazio`);
  }
  return crypto.subtle.importKey('raw', rawKeyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
}

// Web Crypto espera o auth tag GRUDADO no final do ciphertext (um único
// blob). O Node (crypto.js do gateway) separa via decipher.setAuthTag() —
// mesma matemática, formato de chamada diferente — por isso o concat manual
// aqui em vez de só repassar block.authTag como está.
async function decryptBlock(cryptoKey, ciphertext, ivBytes, authTagBytes) {
  const combined = new Uint8Array(ciphertext.length + authTagBytes.length);
  combined.set(ciphertext, 0);
  combined.set(authTagBytes, ciphertext.length);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBytes, tagLength: 128 },
    cryptoKey,
    combined
  );
  return new Uint8Array(plain);
}

/**
 * Busca o bilhete `/p2p/:fileId` do gateway. É só metadata (JSON pequeno) —
 * não é a banda do vídeo em si, então ir por HTTP aqui não quebra a
 * promessa de "vídeo 100% P2P": o que pesa (os blocos) ainda vem todo dos
 * peers depois disso.
 * @param {string} manifestUrl
 */
export async function fetchP2PManifest(manifestUrl) {
  const res = await fetch(manifestUrl, { cache: 'no-store' });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch {}
    throw new Error(`manifesto /p2p/ respondeu ${res.status}${detail ? ' — ' + detail : ''}`);
  }
  const manifest = await res.json();
  if (!manifest.ok) throw new Error(manifest.error || 'manifesto /p2p/ retornou ok:false');
  if (!manifest.blocks || !manifest.blocks.length) throw new Error('manifesto sem blocks');
  if (!manifest.candidates || !manifest.candidates.length) {
    throw new Error('manifesto sem candidatos relay — nenhum peer alcançável via WebRTC pra esse arquivo agora');
  }
  // URL do beacon de métricas (relativa ao gateway que emitiu o bilhete). Carrega junto o
  // ?geo= da demo, se houver, pra região do beacon bater com a do manifesto.
  try {
    const base = new URL(manifestUrl, typeof location !== 'undefined' ? location.href : undefined);
    if (manifest.metricsUrl) {
      const m = new URL(manifest.metricsUrl, base);
      const g = base.searchParams.get('geo');
      if (g) m.searchParams.set('geo', g);
      manifest._metricsUrl = m.href;
    }
  } catch (_) { /* sem beacon: não é crítico */ }
  return manifest;
}

/**
 * Candidates em ordem de proximidade (o gateway já manda assim). Mostra no log de onde
 * vai servir e manda o P2PManager discar só os primeiros, em vez de todos.
 */
export function prepareCandidates(p2p, manifest, { maxDial = 3, onLog = () => {} } = {}) {
  const c = manifest.candidates;
  onLog('candidatos (mais perto primeiro):', c.map((x) =>
    `${x.relayNodeId}${x.edge ? ' [borda]' : ''}${x.region ? ' ' + x.region : ''}${x.distanceKm != null ? ' ' + x.distanceKm + 'km' : ''}${x.online === false ? ' [offline]' : ''}`
  ).join(' | '));
  if (typeof p2p.setPreferredPeers === 'function') {
    p2p.setPreferredPeers(c.filter((x) => x.online !== false).map((x) => x.relayNodeId), { max: maxDial });
  }
}

/**
 * Soma o que veio direto dos celulares e manda UM beacon pro gateway (/metrics/player),
 * pro painel mostrar "% servido por P2P". Melhor esforço: nunca lança, nunca bloqueia.
 */
// window/document de ambientes não-padrão (embeds, testes em Node) podem não ter addEventListener.
const listen = (t, ev, fn) => { try { if (t && typeof t.addEventListener === 'function') t.addEventListener(ev, fn); } catch (_) {} };
const unlisten = (t, ev, fn) => { try { if (t && typeof t.removeEventListener === 'function') t.removeEventListener(ev, fn); } catch (_) {} };

export class P2PReporter {
  constructor(manifest) {
    this.url = manifest._metricsUrl || null;
    this.fileId = manifest.fileId;
    this.bytes = 0; this.blocks = 0; this.edgeBlocks = 0;
    this.nodes = {};
    this.t0 = Date.now();
    this._sent = false;
  }
  add(bytes, cand) {
    this.bytes += bytes; this.blocks += 1;
    if (cand && cand.edge) this.edgeBlocks += 1;
    if (cand && cand.relayNodeId) this.nodes[cand.relayNodeId] = (this.nodes[cand.relayNodeId] || 0) + 1;
  }
  flush() {
    if (!this.url || this.blocks === 0) return;
    const body = JSON.stringify({
      fileId: this.fileId, bytes: this.bytes, blocks: this.blocks,
      edgeBlocks: this.edgeBlocks, ms: Date.now() - this.t0, nodes: this.nodes
    });
    try {
      // text/plain = requisição CORS "simples" (sem preflight), o que sendBeacon exige pra funcionar entre origens
      const blob = new Blob([body], { type: 'text/plain' });
      if (!(typeof navigator !== 'undefined' && navigator.sendBeacon && navigator.sendBeacon(this.url, blob))) {
        fetch(this.url, { method: 'POST', body, headers: { 'Content-Type': 'text/plain' }, keepalive: true, mode: 'cors' }).catch(() => {});
      }
    } catch (_) { /* melhor esforço */ }
    // zera pra um próximo flush mandar só o que veio depois (sem contar duas vezes)
    this.bytes = 0; this.blocks = 0; this.edgeBlocks = 0; this.nodes = {}; this.t0 = Date.now();
  }
}

/**
 * Busca os bytes cifrados de UM bloco. Tenta os candidates em ordem (já do mais perto ao
 * mais longe), pedindo SÓ àquele celular (peerId). Se nenhum responder — lista do bilhete
 * velha, por ex. —, último recurso: pergunta a quem tiver canal aberto (comportamento antigo).
 * @returns {Promise<{bytes:Uint8Array, cand:object}|null>}
 */
async function fetchBlockBytes(p2p, fileId, block, candidates, { timeoutMs, firstWaitMs, gotOne, onLog }) {
  for (let i = 0; i < candidates.length; i++) {
    const cand = candidates[i];
    const key = shardKeyFor(fileId, block.blockIndex, cand.shardIndex);
    let wait = gotOne ? 500 : (i === 0 ? firstWaitMs : Math.min(firstWaitMs, 2000));
    if (cand.online === false) wait = Math.min(wait, 500); // o gateway já viu esse celular cair
    onLog('bloco', block.blockIndex, '— tentando', key, 'via', cand.relayNodeId);
    const bytes = await p2p.fetchShard(key, { timeoutMs, waitForPeersMs: wait, peerId: cand.relayNodeId });
    if (bytes) return { bytes, cand };
  }
  const seen = new Set();
  for (const cand of candidates) {
    if (seen.has(cand.shardIndex)) continue;
    seen.add(cand.shardIndex);
    const key = shardKeyFor(fileId, block.blockIndex, cand.shardIndex);
    onLog('bloco', block.blockIndex, '— último recurso: qualquer peer com canal aberto,', key);
    const bytes = await p2p.fetchShard(key, { timeoutMs, waitForPeersMs: 500 });
    if (bytes) return { bytes, cand: { ...cand, relayNodeId: null, edge: false } };
  }
  return null;
}

/**
 * Busca TODOS os blocos do arquivo via P2P (WebRTC), descriptografa cada um
 * e concatena na ordem certa.
 * @param {import('./p2pSource.js').P2PManager} p2p
 * @param {object} manifest - retorno de fetchP2PManifest()
 * @param {{
 *   onProgress?: (done:number, total:number) => void,
 *   onLog?: (...a:any[]) => void,
 *   perBlockTimeoutMs?: number,
 *   waitForPeersMs?: number
 * }} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function fetchFileP2P(p2p, manifest, opts = {}) {
  const {
    onProgress = () => {},
    onLog = () => {},
    perBlockTimeoutMs = 15000,
    waitForPeersMs = 4000
  } = opts;

  if (!manifest.fileKeyB64) {
    throw new Error('manifesto sem fileKeyB64 — arquivo não publicado com chave pra acesso via gateway/P2P');
  }
  const cryptoKey = await importAesKey(b64ToBytes(manifest.fileKeyB64));
  const blocks = manifest.blocks.slice().sort((a, b) => a.blockIndex - b.blockIndex);
  const total = blocks.length;
  const decrypted = new Array(total);
  let doneCount = 0;

  prepareCandidates(p2p, manifest, { onLog });
  const reporter = new P2PReporter(manifest);

  // Sequencial de propósito: na prática os blocos tendem a estar todos
  // no(s) mesmo(s) peer(s) (replica inteira do arquivo, não espalhada por
  // bloco) — paralelizar só sobrecarregaria o mesmo data channel sem ganho
  // real, e complica progresso/erro por bloco.
  for (const block of blocks) {
    let ciphertext = null;
    let usedShardIndex = null;
    let usedNodeId = null;

    const got = await fetchBlockBytes(p2p, manifest.fileId, block, manifest.candidates, {
      timeoutMs: perBlockTimeoutMs,
      // só espera peer "aparecer" no signaling no 1º bloco — dos demais
      // em diante a sessão WebRTC já deve estar de pé.
      firstWaitMs: waitForPeersMs,
      gotOne: doneCount > 0,
      onLog
    });
    if (got) {
      ciphertext = got.bytes.subarray(0, block.plainLength);
      usedShardIndex = got.cand.shardIndex;
      usedNodeId = got.cand.relayNodeId;
      reporter.add(got.bytes.byteLength, got.cand);
      if (opts.onServed) opts.onServed({ ...got.cand, block: block.blockIndex });
    }

    if (!ciphertext) {
      reporter.flush();
      throw new Error(
        `bloco ${block.blockIndex}/${total}: nenhum candidato respondeu (tentados: ${manifest.candidates
          .map((c) => c.relayNodeId)
          .join(', ')})`
      );
    }

    onLog('bloco', block.blockIndex, '— recebido de', usedNodeId, `shardIndex ${usedShardIndex} (${ciphertext.length} bytes cifrados), descriptografando...`);
    try {
      decrypted[block.blockIndex] = await decryptBlock(
        cryptoKey,
        ciphertext,
        b64ToBytes(block.iv),
        b64ToBytes(block.authTag)
      );
    } catch (e) {
      throw new Error(`bloco ${block.blockIndex}/${total}: falha ao descriptografar (chave/iv/authTag não batem com o shard recebido) — ${e && e.message}`);
    }

    doneCount += 1;
    onProgress(doneCount, total);
  }

  reporter.flush();
  let totalLength = 0;
  for (const b of decrypted) totalLength += b.length;
  const full = new Uint8Array(totalLength);
  let offset = 0;
  for (const b of decrypted) {
    full.set(b, offset);
    offset += b.length;
  }
  return full;
}

/**
 * Leitor de blocos SOB DEMANDA — base do streaming progressivo (MSE).
 *
 * Diferente de fetchFileP2P (que baixa tudo e devolve o arquivo inteiro),
 * aqui nada é baixado até alguém pedir um intervalo de bytes. Como cada bloco
 * é cifrado de forma independente (AES-GCM com iv/authTag próprios, sem
 * encadeamento), qualquer bloco pode ser buscado e decifrado isoladamente, em
 * qualquer ordem — é isso que torna seek em vídeo longo possível.
 *
 * Mantém um cache LRU pequeno (alguns blocos) e faz prefetch dos próximos
 * blocos em paralelo: cada bloco é uma ida-e-volta pelo data channel, então
 * ler em série limitaria a vazão a (tamanho do bloco / RTT).
 */
export class P2PBlockReader {
  /**
   * @param {import('./p2pSource.js').P2PManager} p2p
   * @param {object} manifest - retorno de fetchP2PManifest()
   * @param {{
   *   onLog?: Function,
   *   onBlock?: (fetched:number, total:number) => void,
   *   perBlockTimeoutMs?: number,
   *   waitForPeersMs?: number,
   *   maxAttempts?: number,
   *   prefetchBlocks?: number,
   *   cacheBlocks?: number
   * }} [opts]
   */
  constructor(p2p, manifest, opts = {}) {
    this.p2p = p2p;
    this.manifest = manifest;
    this.onLog = opts.onLog || (() => {});
    this.onBlock = opts.onBlock || (() => {});
    this.perBlockTimeoutMs = opts.perBlockTimeoutMs ?? 15000;
    this.waitForPeersMs = opts.waitForPeersMs ?? 4000;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.prefetchBlocks = opts.prefetchBlocks ?? 3;
    this.cacheBlocks = opts.cacheBlocks ?? this.prefetchBlocks + 6;
    this._cache = new Map(); // posição do bloco -> Promise<Uint8Array>
    this._candidates = manifest.candidates.slice();
    this.onServed = opts.onServed || (() => {});
    this._lastServedNode = null;
    this.reporter = new P2PReporter(manifest);
    prepareCandidates(p2p, manifest, { onLog: this.onLog });
    // quem fecha a aba/troca de página não passa por destroy(): manda o beacon aí também
    this._onHide = () => this.reporter.flush();
    this._onVis = () => { if (document.visibilityState === 'hidden') this._onHide(); };
    listen(typeof document !== 'undefined' ? document : null, 'visibilitychange', this._onVis);
    listen(typeof window !== 'undefined' ? window : null, 'pagehide', this._onHide);
    this._gotOne = false;
    this._destroyed = false;
    this.fetched = 0;
  }

  async init() {
    if (!this.manifest.fileKeyB64) {
      throw new Error('manifesto sem fileKeyB64 — arquivo não publicado com chave pra acesso via gateway/P2P');
    }
    this.cryptoKey = await importAesKey(b64ToBytes(this.manifest.fileKeyB64));
    this.blocks = this.manifest.blocks.slice().sort((a, b) => a.blockIndex - b.blockIndex);
    this.offsets = new Array(this.blocks.length + 1);
    this.offsets[0] = 0;
    for (let i = 0; i < this.blocks.length; i++) {
      if (this.blocks[i].blockIndex !== i) {
        throw new Error(`manifesto com blocos não contíguos (esperado blockIndex ${i}, veio ${this.blocks[i].blockIndex})`);
      }
      this.offsets[i + 1] = this.offsets[i] + this.blocks[i].plainLength;
    }
    this.total = this.offsets[this.blocks.length];
  }

  /** Posição (índice no array) do bloco que contém o byte `offset`. */
  blockAt(offset) {
    let lo = 0;
    let hi = this.blocks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** Lê [start, end) do arquivo decifrado (busca só os blocos necessários). */
  async read(start, end) {
    end = Math.min(end, this.total);
    if (start < 0 || start >= end) return new Uint8Array(0);
    const first = this.blockAt(start);
    const last = this.blockAt(end - 1);
    const parts = [];
    for (let i = first; i <= last; i++) parts.push(this._get(i));
    this.prefetch(last + 1);
    const blocks = await Promise.all(parts);
    if (first === last) return blocks[0].subarray(start - this.offsets[first], end - this.offsets[first]);
    const out = new Uint8Array(end - start);
    let o = 0;
    for (let k = 0; k < blocks.length; k++) {
      const pos = first + k;
      const from = Math.max(start, this.offsets[pos]) - this.offsets[pos];
      const to = Math.min(end, this.offsets[pos + 1]) - this.offsets[pos];
      out.set(blocks[k].subarray(from, to), o);
      o += to - from;
    }
    return out;
  }

  /** Dispara (sem esperar) a busca dos próximos blocos a partir de `pos`. */
  prefetch(pos) {
    for (let i = pos; i < pos + this.prefetchBlocks && i < this.blocks.length; i++) {
      this._get(i).catch(() => {});
    }
  }

  _get(pos) {
    let p = this._cache.get(pos);
    if (p) {
      // toca no LRU: reinsere no fim
      this._cache.delete(pos);
      this._cache.set(pos, p);
      return p;
    }
    p = this._fetchBlock(pos);
    this._cache.set(pos, p);
    p.catch(() => {
      if (this._cache.get(pos) === p) this._cache.delete(pos); // erro não fica em cache: próxima leitura tenta de novo
    });
    while (this._cache.size > this.cacheBlocks) {
      this._cache.delete(this._cache.keys().next().value);
    }
    return p;
  }

  async _fetchBlock(pos) {
    const block = this.blocks[pos];
    const total = this.blocks.length;
    let lastErr = null;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (this._destroyed) throw new Error('leitor P2P destruído');
      const got = await fetchBlockBytes(this.p2p, this.manifest.fileId, block, this._candidates, {
        timeoutMs: this.perBlockTimeoutMs,
        firstWaitMs: this.waitForPeersMs,
        gotOne: this._gotOne,
        onLog: this.onLog
      });
      if (got) {
        const cand = got.cand;
        try {
          const plain = await decryptBlock(
            this.cryptoKey,
            got.bytes.subarray(0, block.plainLength),
            b64ToBytes(block.iv),
            b64ToBytes(block.authTag)
          );
          this._gotOne = true;
          // Quem respondeu sobe pro topo SÓ se não for o "último recurso" (relayNodeId null) —
          // senão perderia a ordem de proximidade que o gateway calculou.
          if (cand.relayNodeId) {
            const real = this._candidates.find((c) => c.relayNodeId === cand.relayNodeId && c.shardIndex === cand.shardIndex);
            if (real) this._candidates = [real, ...this._candidates.filter((c) => c !== real)];
          }
          this.reporter.add(got.bytes.byteLength, cand);
          if (cand.relayNodeId !== this._lastServedNode) {
            this._lastServedNode = cand.relayNodeId;
            this.onServed({ ...cand, block: pos }); // ex.: "servido de Campinas, 12 km"
          }
          this.fetched += 1;
          this.onBlock(this.fetched, total);
          return plain;
        } catch (e) {
          lastErr = e;
          this.onLog('bloco', pos, 'falha ao descriptografar via', cand.relayNodeId, e && e.message);
        }
      }
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
    throw new Error(
      `bloco ${pos}/${total}: nenhum candidato respondeu após ${this.maxAttempts} tentativas` +
        (lastErr ? ` (último erro: ${lastErr.message})` : '')
    );
  }

  destroy() {
    this._destroyed = true;
    this._cache.clear();
    try { this.reporter.flush(); } catch (_) { /* melhor esforço */ }
    unlisten(typeof window !== 'undefined' ? window : null, 'pagehide', this._onHide);
    unlisten(typeof document !== 'undefined' ? document : null, 'visibilitychange', this._onVis);
  }
}
