// Simula o app Android falando com o signaling: registra um nodeId e responde
// relay requests (put/get_range) igual ShardRequestHandler.kt faria.
const WebSocket = require('ws');
const url = process.argv[2] || 'ws://localhost:8787';
const nodeId = process.argv[3] || 'phone-1';

const store = new Map();
const ws = new WebSocket(url);

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'register', nodeId }));
  console.log(`[fakephone] registrado como ${nodeId} em ${url}`);
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type !== 'relay') return;
  const { from, requestId, header, payloadBase64 } = msg;
  const payload = payloadBase64 ? Buffer.from(payloadBase64, 'base64') : null;

  let respHeader, respPayload = null;
  if (header.op === 'put') {
    store.set(header.shardKey, payload);
    respHeader = { ok: true, size: payload.length };
  } else if (header.op === 'get_range' || header.op === 'get') {
    const data = store.get(header.shardKey);
    if (!data) { respHeader = { ok: false, error: 'shard não encontrado' }; }
    else {
      const offset = header.offset || 0;
      const length = header.length ?? data.length;
      respPayload = header.op === 'get_range' ? data.subarray(offset, offset + length) : data;
      respHeader = { ok: true };
    }
  } else if (header.op === 'status') {
    respHeader = { ok: true, nodeId };
  } else {
    respHeader = { ok: false, error: 'op não suportada' };
  }

  const out = { type: 'relay_response', to: from, requestId, header: respHeader };
  if (respPayload) out.payloadBase64 = respPayload.toString('base64');
  ws.send(JSON.stringify(out));
});
