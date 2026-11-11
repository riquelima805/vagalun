'use strict';
/**
 * Vagalun — serviço de convites (indicações).
 *
 * Sem dependências externas (só Node >= 18). Pode rodar sozinho (server.js)
 * ou ser montado dentro do servidor de signaling que já existe:
 *
 *     const { createReferral } = require('./referral');
 *     const referral = createReferral();
 *     httpServer.on('request', async (req, res) => {
 *       if (await referral.handle(req, res)) return;   // rotas /i/, /referral/, /admin/
 *       ...suas rotas atuais...
 *     });
 *
 * Tudo é gravado em um arquivo JSON (DATA_FILE). Escrita atômica: grava em
 * .tmp e renomeia, então uma queda no meio não corrompe o arquivo.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ───────────────────────── configuração ─────────────────────────
function envInt(name, def) {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : def;
}

function defaults() {
  return {
    dataFile: process.env.DATA_FILE || path.join(__dirname, 'data', 'referrals.json'),
    pointsPerReferral: envInt('POINTS_PER_REFERRAL', 100),
    maxRewardedPerCode: envInt('MAX_REWARDED_PER_CODE', 50),
    // HTTP do servidor que conta os pontos (o mesmo do signaling). Ex.: https://relay.vagalun.com
    // Se vazio, toda indicação vale na hora (modo desenvolvimento, sem antifraude).
    pointsApiUrl: (process.env.POINTS_API_URL || '').replace(/\/+$/, ''),
    activeUptimeSeconds: envInt('ACTIVE_UPTIME_SECONDS', 1800),
    pendingTtlDays: envInt('PENDING_TTL_DAYS', 30),
    redeemPerIpPerDay: envInt('REDEEM_PER_IP_PER_DAY', 20),
    statsPerIpPerMinute: envInt('STATS_PER_IP_PER_MINUTE', 120),
    sweepMs: envInt('SWEEP_MS', 10 * 60 * 1000),
    refreshThrottleMs: envInt('REFRESH_THROTTLE_MS', 30000),
    appDownloadUrl: process.env.APP_DOWNLOAD_URL || '',
    androidPackage: process.env.ANDROID_PACKAGE || 'com.decentstorage.app',
    adminToken: process.env.ADMIN_TOKEN || '',
    trustProxy: process.env.TRUST_PROXY === '1',
  };
}

// ───────────────────────── base58 / ed25519 ─────────────────────────
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58decode(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > 60) return null;
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let bytes = Buffer.alloc(0);
  if (n > 0n) {
    let hex = n.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    bytes = Buffer.from(hex, 'hex');
  }
  let zeros = 0;
  for (const ch of s) { if (ch === '1') zeros++; else break; }
  return Buffer.concat([Buffer.alloc(zeros), bytes]);
}

function pubkeyBytes(pubkey) {
  const b = b58decode(pubkey);
  return b && b.length === 32 ? b : null;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function verifyEd25519(pubkey, message, signature) {
  try {
    const raw = pubkeyBytes(pubkey);
    if (!raw || !signature || signature.length !== 64) return false;
    const key = crypto.createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(null, Buffer.from(message), key, signature);
  } catch {
    return false;
  }
}

// O código de convite é o começo da carteira, em maiúsculas (igual ao app).
const CODE_RE = /^[1-9A-Z]{8}$/;
const codeOf = (pubkey) => pubkey.slice(0, 8).toUpperCase();
const redeemMessage = (code, pubkey) => `vagalun-referral:v1:${code}:${pubkey}`;

// ───────────────────────── armazenamento em JSON ─────────────────────────
class Store {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, codes: {}, referrals: {} };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        // Nunca sobrescrever um arquivo que não conseguimos ler: seria perder os dados.
        throw new Error(`Não consegui ler ${file} (${e.message}). Corrija ou renomeie o arquivo e tente de novo.`);
      }
      this.data = { version: 1, codes: {}, referrals: {}, ...parsed };
    }
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

// ───────────────────────── limite por IP ─────────────────────────
function makeLimiter(max, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    let e = hits.get(key);
    if (!e || e.resetAt <= now) {
      e = { count: 0, resetAt: now + windowMs };
      hits.set(key, e);
      if (hits.size > 50000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    e.count++;
    return e.count <= max;
  };
}

// ───────────────────────── página de convite ─────────────────────────
function landingHtml(code, cfg) {
  const dl = cfg.appDownloadUrl;
  const intent =
    `intent://invite/${code}#Intent;scheme=vagalun;package=${cfg.androidPackage};` +
    (dl ? `S.browser_fallback_url=${encodeURIComponent(dl)};` : '') + 'end';
  const shown = code ? `<div class="code" id="code">${code}</div>` : '';
  return `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${code ? 'Você foi convidado para a Vagalun' : 'Vagalun'}</title>
<meta name="description" content="Ceda o espaço que sobra no seu celular e ganhe pontos. Guarde seus arquivos em uma rede feita por pessoas, no Brasil.">
<meta name="theme-color" content="#E5382B">
<style>
:root{--bg:#fff;--card:#f5f5f4;--bd:#e6e6e4;--tx:#111;--tx2:#777;--red:#e5382b}
@media(prefers-color-scheme:dark){:root{--bg:#0f0f0e;--card:#1a1a19;--bd:#2e2e2c;--tx:#f2f2f0;--tx2:#a0a09b;--red:#f0503f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
main{width:100%;max-width:420px;text-align:center}
.brand{color:var(--red);font-weight:800;letter-spacing:.14em;font-size:15px}
h1{font-size:28px;line-height:1.2;margin:14px 0 10px}
p{color:var(--tx2);margin:0 0 22px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:22px;padding:22px;margin-bottom:18px}
.label{font-size:13px;color:var(--tx2);margin-bottom:8px}
.code{font:700 34px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;margin:4px 0 16px}
.btn{display:block;width:100%;border:0;border-radius:18px;padding:15px 18px;font:600 16px system-ui,sans-serif;text-decoration:none;cursor:pointer;margin-top:10px}
.pri{background:var(--red);color:#fff}
.sec{background:transparent;color:var(--tx);border:1px solid var(--bd)}
ol{text-align:left;color:var(--tx2);padding-left:20px;margin:0}
ol li{margin:6px 0}
small{display:block;margin-top:22px;color:var(--tx2);font-size:12px}
</style></head>
<body><main>
<div class="brand">VAGALUN</div>
<h1>${code ? 'Seu amigo te convidou' : 'Ganhe com o espaço do seu celular'}</h1>
<p>${code ? 'Entre pela indicação dele e comece a contribuir com a rede.' : 'Guarde arquivos com segurança numa rede feita por pessoas, no Brasil.'}</p>
${code ? `<div class="card">
<div class="label">Código de convite</div>${shown}
<button class="btn pri" id="copy" type="button">Copiar código</button>
<a class="btn sec" id="open" href="${intent}" style="display:none">Já tenho o app — abrir</a>
${dl ? `<a class="btn sec" href="${dl.replace(/"/g, '&quot;')}">Baixar o app</a>` : ''}
</div>
<ol><li>Instale o app Vagalun.</li><li>Ao criar sua conta, digite o código acima<br>(ou depois, na aba Missões).</li><li>Deixe o app ligado — seu amigo ganha pontos quando você ficar ativo.</li></ol>` :
(dl ? `<a class="btn pri" href="${dl.replace(/"/g, '&quot;')}">Baixar o app</a>` : '')}
<small>Pontos não são dinheiro. A conversão, se houver, será anunciada à parte.</small>
</main>
<script>
(function(){
  if(/Android/i.test(navigator.userAgent)){var o=document.getElementById('open');if(o)o.style.display='block';}
  var b=document.getElementById('copy');
  if(b)b.addEventListener('click',function(){
    var c=document.getElementById('code').textContent;
    function done(){b.textContent='Código copiado ✓';}
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(c).then(done,done);}else{done();}
  });
})();
</script>
</body></html>`;
}

// ───────────────────────── serviço ─────────────────────────
function createReferral(overrides = {}) {
  const cfg = { ...defaults(), ...overrides };
  const store = new Store(cfg.dataFile);
  const redeemOk = makeLimiter(cfg.redeemPerIpPerDay, 24 * 60 * 60 * 1000);
  const statsOk = makeLimiter(cfg.statsPerIpPerMinute, 60 * 1000);
  const lastRefresh = new Map(); // code -> timestamp (evita consultar o servidor de pontos toda hora)

  const { codes, referrals } = store.data;
  const now = () => Date.now();
  const requireActivity = () => cfg.pointsApiUrl !== '';

  function clientIp(req) {
    if (cfg.trustProxy) {
      const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (xff) return xff;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  function sendHtml(res, status, html) {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(html);
  }

  function readJson(req, limit = 4096) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new Error('too_large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
        catch { reject(new Error('bad_json')); }
      });
      req.on('error', reject);
    });
  }

  // Consulta o servidor de pontos e promove "pending" → "active" quem já ficou online o suficiente.
  async function refreshPending(onlyCode) {
    if (!requireActivity()) return;
    const ttl = cfg.pendingTtlDays * 24 * 60 * 60 * 1000;
    const list = Object.entries(referrals).filter(([, r]) => r.status === 'pending' && (!onlyCode || r.code === onlyCode));
    let changed = false;
    const queue = list.slice();
    const worker = async () => {
      while (queue.length) {
        const [referee, r] = queue.shift();
        if (now() - r.createdAt > ttl) { r.status = 'expired'; changed = true; continue; }
        try {
          const resp = await fetch(`${cfg.pointsApiUrl}/points/${encodeURIComponent(referee)}`, { signal: AbortSignal.timeout(4000) });
          if (!resp.ok) continue;
          const j = await resp.json();
          if ((j.uptimeSeconds || 0) >= cfg.activeUptimeSeconds) {
            r.status = 'active';
            r.activatedAt = now();
            changed = true;
          }
        } catch { /* servidor de pontos fora do ar: tenta na próxima */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker));
    if (changed) store.save();
  }

  function statsFor(pubkey) {
    const code = codeOf(pubkey);
    let invited = 0, active = 0, pending = 0;
    for (const r of Object.values(referrals)) {
      if (r.referrer !== pubkey) continue;
      if (r.status === 'expired') continue;
      invited++;
      if (r.status === 'active') active++; else pending++;
    }
    const rewarded = Math.min(active, cfg.maxRewardedPerCode);
    return {
      code,
      invited,
      active,
      pending,
      bonusPoints: rewarded * cfg.pointsPerReferral,
      pointsPerReferral: cfg.pointsPerReferral,
      activeUptimeSeconds: requireActivity() ? cfg.activeUptimeSeconds : 0,
      invitedBy: referrals[pubkey] ? referrals[pubkey].code : null,
    };
  }

  // ── rotas ──
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const method = req.method;

    if (method === 'GET' && p === '/health') { sendJson(res, 200, { ok: true }); return true; }

    if (method === 'GET' && (p === '/' || p === '/i' || p === '/i/')) {
      sendHtml(res, 200, landingHtml('', cfg)); return true;
    }

    let m = p.match(/^\/i\/([^/]+)\/?$/);
    if (method === 'GET' && m) {
      const code = decodeURIComponent(m[1]).trim().toUpperCase();
      sendHtml(res, CODE_RE.test(code) ? 200 : 404, landingHtml(CODE_RE.test(code) ? code : '', cfg));
      return true;
    }

    m = p.match(/^\/referral\/stats\/([^/]+)$/);
    if (method === 'GET' && m) {
      if (!statsOk(clientIp(req))) { sendJson(res, 429, { error: 'rate_limited' }); return true; }
      const pubkey = decodeURIComponent(m[1]);
      if (!pubkeyBytes(pubkey)) { sendJson(res, 400, { error: 'invalid_pubkey' }); return true; }
      const code = codeOf(pubkey);
      // Quem abre o app passa a "existir": é assim que o servidor sabe quais códigos são reais
      // (e consegue avisar quem digitou um código errado).
      if (!codes[code]) { codes[code] = pubkey; store.save(); }
      if (codes[code] !== pubkey) { sendJson(res, 200, { ...statsFor('-'), code }); return true; } // colisão de prefixo: nunca acontece na prática
      if (now() - (lastRefresh.get(code) || 0) >= cfg.refreshThrottleMs) {
        lastRefresh.set(code, now());
        await refreshPending(code);
      }
      sendJson(res, 200, statsFor(pubkey));
      return true;
    }

    if (method === 'POST' && p === '/referral/redeem') {
      if (!redeemOk(clientIp(req))) { sendJson(res, 429, { error: 'rate_limited' }); return true; }
      let body;
      try { body = await readJson(req); }
      catch (e) { sendJson(res, e.message === 'too_large' ? 413 : 400, { error: e.message }); return true; }

      const code = String(body.code || '').trim().toUpperCase();
      const pubkey = String(body.pubkey || '');
      if (!CODE_RE.test(code)) { sendJson(res, 400, { error: 'invalid_code' }); return true; }
      if (!pubkeyBytes(pubkey)) { sendJson(res, 400, { error: 'invalid_pubkey' }); return true; }

      let sig;
      try { sig = Buffer.from(String(body.signature || ''), 'base64'); } catch { sig = null; }
      if (!verifyEd25519(pubkey, redeemMessage(code, pubkey), sig)) {
        sendJson(res, 401, { error: 'bad_signature' }); return true;
      }

      if (referrals[pubkey]) { sendJson(res, 409, { error: 'already_redeemed', code: referrals[pubkey].code }); return true; }
      if (code === codeOf(pubkey)) { sendJson(res, 400, { error: 'self_referral' }); return true; }
      const referrer = codes[code];
      if (!referrer) { sendJson(res, 404, { error: 'unknown_code' }); return true; }
      if (referrer === pubkey) { sendJson(res, 400, { error: 'self_referral' }); return true; }

      if (!codes[codeOf(pubkey)]) codes[codeOf(pubkey)] = pubkey; // a carteira que resgata também passa a existir
      referrals[pubkey] = {
        code,
        referrer,
        createdAt: now(),
        status: requireActivity() ? 'pending' : 'active',
        activatedAt: requireActivity() ? null : now(),
      };
      store.save();
      sendJson(res, 200, { ok: true, status: referrals[pubkey].status });
      return true;
    }

    if (method === 'GET' && p === '/admin/summary') {
      const tok = String(req.headers['x-admin-token'] || '');
      const a = Buffer.from(tok), b = Buffer.from(cfg.adminToken);
      if (!cfg.adminToken || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        sendJson(res, 401, { error: 'unauthorized' }); return true;
      }
      const byStatus = { pending: 0, active: 0, expired: 0 };
      const perCode = {};
      for (const r of Object.values(referrals)) {
        byStatus[r.status] = (byStatus[r.status] || 0) + 1;
        perCode[r.code] ||= { invited: 0, active: 0 };
        perCode[r.code].invited++;
        if (r.status === 'active') perCode[r.code].active++;
      }
      const top = Object.entries(perCode).sort((x, y) => y[1].active - x[1].active || y[1].invited - x[1].invited)
        .slice(0, 10).map(([code, v]) => ({ code, ...v }));
      sendJson(res, 200, {
        knownWallets: Object.keys(codes).length,
        referrals: Object.keys(referrals).length,
        byStatus,
        pointsGranted: Object.values(perCode).reduce((s, v) => s + Math.min(v.active, cfg.maxRewardedPerCode) * cfg.pointsPerReferral, 0),
        top,
      });
      return true;
    }

    return false;
  }

  const timer = cfg.sweepMs > 0 ? setInterval(() => refreshPending().catch(() => {}), cfg.sweepMs) : null;
  if (timer) timer.unref();
  if (!requireActivity()) {
    console.warn('[referral] POINTS_API_URL vazio: indicações valem NA HORA (modo desenvolvimento). Em produção, configure para exigir atividade real.');
  }

  return { handle, close: () => timer && clearInterval(timer), _store: store, _cfg: cfg };
}

module.exports = { createReferral, b58decode, verifyEd25519, codeOf, redeemMessage, CODE_RE };
