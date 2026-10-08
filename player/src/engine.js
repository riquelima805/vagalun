// Engine de reprodução: decide COMO tocar cada fonte.
//
// Estratégia (reflete a arquitetura: cache -> peers -> CDN gateway -> nós):
//  - `sources` é uma lista ordenada de candidatos. O engine tenta o primeiro;
//    se ele falhar (erro de rede, 404, stall persistente), passa pro próximo
//    automaticamente, preservando currentTime/volume/estado.
//  - Cada fonte pode ser HLS (.m3u8) ou progressiva (mp4/webm) servida com
//    Range requests — exatamente o que o gateway (/raw/:fileId) já entrega
//    (Accept-Ranges + 206 Partial Content), então funciona sem HLS nenhum.
//  - HLS só carrega hls.js via import() dinâmico quando necessário — em Safari
//    (que tem HLS nativo) nem baixa a lib.

import { P2PManager, bytesToObjectUrl } from './p2p/p2pSource.js';
import { fetchP2PManifest, fetchFileP2P } from './p2p/p2pFile.js';
import { P2PMseStream, MseUnsupportedError } from './p2p/mseSource.js';

const STALL_TIMEOUT_MS = 9000; // tempo parado em "waiting" antes de tentar próxima fonte
const MAX_RETRIES_PER_SOURCE = 2;

// Arquivo que NÃO é mp4 fragmentado só pode tocar baixando tudo e montando um
// Blob — o usuário fica num loading proporcional ao tamanho. Acima desse
// limite não vale a pena segurar o P2P: pula pra próxima fonte (HTTP com
// Range, que começa a tocar na hora). Override por fonte: p2pBlobMaxBytes.
const P2P_BLOB_MAX_BYTES = 48 * 1024 * 1024;

// Um P2PManager por signalingUrl, compartilhado pelo engine (evita reconectar
// no signaling a cada troca de fonte/vídeo). Conecta de fato só no primeiro uso.
//
// Por quê por-URL e não um único global: o gateway devolve `signalingUrl`
// dinâmico no bilhete de /p2p/:fileId (GATEWAY_SIGNALING_PUBLIC_URL varia por
// deploy/ambiente). Um manager só, fixo no default de p2pSource.js, conecta
// no signaling errado sempre que o site publicado usa outro — e nunca acha o
// peer que tem o fileId, mesmo com tudo mais certo.
const p2pManagersByUrl = new Map();
function getP2PManager(signalingUrl) {
  const key = signalingUrl || '__default__';
  let manager = p2pManagersByUrl.get(key);
  if (!manager) {
    manager = signalingUrl ? new P2PManager({ signalingUrl }) : new P2PManager();
    p2pManagersByUrl.set(key, manager);
  }
  return manager;
}

function isP2pSource(src, explicitType) {
  return explicitType === 'p2p';
}

function isHlsSource(src, explicitType) {
  if (explicitType === 'hls') return true;
  if (explicitType === 'mp4' || explicitType === 'progressive') return false;
  if (!src) return false;
  const clean = src.split('?')[0].toLowerCase();
  return clean.endsWith('.m3u8') || src.includes('mpegurl') || src.includes('type=application/x-mpegurl');
}

function nativeHlsSupport(video) {
  return video.canPlayType('application/vnd.apple.mpegurl') !== '';
}

/**
 * Baixa UM arquivo inteiro (k=1) direto dos celulares via WebRTC, a partir do bilhete /p2p/:fileId
 * de QUALQUER gateway. Usado pela ponte do Service Worker (vagalun-sw-bridge.js) como último recurso
 * quando todos os gateways HTTP estão fora. `ticket` pode ser a URL do bilhete ou o objeto já baixado.
 */
export async function fetchFileViaP2P(ticket, { signalingUrls, perBlockTimeoutMs = 15000, waitForPeersMs = 6000, onLog } = {}) {
  const manifest = typeof ticket === 'string' ? await fetchP2PManifest(ticket) : ticket;
  const urls = (signalingUrls && signalingUrls.length ? signalingUrls : manifest.signalingUrls) || [];
  const p2p = getP2PManager(urls.length ? urls[0] : manifest.signalingUrl);
  const bytes = await fetchFileP2P(p2p, manifest, { perBlockTimeoutMs, waitForPeersMs, onLog: onLog || p2p._log });
  return { bytes, contentType: manifest.contentType, fileId: manifest.fileId };
}

export class PlaybackEngine {
  constructor(videoEl, { onEvent, onQualityLevels } = {}) {
    this.video = videoEl;
    this.onEvent = onEvent || (() => {});
    this.onQualityLevels = onQualityLevels || (() => {});
    this.sources = [];
    this.sourceIndex = -1;
    this.hls = null;
    this._hlsModPromise = null;
    this._stallTimer = null;
    this._retries = 0;
    this._resumeTime = 0;
    this._destroyed = false;

    this._onWaiting = this._onWaiting.bind(this);
    this._onPlaying = this._onPlaying.bind(this);
    this._onErrorNative = this._onErrorNative.bind(this);

    this.video.addEventListener('waiting', this._onWaiting);
    this.video.addEventListener('playing', this._onPlaying);
    this.video.addEventListener('error', this._onErrorNative);
  }

  /** @param {Array<{src:string,type?:string,label?:string}>|string} sources */
  setSources(sources, { resumeTime = 0 } = {}) {
    const list = Array.isArray(sources) ? sources : [{ src: sources }];
    this.sources = list.filter((s) => s && s.src);
    this.sourceIndex = -1;
    this._resumeTime = resumeTime || 0;
    if (!this.sources.length) {
      this.onEvent('error', { fatal: true, reason: 'sem fontes configuradas' });
      return;
    }
    this._loadSourceAt(0);
  }

  _loadSourceAt(index) {
    if (this._destroyed) return;
    if (index >= this.sources.length) {
      this.onEvent('error', {
        fatal: true,
        reason: 'todas as fontes falharam (cache, peers e CDN indisponíveis)'
      });
      return;
    }
    this.sourceIndex = index;
    this._retries = 0;
    const source = this.sources[index];
    this._teardownHls();
    this._teardownMse();
    this.onEvent('source:trying', { index, src: source.src });

    if (isP2pSource(source.src, source.type)) {
      this._loadP2P(source);
    } else if (isHlsSource(source.src, source.type)) {
      this._loadHls(source);
    } else {
      this._loadProgressive(source);
    }
  }

  /**
   * Fonte P2P — dois modos, escolhidos pelo formato de `source`:
   *
   * 1) MANIFESTO (multi-bloco, o caso normal pra vídeo hoje): `source.src` é
   *    o fileId e `source.p2pManifestUrl` aponta pro bilhete /p2p/:fileId do
   *    gateway (JSON pequeno — candidatos relay + iv/authTag por bloco).
   *    Busca TODOS os blocos nos peers via WebRTC, descriptografa
   *    (AES-256-GCM) e concatena — 100% P2P pro peso real (a mídia); o
   *    fetch do manifesto em si é só metadata, não conta como "cair pro
   *    HTTP" no sentido que importa (banda de vídeo).
   * 2) LEGADO (shard único): sem `p2pManifestUrl`, `source.src` já É o
   *    shardKey a buscar direto — mantido pra compat com integrações mais
   *    antigas/arquivos de bloco único.
   *
   * Se o P2P falhar (nenhum peer, bloco faltando etc.), cai pra próxima
   * fonte da lista (ex.: /raw/:fileId via CDN/gateway), igual qualquer
   * outra falha de fonte — o fallback HTTP continua existindo como rede de
   * segurança, só não é mais o caminho principal.
   */
  async _loadP2P(source) {
    this.onEvent('p2p:fetching', { shardKey: source.src });
    try {
      if (source.p2pManifestUrl) {
        await this._loadP2PManifest(source);
      } else {
        await this._loadP2PLegacyShard(source);
      }
    } catch (e) {
      // FIX: antes disso, um erro aqui (ex.: manifesto sem fileKeyB64,
      // crypto.subtle indisponível por contexto inseguro, JSON malformado)
      // só disparava onEvent('error', ...) — no site publicado de verdade
      // (diferente da demo index.html) ninguém escuta esse evento no
      // console, só o controls.js (mostra na UI, não loga). Resultado: o
      // player caía pro fallback HTTP em silêncio total, sem nenhuma pista
      // de qual foi o erro real — os logs [vagalun-p2p] simplesmente
      // paravam depois da criação do P2PManager, sem dizer por quê.
      // console.error aqui sempre aparece, independente de quem escuta
      // onEvent, e mostra a stack completa (e.stack), não só e.message.
      console.error('[vagalun-p2p] falha carregando fonte P2P —', source.src, e);
      if (this._destroyed || this.sourceIndex !== this.sources.indexOf(source)) return;
      this.onEvent('error', {
        fatal: false,
        reason: `p2p: ${(e && e.message) || 'falha desconhecida'}`,
        shardKey: source.src
      });
      this._advanceToNextSource();
    }
  }

  async _loadP2PLegacyShard(source) {
    const p2p = getP2PManager(source.p2pSignalingUrl);
    const bytes = await p2p.fetchShard(source.src, {
      timeoutMs: source.p2pTimeoutMs ?? 12000,
      waitForPeersMs: source.p2pWaitForPeersMs ?? 4000
    });
    if (this._destroyed || this.sourceIndex !== this.sources.indexOf(source)) return;
    if (!bytes) throw new Error('nenhum peer respondeu');
    this._setP2PBlobSource(source, bytes);
  }

  async _loadP2PManifest(source) {
    const manifest = await fetchP2PManifest(source.p2pManifestUrl);
    if (this._isStale(source)) return;
    const p2p = getP2PManager(manifest.signalingUrl || source.p2pSignalingUrl);
    this.onEvent('p2p:manifest', { fileId: manifest.fileId, blocks: manifest.blocks.length });

    // 1) Streaming progressivo (MSE): começa a tocar no 1º fragmento, mantém
    //    ~1min de buffer, permite seek. Exige mp4 fragmentado.
    if (source.p2pStreaming !== false && P2PMseStream.isSupported()) {
      try {
        await this._startP2PStream(source, manifest, p2p);
        return;
      } catch (e) {
        if (!(e instanceof MseUnsupportedError)) throw e;
        this._teardownMse();
        console.warn('[vagalun-p2p] streaming MSE indisponível —', e.message);
        this.onEvent('p2p:stream-unsupported', { reason: e.message, code: e.code });
      }
    }
    if (this._isStale(source)) return;

    // 2) Fallback: baixa tudo e monta Blob. Só aceitável pra arquivo pequeno.
    const limit = source.p2pBlobMaxBytes ?? P2P_BLOB_MAX_BYTES;
    if (manifest.originalLength > limit) {
      throw new Error(
        `arquivo de ${(manifest.originalLength / 1048576).toFixed(0)}MB não é mp4 fragmentado — ` +
        'baixar tudo via P2P travaria o início; usando a próxima fonte (republique o vídeo pra habilitar streaming P2P)'
      );
    }
    const bytes = await fetchFileP2P(p2p, manifest, {
      perBlockTimeoutMs: source.p2pTimeoutMs ?? 15000,
      waitForPeersMs: source.p2pWaitForPeersMs ?? 4000,
      onProgress: (done, total) => this.onEvent('p2p:block', { done, total }),
      onLog: p2p._log
    });
    if (this._isStale(source)) return;
    this._setP2PBlobSource(source, bytes, manifest.contentType);
  }

  _isStale(source) {
    return this._destroyed || this.sourceIndex !== this.sources.indexOf(source);
  }

  async _startP2PStream(source, manifest, p2p) {
    const stream = new P2PMseStream({
      p2p,
      manifest,
      onLog: p2p._log,
      aheadTargetS: source.p2pAheadSeconds,
      backBufferS: source.p2pBackBufferSeconds,
      perBlockTimeoutMs: source.p2pTimeoutMs ?? 15000,
      waitForPeersMs: source.p2pWaitForPeersMs ?? 4000,
      prefetchBlocks: source.p2pPrefetchBlocks,
      onEvent: (name, data) => { if (this._mse === stream) this.onEvent(name, data); },
      onFatal: (err) => {
        // erro DEPOIS de já estar tocando (peer sumiu, bloco corrompido...):
        // cai pra próxima fonte retomando do ponto atual.
        if (this._mse !== stream || this._isStale(source)) return;
        console.error('[vagalun-p2p] stream P2P falhou —', err);
        this.onEvent('error', { fatal: false, reason: `p2p stream: ${err && err.message}`, shardKey: source.src });
        this._advanceToNextSource();
      }
    });
    this._mse = stream;
    try {
      const info = await stream.probe(); // MseUnsupportedError sobe daqui, antes de tocar no <video>
      if (this._isStale(source)) { stream.destroy(); return; }
      this.onEvent('p2p:stream', info);
      await stream.attach(this.video, { resumeTime: this._resumeTime });
    } catch (e) {
      if (this._mse === stream && !(e instanceof MseUnsupportedError)) {
        // falha no attach (ex.: 1º bloco não veio): não é "formato errado",
        // é erro de verdade -> propaga pro handler de _loadP2P (próxima fonte)
        stream.destroy();
        this._mse = null;
      }
      throw e;
    }
    if (this._isStale(source)) return;
    this.onEvent('p2p:ready', { shardKey: source.src, streaming: true, mode: stream.mode });
  }

  _setP2PBlobSource(source, bytes, contentType) {
    this._activeObjectUrl && URL.revokeObjectURL(this._activeObjectUrl);
    const url = bytesToObjectUrl(bytes, contentType || source.mimeType || 'video/mp4');
    this._activeObjectUrl = url;
    this.onEvent('p2p:ready', { shardKey: source.src, bytes: bytes.byteLength });
    this._loadProgressive({ ...source, src: url });
  }

  _loadProgressive(source) {
    this.video.src = source.src;
    if (this._resumeTime > 1) {
      const onLoaded = () => {
        try { this.video.currentTime = this._resumeTime; } catch {}
        this.video.removeEventListener('loadedmetadata', onLoaded);
      };
      this.video.addEventListener('loadedmetadata', onLoaded);
    }
    this.video.load();
  }

  async _loadHls(source) {
    if (nativeHlsSupport(this.video)) {
      // Safari / iOS: deixa o próprio <video> tocar HLS, sem MSE.
      this._loadProgressive(source);
      return;
    }
    if (!this._hlsModPromise) {
      this._hlsModPromise = import('hls.js').then((m) => m.default || m);
    }
    let Hls;
    try {
      Hls = await this._hlsModPromise;
    } catch (e) {
      this.onEvent('error', { fatal: false, reason: 'falha ao carregar hls.js', detail: e });
      this._advanceToNextSource();
      return;
    }
    if (this._destroyed) return;
    if (!Hls.isSupported()) {
      // Sem MSE (browser exótico) — tenta tocar direto como progressivo.
      this._loadProgressive(source);
      return;
    }

    this.hls = new Hls({
      maxBufferLength: 30,
      backBufferLength: 30,
      enableWorker: true,
      lowLatencyMode: false
    });

    this.hls.on(Hls.Events.MANIFEST_PARSED, (_evt, data) => {
      const levels = (data.levels || []).map((lvl, i) => ({
        index: i,
        height: lvl.height,
        bitrate: lvl.bitrate,
        label: lvl.height ? `${lvl.height}p` : `${Math.round(lvl.bitrate / 1000)}kbps`
      }));
      this.onQualityLevels(levels);
      if (this._resumeTime > 1) {
        try { this.video.currentTime = this._resumeTime; } catch {}
      }
    });

    this.hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          this.onEvent('error', { fatal: false, reason: 'erro de rede no HLS', detail: data });
          this._advanceToNextSource();
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          try {
            this.hls.recoverMediaError();
          } catch {
            this._advanceToNextSource();
          }
          break;
        default:
          this._advanceToNextSource();
          break;
      }
    });

    this.hls.loadSource(source.src);
    this.hls.attachMedia(this.video);
  }

  setQualityLevel(index) {
    if (this.hls) {
      this.hls.currentLevel = index; // -1 = auto
    }
  }

  _teardownHls() {
    if (this.hls) {
      try { this.hls.destroy(); } catch {}
      this.hls = null;
    }
    clearTimeout(this._stallTimer);
  }

  _teardownMse() {
    if (this._mse) {
      const attached = !!this._mse._video; // probe() que falhou nunca encostou no <video>
      try { this._mse.destroy(); } catch {}
      this._mse = null;
      // libera o MediaSource/buffer; removeAttribute (e não src='') pra não disparar 'error' vazio
      if (attached) { try { this.video.removeAttribute('src'); this.video.load(); } catch {} }
    }
  }

  _onWaiting() {
    // Ignora "waiting" enquanto ainda não existe nenhuma fonte carregada no
    // elemento (ex.: durante a espera do P2P, antes de setar video.src) —
    // o navegador pode disparar esse evento mesmo sem play() ter sido
    // chamado de verdade, e sem src nenhum não é "travou", é só "não
    // começou ainda". Contar isso como stall fazia o engine avançar/esgotar
    // fontes numa corrida com o próprio fluxo do _loadP2P, deixando o
    // overlay de erro fatal preso mesmo quando a fonte certa carregava
    // logo em seguida por outro caminho.
    if (!this.video.currentSrc) return;
    this.onEvent('buffering', { state: true });
    clearTimeout(this._stallTimer);
    // Streaming P2P tem timeout/retry próprios por bloco e avisa via onFatal;
    // recarregar a fonte aqui só jogaria fora o buffer e recomeçaria o stream.
    if (this._mse && this._mse.isActive()) return;
    this._stallTimer = setTimeout(() => {
      // travou demais esperando dado — provavelmente a fonte atual está ruim.
      this._retries += 1;
      if (this._retries > MAX_RETRIES_PER_SOURCE) {
        this._advanceToNextSource();
      } else {
        // tenta recarregar a mesma fonte do ponto atual antes de desistir dela
        const t = this.video.currentTime;
        this._resumeTime = t;
        this._loadSourceAt(this.sourceIndex);
      }
    }, STALL_TIMEOUT_MS);
  }

  _onPlaying() {
    this.onEvent('buffering', { state: false });
    clearTimeout(this._stallTimer);
    this._retries = 0;
  }

  _onErrorNative() {
    const err = this.video.error;
    if (!err) return;
    this.onEvent('error', { fatal: false, reason: 'erro no elemento <video>', code: err.code });
    this._advanceToNextSource();
  }

  _advanceToNextSource() {
    this._resumeTime = this.video.currentTime || this._resumeTime;
    this._loadSourceAt(this.sourceIndex + 1);
  }

  destroy() {
    this._destroyed = true;
    clearTimeout(this._stallTimer);
    this._teardownHls();
    this._teardownMse();
    if (this._activeObjectUrl) {
      URL.revokeObjectURL(this._activeObjectUrl);
      this._activeObjectUrl = null;
    }
    this.video.removeEventListener('waiting', this._onWaiting);
    this.video.removeEventListener('playing', this._onPlaying);
    this.video.removeEventListener('error', this._onErrorNative);
  }
}
