// Streaming progressivo de vídeo P2P via MediaSource (MSE).
//
// Problema que isso resolve: o caminho antigo baixava TODOS os blocos, montava
// um Blob com o arquivo inteiro e só então dava play — pra um filme longo o
// usuário ficava num loading proporcional ao tamanho do arquivo. Aqui o vídeo
// começa assim que o 1º fragmento chega, só mantém ~1 minuto de buffer à
// frente, descarta o que já passou e permite pular pra qualquer ponto.
//
// Pré-requisito do arquivo: MP4 FRAGMENTADO (moov com mvex + moof/mdat). O
// publish gera isso (hosting/mediaOptimize.js: frag_keyframe+empty_moov+
// default_base_moof+global_sidx). Com `sidx` global o player sabe, pra cada
// fragmento (~2s), o intervalo de bytes exato -> seek barato e RAM limitada.
//
// Dois modos, decididos em probe():
//   'indexed'    — tem sidx válido: seek pra qualquer ponto, back-buffer
//                  descartado, duração conhecida desde o início.
//   'sequential' — fragmentado mas SEM sidx: toca em ordem; seek só pra
//                  frente do que já baixou (espera o download chegar lá) e
//                  nada é descartado (não há como re-buscar). Funciona, mas
//                  é o modo degradado: republique com global_sidx.
//
// Se o arquivo não for fragmentado / codec não suportado, probe() lança
// MseUnsupportedError ANTES de tocar no <video>, e o engine decide o fallback.

import { P2PBlockReader } from './p2pFile.js';
import { readBoxHeader, parseMoov, parseSidx, mfraSizeFromTail, concatBytes } from './mp4.js';

export class MseUnsupportedError extends Error {
  /** @param {string} message @param {'no-mse'|'not-fragmented'|'codec'|'init'} code */
  constructor(message, code) {
    super(message);
    this.name = 'MseUnsupportedError';
    this.code = code;
  }
}

const MAX_HEAD_BOX = 32 * 1024 * 1024; // moov/sidx maiores que isso = arquivo estranho demais
const GAP_TOLERANCE = 0.3; // s — buraco no começo de um range que o <video> pula sozinho

export class P2PMseStream {
  /**
   * @param {{
   *   p2p: import('./p2pSource.js').P2PManager,
   *   manifest: object,
   *   onEvent?: (name:string, data:any) => void,
   *   onFatal?: (err:Error) => void,
   *   onLog?: Function,
   *   aheadTargetS?: number,   // quanto de buffer manter à frente (padrão 60s)
   *   backBufferS?: number,    // quanto manter atrás (padrão 30s)
   *   reader?: object          // injeção (testes)
   * }} o
   */
  constructor(o) {
    this.manifest = o.manifest;
    this.onEvent = o.onEvent || (() => {});
    this.onFatal = o.onFatal || (() => {});
    this.onLog = o.onLog || (() => {});
    this.aheadTargetS = o.aheadTargetS ?? 60;
    this.backBufferS = o.backBufferS ?? 30;
    this.reader =
      o.reader ||
      new P2PBlockReader(o.p2p, o.manifest, {
        onLog: this.onLog,
        onBlock: (done, total) => this.onEvent('p2p:block', { done, total }),
        onServed: (info) => this.onEvent('p2p:served', info),
        perBlockTimeoutMs: o.perBlockTimeoutMs,
        waitForPeersMs: o.waitForPeersMs,
        prefetchBlocks: o.prefetchBlocks
      });

    this.mode = null; // 'indexed' | 'sequential'
    this.mime = null;
    this.duration = null;
    this._units = [];
    this._init = null;
    this._probed = false;

    this._video = null;
    this._ms = null;
    this._sb = null;
    this._url = null;
    this._destroyed = false;
    this._failed = false;
    this._gen = 0;
    this._next = 0; // só modo sequential
    this._lastIdx = -1;
    this._sameIdx = 0;
    this._ended = false;
    this._q = Promise.resolve();
    this._wake = null;
    this._firstAppend = null;
  }

  static isSupported() {
    return (
      typeof window !== 'undefined' &&
      typeof window.MediaSource !== 'undefined' &&
      typeof window.MediaSource.isTypeSupported === 'function'
    );
  }

  // ------------------------------------------------------------------ probe

  /**
   * Lê o começo do arquivo (ftyp/moov/sidx), descobre codec e monta o índice.
   * Não mexe no <video>. Lança MseUnsupportedError se não der pra usar MSE.
   */
  async probe() {
    if (!P2PMseStream.isSupported()) throw new MseUnsupportedError('MediaSource indisponível neste navegador', 'no-mse');
    await this.reader.init();
    const total = this.reader.total;
    // Durante o probe só lemos cabeçalhos: sem prefetch (se o arquivo não for
    // fragmentado, não queremos ter gasto banda P2P em blocos que serão descartados).
    const prefetch = this.reader.prefetchBlocks;
    this.reader.prefetchBlocks = 0;
    try {
      return await this._probe(total);
    } finally {
      this.reader.prefetchBlocks = prefetch;
    }
  }

  async _probe(total) {

    // mfra (índice de acesso aleatório do fim do arquivo) não pode ir pro MSE
    const tail = await this.reader.read(Math.max(0, total - 16), total);
    const mfra = mfraSizeFromTail(tail);
    this._mediaEnd = mfra > 0 && mfra < total ? total - mfra : total;

    let off = 0;
    let ftyp = null;
    let moov = null;
    const sidxList = [];
    let firstFrag = null;
    for (let n = 0; n < 64 && off < total; n++) {
      const hb = await this.reader.read(off, Math.min(off + 16, total));
      const h = readBoxHeader(hb, 0);
      if (!h) break;
      const size = h.size === null ? total - off : h.size;
      if (h.type === 'moof' || h.type === 'mdat') { firstFrag = off; break; }
      if (h.type === 'ftyp' || h.type === 'moov' || h.type === 'sidx') {
        if (size > MAX_HEAD_BOX) throw new MseUnsupportedError(`box ${h.type} grande demais (${size} bytes)`, 'init');
        const bytes = await this.reader.read(off, off + size);
        if (h.type === 'ftyp') ftyp = bytes;
        else if (h.type === 'moov') moov = bytes;
        else sidxList.push({ bytes, endAbs: off + size });
      }
      if (size <= 0) break;
      off += size;
    }

    if (!moov || firstFrag === null) {
      throw new MseUnsupportedError('arquivo sem moov antes dos dados (mp4 não fragmentado / moov no fim)', 'not-fragmented');
    }
    const info = parseMoov(moov);
    if (!info.hasMvex) {
      throw new MseUnsupportedError('mp4 não fragmentado (moov sem mvex) — republique com frag_keyframe+empty_moov', 'not-fragmented');
    }

    const media = info.tracks.filter((t) => t.handler === 'vide' || t.handler === 'soun');
    if (!media.length) throw new MseUnsupportedError('nenhuma trilha de áudio/vídeo no moov', 'init');
    const unknown = media.find((t) => !t.codec);
    if (unknown) throw new MseUnsupportedError(`codec não reconhecido (entrada "${unknown.entry}")`, 'codec');
    this.mime = `video/mp4; codecs="${media.map((t) => t.codec).join(',')}"`;
    if (!window.MediaSource.isTypeSupported(this.mime)) {
      throw new MseUnsupportedError(`navegador não suporta ${this.mime}`, 'codec');
    }

    this._init = ftyp ? concatBytes(ftyp, moov) : moov;
    await this._buildIndex(info, sidxList, firstFrag);
    this._probed = true;
    this.onLog('mse probe ok —', this.mode, this.mime, `${this._units.length} unidades`, this.duration ? `${this.duration.toFixed(1)}s` : '');
    return { mode: this.mode, mime: this.mime, duration: this.duration, units: this._units.length };
  }

  async _buildIndex(info, sidxList, firstFrag) {
    const vtrack = info.tracks.find((t) => t.handler === 'vide') || info.tracks[0];
    const cand = sidxList.find((s) => s.bytes.length >= 16 && this._sidxRef(s.bytes) === vtrack.id) || sidxList[0];
    if (cand) {
      try {
        const sidx = parseSidx(cand.bytes, cand.endAbs);
        if (!sidx.hierarchical && sidx.units.length) {
          const first = sidx.units[0];
          const last = sidx.units[sidx.units.length - 1];
          const okRange = first.start >= firstFrag && last.end <= this._mediaEnd + 1;
          // sanidade: o sidx tem que apontar pra uma `moof` de verdade
          const a = await this.reader.read(first.start, first.start + 8);
          const b = await this.reader.read(last.start, last.start + 8);
          const isMoof = (x) => x.length >= 8 && String.fromCharCode(x[4], x[5], x[6], x[7]) === 'moof';
          if (okRange && isMoof(a) && isMoof(b)) {
            this.mode = 'indexed';
            this._units = sidx.units;
            this.duration = sidx.duration;
            this._tol = Math.min(0.25, Math.max(0.01, sidx.duration / sidx.units.length / 4));
            return;
          }
        }
      } catch (e) {
        this.onLog('sidx inválido, caindo pro modo sequencial —', e && e.message);
      }
    }
    // sem sidx utilizável: unidades = intervalos alinhados aos blocos
    this.mode = 'sequential';
    const r = this.reader;
    const units = [];
    for (let i = r.blockAt(firstFrag); i < r.blocks.length; i++) {
      const start = Math.max(r.offsets[i], firstFrag);
      const end = Math.min(r.offsets[i + 1], this._mediaEnd);
      if (end > start) units.push({ start, end, t: 0, dur: 0 });
    }
    this._units = units;
    this.duration = Number.isFinite(this.manifest.duration) ? this.manifest.duration : null;
  }

  _sidxRef(bytes) {
    const h = readBoxHeader(bytes, 0);
    const o = h.hdr + 4;
    return ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  }

  // ----------------------------------------------------------------- attach

  /**
   * Liga o stream num <video>. Resolve quando o 1º fragmento já foi anexado
   * (ou seja: já dá pra tocar). Rejeita se falhar antes disso.
   */
  async attach(video, { resumeTime = 0 } = {}) {
    if (!this._probed) await this.probe();
    this._video = video;
    const ms = new window.MediaSource();
    this._ms = ms;
    this._url = URL.createObjectURL(ms);
    video.src = this._url;

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('MediaSource não abriu (sourceopen)')), 10000);
      ms.addEventListener('sourceopen', () => { clearTimeout(t); resolve(); }, { once: true });
    });
    if (this._destroyed) return;

    this._sb = ms.addSourceBuffer(this.mime);
    this._onSeeking = () => {
      if (this.mode === 'indexed') this._gen += 1; // descarta resultado de fetch velho; o loop reavalia
      this._poke();
    };
    this._onTimeUpdate = () => this._poke();
    video.addEventListener('seeking', this._onSeeking);
    video.addEventListener('timeupdate', this._onTimeUpdate);

    await this._append(this._init);
    if (this.mode === 'indexed' && Number.isFinite(this.duration)) {
      try { ms.duration = this.duration; } catch {}
    }
    if (resumeTime > 1) {
      try { video.currentTime = resumeTime; } catch {}
    }

    this._firstAppend = deferred();
    this._run();
    await this._firstAppend.promise;
  }

  // -------------------------------------------------------------- main loop

  _poke() {
    if (this._wake) { const w = this._wake; this._wake = null; w(); }
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => { this._wake = null; resolve(); }, ms);
      this._wake = () => { clearTimeout(t); resolve(); };
    });
  }

  _rangeAt(t) {
    const b = this._video.buffered;
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) - GAP_TOLERANCE && t <= b.end(i)) return { start: b.start(i), end: b.end(i) };
    }
    return null;
  }

  _unitIndexAtTime(t) {
    const u = this._units;
    let lo = 0;
    let hi = u.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (u[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /** Decide o que fazer agora. {idx} | {wait} | {done} */
  _choose() {
    const cur = this._video.currentTime || 0;
    const r = this._rangeAt(cur);
    const full = r && r.end - cur >= this.aheadTargetS;

    if (this.mode === 'sequential') {
      if (this._next >= this._units.length) return { done: true };
      return full ? { wait: true } : { idx: this._next };
    }

    // indexed: sempre preenche o buraco logo DEPOIS do range onde o playhead está
    let idx;
    if (!r) {
      idx = this._unitIndexAtTime(cur);
    } else {
      if (r.end >= this.duration - 0.1) return { done: true };
      if (full) return { wait: true };
      idx = this._unitIndexAtTime(r.end + this._tol);
    }
    // salvaguarda contra loop: mesma unidade escolhida de novo sem o buffer avançar
    if (idx === this._lastIdx) {
      this._sameIdx += 1;
      if (this._sameIdx >= 2) idx += 1;
    } else {
      this._sameIdx = 0;
    }
    if (idx >= this._units.length) return { done: true };
    return { idx };
  }

  async _run() {
    try {
      while (!this._destroyed && !this._failed) {
        const gen = this._gen;
        const pick = this._choose();

        if (pick.done) {
          await this._finish();
          await this._sleep(1000);
          continue;
        }
        if (pick.wait) {
          await this._sleep(500);
          continue;
        }

        const u = this._units[pick.idx];
        const bytes = await this.reader.read(u.start, u.end);
        if (this._destroyed) return;
        if (gen !== this._gen) continue; // houve seek enquanto buscava: reavalia

        if (this.mode === 'indexed') await this._evictBehind();
        await this._append(bytes);
        this._ended = false;
        this._lastIdx = pick.idx;
        if (this.mode === 'sequential') this._next = pick.idx + 1;
        if (this._firstAppend) { this._firstAppend.resolve(); this._firstAppend = null; }
        this.onEvent('p2p:buffer', { ahead: this._aheadSeconds() });
      }
    } catch (e) {
      this._fail(e);
    }
  }

  _aheadSeconds() {
    const cur = this._video.currentTime || 0;
    const r = this._rangeAt(cur);
    return r ? Math.max(0, r.end - cur) : 0;
  }

  async _finish() {
    if (this._ended || !this._ms || this._ms.readyState !== 'open') return;
    await this._q; // espera operações pendentes no SourceBuffer
    try {
      this._ms.endOfStream();
      this._ended = true;
      this.onEvent('p2p:streamed', { mode: this.mode });
    } catch (e) {
      this.onLog('endOfStream falhou —', e && e.message);
    }
  }

  // ------------------------------------------------------------ SourceBuffer

  _enqueue(fn) {
    const run = this._q.then(() => this._runOp(fn));
    this._q = run.catch(() => {});
    return run;
  }

  _runOp(fn) {
    return new Promise((resolve, reject) => {
      const sb = this._sb;
      if (!sb || this._destroyed) return reject(new Error('stream destruído'));
      const cleanup = () => {
        sb.removeEventListener('updateend', done);
        sb.removeEventListener('abort', done);
        sb.removeEventListener('error', fail);
      };
      const done = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(new Error('erro no SourceBuffer (dados rejeitados pelo decoder)')); };
      sb.addEventListener('updateend', done);
      sb.addEventListener('abort', done);
      sb.addEventListener('error', fail);
      try {
        fn(sb);
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
  }

  async _append(bytes) {
    try {
      await this._enqueue((sb) => sb.appendBuffer(bytes));
    } catch (e) {
      if (e && e.name === 'QuotaExceededError') {
        // buffer cheio: libera o que já passou e tenta de novo UMA vez
        if (this.mode !== 'indexed') {
          throw new Error('buffer do navegador cheio e o arquivo não tem sidx (não dá pra descartar e re-buscar) — republique com global_sidx');
        }
        const freed = await this._evictBehind(true);
        if (!freed) throw new Error('buffer do navegador cheio (QuotaExceeded) sem nada pra descartar');
        await this._enqueue((sb) => sb.appendBuffer(bytes));
      } else {
        throw e;
      }
    }
  }

  /** Remove do buffer o que já foi assistido há mais de backBufferS. */
  async _evictBehind(force = false) {
    const sb = this._sb;
    if (!sb || !sb.buffered.length) return false;
    const cur = this._video.currentTime || 0;
    const keepFrom = cur - (force ? Math.min(5, this.backBufferS) : this.backBufferS);
    const start = sb.buffered.start(0);
    // histerese de 10s: remove em pedaços, não a cada fragmento
    if (keepFrom - start < (force ? 1 : 10)) return false;
    await this._enqueue((s) => s.remove(0, keepFrom));
    return true;
  }

  // -------------------------------------------------------------- lifecycle

  isActive() {
    return !!this._sb && !this._failed && !this._destroyed;
  }

  _fail(err) {
    if (this._failed || this._destroyed) return;
    this._failed = true;
    if (this._firstAppend) { this._firstAppend.reject(err); this._firstAppend = null; }
    this.onFatal(err);
  }

  destroy() {
    this._destroyed = true;
    this._gen += 1;
    this._poke();
    if (this._firstAppend) { this._firstAppend.reject(new Error('stream destruído')); this._firstAppend = null; }
    if (this._video) {
      this._video.removeEventListener('seeking', this._onSeeking);
      this._video.removeEventListener('timeupdate', this._onTimeUpdate);
    }
    try { this.reader.destroy(); } catch {}
    if (this._url) { URL.revokeObjectURL(this._url); this._url = null; }
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  // evita "unhandled rejection" se ninguém estiver esperando mais
  promise.catch(() => {});
  return { promise, resolve, reject };
}
