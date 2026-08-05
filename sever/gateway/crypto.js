const crypto = require('crypto');
const base58 = require('./base58');


function decryptBlock(ciphertext, ivB64, authTagB64, key) {
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function pubkeyToKeyObject(pubkeyB58) {
  const raw = base58.decode(pubkeyB58);
  if (raw.length !== 32) throw new Error('chave pública Ed25519 inválida (esperado 32 bytes)');
  const jwk = { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') };
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}


function verifyEd25519(message, signatureB64, pubkeyB58) {
  try {
    const keyObj = pubkeyToKeyObject(pubkeyB58);
    const signature = Buffer.from(signatureB64, 'base64');
    return crypto.verify(null, Buffer.from(message, 'utf8'), keyObj, signature);
  } catch (e) {
    return false;
  }
}

module.exports = { decryptBlock, verifyEd25519, pubkeyToKeyObject };
