'use strict';

/**
 * gwDirectory.js — quem são os gateways que EU conheço (e que o cliente pode usar como alternativa).
 *
 * Sem servidor central de descoberta: cada gateway guarda uma lista curta e a repassa em
 *   GET /gw/list              (e embutida em /sync/registry, então réplicas aprendem umas das outras)
 *   POST /gw/announce {url}   (um gateway novo se apresenta; eu CONFIRMO que ele controla a URL)
 *
 * Confirmar a URL = chamar `<url>/gw/info?nonce=X` e ver o X de volta. Isso prova controle da URL
 * (não identidade) — basta: o cliente nunca confia no conteúdo de um gateway (verifica tudo), então
 * um gateway falso só consegue ser lento/indisponível, e o ranking por RTT/falhas o joga pro fim.
 *
 * SSRF: o announce faz o servidor ligar pra uma URL que OUTRO escolheu. Por isso só http(s) e
 * hosts que NÃO resolvam pra IP privado/loopback/link-local (GATEWAY_ANNOUNCE_ALLOW_PRIVATE=1 só em teste).
 */

const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');

const MAX = parseInt(process.env.GATEWAY_DIR_MAX || '64', 10);
const TTL_MS = 24 * 3600 * 1000;
const known = new Map(); // url -> { firstSeen, lastOk, fails, via }
let selfUrl = null;

function normalizeUrl(u) {
  if (typeof u !== 'string') return null;
  try {
    const x = new URL(u.trim());
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return null;
    if (x.username || x.password) return null;
    return `${x.protocol}//${x.host}`; // só origem: sem path/query
  } catch (_) { return null; }
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:');
  }
  return true;
}

async function assertPublicHost(url) {
  if (process.env.GATEWAY_ANNOUNCE_ALLOW_PRIVATE === '1') return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('host privado/loopback não é aceito');
}

function setSelf(url) { selfUrl = normalizeUrl(url); }
function getSelf() { return selfUrl; }

/** Aprendizado passivo (vem de um seed configurado ou de /sync): não faz nenhuma requisição. */
function learn(urls, via = 'learned') {
  let added = 0;
  for (const raw of urls || []) {
    const u = normalizeUrl(raw);
    if (!u || u === selfUrl) continue;
    const e = known.get(u);
    if (e) continue;
    if (known.size >= MAX) break;
    known.set(u, { firstSeen: Date.now(), lastOk: 0, fails: 0, via });
    added++;
  }
  return added;
}

async function probe(url, { fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  const nonce = crypto.randomBytes(12).toString('hex');
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`${url}/gw/info?nonce=${nonce}`, { signal: ctl.signal, redirect: 'error' });
    if (!r.ok) return false;
    const j = await r.json();
    return j && j.ok === true && j.nonce === nonce;
  } catch (_) { return false; } finally { clearTimeout(t); }
}

/** POST /gw/announce */
async function announce(rawUrl, deps = {}) {
  const url = normalizeUrl(rawUrl);
  if (!url) throw new Error('url inválida');
  if (url === selfUrl) return { ok: true, self: true };
  if (known.size >= MAX && !known.has(url)) throw new Error('lista de gateways cheia');
  await assertPublicHost(url);
  if (!(await probe(url, deps))) throw new Error('gateway não confirmou controle da URL (/gw/info com nonce)');
  const e = known.get(url) || { firstSeen: Date.now(), lastOk: 0, fails: 0, via: 'announce' };
  e.lastOk = Date.now(); e.fails = 0;
  known.set(url, e);
  return { ok: true };
}

/** Re-sonda os anunciados; some quem ficou 24h sem responder ou falhou 5x seguidas. */
async function sweep(deps = {}) {
  for (const [url, e] of [...known]) {
    const ok = await probe(url, deps);
    if (ok) { e.lastOk = Date.now(); e.fails = 0; } else e.fails += 1;
    if (e.fails >= 5 || (e.lastOk && Date.now() - e.lastOk > TTL_MS)) known.delete(url);
  }
}

function list({ includeSelf = true } = {}) {
  const others = [...known.entries()].sort((a, b) => b[1].lastOk - a[1].lastOk).map(([u]) => u);
  return includeSelf && selfUrl ? [selfUrl, ...others] : others;
}

function _reset() { known.clear(); selfUrl = null; }

module.exports = { normalizeUrl, setSelf, getSelf, learn, announce, sweep, list, probe, isPrivateIp, _reset };
