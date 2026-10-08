// Item 14: rate limit isolado do gateway (não importa de sever/server.js de
// propósito — são processos separados, signaling e gateway não deveriam
// ficar acoplados só pra reusar 20 linhas). Mesmo padrão de sliding window
// em memória já usado lá.

const rateBuckets = new Map(); // key -> [timestamps]

function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  let arr = rateBuckets.get(key);
  if (!arr) { arr = []; rateBuckets.set(key, arr); }
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  if (arr.length >= limit) return true;
  arr.push(now);
  return false;
}

// limpeza periódica — sem isso, todo IP/fileId que já bateu aqui uma vez
// vira uma entrada que nunca mais sai da memória.
setInterval(() => {
  const now = Date.now();
  for (const [key, arr] of rateBuckets) {
    while (arr.length && now - arr[0] > 10 * 60_000) arr.shift();
    if (arr.length === 0) rateBuckets.delete(key);
  }
}, 60_000).unref();

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
}

module.exports = { rateLimited, clientIp };
