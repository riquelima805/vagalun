// Hash por shard: calculado uma vez no publish, guardado no manifesto
// (placements[i].shardHash), e conferido de novo toda vez que o gateway
// busca aquele shard de um peer. Objetivo: pegar corrupção (bit flip no
// storage do celular/PC, transferência incompleta, etc.) na hora que o
// shard chega — antes de gastar CPU com Reed-Solomon decode + AES-GCM
// decrypt, e sabendo exatamente qual shard/peer falhou.
//
// Espelho de sever/gateway/shardHash.js — mesma lógica, cópia local pro
// hosting/gateway-client não depender de um require relativo cruzando
// pra fora da própria pasta (mesmo padrão de reedSolomon.cjs/shardTransport.cjs).

const crypto = require('crypto');

function hashShard(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function verifyShard(buf, expectedHashHex) {
  if (!expectedHashHex) return false;
  return hashShard(buf) === expectedHashHex;
}

module.exports = { hashShard, verifyShard };

