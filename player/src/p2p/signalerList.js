// signalerList.js — de onde o cliente sabe QUAIS signalers existem.
//
// Fontes, em ordem de prioridade (a ordem final é a mesma pra todo mundo, o que
// maximiza a chance de dois peers caírem no MESMO signaler e se enxergarem):
//   1) seeds        — embutidos no código/app (funciona offline, sem GitHub)
//   2) remote lists — JSONs em vários lugares (GitHub, IPFS gateway, site próprio...).
//                     Aceita o formato antigo {signalingUrl|url|wss} e o novo {signalers:[...]}
//   3) aprendidos   — signalers anunciados por OUTROS signalers (msg `signalers`)
//   (4) on-chain    — ponto de extensão: registerSource(async () => [...urls])
//
// Aprendidos entram só no FIM da lista, com teto, e nunca expulsam seed: um signaler
// malicioso consegue no máximo "sugerir" mais candidatos, não derrubar os seus.

export const DEFAULT_SEEDS = ['wss://signal.vagalun.shop'];
export const DEFAULT_REMOTE_LISTS = [
  'https://raw.githubusercontent.com/riquelima805/adla-nft-market/refs/heads/main/reley.json',
];

const STORAGE_KEY = 'vagalun.signalers.learned.v1';

export function normalizeUrl(u) {
  if (typeof u !== 'string') return null;
  let s = u.trim();
  if (!s) return null;
  if (s.startsWith('https://')) s = 'wss://' + s.slice(8);
  else if (s.startsWith('http://')) s = 'ws://' + s.slice(7);
  if (!/^wss?:\/\/[^\s/]+/.test(s)) return null;
  return s.replace(/\/+$/, '');
}

function extractUrls(json) {
  const out = [];
  if (!json || typeof json !== 'object') return out;
  if (Array.isArray(json.signalers)) out.push(...json.signalers);
  for (const k of ['signalingUrl', 'url', 'wss']) if (typeof json[k] === 'string') out.push(json[k]);
  return out.map(normalizeUrl).filter(Boolean);
}

export class SignalerList {
  /**
   * @param {object} [o]
   * @param {string[]} [o.seeds]
   * @param {string[]} [o.remoteLists]
   * @param {boolean}  [o.allowInsecure] aceita ws:// (PC node sem TLS). Em página https o browser bloqueia mesmo assim.
   * @param {number}   [o.maxLearned]
   * @param {Storage}  [o.storage]
   * @param {typeof fetch} [o.fetchImpl]
   */
  constructor(o = {}) {
    this.allowInsecure = o.allowInsecure ?? true;
    this.maxLearned = o.maxLearned ?? 5;
    this.fetchImpl = o.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    // storage: null desliga a persistência de propósito (testes); undefined usa localStorage se existir
    this.storage = 'storage' in o ? o.storage : (typeof localStorage !== 'undefined' ? localStorage : null);
    this._seeds = (o.seeds || DEFAULT_SEEDS).map(normalizeUrl).filter(Boolean);
    this._remoteUrls = o.remoteLists || DEFAULT_REMOTE_LISTS;
    this._remote = [];
    this._learned = [];
    this._sources = [];
    this.onChange = null;
    try {
      const raw = this.storage && this.storage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this._remote = (parsed.remote || []).map(normalizeUrl).filter(Boolean);
        this._learned = (parsed.learned || []).map(normalizeUrl).filter(Boolean).slice(0, this.maxLearned);
      }
    } catch (_) { /* storage indisponível: segue só com seeds */ }
  }

  _ok(u) { return this.allowInsecure || u.startsWith('wss://'); }

  /** Lista final, ordenada e sem duplicatas. */
  urls() {
    const seen = new Set();
    const out = [];
    for (const u of [...this._seeds, ...this._remote, ...this._learned]) {
      if (u && this._ok(u) && !seen.has(u)) { seen.add(u); out.push(u); }
    }
    return out;
  }

  _persist() {
    try {
      this.storage && this.storage.setItem(STORAGE_KEY, JSON.stringify({ remote: this._remote, learned: this._learned }));
    } catch (_) { /* ignora */ }
  }

  _changed() { this._persist(); if (this.onChange) this.onChange(this.urls()); }

  /** Chamado quando um signaler anuncia outros. Só acrescenta no fim, com teto. */
  addLearned(urls) {
    const known = new Set(this.urls());
    let added = false;
    for (const raw of urls || []) {
      const u = normalizeUrl(raw);
      if (!u || !this._ok(u) || known.has(u)) continue;
      if (this._learned.length >= this.maxLearned) break;
      this._learned.push(u); known.add(u); added = true;
    }
    if (added) this._changed();
    return added;
  }

  /** Fonte extra (ex.: ler SignalerRecord on-chain). Deve devolver string[]. */
  registerSource(fn) { this._sources.push(fn); }

  /** Busca TODAS as listas remotas em paralelo; falha de uma não afeta as outras. */
  async refreshRemote(timeoutMs = 6000) {
    const jobs = [];
    if (this.fetchImpl) {
      for (const url of this._remoteUrls) {
        jobs.push((async () => {
          const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
          const t = ctl && setTimeout(() => ctl.abort(), timeoutMs);
          try {
            const r = await this.fetchImpl(url, { signal: ctl && ctl.signal, cache: 'no-store' });
            if (!r.ok) return [];
            return extractUrls(await r.json());
          } catch (_) { return []; } finally { if (t) clearTimeout(t); }
        })());
      }
    }
    for (const fn of this._sources) jobs.push(Promise.resolve().then(fn).then((a) => (a || []).map(normalizeUrl).filter(Boolean)).catch(() => []));
    const found = (await Promise.all(jobs)).flat();
    if (!found.length) return false;
    const next = [...new Set(found)];
    const same = next.length === this._remote.length && next.every((u, i) => u === this._remote[i]);
    if (same) return false;
    this._remote = next;
    this._changed();
    return true;
  }
}
