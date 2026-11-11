// Construtor de sites com IA (painel: página inicial "AI Website Builder").
//
// Rotas (o painel em client/src/pages/Home.jsx já chama exatamente estas):
//   POST /api/generate          { prompt, siteId? }  -> { id, url, updated }
//        Gera (ou ajusta, se vier siteId) um rascunho em drafts/<id>/index.html. Sem login.
//   GET  /drafts/:id            Preview do rascunho (usado no iframe do painel).
//   POST /api/generate/publish  { draftId }  (Bearer token) -> { success, site }
//        Publica o rascunho nos nós, igual ao upload de .zip.
//
// Usa a API da Groq (formato OpenAI). Variáveis do .env:
//   GROQ_API_KEY (obrigatória), GROQ_MODEL, GROQ_REASONING_EFFORT (opcional, p/ modelos com raciocínio)
//   GEN_PER_IP_PER_HOUR (8), GEN_MAX_CONCURRENT (3), DRAFT_TTL_DAYS (7)
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const MAX_PROMPT_CHARS = 2000;
const MAX_HTML_BYTES = 400 * 1024;
const GROQ_URL = process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions';

const SYSTEM_PROMPT = `You are Vagalun AI, a website builder. You turn a short description into ONE complete, polished, single-file website.

Rules:
- Output ONLY the full HTML document, starting with <!DOCTYPE html> and ending with </html>. No markdown, no code fences, no explanations.
- Everything inline: all CSS in one <style>, all JavaScript in one <script>. No frameworks, no CDN, no external fonts, no external images or scripts (the site is hosted on a peer-to-peer network). Use system font stacks, CSS gradients, inline SVG and emoji for visuals.
- Responsive (mobile first), accessible (semantic tags, alt text, contrast), modern and visually strong. Include <meta name="viewport"> and a meaningful <title>.
- Write the site's text in the same language as the user's description.
- Make it actually work: working navigation, interactive widgets (cart, filters, forms with client-side validation, etc.) implemented in vanilla JS. Forms must not submit to any server; show a friendly confirmation instead.
- Never include the user's secrets, trackers, or code that calls external APIs.
- When given an existing site plus a change request, return the COMPLETE updated file, keeping everything the user did not ask to change.`;

function slugify(text) {
  const s = String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 28).replace(/-+$/g, '');
  return s || 'site';
}

function extractHtml(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence && /<html|<!doctype/i.test(fence[1])) t = fence[1].trim();
  else {
    const i = t.search(/<!doctype html|<html[\s>]/i);
    if (i > 0) t = t.slice(i);
  }
  if (!/<!doctype html|<html[\s>]/i.test(t) || !/<\/html>\s*$/i.test(t)) return null;
  return t;
}

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function registerGenerateRoutes(app, deps) {
  const {
    authenticate, sites, saveDB, findUserById, getPlan, uuidv4,
    sitesDir, draftsDir, publishToGateway, publicBaseDomain,
  } = deps;

  const num = (name, def) => { const v = parseInt(process.env[name] ?? '', 10); return Number.isFinite(v) ? v : def; };
  const PER_IP_PER_HOUR = num('GEN_PER_IP_PER_HOUR', 8);
  const MAX_CONCURRENT = num('GEN_MAX_CONCURRENT', 3);
  const TTL_MS = num('DRAFT_TTL_DAYS', 7) * 24 * 3600 * 1000;

  fs.mkdirSync(draftsDir, { recursive: true });

  const hits = new Map();          // ip -> [timestamps]
  const publishing = new Set();    // draftIds sendo publicados agora
  let running = 0;

  const clientIp = (req) =>
    String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'x');

  function rateLimited(ip) {
    if (PER_IP_PER_HOUR <= 0) return false;
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
    if (list.length >= PER_IP_PER_HOUR) { hits.set(ip, list); return true; }
    list.push(now); hits.set(ip, list);
    return false;
  }

  // Limpa rascunhos antigos e contadores velhos (a cada hora; unref não segura o processo).
  function sweep() {
    const now = Date.now();
    for (const [ip, list] of hits) {
      const fresh = list.filter((t) => now - t < 3600_000);
      if (fresh.length) hits.set(ip, fresh); else hits.delete(ip);
    }
    if (TTL_MS <= 0) return;
    try {
      for (const name of fs.readdirSync(draftsDir)) {
        if (!ID_RE.test(name)) continue;
        const dir = path.join(draftsDir, name);
        const st = fs.statSync(dir);
        if (st.isDirectory() && now - st.mtimeMs > TTL_MS) fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (e) { console.warn('[generate] limpeza de rascunhos falhou:', e.message); }
  }
  setInterval(sweep, 3600_000).unref();
  sweep();

  const draftFile = (id) => path.join(draftsDir, id, 'index.html');
  const metaFile = (id) => path.join(draftsDir, id, '.meta.json');
  const readMeta = (id) => { try { return JSON.parse(fs.readFileSync(metaFile(id), 'utf8')); } catch { return {}; } };

  async function askGroq(messages) {
    if (typeof fetch !== 'function') throw new Error('Node sem fetch (use Node 18+).');
    const body = {
      model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
      messages,
      temperature: 0.7,
      max_completion_tokens: 16000,
    };
    if (process.env.GROQ_REASONING_EFFORT) body.reasoning_effort = process.env.GROQ_REASONING_EFFORT;
    const resp = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(150_000),
    });
    if (!resp.ok) {
      const txt = (await resp.text().catch(() => '')).slice(0, 300);
      console.error(`[generate] Groq respondeu ${resp.status}: ${txt}`);
      if (resp.status === 429) throw Object.assign(new Error('A IA está sobrecarregada agora. Tente de novo em instantes.'), { status: 429 });
      throw Object.assign(new Error('A IA não conseguiu responder agora. Tente de novo.'), { status: 502 });
    }
    const j = await resp.json();
    return j?.choices?.[0]?.message?.content || '';
  }

  // ───────────── POST /api/generate ─────────────
  app.post('/api/generate', async (req, res) => {
    if (!process.env.GROQ_API_KEY) {
      return res.status(503).json({ error: 'Gerador de IA não configurado (falta GROQ_API_KEY no .env do servidor).' });
    }
    const prompt = String(req.body?.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'Descreva o site que você quer.' });
    if (prompt.length > MAX_PROMPT_CHARS) {
      return res.status(400).json({ error: `Descrição muito longa (máx. ${MAX_PROMPT_CHARS} caracteres).` });
    }

    let draftId = req.body?.siteId ? String(req.body.siteId) : null;
    if (draftId && !ID_RE.test(draftId)) return res.status(400).json({ error: 'Rascunho inválido.' });
    let previous = null;
    if (draftId) {
      try { previous = fs.readFileSync(draftFile(draftId), 'utf8'); } catch { previous = null; draftId = null; }
    }

    if (rateLimited(clientIp(req))) {
      return res.status(429).json({ error: 'Muitos pedidos seguidos. Tente de novo em alguns minutos.' });
    }
    if (running >= MAX_CONCURRENT) {
      return res.status(503).json({ error: 'Muita gente gerando sites agora. Tente de novo em instantes.' });
    }

    running++;
    try {
      const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
      if (previous) {
        messages.push({
          role: 'user',
          content: `Here is the current site:\n\n${previous}\n\nApply this change and return the COMPLETE updated HTML file:\n${prompt}`,
        });
      } else {
        messages.push({ role: 'user', content: prompt });
      }

      const html = extractHtml(await askGroq(messages));
      if (!html) {
        return res.status(502).json({ error: 'A IA devolveu uma resposta incompleta. Tente uma descrição mais curta.' });
      }
      if (Buffer.byteLength(html) > MAX_HTML_BYTES) {
        return res.status(502).json({ error: 'O site gerado ficou grande demais. Peça algo mais simples.' });
      }

      const id = draftId || `${slugify(prompt)}-${crypto.randomBytes(3).toString('hex')}`;
      fs.mkdirSync(path.join(draftsDir, id), { recursive: true });
      atomicWrite(draftFile(id), html);
      return res.json({ id, url: `/drafts/${id}/`, updated: !!previous });
    } catch (err) {
      const status = err.name === 'TimeoutError' || err.name === 'AbortError' ? 504 : (err.status || 500);
      const msg = status === 504 ? 'A IA demorou demais para responder. Tente uma descrição mais curta.' : err.message;
      if (status === 500) console.error('[generate] erro:', err);
      return res.status(status).json({ error: msg });
    } finally {
      running--;
    }
  });

  // ───────────── GET /drafts/:id (preview) ─────────────
  // O HTML é gerado por IA a partir de texto do visitante: nunca pode rodar na origem do painel
  // (o token de login fica no localStorage dela). `sandbox` sem allow-same-origin isola isso.
  function servePreview(req, res) {
    const id = req.params.id;
    if (!ID_RE.test(id) || !fs.existsSync(draftFile(id))) return res.status(404).send('Rascunho não encontrado.');
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "sandbox allow-scripts allow-forms allow-popups allow-modals; frame-ancestors 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(draftFile(id)).pipe(res);
  }
  app.get('/drafts/:id/index.html', servePreview);
  app.get('/drafts/:id', servePreview);

  // ───────────── POST /api/generate/publish ─────────────
  app.post('/api/generate/publish', authenticate, async (req, res) => {
    const draftId = String(req.body?.draftId || '');
    if (!ID_RE.test(draftId)) return res.status(400).json({ error: 'Rascunho inválido.' });
    if (!fs.existsSync(draftFile(draftId))) {
      return res.status(404).json({ error: 'Rascunho não encontrado (pode ter expirado). Gere o site de novo.' });
    }
    if (publishing.has(draftId)) return res.status(409).json({ error: 'Esse site já está sendo publicado.' });

    const user = findUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const plan = getPlan(user);

    const meta = readMeta(draftId);
    let site = meta.siteId ? sites.get(meta.siteId) : null;
    if (site && site.userId !== req.userId) site = null;
    const isNew = !site;

    if (isNew) {
      const count = [...sites.values()].filter((s) => s.userId === req.userId).length;
      if (count >= plan.maxSites) {
        return res.status(403).json({
          error: `Seu plano (${plan.name}) permite no máximo ${plan.maxSites} site(s). Faça upgrade em /billing para criar mais.`,
        });
      }
    }

    const bytes = fs.statSync(draftFile(draftId)).size;
    const limitBytes = plan.storageMB * 1024 * 1024;
    const siteId = site ? site.siteId : uuidv4();
    const otherBytes = [...sites.values()]
      .filter((s) => s.userId === req.userId && s.siteId !== siteId)
      .reduce((sum, s) => sum + (s.storageUsed || 0), 0);
    if (otherBytes + bytes > limitBytes) {
      return res.status(402).json({
        error: `Esse site passaria do limite de ${plan.storageMB} MB do plano ${plan.name}. Faça upgrade em /billing.`,
      });
    }

    publishing.add(draftId);
    const siteDir = path.join(sitesDir, siteId);
    const oldBytes = site ? (site.storageUsed || 0) : 0;
    try {
      fs.rmSync(siteDir, { recursive: true, force: true });
      fs.mkdirSync(siteDir, { recursive: true });
      fs.copyFileSync(draftFile(draftId), path.join(siteDir, 'index.html'));

      if (isNew) {
        const title = (fs.readFileSync(draftFile(draftId), 'utf8').match(/<title[^>]*>([^<]{1,80})<\/title>/i) || [])[1];
        const domain = `${siteId}.${publicBaseDomain}`;
        site = {
          siteId, userId: req.userId, name: (title || draftId).trim(), domain,
          status: 'ready', storageUsed: 0, trafficUsed: 0,
          url: `https://${domain}`, createdAt: new Date(), files: [],
        };
        sites.set(siteId, site); // publishToGateway lê o site pelo mapa (lastRoutes, anúncios)
      }

      const result = await publishToGateway(siteId, siteDir);
      site.gatewayDomain = result.domain;
      site.storageUsed = bytes;
      site.files = 'index.html';
      saveDB();
      fs.rmSync(siteDir, { recursive: true, force: true });
      atomicWrite(metaFile(draftId), JSON.stringify({ siteId, userId: req.userId }));
      return res.json({ success: true, site });
    } catch (err) {
      fs.rmSync(siteDir, { recursive: true, force: true });
      if (isNew) sites.delete(siteId); else site.storageUsed = oldBytes;
      saveDB();
      console.error(`[generate] falha ao publicar rascunho ${draftId}:`, err.message);
      return res.status(502).json({
        error: `Falha ao publicar nos nós: ${err.message}. Confira se o gateway e os celulares/nós estão no ar.`,
      });
    } finally {
      publishing.delete(draftId);
    }
  });
}
