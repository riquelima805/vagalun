// Item 12, Camada 2: backup do registry fora da VPS atual, SEM depender de
// nenhum provedor externo (S3/R2/B2/etc.) — usa a própria rede de nós que o
// projeto já tem. A ideia: em vez de mandar pra "a nuvem de alguém", manda
// pra um punhado de nós que o PRÓPRIO OPERADOR controla (o celular/PC dele,
// de um sócio, em locais/provedores diferentes) — decentralizado de verdade,
// e já dá diversidade geográfica sem precisar de uma segunda VPS.
//
// Ponto crítico de design: a lista de nós de confiança (REGISTRY_BACKUP_NODES)
// é fixa, via variável de ambiente — NÃO vem do registry dinâmico. Se o
// registry.js morrer (disco corrompido, apagou sem querer), você ainda
// precisa saber onde estão as cópias de backup sem depender do próprio
// arquivo que se perdeu. Por isso essa lista mora só na configuração do
// processo, nunca dentro do gateway-data.json.
//
// O conteúdo é cifrado (AES-256-GCM) com uma chave que SÓ o operador tem
// (REGISTRY_BACKUP_KEY) — os nós de backup guardam um blob opaco, nunca a
// chave. Mesmo sendo nós "de confiança", não custa nada não expor o mapa
// de peers/sites em texto puro pra quem guarda o backup fisicamente.

const fs = require('fs');
const crypto = require('crypto');
const shardTransport = require('./shardTransport');
const registry = require('./registry');

const BACKUP_SHARD_KEY = '__registry_backup__';

const RAW_KEY_B64 = process.env.REGISTRY_BACKUP_KEY || null;
const RAW_NODES = process.env.REGISTRY_BACKUP_NODES || ''; // "host:port,host:port,..."
const INTERVAL_MS = Number(process.env.REGISTRY_BACKUP_INTERVAL_MS || 5 * 60_000);

function parseNodes() {
  return RAW_NODES.split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [host, portStr] = entry.split(':');
    const port = Number(portStr);
    if (!host || !port) throw new Error(`REGISTRY_BACKUP_NODES: entrada inválida "${entry}" (esperado host:port)`);
    return { host, port };
  });
}

function getKey() {
  if (!RAW_KEY_B64) return null;
  const key = Buffer.from(RAW_KEY_B64, 'base64');
  if (key.length !== 32) throw new Error('REGISTRY_BACKUP_KEY precisa decodificar pra exatamente 32 bytes (AES-256)');
  return key;
}

function encrypt(plaintextBuf, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // blob autocontido: [iv(12)][authTag(16)][ciphertext] — não precisa de
  // metadado externo pra decifrar, só da chave.
  return Buffer.concat([iv, authTag, ciphertext]);
}

function decrypt(blob, key) {
  const iv = blob.subarray(0, 12);
  const authTag = blob.subarray(12, 28);
  const ciphertext = blob.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

let lastBackedUpHash = null;

/**
 * Replica o snapshot atual do registry pros nós de confiança configurados.
 * Best-effort: um nó de backup offline não derruba o processo nem os outros
 * — só entra no log como falha (mesmo espírito do deleteFileFromNodes em
 * content.js). Pula silenciosamente se REGISTRY_BACKUP_KEY/NODES não
 * estiverem configurados (feature desligada até o operador decidir os nós).
 */
async function backupNow(jsonStr) {
  const key = getKey();
  if (!key) return; // camada 2 desligada — só a camada 1 (local) está ativa
  const nodes = parseNodes();
  if (nodes.length === 0) return;

  const plaintext = Buffer.from(jsonStr, 'utf8');
  const hash = crypto.createHash('sha256').update(plaintext).digest('hex');
  if (hash === lastBackedUpHash) return; // nada mudou desde o último backup — não martela os nós à toa

  const blob = encrypt(plaintext, key);
  const results = await Promise.allSettled(
    nodes.map((n) => shardTransport.putShard(n.host, n.port, BACKUP_SHARD_KEY, blob))
  );

  const okCount = results.filter((r) => r.status === 'fulfilled' && r.value).length;
  if (okCount === 0) {
    console.error(`[registryBackup] falha ao replicar em TODOS os ${nodes.length} nó(s) de backup configurados`);
    return; // não marca como "feito" — tenta de novo no próximo ciclo
  }
  if (okCount < nodes.length) {
    console.error(`[registryBackup] replicado em ${okCount}/${nodes.length} nó(s) de backup (alguns falharam)`);
  }
  lastBackedUpHash = hash;
}

/**
 * Recuperação manual (rodar num script separado durante disaster recovery,
 * NUNCA automaticamente no boot — evita que uma instância com estado local
 * ruim sobrescreva sozinha uma recuperação que o operador está fazendo à
 * mão). Tenta cada nó configurado até um responder, decifra, e devolve o
 * JSON pronto pra escrever em gateway-data.json antes de subir o gateway.
 */
async function restoreFromBackup() {
  const key = getKey();
  if (!key) throw new Error('REGISTRY_BACKUP_KEY não configurado — não dá pra decifrar nenhum backup');
  const nodes = parseNodes();
  if (nodes.length === 0) throw new Error('REGISTRY_BACKUP_NODES vazio — nenhum nó de backup configurado');

  const errors = [];
  for (const n of nodes) {
    try {
      const blob = await shardTransport.getShard(n.host, n.port, BACKUP_SHARD_KEY);
      if (!blob) { errors.push(`${n.host}:${n.port}: sem dado`); continue; }
      const plaintext = decrypt(blob, key);
      JSON.parse(plaintext.toString('utf8')); // valida que decifrou algo coerente antes de devolver
      return plaintext.toString('utf8');
    } catch (e) {
      errors.push(`${n.host}:${n.port}: ${e.message}`);
    }
  }
  throw new Error(`nenhum nó de backup respondeu com um snapshot válido:\n${errors.join('\n')}`);
}

/** Liga a replicação periódica — chamar uma vez no boot do gateway. */
function start() {
  if (!getKey()) {
    console.log('[registryBackup] REGISTRY_BACKUP_KEY não configurado — camada 2 (replicação externa) desligada');
    return;
  }
  registry.setOnDataSaved((jsonStr) => {
    backupNow(jsonStr).catch((e) => console.error('[registryBackup] erro inesperado:', e.message));
  });
  // além de reagir a toda mudança, garante um backup mesmo em período parado
  // (ex.: gateway sobe e nada muda por horas — ainda assim quer 1 cópia fresca)
  setInterval(() => {
    try {
      const jsonStr = fs.readFileSync(registry.DATA_FILE, 'utf8');
      backupNow(jsonStr).catch((e) => console.error('[registryBackup] erro inesperado:', e.message));
    } catch (e) {
      // arquivo pode não existir ainda num gateway zero-estado — tudo bem, ignora
    }
  }, INTERVAL_MS).unref();
  console.log(`[registryBackup] ligado: replicando pra ${parseNodes().length} nó(s) de confiança a cada ${INTERVAL_MS}ms`);
}

module.exports = { start, backupNow, restoreFromBackup };
