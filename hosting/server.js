import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import { optimizeMediaFile, optimizeMediaDir } from './mediaOptimize.js';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import unzipper from 'unzipper';
import QRCode from 'qrcode';
import { createRequire } from 'module';
import http from 'node:http';

dotenv.config();

const require = createRequire(import.meta.url);
const {
  publishSiteDir, resolvePublishTargets, resolveStreamTargets, uploadFileToGateway,
  deleteFileFromGateway, publishRoutes, fetchFileFromGateway, isStreamable,
} = require('./gateway-client/publish.cjs');

// Publicação nos nós é OBRIGATÓRIA: o disco local (hosting/sites/<id>) é só
// um estágio temporário de processamento (extrair zip, medir tamanho,
// publicar). Depois que a publicação nos nós é confirmada, o diretório local
// é apagado — quem serve o site pro visitante é sempre o gateway/rede de
// nós (ver sendSiteFile), nunca mais o disco desta VPS.
const GATEWAY_URL = process.env.GATEWAY_URL || null;
const GATEWAY_ADMIN_TOKEN = process.env.GATEWAY_ADMIN_TOKEN || null;
const GATEWAY_RELAY_URL = process.env.GATEWAY_RELAY_URL || null;
// SIGNALING_ADMIN_TOKEN é o token do sever/server.js (rota GET /nodes),
// que é um processo/porta diferente do gateway — não confundir com
// GATEWAY_ADMIN_TOKEN, que é do sever/gateway/gateway.js.
const SIGNALING_ADMIN_TOKEN = process.env.SIGNALING_ADMIN_TOKEN || null;
const GATEWAY_NODE_HOST = process.env.GATEWAY_NODE_HOST || null;
const GATEWAY_NODE_PORT = process.env.GATEWAY_NODE_PORT || null;
const GATEWAY_BASE_DOMAIN = process.env.GATEWAY_BASE_DOMAIN || 'gateway.local';
// Domínio público que os usuários acessam (ex: vagalun.shop). Usado só pra
// decidir se um Host recebido é o painel/API (apex, www, app, api, signal)
// ou o subdomínio de um site publicado (ex: cole.vagalun.shop).
const PUBLIC_BASE_DOMAIN = process.env.PUBLIC_BASE_DOMAIN || GATEWAY_BASE_DOMAIN;
const RESERVED_SUBDOMAINS = new Set(
  (process.env.RESERVED_SUBDOMAINS || 'www,app,api,signal,gateway')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
);

// Pergunta ao signaling (sever/server.js) quem está conectado AGORA, em vez
// de confiar num nodeId fixo salvo no .env. Peers (celulares) são efêmeros:
// entram e saem o tempo todo, então essa lista precisa ser consultada a
// cada publish, nunca hardcoded.
//
// IMPORTANTE: o /nodes do signaling é uma lista "crua" de QUALQUER cliente
// WebSocket conectado — não só celulares. O próprio processo gateway fica
// conectado o tempo todo como GATEWAY_RELAY_NODE_ID (default 'gateway-1',
// ver sever/gateway/content.js) pra poder pedir shards via relay, e scripts
// de publish (esse arquivo, o CLI) se conectam com nodeId tipo
// 'hosting-platform-<timestamp>' ou 'publisher-<timestamp>'. Nenhum desses é
// um celular capaz de armazenar/servir shard — se entrarem na lista de "nós
// disponíveis pra publicar", o publish tenta mandar shard pra eles e trava em
// timeout (foi o bug que causou "timeout esperando resposta de gateway-1").
const INFRA_NODE_IDS = new Set(
  (process.env.GATEWAY_RELAY_NODE_ID || 'gateway-1').split(',').map((s) => s.trim()).filter(Boolean)
);
function isInfraNodeId(nodeId) {
  return INFRA_NODE_IDS.has(nodeId) || nodeId.startsWith('publisher-') || nodeId.startsWith('hosting-platform-');
}
async function getOnlineRelayNodeIds() {
  if (!GATEWAY_RELAY_URL) return [];
  // GATEWAY_RELAY_URL é ws://host:porta — a rota /nodes é HTTP na mesma porta.
  const httpUrl = GATEWAY_RELAY_URL.replace(/^ws/, 'http').replace(/\/$/, '') + '/nodes';
  const headers = SIGNALING_ADMIN_TOKEN ? { 'X-Admin-Token': SIGNALING_ADMIN_TOKEN } : {};
  const resp = await fetch(httpUrl, { headers });
  if (!resp.ok) {
    throw new Error(`signaling respondeu ${resp.status} ao consultar nós online (${httpUrl})`);
  }
  const data = await resp.json();
  const online = Array.isArray(data.online) ? data.online : [];
  return online.filter((nodeId) => !isInfraNodeId(nodeId));
}

// Publica um site inteiro nos nós. Lança erro se não conseguir — quem chama
// decide o que fazer (não apaga o disco local, não confirma o deploy).
async function publishToGateway(siteId, siteDir) {
  if (!GATEWAY_URL) {
    throw new Error('GATEWAY_URL não configurado no .env — sem ele não dá pra publicar (e não existe mais fallback local).');
  }
  const hasTcp = GATEWAY_NODE_HOST && GATEWAY_NODE_PORT;

  let onlineNodes = [];
  if (GATEWAY_RELAY_URL) {
    onlineNodes = await getOnlineRelayNodeIds();
  }
  const hasRelay = onlineNodes.length > 0;

  if (!hasRelay && !hasTcp) {
    throw new Error(
      GATEWAY_RELAY_URL
        ? 'Nenhum nó/celular está conectado ao signaling agora (lista de /nodes veio vazia). Abra o app nos celulares que vão hospedar e tente de novo.'
        : 'Config do gateway incompleta: defina GATEWAY_RELAY_URL (signaling) ou (GATEWAY_NODE_HOST + GATEWAY_NODE_PORT) no .env.'
    );
  }

  // k = quantos nós dão pra reconstruir o arquivo, m = quantos extras de
  // paridade. Com N celulares reais online agora, m>0 aguenta até m cair
  // sem derrubar o site. Com 1 celular só, fica k=1/m=0 (sem redundância).
  const phoneCount = hasRelay ? onlineNodes.length : 1;
  const k = Math.max(1, Math.min(phoneCount, Number(process.env.GATEWAY_K || phoneCount)));
  const m = Math.max(0, Number(process.env.GATEWAY_M || Math.max(0, phoneCount - k)));

  const domain = `${siteId}.${GATEWAY_BASE_DOMAIN}`;
  const site = sites.get(siteId);
  const result = await publishSiteDir(siteDir, domain, {
    gatewayUrl: GATEWAY_URL,
    adminToken: GATEWAY_ADMIN_TOKEN,
    k, m,
    relayUrl: hasRelay ? GATEWAY_RELAY_URL : undefined,
    relayNodeId: hasRelay ? onlineNodes : undefined, // array de nodeIds conectados agora
    nodeHost: hasTcp ? GATEWAY_NODE_HOST : undefined,
    nodePort: hasTcp ? Number(GATEWAY_NODE_PORT) : undefined,
    // Rotas (com fileId) da última publicação bem-sucedida deste site.
    // Arquivo cujo path+conteúdo não mudou é pulado (sem reencode/reupload
    // de shard) — só arquivo novo ou alterado é reenviado aos nós.
    previousRoutes: site?.lastRoutes || [],
    // Anúncio configurado pelo dono do site (POST /api/sites/:siteId/ads no
    // painel) — vira options.ads em todo <video> reescrito pro player P2P.
    adsConfig: site?.adsConfig || null,
    // Sem limite de tamanho/extensão aqui: agora TUDO precisa ir pro nó,
    // já que o disco local deixa de existir depois do publish.
  });
  // Guarda pra próxima republicação poder pular os arquivos que não mudaram.
  // (quem chama publishToGateway já dá saveDB() logo em seguida, mas
  // garantimos aqui também caso isso mude no futuro)
  if (site) { site.lastRoutes = result.routesFull; saveDB(); }
  console.log(
    `[gateway] site publicado: ${domain} (${result.fileCount} arquivo(s): ` +
    `${result.uploaded} enviado(s), ${result.reused} reaproveitado(s) sem mudança, ${result.deletedOrphans} órfão(s) apagado(s) dos nós; ${phoneCount} nó(s): ${onlineNodes.join(', ') || GATEWAY_NODE_HOST})`
  );
  if (result.deleteFailures?.length) {
    console.warn(`[gateway] falha ao apagar ${result.deleteFailures.length} fileId(s) órfão(s) dos nós (ficam ocupando espaço até tentar de novo):`, result.deleteFailures);
  }
  return { domain, fileCount: result.fileCount, uploaded: result.uploaded, reused: result.reused };
}

// Resolve pra qual(is) nó(s) publicar agora (mesma lógica de publishToGateway,
// extraída pra ser reaproveitada pelo Explorador — que publica arquivo a
// arquivo em vez de a pasta inteira). Devolve tudo que
// resolvePublishTargets/uploadFileToGateway/deleteFileFromGateway/publishRoutes
// (gateway-client/publish.cjs) precisam.
async function resolveGatewayConfig() {
  if (!GATEWAY_URL) {
    throw new Error('GATEWAY_URL não configurado no .env — sem ele não dá pra publicar (e não existe mais fallback local).');
  }
  const hasTcp = GATEWAY_NODE_HOST && GATEWAY_NODE_PORT;

  let onlineNodes = [];
  if (GATEWAY_RELAY_URL) {
    onlineNodes = await getOnlineRelayNodeIds();
  }
  const hasRelay = onlineNodes.length > 0;

  if (!hasRelay && !hasTcp) {
    throw new Error(
      GATEWAY_RELAY_URL
        ? 'Nenhum nó/celular está conectado ao signaling agora (lista de /nodes veio vazia). Abra o app nos celulares que vão hospedar e tente de novo.'
        : 'Config do gateway incompleta: defina GATEWAY_RELAY_URL (signaling) ou (GATEWAY_NODE_HOST + GATEWAY_NODE_PORT) no .env.'
    );
  }

  const phoneCount = hasRelay ? onlineNodes.length : 1;
  const k = Math.max(1, Math.min(phoneCount, Number(process.env.GATEWAY_K || phoneCount)));
  const m = Math.max(0, Number(process.env.GATEWAY_M || Math.max(0, phoneCount - k)));

  return {
    gatewayUrl: GATEWAY_URL,
    adminToken: GATEWAY_ADMIN_TOKEN,
    k, m,
    relayUrl: hasRelay ? GATEWAY_RELAY_URL : undefined,
    relayNodeId: hasRelay ? onlineNodes : undefined,
    nodeHost: hasTcp ? GATEWAY_NODE_HOST : undefined,
    nodePort: hasTcp ? Number(GATEWAY_NODE_PORT) : undefined,
  };
}

function siteDomain(siteId) {
  return `${siteId}.${GATEWAY_BASE_DOMAIN}`;
}

// Só usada pela pasta de estágio temporária do upload inicial de .zip
// (POST /api/sites/:id/upload) — o Explorador não usa mais disco, então não
// precisa mais disso pra republicar edições avulsas.
function getDirSize(dir) {
  let size = 0;
  fs.readdirSync(dir).forEach(file => {
    const full = path.join(dir, file);
    const stat = fs.statSync(full);
    size += stat.size;
    if (stat.isDirectory()) size += getDirSize(full);
  });
  return size;
}

// Sobe UM arquivo direto pros nós (sem pasta local nenhuma) e devolve a rota
// pronta { path, fileId, contentType, size }. Fecha o relayClient sozinho.
// Vídeo/áudio (ver isStreamable) sobe em modo replicado (k=1, várias cópias
// completas) em vez de fatiado — é o que habilita o player P2P no navegador
// (sever/gateway/p2pPlayerScript.js) pra esse arquivo depois.
async function uploadSingleFileToNodes(siteId, relPath, buffer) {
  const gwOpts = await resolveGatewayConfig();
  const streamable = isStreamable(relPath);
  const targets = streamable
    ? await resolveStreamTargets(gwOpts, 3)
    : await resolvePublishTargets(gwOpts);
  try {
    return await uploadFileToGateway(buffer, relPath, siteDomain(siteId), targets, gwOpts);
  } finally {
    if (targets.relayClient) targets.relayClient.close();
  }
}

// Reassina e republica o manifesto do site com a lista de routes dada
// (já resolvidas, com fileId) — sem reencode/reupload de shard nenhum.
// Atualiza site.lastRoutes/gatewayDomain e salva o banco.
async function publishSiteRoutes(site, routes) {
  const gwOpts = await resolveGatewayConfig();
  const result = await publishRoutes(siteDomain(site.siteId), routes, gwOpts);
  site.lastRoutes = routes;
  site.gatewayDomain = result.domain;
  site.storageUsed = routes.reduce((sum, r) => sum + (r.size || 0), 0);
  saveDB();
  return result;
}

// Apaga um fileId dos nós, best-effort (não lança — um shard órfão só fica
// ocupando espaço até uma limpeza futura, nunca deve travar a operação do
// usuário no Explorador).
async function deleteFileRemote(fileId) {
  const gwOpts = await resolveGatewayConfig();
  return deleteFileFromGateway(fileId, gwOpts);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'secret-key-change-in-prod';

// ============ PLANOS ============
// storageMB / trafficMB em MB. price em R$ (reais).
const PLANS = {
  free:     { name: 'Free',     price: 0,  storageMB: 1,      trafficMB: 30,      maxSites: 1  },
  basic:    { name: 'Basic',    price: 5,  storageMB: 500,    trafficMB: 5000,    maxSites: 3  },
  pro:      { name: 'Pro',      price: 10, storageMB: 2000,   trafficMB: 20000,   maxSites: 10 },
  business: { name: 'Business', price: 30, storageMB: 10000,  trafficMB: 100000,  maxSites: 50 }
};
// Nomes antigos de plano que já foram gravados no banco (ex: users que
// assinaram antes do rename) mas não existem mais em PLANS. Sem isso,
// PLANS[user.plan] vem undefined e getPlan cai silenciosamente no free
// (1 MB) mesmo pra quem pagou um plano alto — foi o bug do zip de 1 MB.
const PLAN_ALIASES = { starter: 'basic' };
function getPlan(user) {
  const key = PLAN_ALIASES[user?.plan] || user?.plan;
  return PLANS[key] || PLANS.free;
}

// ============ COBRANÇA DIÁRIA (saldo em SOL) ============
// price (R$/mês) do PLANS vira um custo em SOL por dia. Free não cobra
// (fica de fora do débito diário, sem risco de ser congelado por saldo).
const SOL_BRL_RATE = Number(process.env.SOL_BRL_RATE || 500); // mesma taxa usada no checkout Solana
function planPriceSolPerDay(planKey) {
  const plan = PLANS[planKey];
  if (!plan || plan.price <= 0) return 0;
  return (plan.price / SOL_BRL_RATE) / 30;
}
// Dias que um site fica congelado (site.status = 'frozen') sem saldo antes
// de ser apagado de vez. Configurável via .env pra devnet poder testar rápido.
const FROZEN_DELETE_AFTER_DAYS = Number(process.env.FROZEN_DELETE_AFTER_DAYS || 7);
const BILLING_INTERVAL_MS = Number(process.env.BILLING_INTERVAL_MS || 24 * 60 * 60 * 1000);

// Apaga de vez um site congelado há tempo demais: local, no gateway (best
// effort) e do banco.
async function deleteSiteHard(site) {
  try {
    const siteDir = path.join(sitesDir, site.siteId);
    if (fs.existsSync(siteDir)) fs.rmSync(siteDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`[billing] falha ao apagar pasta local do site ${site.siteId}:`, err.message);
  }
  sites.delete(site.siteId);
  console.log(`🗑️  Site ${site.siteId} (${site.name}) apagado — congelado sem saldo há mais de ${FROZEN_DELETE_AFTER_DAYS} dia(s).`);
}

// Roda uma vez por dia: debita do saldo de cada usuário o custo dos sites
// publicados nesse plano, congela quem não tem saldo suficiente, e apaga
// quem está congelado há tempo demais. Best-effort — nunca lança, só loga.
// Também grava um registro em billingHistory por usuário a cada rodada
// (mesmo custo 0, plano free) pra alimentar a tela de consumo diário do
// painel — sem isso o usuário não tem como ver POR QUE o saldo caiu.
function addBillingHistoryEntry(userId, entry) {
  const list = billingHistory.get(userId) || [];
  list.push(entry);
  // mantém só os últimos N dias
  const cutoff = Date.now() - BILLING_HISTORY_MAX_DAYS * 24 * 60 * 60 * 1000;
  const trimmed = list.filter((e) => new Date(e.date).getTime() >= cutoff);
  billingHistory.set(userId, trimmed);
}

async function runDailyBilling() {
  try {
    let changed = false;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    for (const user of users.values()) {
      const perDay = planPriceSolPerDay(user.plan);
      const userSites = [...sites.values()].filter((s) => s.userId === user.userId);
      const publishedSites = userSites.filter((s) => s.status !== 'frozen' && s.gatewayDomain);

      if (perDay <= 0) {
        // Plano free (ou inválido): nada a debitar, mas ainda registra o
        // dia no histórico pra a linha do tempo do painel não ficar com buraco.
        addBillingHistoryEntry(user.userId, {
          date: today,
          plan: user.plan || 'free',
          sitesCount: publishedSites.length,
          costSol: 0,
          balanceAfter: +(user.balance || 0).toFixed(9),
          status: 'ok'
        });
        continue;
      }

      if (publishedSites.length === 0) {
        addBillingHistoryEntry(user.userId, {
          date: today,
          plan: user.plan,
          sitesCount: 0,
          costSol: 0,
          balanceAfter: +(user.balance || 0).toFixed(9),
          status: 'ok'
        });
        continue;
      }

      const costToday = perDay * publishedSites.length;
      if ((user.balance || 0) >= costToday) {
        user.balance = +(user.balance - costToday).toFixed(9);
        changed = true;
        addBillingHistoryEntry(user.userId, {
          date: today,
          plan: user.plan,
          sitesCount: publishedSites.length,
          costSol: +costToday.toFixed(9),
          balanceAfter: user.balance,
          status: 'ok'
        });
        continue;
      }

      // Saldo insuficiente: zera o que tinha e congela todos os sites
      // publicados desse usuário (pausa a exibição — ver sendSiteFile).
      const balanceBefore = user.balance || 0;
      user.balance = 0;
      for (const site of publishedSites) {
        site.status = 'frozen';
        site.frozenAt = site.frozenAt || new Date().toISOString();
        changed = true;
        console.log(`🧊 Site ${site.siteId} (${site.name}) congelado — saldo insuficiente pra plano ${user.plan}.`);
      }
      addBillingHistoryEntry(user.userId, {
        date: today,
        plan: user.plan,
        sitesCount: publishedSites.length,
        costSol: +costToday.toFixed(9),
        balanceAfter: 0,
        // custo do dia era maior que o saldo (balanceBefore) que tinha: mostra
        // no painel que o débito não foi feito integralmente, e sim que estourou.
        status: balanceBefore > 0 ? 'insufficient_partial' : 'frozen'
      });
    }

    // Sites já congelados há mais de FROZEN_DELETE_AFTER_DAYS: apaga.
    const now = Date.now();
    for (const site of [...sites.values()]) {
      if (site.status !== 'frozen' || !site.frozenAt) continue;
      const daysFrozen = (now - new Date(site.frozenAt).getTime()) / (24 * 60 * 60 * 1000);
      if (daysFrozen >= FROZEN_DELETE_AFTER_DAYS) {
        await deleteSiteHard(site);
        changed = true;
      }
    }

    saveDB(); // sempre salva: billingHistory muda toda rodada mesmo sem 'changed'
  } catch (err) {
    console.error('[billing] runDailyBilling falhou:', err.message);
  }
}
setInterval(runDailyBilling, BILLING_INTERVAL_MS);
// Roda uma vez logo na subida do processo também, pra não depender de
// esperar 24h pra pegar backlog (ex: server ficou horas fora do ar).
setTimeout(runDailyBilling, 10_000);

// Descongela um site assim que o usuário recarrega o saldo (chamado pelos
// handlers de pagamento confirmado — Stripe/PIX/Solana — depois de creditar).
function unfreezeSitesIfSolvent(userId) {
  const user = findUserById(userId);
  if (!user) return;
  const perDay = planPriceSolPerDay(user.plan);
  const frozenSites = [...sites.values()].filter((s) => s.userId === userId && s.status === 'frozen');
  if (frozenSites.length === 0) return;
  if (perDay > 0 && (user.balance || 0) < perDay * frozenSites.length) return; // ainda não dá pra cobrir nem 1 dia
  for (const site of frozenSites) {
    site.status = 'ready';
    delete site.frozenAt;
  }
  saveDB();
}

// Storage de uploads temporário
const uploadsDir = path.join(__dirname, 'uploads');
const sitesDir = path.join(__dirname, 'sites');
const docsDir = path.join(__dirname, 'docs');

[uploadsDir, sitesDir, docsDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Configurar multer
const upload = multer({ 
  dest: uploadsDir,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB
});

// Middleware
app.use(cors());

// ============ ROTEAMENTO POR SUBDOMÍNIO (sites publicados) ============
// Precisa vir ANTES de express.static('public') e de qualquer outra rota:
// se o Host da requisição for um subdomínio de PUBLIC_BASE_DOMAIN que não
// seja reservado (www/app/api/...), tratamos como acesso direto a um site
// publicado (ex: cole.vagalun.shop), resolvido por Host — não por path.
// Sem isso, o express.static já responde com public/index.html antes de
// chegar em qualquer outro middleware (foi o bug que você viu).
app.use(async (req, res, next) => {
  const hostHeader = (req.headers.host || '').split(':')[0].toLowerCase();
  if (!hostHeader || !PUBLIC_BASE_DOMAIN) return next();

  const base = PUBLIC_BASE_DOMAIN.toLowerCase();
  if (hostHeader === base) return next(); // apex (vagalun.shop) -> painel/API normal

  const isSubdomainOfBase = hostHeader.endsWith(`.${base}`);
  const subdomain = isSubdomainOfBase ? hostHeader.slice(0, -(`.${base}`.length)) : null;
  if (isSubdomainOfBase && (RESERVED_SUBDOMAINS.has(subdomain) || subdomain.includes('.'))) {
    return next(); // www/app/api/... ou sub-sub-domínio -> painel normal
  }

  // Acha o site: por siteId direto (ex: 762e748c-....vagalun.shop), pelo
  // domínio customizado escolhido na criação (aceita "cole" curto ou
  // "cole.vagalun.shop" completo), OU por domínio próprio raiz do usuário
  // (ex: meusite.com, apontado via CNAME/A na tela de DNS) — nesse caso
  // hostHeader NÃO termina em .PUBLIC_BASE_DOMAIN, então precisa comparar
  // direto contra site.domain (com e sem "www.").
  const site = [...sites.values()].find((s) => {
    const d = String(s.domain || '').toLowerCase();
    if (isSubdomainOfBase) {
      return s.siteId === subdomain || d === subdomain || d === hostHeader;
    }
    // domínio próprio (root, fora do PUBLIC_BASE_DOMAIN)
    return d === hostHeader || d === `www.${hostHeader}` || `www.${d}` === hostHeader;
  });

  if (!site) {
    // Não é subdomínio nosso nem domínio próprio conhecido -> deixa pra outra rota/serviço
    if (!isSubdomainOfBase) return next();
    res.status(404).send(`Nenhum site publicado em ${hostHeader}`);
    return;
  }

  await sendSiteFile(req, res, site.siteId, req.path);
});

app.use(express.json());
app.use(express.static('public'));

// ============ PAINEL (React, client/dist) SERVIDO EM /app ============
// O client é buildado com `base: '/app/'` (vite.config.js) e o Router usa
// basename="/app" — mas até aqui o server nunca servia esse build em lugar
// nenhum, nem em dev nem em produção. Resultado: /app/sites e qualquer rota
// direta do painel dava 404 (ou a mensagem confusa do próprio Vite quando
// rodado solto na porta 5173 sem o prefixo /app/). Agora: serve os arquivos
// estáticos do build em /app, e qualquer rota client-side dentro de /app
// (ex: /app/sites, /app/billing, refresh de página) cai no index.html do
// painel — o React Router assume a partir daí.
const clientDistDir = path.join(__dirname, 'client', 'dist');
if (fs.existsSync(clientDistDir)) {
  app.use('/app', express.static(clientDistDir));
  app.get('/app/*', (req, res) => {
    res.sendFile(path.join(clientDistDir, 'index.html'));
  });
} else {
  // Build do painel ainda não foi gerado (rode `npm run build` em hosting/client).
  app.get('/app', (req, res) => {
    res.status(503).send('Painel não buildado ainda: rode "npm run build" em hosting/client.');
  });
}

// ============ PERSISTÊNCIA (arquivo JSON local) ============
const dataDir = path.join(__dirname, 'data');
const dbFile = path.join(dataDir, 'db.json');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const users = new Map();
const sites = new Map();
const payments = new Map();
// Histórico de cobrança diária por usuário: userId -> array de
// { date (YYYY-MM-DD), plan, sitesCount, costSol, balanceAfter, status }.
// Alimentado pelo runDailyBilling, usado pela tela de consumo diário do
// painel (GET /api/billing/history). Mantém só os últimos 90 dias por
// usuário pra não crescer pra sempre.
const billingHistory = new Map();
const BILLING_HISTORY_MAX_DAYS = 90;

function loadDB() {
  if (!fs.existsSync(dbFile)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(dbFile, 'utf-8'));
    (raw.users || []).forEach(([key, value]) => users.set(key, value));
    (raw.sites || []).forEach(([key, value]) => sites.set(key, value));
    (raw.payments || []).forEach(([key, value]) => payments.set(key, value));
    (raw.billingHistory || []).forEach(([key, value]) => billingHistory.set(key, value));
    console.log(`💾 Banco carregado: ${users.size} usuário(s), ${sites.size} site(s)`);
  } catch (err) {
    console.error('⚠️  Falha ao carregar data/db.json, começando vazio:', err.message);
  }
}

function saveDB() {
  const raw = {
    users: [...users.entries()],
    sites: [...sites.entries()],
    payments: [...payments.entries()],
    billingHistory: [...billingHistory.entries()]
  };
  fs.writeFileSync(dbFile, JSON.stringify(raw, null, 2));
}

loadDB();

// ============ HELPERS ============
function findUserById(userId) {
  for (const u of users.values()) {
    if (u.userId === userId) return u;
  }
  return null;
}

// Ativa um plano pago pro usuário após confirmação de pagamento
function activatePlan(userId, plan) {
  if (!PLANS[plan]) return false;
  const user = findUserById(userId);
  if (!user) return false;
  user.plan = plan;
  saveDB();
  unfreezeSitesIfSolvent(userId);
  console.log(`✅ Plano "${plan}" ativado para ${user.email}`);
  return true;
}

function generateToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'Invalid token' });
  
  req.userId = decoded.userId;
  next();
};

// ============ AUTH ROUTES ============
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    
    if (users.has(email)) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = uuidv4();
    
    users.set(email, {
      userId,
      email,
      password: hashedPassword,
      name,
      balance: 0,
      plan: 'free', // free, basic, pro, business
      storageUsed: 0,
      trafficUsed: 0,
      createdAt: new Date(),
      walletAddress: null // Solana
    });
    saveDB();
    
    const token = generateToken(userId);
    res.json({ token, userId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = users.get(email);
    
    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = generateToken(user.userId);
    res.json({ token, userId: user.userId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/auth/me', authenticate, (req, res) => {
  let user = null;
  for (const u of users.values()) {
    if (u.userId === req.userId) {
      user = u;
      break;
    }
  }
  
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  const { password, ...safe } = user;
  res.json(safe);
});

// ============ SITES ROUTES ============
app.post('/api/sites', authenticate, (req, res) => {
  try {
    const { name, domain } = req.body;

    const user = findUserById(req.userId);
    const plan = getPlan(user);
    const userSiteCount = [...sites.values()].filter(s => s.userId === req.userId).length;

    if (userSiteCount >= plan.maxSites) {
      return res.status(403).json({
        error: `Seu plano (${plan.name}) permite no máximo ${plan.maxSites} site(s). Faça upgrade em /billing para criar mais.`
      });
    }

    const siteId = uuidv4();
    // Domínio "provisório" mostrado antes do publish real: usa o mesmo
    // PUBLIC_BASE_DOMAIN que o publishToGateway usa de verdade (env
    // PUBLIC_BASE_DOMAIN, com fallback pro GATEWAY_BASE_DOMAIN), então o
    // painel já mostra o endereço final/real (ex: siteId.vagalun.shop) em
    // vez do placeholder "plataforma.local" que nunca resolve pra nada.
    const defaultDomain = `${siteId}.${PUBLIC_BASE_DOMAIN}`;

    sites.set(siteId, {
      siteId,
      userId: req.userId,
      name,
      domain: domain || defaultDomain,
      status: 'ready',
      storageUsed: 0,
      trafficUsed: 0,
      url: `https://${domain || defaultDomain}`,
      createdAt: new Date(),
      files: []
    });
    saveDB();
    
    // Criar diretório do site
    const siteDir = path.join(sitesDir, siteId);
    fs.mkdirSync(siteDir, { recursive: true });
    
    res.json(sites.get(siteId));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sites', authenticate, (req, res) => {
  const userSites = [...sites.values()].filter(s => s.userId === req.userId);
  res.json(userSites);
});

app.get('/api/sites/:siteId', authenticate, (req, res) => {
  const site = sites.get(req.params.siteId);
  
  if (!site || site.userId !== req.userId) {
    return res.status(404).json({ error: 'Site not found' });
  }
  
  res.json(site);
});

// ============ UPLOAD & DEPLOY ============
app.post('/api/sites/:siteId/upload', authenticate, upload.single('file'), async (req, res) => {
  try {
    const site = sites.get(req.params.siteId);
    
    if (!site || site.userId !== req.userId) {
      return res.status(404).json({ error: 'Site not found' });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const user = findUserById(req.userId);
    const plan = getPlan(user);
    const limitBytes = plan.storageMB * 1024 * 1024;

    // Falha rápida: o próprio .zip já estoura o limite do plano
    if (req.file.size > limitBytes) {
      fs.rmSync(req.file.path, { force: true });
      return res.status(402).json({
        error: `Arquivo (${(req.file.size / 1024 / 1024).toFixed(2)} MB) excede o limite de armazenamento do plano ${plan.name} (${plan.storageMB} MB). Faça upgrade em /billing.`
      });
    }
    
    const siteDir = path.join(sitesDir, req.params.siteId);
    const oldSiteBytes = fs.existsSync(siteDir) ? getDirSize(siteDir) : 0;
    
    // Extrair ZIP
    fs.createReadStream(req.file.path)
      .pipe(unzipper.Extract({ path: siteDir }))
      .on('close', async () => {
        // Se o zip veio com tudo dentro de uma única pasta (comum ao
        // compactar pelo Windows/Mac), "desembrulha" pra raiz do site
        function flattenIfWrapped(dir) {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          const hasIndexHere = entries.some(e => e.isFile() && e.name.toLowerCase() === 'index.html');
          if (hasIndexHere) return;
          
          const dirs = entries.filter(e => e.isDirectory());
          const files = entries.filter(e => e.isFile());
          
          if (dirs.length === 1 && files.length === 0) {
            const innerDir = path.join(dir, dirs[0].name);
            const innerEntries = fs.readdirSync(innerDir);
            innerEntries.forEach(name => {
              fs.renameSync(path.join(innerDir, name), path.join(dir, name));
            });
            fs.rmdirSync(innerDir);
            flattenIfWrapped(dir); // caso haja mais de um nível de pasta
          }
        }
        flattenIfWrapped(siteDir);

        // Otimiza toda mídia do site UMA VEZ aqui, antes de calcular
        // tamanho/publicar pros nós: vídeo ganha +faststart, áudio perde
        // capas/ID3 pesados, imagem vira WebP redimensionado sem EXIF.
        // Falhas individuais não derrubam o deploy (fica o arquivo original).
        try {
          const mediaStats = await optimizeMediaDir(siteDir);
          if (mediaStats.scanned > 0) {
            console.log(`[mediaOptimize] site ${req.params.siteId}: ${mediaStats.optimized}/${mediaStats.scanned} otimizados, ${mediaStats.failed} falharam`);
          }
        } catch (mediaErr) {
          console.error('[mediaOptimize] varredura falhou, seguindo com arquivos originais:', mediaErr.message);
        }

        // Calcular tamanho
        function getSize(dir) {
          let size = 0;
          const files = fs.readdirSync(dir);
          files.forEach(file => {
            const stat = fs.statSync(path.join(dir, file));
            size += stat.size;
            if (stat.isDirectory()) {
              size += getSize(path.join(dir, file));
            }
          });
          return size;
        }
        
        const bytes = getSize(siteDir);

        // Confere se o resultado extraído cabe no limite do plano.
        // Compara o total do usuário (outros sites + este, já atualizado) com o limite.
        const otherSitesBytes = [...sites.values()]
          .filter(s => s.userId === req.userId && s.siteId !== req.params.siteId)
          .reduce((sum, s) => sum + (s.storageUsed || 0), 0);

        if (otherSitesBytes + bytes > limitBytes) {
          // Estourou o plano: desfaz o deploy
          fs.rmSync(siteDir, { recursive: true, force: true });
          fs.mkdirSync(siteDir, { recursive: true });
          fs.rmSync(req.file.path, { force: true });
          site.storageUsed = oldSiteBytes;
          saveDB();
          return res.status(402).json({
            error: `Esse deploy usaria ${(bytes / 1024 / 1024).toFixed(2)} MB e passaria do limite de ${plan.storageMB} MB do plano ${plan.name}. Faça upgrade em /billing ou reduza o tamanho do site.`
          });
        }

        const hasIndex = fs.existsSync(path.join(siteDir, 'index.html'));

        // Limpar upload (o .zip enviado, não a pasta extraída ainda)
        fs.rmSync(req.file.path, { force: true });

        // Publicação nos nós é OBRIGATÓRIA agora. Se falhar, o deploy inteiro
        // falha — o disco local (siteDir) é só um estágio, não fica pra trás
        // como fallback. Isso evita ficar com um "site fantasma" que só
        // existe local e nunca foi de fato pra rede de nós.
        try {
          const result = await publishToGateway(req.params.siteId, siteDir);
          site.gatewayDomain = result.domain;
          site.storageUsed = bytes;
          site.files = req.file.originalname;
          saveDB();

          // Publicado nos nós com sucesso: a pasta local era só um estágio
          // pra extrair/otimizar/medir o zip antes de subir — pode apagar
          // agora. O Explorador daqui pra frente lê/escreve direto nos nós
          // via site.lastRoutes (ver seção EXPLORADOR DE ARQUIVOS abaixo),
          // nunca mais neste diretório.
          fs.rmSync(siteDir, { recursive: true, force: true });

          res.json({
            success: true,
            site,
            message: hasIndex
              ? 'Site publicado nos nós com sucesso'
              : 'Upload feito, mas não encontrei um index.html na raiz do ZIP — confira a estrutura do seu projeto.',
            hasIndex,
            storageUsed: `${(bytes / 1024 / 1024).toFixed(2)} MB`,
            gatewayDomain: result.domain
          });
        } catch (err) {
          // Publicação falhou: desfaz o deploy, mantém o estado anterior do site.
          fs.rmSync(siteDir, { recursive: true, force: true });
          fs.mkdirSync(siteDir, { recursive: true });
          site.storageUsed = oldSiteBytes;
          saveDB();
          console.error(`[gateway] falha ao publicar site ${req.params.siteId}:`, err.message);
          res.status(502).json({
            error: `Falha ao publicar nos nós: ${err.message}. O deploy foi cancelado — confira se o gateway (sever/gateway) e os nós/celulares estão no ar.`
          });
        }
      })
      .on('error', (err) => {
        res.status(500).json({ error: `Extract failed: ${err.message}` });
      });
      
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ EXPLORADOR DE ARQUIVOS ============
//
// Sem disco local nenhum: o Explorador lê e escreve direto nos nós, usando
// site.lastRoutes (o manifesto da última publicação, [{path, fileId,
// contentType, size}]) como "árvore de arquivos" e o gateway (uploadSingleFileToNodes
// / fetchFileFromGateway / deleteFileRemote / publishSiteRoutes, ver acima)
// pra ler/gravar/apagar/republicar. hosting/sites/<id> não é mais tocado
// pelo Explorador — só o upload inicial do .zip (POST /api/sites/:id/upload)
// ainda usa uma pasta temporária pra extrair+otimizar antes de publicar.
//
// Convenção de path: relPath vem do cliente sem barra inicial (ex: '',
// 'img', 'img/logo.png' — mesmo formato de antes). Internamente vira
// routePath = '/' + relPath pra bater com site.lastRoutes. A rota alias '/'
// (equivalente a '/index.html') nunca aparece na listagem — publishSiteRoutes
// recria ela sozinha a cada publish.

function assertOwnsSite(req, res) {
  const site = sites.get(req.params.siteId);
  if (!site || site.userId !== req.userId) {
    res.status(404).json({ error: 'Site not found' });
    return null;
  }
  return site;
}

function toRoutePath(relPath) {
  const clean = String(relPath || '').split(path.sep).join('/').replace(/^\/+/, '').replace(/\/+$/, '');
  return '/' + clean;
}

function siteRoutes(site) {
  // Nunca expõe a rota alias '/' no Explorador — só '/index.html'.
  return (site.lastRoutes || []).filter((r) => r.path !== '/');
}

function findRoute(site, relPath) {
  const routePath = toRoutePath(relPath);
  return siteRoutes(site).find((r) => r.path === routePath) || null;
}

const EDITABLE_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.jsx', '.ts', '.tsx', '.json', '.md',
  '.txt', '.svg', '.xml', '.yml', '.yaml', '.env', '.csv'
]);

// Listar arquivos/pastas "virtuais" de um caminho, derivados de site.lastRoutes
app.get('/api/sites/:siteId/files', authenticate, (req, res) => {
  try {
    const site = assertOwnsSite(req, res);
    if (!site) return;

    const relPath = req.query.path || '';
    const routePrefix = relPath ? toRoutePath(relPath) : ''; // '' = raiz

    const entries = new Map();
    for (const r of siteRoutes(site)) {
      if (routePrefix && !(r.path === routePrefix || r.path.startsWith(routePrefix + '/'))) continue;
      const rest = (routePrefix ? r.path.slice(routePrefix.length) : r.path).replace(/^\//, '');
      if (!rest) continue; // é o próprio prefixo (não deveria ocorrer, path é sempre de arquivo)
      const [name, ...more] = rest.split('/');
      const childRoutePath = (routePrefix || '') + '/' + name;
      if (more.length > 0) {
        if (!entries.has(name)) entries.set(name, { name, type: 'folder', size: null, path: childRoutePath.slice(1) });
      } else {
        entries.set(name, { name, type: 'file', size: r.size ?? null, path: r.path.slice(1) });
      }
    }

    const list = [...entries.values()].sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'folder' ? -1 : 1)
    );
    res.json({ path: relPath, entries: list });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Ler o conteúdo de um arquivo de texto direto do gateway (GET /raw/:fileId)
app.get('/api/sites/:siteId/files/content', authenticate, async (req, res) => {
  try {
    const site = assertOwnsSite(req, res);
    if (!site) return;

    const relPath = req.query.path || '';
    const route = findRoute(site, relPath);
    if (!route) return res.status(404).json({ error: 'Arquivo não encontrado' });

    const ext = path.extname(route.path).toLowerCase();
    if (!EDITABLE_EXTENSIONS.has(ext)) {
      return res.status(415).json({ error: 'Esse tipo de arquivo não é editável como texto por aqui — baixe/reenvie via upload avulso.' });
    }
    if ((route.size || 0) > 2 * 1024 * 1024) {
      return res.status(413).json({ error: 'Arquivo grande demais pra editar no navegador (limite 2 MB).' });
    }

    const gwOpts = await resolveGatewayConfig();
    const buf = await fetchFileFromGateway(route.fileId, gwOpts);
    res.json({ path: relPath, content: buf.toString('utf8') });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Salvar conteúdo editado: sobe o novo conteúdo pros nós, atualiza a rota
// no manifesto (substitui o fileId antigo) e apaga o fileId antigo (órfão).
app.put('/api/sites/:siteId/files/content', authenticate, async (req, res) => {
  try {
    const site = assertOwnsSite(req, res);
    if (!site) return;

    const { path: relPath, content } = req.body;
    if (!relPath || typeof content !== 'string') {
      return res.status(400).json({ error: 'path e content são obrigatórios' });
    }
    const routePath = toRoutePath(relPath);
    const ext = path.extname(routePath).toLowerCase();
    if (!EDITABLE_EXTENSIONS.has(ext)) {
      return res.status(415).json({ error: 'Esse tipo de arquivo não é editável como texto por aqui.' });
    }

    const buf = Buffer.from(content, 'utf8');

    // Confere limite do plano antes de gravar (o arquivo pode ter crescido)
    const user = findUserById(req.userId);
    const plan = getPlan(user);
    const limitBytes = plan.storageMB * 1024 * 1024;
    const oldRoute = findRoute(site, relPath);
    const currentBytes = site.storageUsed || 0;
    const newBytes = currentBytes - (oldRoute?.size || 0) + buf.length;
    const otherSitesBytes = [...sites.values()]
      .filter(s => s.userId === req.userId && s.siteId !== req.params.siteId)
      .reduce((sum, s) => sum + (s.storageUsed || 0), 0);
    if (otherSitesBytes + newBytes > limitBytes) {
      return res.status(402).json({ error: `Essa edição passaria do limite de ${plan.storageMB} MB do plano ${plan.name}.` });
    }

    try {
      const newRoute = await uploadSingleFileToNodes(req.params.siteId, routePath, buf);
      const routes = siteRoutes(site).filter((r) => r.path !== routePath);
      routes.push(newRoute);
      const result = await publishSiteRoutes(site, routes);
      // Só apaga o fileId antigo dos nós DEPOIS do manifesto novo confirmado.
      if (oldRoute && oldRoute.fileId !== newRoute.fileId) await deleteFileRemote(oldRoute.fileId);
      res.json({ success: true, gatewayDomain: result.domain });
    } catch (err) {
      console.error(`[gateway] falha ao salvar/republicar ${routePath} do site ${req.params.siteId}:`, err.message);
      res.status(502).json({ error: `Falha ao publicar a edição nos nós: ${err.message}` });
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Upload de um arquivo avulso (qualquer tipo) pra uma pasta do site — sobe
// direto pros nós a partir do arquivo temporário do multer (nunca grava em
// hosting/sites/<id>).
app.post('/api/sites/:siteId/files/upload', authenticate, upload.single('file'), async (req, res) => {
  let tempPath = req.file?.path;
  try {
    const site = assertOwnsSite(req, res);
    if (!site) return;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const user = findUserById(req.userId);
    const plan = getPlan(user);
    const limitBytes = plan.storageMB * 1024 * 1024;
    const otherSitesBytes = [...sites.values()]
      .filter(s => s.userId === req.userId && s.siteId !== req.params.siteId)
      .reduce((sum, s) => sum + (s.storageUsed || 0), 0);
    const oldRoute = findRoute(site, path.posix.join(req.body.path || '', req.file.originalname));
    const currentBytes = (site.storageUsed || 0) - (oldRoute?.size || 0);

    if (otherSitesBytes + currentBytes + req.file.size > limitBytes) {
      fs.rmSync(req.file.path, { force: true });
      return res.status(402).json({
        error: `Esse arquivo passaria do limite de ${plan.storageMB} MB do plano ${plan.name}. Faça upgrade em /billing.`
      });
    }

    // Otimização roda no arquivo temporário, antes de subir pros nós: vídeo
    // ganha +faststart, áudio perde capas/ID3 pesados, imagem vira WebP
    // redimensionado sem EXIF. Falha aqui não derruba o upload (usa o original).
    const optResult = await optimizeMediaFile(req.file.path, req.file.originalname);
    const finalTempPath = optResult?.newPath || req.file.path;
    tempPath = finalTempPath;
    const finalName = optResult?.newPath ? path.basename(optResult.newPath) : req.file.originalname;
    const relPath = path.posix.join(req.body.path || '', finalName);
    const buf = fs.readFileSync(finalTempPath);

    try {
      const newRoute = await uploadSingleFileToNodes(req.params.siteId, toRoutePath(relPath), buf);
      const routes = siteRoutes(site).filter((r) => r.path !== newRoute.path);
      routes.push(newRoute);
      await publishSiteRoutes(site, routes);
      if (oldRoute && oldRoute.fileId !== newRoute.fileId) await deleteFileRemote(oldRoute.fileId);

      res.json({
        success: true,
        fileName: finalName,
        optimized: !!optResult?.processed,
        optimizeMethod: optResult?.method || null,
      });
    } catch (err) {
      console.error(`[gateway] falha ao publicar upload avulso do site ${req.params.siteId}:`, err.message);
      return res.status(502).json({ error: `Falha ao publicar o arquivo nos nós: ${err.message}` });
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  } finally {
    if (tempPath && fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
  }
});

// Descompactar um .zip: lê do temp do multer em memória (unzipper.Open.buffer),
// sobe cada entrada direto pros nós — nunca grava a árvore extraída em disco.
app.post('/api/sites/:siteId/files/extract', authenticate, async (req, res) => {
  try {
    const site = assertOwnsSite(req, res);
    if (!site) return;

    const { path: relPath } = req.body;
    const zipRoute = findRoute(site, relPath);
    if (!zipRoute || !zipRoute.path.toLowerCase().endsWith('.zip')) {
      return res.status(400).json({ error: 'Arquivo .zip não encontrado' });
    }
    const destFolder = path.posix.dirname(relPath || '');

    const gwOpts = await resolveGatewayConfig();
    const zipBuf = await fetchFileFromGateway(zipRoute.fileId, gwOpts);
    const zip = await unzipper.Open.buffer(zipBuf);
    const fileEntries = zip.files.filter((f) => f.type === 'File');
    if (fileEntries.length === 0) return res.status(400).json({ error: 'Zip vazio ou sem arquivos' });

    const user = findUserById(req.userId);
    const plan = getPlan(user);
    const limitBytes = plan.storageMB * 1024 * 1024;
    const otherSitesBytes = [...sites.values()]
      .filter(s => s.userId === req.userId && s.siteId !== req.params.siteId)
      .reduce((sum, s) => sum + (s.storageUsed || 0), 0);
    const extractedBytes = fileEntries.reduce((sum, f) => sum + (f.uncompressedSize || 0), 0);
    if (otherSitesBytes + (site.storageUsed || 0) + extractedBytes > limitBytes) {
      return res.status(402).json({
        error: `Descompactar esse zip passaria do limite de ${plan.storageMB} MB do plano ${plan.name}.`
      });
    }

    const targets = await resolvePublishTargets(gwOpts);
    const newRoutes = [];
    try {
      for (const entry of fileEntries) {
        const buf = await entry.buffer();
        const entryRelPath = destFolder && destFolder !== '.' ? path.posix.join(destFolder, entry.path) : '/' + entry.path;
        const routePath = toRoutePath(entryRelPath);
        const route = await uploadFileToGateway(buf, routePath, siteDomain(req.params.siteId), targets, gwOpts);
        newRoutes.push(route);
      }
    } finally {
      if (targets.relayClient) targets.relayClient.close();
    }

    const byPath = new Map(newRoutes.map((r) => [r.path, r]));
    const routes = siteRoutes(site).filter((r) => !byPath.has(r.path));
    routes.push(...newRoutes);
    try {
      const result = await publishSiteRoutes(site, routes);
      res.json({ success: true, extracted: newRoutes.length, gatewayDomain: result.domain });
    } catch (err) {
      console.error(`[gateway] falha ao republicar site ${req.params.siteId} após extrair zip:`, err.message);
      res.status(502).json({ error: `Falha ao publicar os arquivos extraídos nos nós: ${err.message}` });
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// "Criar pasta" — não existe pasta de verdade no manifesto (só paths de
// arquivo). Sobe um marcador .keep vazio, o suficiente pra pasta aparecer
// na listagem até o usuário colocar um arquivo real nela.
app.post('/api/sites/:siteId/files/mkdir', authenticate, async (req, res) => {
  try {
    const site = assertOwnsSite(req, res);
    if (!site) return;

    const { path: relPath, name } = req.body;
    if (!name || /[\\/]/.test(name)) return res.status(400).json({ error: 'Nome de pasta inválido' });

    const keepRoutePath = toRoutePath(path.posix.join(relPath || '', name, '.keep'));
    try {
      const newRoute = await uploadSingleFileToNodes(req.params.siteId, keepRoutePath, Buffer.alloc(0));
      const routes = siteRoutes(site).filter((r) => r.path !== keepRoutePath);
      routes.push(newRoute);
      await publishSiteRoutes(site, routes);
      res.json({ success: true });
    } catch (err) {
      console.error(`[gateway] falha ao criar pasta no site ${req.params.siteId}:`, err.message);
      res.status(502).json({ error: `Falha ao publicar nos nós: ${err.message}` });
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Mover / renomear arquivo ou pasta — reaproveita o(s) mesmo(s) fileId(s),
// só troca o path no manifesto (nenhum reencode/reupload de shard).
app.post('/api/sites/:siteId/files/move', authenticate, async (req, res) => {
  try {
    const site = assertOwnsSite(req, res);
    if (!site) return;

    const { from, to } = req.body;
    const fromRoutePath = toRoutePath(from);
    const toRoutePathVal = toRoutePath(to);

    const all = siteRoutes(site);
    // Arquivo único, ou pasta inteira (qualquer rota sob fromRoutePath/*)
    const matching = all.filter((r) => r.path === fromRoutePath || r.path.startsWith(fromRoutePath + '/'));
    if (matching.length === 0) return res.status(404).json({ error: 'Arquivo não encontrado' });

    const renamed = matching.map((r) => {
      const newPath = r.path === fromRoutePath ? toRoutePathVal : toRoutePathVal + r.path.slice(fromRoutePath.length);
      return { ...r, path: newPath };
    });
    const matchingPaths = new Set(matching.map((r) => r.path));
    const routes = all.filter((r) => !matchingPaths.has(r.path)).concat(renamed);

    try {
      const result = await publishSiteRoutes(site, routes);
      res.json({ success: true, gatewayDomain: result.domain });
    } catch (err) {
      console.error(`[gateway] falha ao republicar site ${req.params.siteId} após mover/renomear:`, err.message);
      res.status(502).json({ error: `Falha ao publicar nos nós: ${err.message}` });
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Apagar arquivo ou pasta: tira a(s) rota(s) do manifesto novo, publica, e
// só DEPOIS apaga de vez o(s) fileId(s) dos nós (best-effort).
app.delete('/api/sites/:siteId/files', authenticate, async (req, res) => {
  try {
    const site = assertOwnsSite(req, res);
    if (!site) return;

    const relPath = req.query.path || '';
    if (!relPath) return res.status(400).json({ error: 'Caminho obrigatório' });
    const routePath = toRoutePath(relPath);

    const all = siteRoutes(site);
    const matching = all.filter((r) => r.path === routePath || r.path.startsWith(routePath + '/'));
    if (matching.length === 0) return res.status(404).json({ error: 'Arquivo não encontrado' });

    const matchingPaths = new Set(matching.map((r) => r.path));
    const routes = all.filter((r) => !matchingPaths.has(r.path));

    try {
      const result = await publishSiteRoutes(site, routes);
      await Promise.all(matching.map((r) => deleteFileRemote(r.fileId)));
      res.json({ success: true, gatewayDomain: result.domain });
    } catch (err) {
      console.error(`[gateway] falha ao republicar site ${req.params.siteId} após apagar:`, err.message);
      res.status(502).json({ error: `Falha ao publicar nos nós: ${err.message}` });
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ============ BILLING ROUTES ============

// ============ DOMÍNIO PRÓPRIO (DNS) ============
// O usuário aponta o domínio dele (CNAME, ou A pro IP da VPS) pra essa
// plataforma; aqui só devolvemos as instruções + um check simples via DNS
// pra confirmar que já propagou, antes de ativar site.domain de fato.
import dns from 'node:dns';
const dnsResolveCname = (h) => new Promise((res) => dns.resolveCname(h, (e, a) => res(e ? [] : a)));
const dnsResolveTxt = (h) => new Promise((res) => dns.resolveTxt(h, (e, a) => res(e ? [] : a.flat())));

app.get('/api/sites/:siteId/dns', authenticate, (req, res) => {
  const site = sites.get(req.params.siteId);
  if (!site || site.userId !== req.userId) return res.status(404).json({ error: 'Site not found' });

  const targetHost = `${site.siteId}.${PUBLIC_BASE_DOMAIN}`;
  const verificationToken = `vagalun-verify=${site.siteId}`;

  res.json({
    // Domínio raiz (ex: meusite.com): registro A apontando pro IP da VPS.
    // Subdomínio (ex: www.meusite.com): CNAME apontando pra targetHost.
    aRecord: { type: 'A', host: '@', value: process.env.HOSTING_SERVER_IP || '<IP_DA_VPS>' },
    cnameRecord: { type: 'CNAME', host: 'www', value: targetHost },
    verificationTxt: { type: 'TXT', host: '@', value: verificationToken },
    instructions:
      'No painel do seu provedor de domínio: crie o registro A do tipo acima apontando pro IP da VPS ' +
      '(ou CNAME se for subdomínio), e o TXT de verificação. A propagação pode levar de minutos a algumas horas.'
  });
});

app.post('/api/sites/:siteId/domain', authenticate, async (req, res) => {
  const site = sites.get(req.params.siteId);
  if (!site || site.userId !== req.userId) return res.status(404).json({ error: 'Site not found' });

  const { domain } = req.body;
  if (!domain || typeof domain !== 'string') return res.status(400).json({ error: 'Informe o domínio' });
  const clean = domain.trim().toLowerCase();

  const verificationToken = `vagalun-verify=${site.siteId}`;
  const [txts, cnames] = await Promise.all([dnsResolveTxt(clean), dnsResolveCname(clean)]);
  const targetHost = `${site.siteId}.${PUBLIC_BASE_DOMAIN}`;
  const txtOk = txts.some((t) => t.includes(verificationToken));
  const cnameOk = cnames.some((c) => c.toLowerCase().replace(/\.$/, '') === targetHost.toLowerCase());

  if (!txtOk && !cnameOk) {
    return res.status(409).json({
      error: 'DNS ainda não confere. Confira o registro TXT de verificação (ou o CNAME) e tente de novo — propagação pode demorar.',
      verificationTxt: verificationToken
    });
  }

  site.domain = clean;
  site.url = `https://${clean}`;
  saveDB();
  res.json({ success: true, site });
});

// ============ ANÚNCIOS (o dono do site configura a própria tag VAST) ============
// Config fica salva no site (site.adsConfig) e é lida pelo publish.cjs na hora
// de gerar o HTML de cada vídeo publicado, virando options.ads do VagalunPlayer.
app.get('/api/sites/:siteId/ads', authenticate, (req, res) => {
  const site = sites.get(req.params.siteId);
  if (!site || site.userId !== req.userId) return res.status(404).json({ error: 'Site not found' });
  res.json({ adsConfig: site.adsConfig || null });
});

app.post('/api/sites/:siteId/ads', authenticate, (req, res) => {
  const site = sites.get(req.params.siteId);
  if (!site || site.userId !== req.userId) return res.status(404).json({ error: 'Site not found' });

  const { enabled, vastUrl, preroll, midroll, midrollInterval, banner } = req.body || {};

  if (enabled && (!vastUrl || typeof vastUrl !== 'string' || !/^https?:\/\//i.test(vastUrl.trim()))) {
    return res.status(400).json({ error: 'Informe uma tag VAST válida (URL http/https) pra ativar o anúncio.' });
  }

  site.adsConfig = enabled
    ? {
        enabled: true,
        vastUrl: vastUrl.trim(),
        preroll: preroll !== false,
        midroll: !!midroll,
        midrollInterval: Number.isFinite(midrollInterval) && midrollInterval > 0 ? midrollInterval : 300,
        banner: !!banner
      }
    : { enabled: false };

  saveDB();
  res.json({ success: true, adsConfig: site.adsConfig });
});

import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';

app.get('/api/billing/plans', (req, res) => {
  res.json(PLANS);
});

// Consumo diário do usuário: histórico de débito (billingHistory) +
// quanto falta pro saldo zerar no ritmo atual, pra tela de consumo do painel.
app.get('/api/billing/history', authenticate, (req, res) => {
  const user = findUserById(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const days = Math.min(Number(req.query.days) || 30, BILLING_HISTORY_MAX_DAYS);
  const history = (billingHistory.get(user.userId) || [])
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-days);

  const plan = getPlan(user);
  const perDay = planPriceSolPerDay(user.plan);
  const publishedSites = [...sites.values()].filter(
    (s) => s.userId === user.userId && s.status !== 'frozen' && s.gatewayDomain
  );
  const costToday = perDay * publishedSites.length;
  const daysUntilEmpty = costToday > 0
    ? Math.floor((user.balance || 0) / costToday)
    : null; // free ou sem custo diário: saldo nunca esvazia por isso

  res.json({
    plan: user.plan || 'free',
    planName: plan.name,
    balance: user.balance || 0,
    costPerDaySol: +costToday.toFixed(9),
    publishedSites: publishedSites.length,
    daysUntilEmpty, // null = sem custo diário (free); número = estimativa no ritmo de hoje
    history // [{date, plan, sitesCount, costSol, balanceAfter, status}]
  });
});

// ============ PAGAMENTO — SOLANA (único método) ============
// Endereço do treasury do contrato (mesmo do README / on-chain addresses).
// Todo pagamento de upgrade de plano vai direto pra essa wallet.
const SOLANA_TREASURY_WALLET = process.env.SOLANA_TREASURY_WALLET
  || 'DDE7RZCCbipWuBGwZLYszBQuMxvDSEF59225YoFzkFba';
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const solanaConnection = new Connection(SOLANA_RPC_URL, 'confirmed');

app.post('/api/billing/solana', authenticate, async (req, res) => {
  try {
    const { plan } = req.body;
    if (!PLANS[plan]) return res.status(400).json({ error: 'Plano inválido' });
    if (plan === 'free') return res.status(400).json({ error: 'O plano Free não requer pagamento.' });

    const amountBRL = PLANS[plan].price;
    const solanaAmount = +(amountBRL / SOL_BRL_RATE).toFixed(6);
    const paymentId = uuidv4();

    // Reference conforme spec do Solana Pay: precisa ser uma chave pública
    // de verdade (não um uuid) — é incluída como conta read-only não-signer
    // na transação, e é isso que usamos depois pra achar a tx on-chain via
    // getSignaturesForAddress. Descartamos a chave privada, só a pública
    // importa aqui.
    const reference = Keypair.generate().publicKey.toBase58();

    const solanaPayUri = `solana:${SOLANA_TREASURY_WALLET}` +
      `?amount=${solanaAmount}&reference=${reference}` +
      `&label=Hospedagem&message=Upgrade%20plano%20${plan}`;
    const qrCodeImage = await QRCode.toDataURL(solanaPayUri, { width: 300, margin: 1 });

    payments.set(paymentId, {
      id: paymentId,
      userId: req.userId,
      method: 'solana',
      amountBRL,
      solanaAmount,
      plan,
      reference,
      recipient: SOLANA_TREASURY_WALLET,
      status: 'pending',
      createdAt: new Date(),
      signature: null
    });
    saveDB();

    res.json({
      paymentId,
      solanaAmount,
      recipientWallet: SOLANA_TREASURY_WALLET,
      reference,
      qrCodeImage,
      message: 'Escaneie no Phantom, Solflare ou outra wallet Solana'
    });
  } catch (error) {
    console.error('❌ Erro no pagamento Solana:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verificação real on-chain: procura, pela reference key, uma transação
// confirmada que pagou o valor certo pro treasury wallet. Sem isso não
// ativamos plano nenhum — é a única fonte de verdade, não tem confirmação
// manual/simulada.
//
// Extraída da rota GET pra ser reaproveitada pelo poller interno do
// servidor (ver reconcileSolanaPayments logo abaixo): a checagem não pode
// depender só do navegador ficar com a aba aberta chamando o endpoint —
// se a aba fechar ou o polling do cliente morrer no primeiro erro de rede,
// o pagamento fica em 'pending' pra sempre mesmo já tendo confirmado on-chain.
// Retorna o payment atualizado (com confirmed: true/false).
async function checkAndConfirmSolanaPayment(payment) {
  if (payment.status === 'completed') {
    return { ...payment, confirmed: true };
  }

  const referenceKey = new PublicKey(payment.reference);
  const sigs = await solanaConnection.getSignaturesForAddress(referenceKey, { limit: 10 });

  for (const sigInfo of sigs) {
    if (sigInfo.err) continue;
    const tx = await solanaConnection.getParsedTransaction(sigInfo.signature, {
      maxSupportedTransactionVersion: 0
    });
    if (!tx || !tx.meta || tx.meta.err) continue;

    const treasuryIndex = tx.transaction.message.accountKeys.findIndex(
      (k) => k.pubkey.toBase58() === payment.recipient
    );
    if (treasuryIndex === -1) continue;

    const paidLamports = tx.meta.postBalances[treasuryIndex] - tx.meta.preBalances[treasuryIndex];
    const paidSol = paidLamports / LAMPORTS_PER_SOL;
    // Tolerância pequena por causa de arredondamento de ponto flutuante.
    if (paidSol + 1e-6 < payment.solanaAmount) continue;

    payment.status = 'completed';
    payment.signature = sigInfo.signature;
    payment.confirmedAt = new Date();
    const user = findUserById(payment.userId);
    if (user) {
      // O valor pago inteiro vira saldo (não só o excedente) — é esse saldo
      // que a cobrança diária (runDailyBilling) vai debitando aos poucos.
      // Antes só o excedente virava saldo e o site congelava no dia seguinte
      // à compra, mesmo tendo acabado de pagar (saldo ficava em 0).
      user.balance = +((user.balance || 0) + paidSol).toFixed(9);
    }
    if (payment.plan) activatePlan(payment.userId, payment.plan);
    saveDB();
    return { ...payment, confirmed: true };
  }

  return { ...payment, confirmed: false };
}

app.get('/api/billing/solana/:paymentId', authenticate, async (req, res) => {
  try {
    const payment = payments.get(req.params.paymentId);
    if (!payment || payment.userId !== req.userId) {
      return res.status(404).json({ error: 'Pagamento não encontrado' });
    }
    const result = await checkAndConfirmSolanaPayment(payment);
    res.json(result);
  } catch (error) {
    console.error('❌ Erro ao verificar pagamento Solana:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ RECONCILIAÇÃO INTERNA DE PAGAMENTOS SOLANA ============
// Roda dentro do próprio processo do servidor, sem depender do navegador:
// varre os pagamentos 'pending' periodicamente e confirma/ativa o plano
// assim que achar a transação on-chain. Isso cobre o caso do usuário pagar
// e fechar a aba, ou o polling do frontend morrer num erro de rede — o
// plano acaba sendo ativado de qualquer jeito, só que via servidor.
const SOLANA_RECONCILE_INTERVAL_MS = Number(process.env.SOLANA_RECONCILE_INTERVAL_MS || 20000);
const SOLANA_PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000; // não fica checando pagamento pendente com mais de 1 dia

async function reconcileSolanaPayments() {
  const now = Date.now();
  const pending = [...payments.values()].filter((p) =>
    p.method === 'solana' &&
    p.status === 'pending' &&
    (now - new Date(p.createdAt).getTime()) < SOLANA_PENDING_MAX_AGE_MS
  );
  for (const payment of pending) {
    try {
      const result = await checkAndConfirmSolanaPayment(payment);
      if (result.confirmed) {
        console.log(`✅ [reconcile] pagamento ${payment.id} confirmado on-chain, plano ${payment.plan} ativado (user ${payment.userId})`);
      }
    } catch (error) {
      // Um erro de RPC num pagamento não pode travar a checagem dos outros,
      // nem derrubar o loop — só loga e tenta esse pagamento de novo no
      // próximo ciclo.
      console.error(`⚠️ [reconcile] falha ao checar pagamento ${payment.id}:`, error.message);
    }
    // Pequeno espaçamento entre chamadas pra não estourar rate limit do
    // RPC público de devnet quando houver vários pagamentos pendentes.
    await new Promise((r) => setTimeout(r, 500));
  }
}

setInterval(() => {
  reconcileSolanaPayments().catch((error) => {
    console.error('⚠️ [reconcile] erro inesperado no ciclo de reconciliação:', error.message);
  });
}, SOLANA_RECONCILE_INTERVAL_MS);



// ============ STORAGE & TRAFFIC MONITORING ============
app.get('/api/usage', authenticate, (req, res) => {
  const user = findUserById(req.userId);
  const userSites = [...sites.values()].filter(s => s.userId === req.userId);

  const totalStorage = userSites.reduce((sum, s) => sum + s.storageUsed, 0);
  const totalTraffic = userSites.reduce((sum, s) => sum + (s.trafficUsed || 0), 0);

  const plan = getPlan(user);
  const storageLimitBytes = plan.storageMB * 1024 * 1024;
  const trafficLimitBytes = plan.trafficMB * 1024 * 1024;

  res.json({
    plan: user?.plan || 'free',
    planName: plan.name,
    sites: { used: userSites.length, limit: plan.maxSites },
    storage: {
      used: (totalStorage / 1024 / 1024).toFixed(2),
      limit: plan.storageMB,
      unit: 'MB'
    },
    traffic: {
      used: (totalTraffic / 1024 / 1024).toFixed(2),
      limit: plan.trafficMB,
      unit: 'MB'
    },
    balance: user?.balance || 0,
    status: (totalStorage > storageLimitBytes || totalTraffic > trafficLimitBytes) ? 'limited' : 'ok'
  });
});

// ============ SERVE STATIC SITES (sempre via gateway/rede de nós) ============

// Função auxiliar: busca o arquivo do site NO GATEWAY (nunca mais no disco
// local). Faz proxy pra http://GATEWAY_URL/<path>, mandando o Host certo
// (<siteId>.<GATEWAY_BASE_DOMAIN>) pra o gateway resolver o site publicado
// via registry.resolveSite — a mesma lógica que ele já usa pra domínio real.
// Faz a requisição pro gateway usando http.request (não fetch) porque o
// fetch nunca deixa sobrescrever o header Host — ele sempre usa o host real
// da URL. Sem isso, o gateway nunca recebia o Host certo pra resolver qual
// site servir (caía sempre na resposta genérica "Gateway online").
function fetchFromGatewayWithHost(gatewayUrl, hostHeader, upstreamPath, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(gatewayUrl);
    const reqOpts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: upstreamPath,
      method: 'GET',
      headers: { Host: hostHeader, ...extraHeaders },
    };
    const lib = u.protocol === 'https:' ? require('node:https') : http;
    const req = lib.request(reqOpts, (upstreamRes) => {
      const chunks = [];
      upstreamRes.on('data', (c) => chunks.push(c));
      upstreamRes.on('end', () => {
        resolve({
          statusCode: upstreamRes.statusCode,
          headers: upstreamRes.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function sendSiteFile(req, res, siteId, relativePath) {
  const site = sites.get(siteId);

  if (!site) {
    return res.status(404).json({ error: 'Site não encontrado' });
  }

  if (!site.gatewayDomain) {
    // Site existe no banco mas nunca foi publicado com sucesso nos nós
    // (ex: upload falhou, ou é um site recém-criado sem deploy ainda).
    return res.status(404).send('Site ainda não publicado. Faça o upload/deploy primeiro.');
  }

  if (site.status === 'frozen') {
    // Saldo insuficiente pra cobrir o dia — pausa a exibição sem apagar
    // nada (os shards continuam publicados nos nós). Some de vez só depois
    // de FROZEN_DELETE_AFTER_DAYS sem saldo (ver runDailyBilling).
    return res.status(402).send(
      'Este site está temporariamente pausado por falta de saldo. ' +
      'O dono precisa recarregar o saldo em SOL para reativar.'
    );
  }

  if (!GATEWAY_URL) {
    return res.status(503).send('GATEWAY_URL não configurado no servidor — não há mais fallback local.');
  }

  const owner = findUserById(site.userId);
  const plan = getPlan(owner);
  const trafficLimitBytes = plan.trafficMB * 1024 * 1024;

  if ((site.trafficUsed || 0) >= trafficLimitBytes) {
    return res.status(402).send('Limite de tráfego do plano atingido. O dono do site precisa fazer upgrade.');
  }

  const upstreamPath = (!relativePath || relativePath === '/') ? '/' : `/${relativePath}`.replace(/\/{2,}/g, '/');

  try {
    const upstream = await fetchFromGatewayWithHost(
      GATEWAY_URL,
      site.gatewayDomain,
      upstreamPath,
      req.headers.range ? { Range: req.headers.range } : {}
    );

    if (upstream.statusCode === 404) {
      return res.status(404).send('Arquivo não encontrado nos nós.');
    }
    if (upstream.statusCode >= 400 && upstream.statusCode !== 404) {
      return res.status(502).send(`Gateway respondeu ${upstream.statusCode} ao buscar o arquivo nos nós.`);
    }

    res.status(upstream.statusCode);
    if (upstream.headers['content-type']) res.setHeader('Content-Type', upstream.headers['content-type']);
    if (upstream.headers['content-range']) res.setHeader('Content-Range', upstream.headers['content-range']);
    res.setHeader('Accept-Ranges', 'bytes');

    res.send(upstream.body);

    site.trafficUsed = (site.trafficUsed || 0) + upstream.body.length;
    saveDB();
  } catch (err) {
    console.error(`[gateway] falha ao buscar ${GATEWAY_URL}${upstreamPath} (Host: ${site.gatewayDomain}):`, err.message);
    res.status(502).send('Falha ao buscar o arquivo nos nós — gateway ou nós podem estar fora do ar.');
  }
} // Fim da função sendSiteFile

// 1. Rota para a raiz do site (ex: http://localhost:3000/00720fdb-750d-420a-a014-51322cbbb021)
app.get('/:siteId', async (req, res) => {
  await sendSiteFile(req, res, req.params.siteId, '/');
});

// 2. Rota para subpastas/arquivos (ex: http://localhost:3000/00720fdb-750d-420a-a014-51322cbbb021/index.html)
app.get('/:siteId/*', async (req, res) => {
  // Pega o caminho após a barra no Express 4 (req.params[0]) ou Express 5 (req.params.splat)
  const relativePath = req.params[0] || (Array.isArray(req.params.splat) ? req.params.splat.join('/') : req.params.splat);
  await sendSiteFile(req, res, req.params.siteId, relativePath);
});
// ============ HEALTH CHECK ============
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
🚀 Hosting Platform Server
📡 Running on http://localhost:${PORT}
🔴 Design: Red & Minimal
💰 Payments: Solana (devnet)
  `);
});
