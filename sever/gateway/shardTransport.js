// Implementa, do lado Node, o mesmo protocolo binário de network/ShardProtocol.kt:
// frame = [4 bytes tamanho, big-endian][N bytes payload]. Um header JSON sempre primeiro,
// e um frame binário opcional depois quando a operação devolve bytes (get / get_range).
// Isso permite o gateway falar TCP direto com qualquer ShardServer.kt que esteja acessível
// na rede (LAN / port-forward), sem precisar reimplementar WebRTC em Node.

const net = require('net');

function writeFrame(socket, buf) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  socket.write(len);
  socket.write(buf);
}

function writeJson(socket, obj) {
  writeFrame(socket, Buffer.from(JSON.stringify(obj), 'utf8'));
}

class FrameReader {
  constructor(socket) {
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    socket.on('data', (chunk) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      this._drain();
    });
  }

  _drain() {
    while (this.waiters.length && this.buf.length >= this.waiters[0].need) {
      const { need, resolve } = this.waiters.shift();
      resolve(this.buf.subarray(0, need));
      this.buf = this.buf.subarray(need);
    }
  }

  readBytes(n) {
    return new Promise((resolve) => {
      this.waiters.push({ need: n, resolve });
      this._drain();
    });
  }

  async readFrame(maxSize = 64 * 1024 * 1024) {
    const lenBuf = await this.readBytes(4);
    const size = lenBuf.readUInt32BE(0);
    if (size < 0 || size > maxSize) throw new Error(`frame de tamanho inválido: ${size}`);
    return this.readBytes(size);
  }

  async readJson() {
    const bytes = await this.readFrame(1024 * 1024);
    return JSON.parse(bytes.toString('utf8'));
  }
}

function withConnection(host, port, timeoutMs, fn) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.createConnection({ host, port });

    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err); else resolve(val);
    };

    const timer = setTimeout(() => finish(new Error(`timeout falando com ${host}:${port}`)), timeoutMs);

    socket.once('error', (e) => finish(e));

    socket.once('connect', async () => {
      try {
        const reader = new FrameReader(socket);
        const result = await fn(socket, reader);
        finish(null, result);
      } catch (e) {
        finish(e);
      }
    });
  });
}

async function getShard(host, port, shardKey, timeoutMs = 8000) {
  return withConnection(host, port, timeoutMs, async (socket, reader) => {
    writeJson(socket, { op: 'get', shardKey });
    const resp = await reader.readJson();
    if (!resp.ok) return null;
    return reader.readFrame();
  });
}

// Usa o op get_range (passo 2) — pedimos o shard inteiro por essa via mesmo, porque
// o handler no Android lê com RandomAccessFile/seek em vez de carregar o arquivo todo em RAM.
async function getShardRange(host, port, shardKey, offset, length, timeoutMs = 8000) {
  return withConnection(host, port, timeoutMs, async (socket, reader) => {
    writeJson(socket, { op: 'get_range', shardKey, offset, length });
    const resp = await reader.readJson();
    if (!resp.ok) return null;
    return reader.readFrame();
  });
}

async function putShard(host, port, shardKey, data, timeoutMs = 8000) {
  return withConnection(host, port, timeoutMs, async (socket, reader) => {
    writeJson(socket, { op: 'put', shardKey });
    writeFrame(socket, data);
    const resp = await reader.readJson();
    return !!resp.ok;
  });
}

async function deleteShard(host, port, shardKey, timeoutMs = 8000) {
  return withConnection(host, port, timeoutMs, async (socket, reader) => {
    writeJson(socket, { op: 'delete', shardKey });
    const resp = await reader.readJson();
    return !!resp.ok;
  });
}

async function status(host, port, timeoutMs = 4000) {
  return withConnection(host, port, timeoutMs, async (socket, reader) => {
    writeJson(socket, { op: 'status' });
    return reader.readJson();
  });
}

module.exports = { getShard, getShardRange, putShard, deleteShard, status, writeJson, writeFrame, FrameReader };
