

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP = {};
for (let i = 0; i < ALPHABET.length; i++) ALPHABET_MAP[ALPHABET[i]] = i;

function decode(str) {
  if (str.length === 0) return Buffer.alloc(0);
  const bytes = [0];
  for (let i = 0; i < str.length; i++) {
    const value = ALPHABET_MAP[str[i]];
    if (value === undefined) throw new Error(`caractere base58 inválido: ${str[i]}`);
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

function encode(buffer) {
  if (buffer.length === 0) return '';
  const digits = [0];
  for (let i = 0; i < buffer.length; i++) {
    let carry = buffer[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let zeros = 0;
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) zeros++;
  return '1'.repeat(zeros) + digits.reverse().map((d) => ALPHABET[d]).join('');
}

module.exports = { decode, encode };
