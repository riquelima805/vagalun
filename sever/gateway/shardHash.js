// Hash por shard (item 10): calculado uma vez no publish, guardado no
// manifesto (placements[i].shardHash), e conferido de novo toda vez que
// o gateway busca aquele shard de um peer. Objetivo: pegar corrupção
// (bit flip no storage do celular/PC, transferência incompleta, etc.)
// NA HORA que o shard chega — antes de gastar CPU com Reed-Solomon
// decode + AES-GCM decrypt, e sabendo exatamente qual shard/peer falhou
// (hoje só o authTag do bloco inteiro pegava isso, depois de decodificar
// tudo, sem apontar o culpado).
//
// SHA-256 simples: não precisa ser criptograficamente inviolável contra
// um peer malicioso e motivado (esse peer já teria o shard de verdade
// pra devolver se quisesse; o risco aqui é corrupção acidental, não
// adversarial), então o custo de SHA-256 puro é o suficiente e é rápido.

const crypto = require('crypto');

function hashShard(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function verifyShard(buf, expectedHashHex) {
  if (!expectedHashHex) return false; // manifesto sem hash = trata como não verificável
  return hashShard(buf) === expectedHashHex;
}

module.exports = { hashShard, verifyShard };
