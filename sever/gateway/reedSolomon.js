// Porta de app/src/main/java/.../erasure/ReedSolomon.kt.
// O gateway só PRECISA de decode() em operação normal — encode() fica aqui
// só de apoio pra self-test (test/selftest.js) simular um upload sem precisar da JVM.

const GF256 = require('./gf256');

function buildEncodingMatrix(k, n) {
  const vander = Array.from({ length: n }, (_, r) =>
    Array.from({ length: k }, (_, c) => GF256.pow(r + 1, c))
  );
  const top = vander.slice(0, k);
  const topInv = invertMatrix(top);
  return vander.map((row) => multiplyRowByMatrix(row, topInv, k));
}

function multiplyRowByMatrix(row, matrix, k) {
  const result = new Array(k).fill(0);
  for (let c = 0; c < k; c++) {
    let sum = 0;
    for (let i = 0; i < k; i++) sum ^= GF256.mul(row[i], matrix[i][c]);
    result[c] = sum;
  }
  return result;
}

function invertMatrix(matrix) {
  const n = matrix.length;
  const aug = matrix.map((row, i) => {
    const r = new Array(2 * n).fill(0);
    for (let c = 0; c < n; c++) r[c] = row[c];
    r[n + i] = 1;
    return r;
  });

  for (let col = 0; col < n; col++) {
    let pivotRow = -1;
    for (let r = col; r < n; r++) {
      if (aug[r][col] !== 0) { pivotRow = r; break; }
    }
    if (pivotRow === -1) {
      throw new Error('Matriz singular — não é invertível (shards insuficientes ou combinação inválida)');
    }
    const tmp = aug[col]; aug[col] = aug[pivotRow]; aug[pivotRow] = tmp;

    const invVal = GF256.inv(aug[col][col]);
    for (let c = 0; c < 2 * n; c++) aug[col][c] = GF256.mul(aug[col][c], invVal);

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = aug[r][col];
      if (factor === 0) continue;
      for (let c = 0; c < 2 * n; c++) aug[r][c] ^= GF256.mul(factor, aug[col][c]);
    }
  }
  return aug.map((row) => row.slice(n, 2 * n));
}

// available: [{index, data: Buffer}], precisa de pelo menos k
function decode(available, originalLength, shardSize, k, m) {
  const n = k + m;
  if (available.length < k) {
    throw new Error(`Shards insuficientes: precisa de ${k}, disponível ${available.length}`);
  }
  const chosen = available.slice().sort((a, b) => a.index - b.index).slice(0, k);
  const matrix = buildEncodingMatrix(k, n);
  const subMatrix = chosen.map((c) => matrix[c.index]);
  const inv = invertMatrix(subMatrix);

  const dataShards = [];
  for (let row = 0; row < k; row++) {
    const out = Buffer.alloc(shardSize);
    for (let byteIdx = 0; byteIdx < shardSize; byteIdx++) {
      let sum = 0;
      for (let col = 0; col < k; col++) sum ^= GF256.mul(inv[row][col], chosen[col].data[byteIdx]);
      out[byteIdx] = sum;
    }
    dataShards.push(out);
  }
  const full = Buffer.concat(dataShards, k * shardSize);
  return full.subarray(0, originalLength);
}

// Só usado por test/selftest.js
function encode(buffer, k, m) {
  const n = k + m;
  const shardSize = Math.ceil(buffer.length / k);
  const dataShards = [];
  for (let i = 0; i < k; i++) {
    const shard = Buffer.alloc(shardSize);
    const start = i * shardSize;
    const end = Math.min((i + 1) * shardSize, buffer.length);
    if (start < buffer.length) buffer.copy(shard, 0, start, end);
    dataShards.push(shard);
  }
  const matrix = buildEncodingMatrix(k, n);
  const shards = [];
  for (let row = 0; row < n; row++) {
    const out = Buffer.alloc(shardSize);
    for (let byteIdx = 0; byteIdx < shardSize; byteIdx++) {
      let sum = 0;
      for (let col = 0; col < k; col++) sum ^= GF256.mul(matrix[row][col], dataShards[col][byteIdx]);
      out[byteIdx] = sum;
    }
    shards.push(out);
  }
  return { shards, originalLength: buffer.length, shardSize, k, m, n };
}

module.exports = { decode, encode };
