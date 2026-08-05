// Porta 1:1 de app/src/main/java/.../erasure/GF256.kt
// Tem que bater byte a byte com o Kotlin, senão o decode RS não fecha com o que o app gerou.

const EXP = new Int32Array(512);
const LOG = new Int32Array(256);

(function init() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = x << 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function mul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function inv(a) {
  if (a === 0) throw new Error('Zero não tem inverso em GF(256)');
  return EXP[255 - LOG[a]];
}

function pow(a, n) {
  if (n === 0) return 1;
  if (a === 0) return 0;
  return EXP[(LOG[a] * n) % 255];
}

module.exports = { mul, inv, pow };
