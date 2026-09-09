// Gerencia keypairs Ed25519 "custodiais" — uma por domínio/site.
// Não é a wallet do usuário no app Android: é uma chave que o PRÓPRIO
// hosting-platform guarda pra poder assinar manifestos automaticamente
// quando o usuário publica pela UI web (sem precisar ter o app aberto).
//
// Guardado em disco como JSON simples. Em produção isso deveria ir pra um
// KMS/segredo cifrado, mas pro passo de integração/teste, arquivo local resolve.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const base58 = require('../gateway/base58');

const KEYS_FILE = process.env.PUBLISHER_KEYS_FILE || path.join(__dirname, 'site-keys.json');

function loadAll() {
  if (!fs.existsSync(KEYS_FILE)) return {};
  return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
}

function saveAll(obj) {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(obj, null, 2));
}

// Retorna { pubkeyB58, privateKey (KeyObject) } pro domínio, criando se não existir.
function getOrCreateSiteKey(domain) {
  const all = loadAll();
  if (all[domain]) {
    const privateKey = crypto.createPrivateKey({
      key: Buffer.from(all[domain].privateKeyDer, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    return { pubkeyB58: all[domain].pubkeyB58, privateKey };
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const pubkeyB58 = base58.encode(rawPub);
  const privateKeyDer = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');

  all[domain] = { pubkeyB58, privateKeyDer, createdAt: Date.now() };
  saveAll(all);

  return { pubkeyB58, privateKey };
}

module.exports = { getOrCreateSiteKey };
