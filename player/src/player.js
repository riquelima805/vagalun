// Ponto de entrada público da lib. Junta engine (fonte/HLS/fallback),
// controls (UI) e adManager (pre-roll/mid-roll/overlay) num único objeto
// que quem incorpora o player usa: `new VagalunPlayer(el, options)`.

import { PlaybackEngine, fetchFileViaP2P } from './engine.js';
import { buildControls } from './controls.js';
import { AdManager } from './adManager.js';
import './styles.css';

const VERSION =
  typeof __VAGALUN_PLAYER_VERSION__ !== 'undefined' ? __VAGALUN_PLAYER_VERSION__ : 'dev';

function randomId() {
  return `vgl-${Math.random().toString(36).slice(2, 9)}`;
}

class VagalunPlayer {
  /**
   * @param {string|HTMLElement} target - seletor CSS ou elemento onde o player será montado
   * @param {object} options
   * @param {Array<{src:string,type?:string,label?:string}>|string} [options.sources]
   * @param {string} [options.poster]
   * @param {boolean} [options.autoplay]
   * @param {boolean} [options.muted]
   * @param {boolean} [options.loop]
   * @param {string} [options.preload]
   * @param {number} [options.resumeTime]
   * @param {string} [options.playerId] - usado pra namespacear volume/qualidade salvos no localStorage
   * @param {object} [options.ads]
   * @param {object} [options.ads.preroll] - config de anúncio em vídeo pra tocar antes do conteúdo
   * @param {string} [options.ads.prerollVast] - alternativa: URL de tag VAST pro pre-roll
   * @param {Array<number|{at:number,videoUrl?:string,vastUrl?:string}>} [options.ads.midroll] - tempos (s) ou configs de mid-roll
   * @param {object} [options.ads.overlay] - config do banner pequeno (imageUrl/html, clickUrl, showFor, delay)
   */
  constructor(target, options = {}) {
    const container = typeof target === 'string' ? document.querySelector(target) : target;
    if (!container) {
      throw new Error('VagalunPlayer: elemento alvo não encontrado');
    }

    this.options = options;
    this.playerId = options.playerId || randomId();
    this._listeners = {};
    this._midrollTimes = (options.ads && options.ads.midroll) || [];
    this._midrollsFired = new Set();
    this._destroyed = false;

    // ---- monta o DOM ----
    this.root = document.createElement('div');
    this.root.className = 'vgl-root';
    this.root.tabIndex = 0;

    this.video = document.createElement('video');
    this.video.className = 'vgl-video';
    this.video.playsInline = true;
    this.video.preload = options.preload || 'metadata';
    if (options.poster) this.video.poster = options.poster;
    if (options.loop) this.video.loop = true;
    if (options.muted) this.video.muted = true;
    if (options.autoplay) this.video.autoplay = true;

    this.root.appendChild(this.video);
    container.innerHTML = '';
    container.appendChild(this.root);

    // ---- anúncios ----
    this.ads = new AdManager({
      root: this.root,
      onEvent: (name, data) => this._emit(name, data)
    });

    // ---- engine de reprodução ----
    this.engine = new PlaybackEngine(this.video, {
      onEvent: (name, data) => this._handleEngineEvent(name, data),
      onQualityLevels: (levels) => this.controls && this.controls.setQualityLevels(levels)
    });

    // ---- UI de controles ----
    this.controls = buildControls({
      root: this.root,
      video: this.video,
      engine: this.engine,
      playerId: this.playerId
    });

    this._onTimeUpdate = () => this._checkMidrolls();
    this.video.addEventListener('timeupdate', this._onTimeUpdate);

    if (options.sources) {
      this.setSources(options.sources, { resumeTime: options.resumeTime });
    }

    if (options.ads && options.ads.overlay) {
      const delay = options.ads.overlay.delay ?? 4;
      this._overlayTimer = setTimeout(() => {
        if (!this._destroyed) this.ads.showOverlay(options.ads.overlay);
      }, delay * 1000);
    }

    if (options.ads && (options.ads.preroll || options.ads.prerollVast)) {
      this._playPreroll();
    }
  }

  async _playPreroll() {
    const { preroll, prerollVast } = this.options.ads || {};
    try {
      this.video.pause();
      if (prerollVast) {
        await this.ads.playFromVast(prerollVast);
      } else if (preroll) {
        await this.ads.playVideoAd(preroll);
      }
    } finally {
      if (!this._destroyed) this.video.play().catch(() => {});
    }
  }

  _checkMidrolls() {
    if (!this._midrollTimes.length || !this.video.duration) return;
    this._midrollTimes.forEach((cfg, i) => {
      if (this._midrollsFired.has(i)) return;
      const at = typeof cfg === 'number' ? cfg : cfg.at;
      if (this.video.currentTime >= at) {
        this._midrollsFired.add(i);
        this._playMidroll(cfg);
      }
    });
  }

  async _playMidroll(cfg) {
    try {
      this.video.pause();
      if (cfg && cfg.vastUrl) {
        await this.ads.playFromVast(cfg.vastUrl);
      } else {
        await this.ads.playVideoAd(cfg);
      }
    } finally {
      if (!this._destroyed) this.video.play().catch(() => {});
    }
  }

  _handleEngineEvent(name, data) {
    if (name === 'error' && data.fatal) {
      this.controls.showError(data.reason, () => {
        this.controls.hideError();
        this.setSources(this.options.sources, { resumeTime: this.video.currentTime });
      });
    } else if (name === 'source:trying') {
      this.controls.hideError();
    } else if (name === 'buffering' && data.state === false) {
      // Rede de segurança: se o overlay de erro ficou preso (ex.: disparado
      // por uma condição de corrida) mas o vídeo voltou a tocar de verdade
      // (engine emite buffering:false no 'playing' nativo), o overlay não
      // devia continuar bloqueando clique em cima dele.
      this.controls.hideError();
    }
    this._emit(name, data);
  }

  // ---- API pública ----

  setSources(sources, opts = {}) {
    this.options.sources = sources;
    this._midrollsFired = new Set();
    this.controls.hideError();
    this.engine.setSources(sources, opts);
  }

  play() {
    return this.video.play();
  }

  pause() {
    this.video.pause();
  }

  seek(time) {
    this.video.currentTime = time;
  }

  get currentTime() {
    return this.video.currentTime;
  }

  set currentTime(t) {
    this.video.currentTime = t;
  }

  get duration() {
    return this.video.duration;
  }

  get volume() {
    return this.video.volume;
  }

  set volume(v) {
    this.video.volume = v;
  }

  get paused() {
    return this.video.paused;
  }

  on(event, cb) {
    (this._listeners[event] ||= []).push(cb);
    return () => this.off(event, cb);
  }

  off(event, cb) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter((fn) => fn !== cb);
  }

  _emit(event, data) {
    (this._listeners[event] || []).forEach((cb) => {
      try {
        cb(data);
      } catch (e) {
        console.error('[VagalunPlayer] erro em listener:', e);
      }
    });
    (this._listeners['*'] || []).forEach((cb) => {
      try {
        cb(event, data);
      } catch (e) {
        console.error('[VagalunPlayer] erro em listener:', e);
      }
    });
  }

  destroy() {
    this._destroyed = true;
    clearTimeout(this._overlayTimer);
    this.video.removeEventListener('timeupdate', this._onTimeUpdate);
    this.engine.destroy();
    this.ads.destroy();
    this.root.remove();
    this._listeners = {};
  }
}

VagalunPlayer.VERSION = VERSION;
// usado pela ponte do Service Worker (fallback P2P quando todos os gateways HTTP caem)
VagalunPlayer.p2pFetchFile = fetchFileViaP2P;

export default VagalunPlayer;
