// Mesmo protocolo binário de WebRtcFrame.kt (node Android) — qualquer
// mudança aqui tem que ser espelhada lá, senão os dois lados param de se
// entender.
//
// FIX (chunking): antes cada frame lógico (header JSON + payload binário —
// ex.: um shard inteiro, facilmente várias centenas de KB, ver
// DEFAULT_BLOCK_SIZE em StorageClient.kt) virava UMA ÚNICA mensagem SCTP no
// data channel via dc.send(). Isso podia estourar o limite de tamanho de
// mensagem do canal (negociado por SDP, varia por peer/browser/versão de
// WebRTC) e o send() falhava DEPOIS que o node já tinha lido o shard do
// disco e montado a resposta. Esse erro era engolido em silêncio do lado do
// node — o player só via timeout, igual a um peer que nunca respondeu,
// mesmo com o shard existindo. Só não acontecia quando a resposta era
// pequena (ex.: "shard não encontrado"), daí o sintoma de "só falha quando
// o arquivo existe de verdade".
//
// Fix: todo frame lógico agora é fatiado em N mensagens de no máximo
// CHUNK_SIZE bytes cada, remontadas do outro lado por (type, requestId) via
// Reassembler.
//
// Layout de CADA chunk no fio:
//   [1B  msgType][4B requestId BE][4B chunkIndex BE][4B totalChunks BE][4B totalLength BE][bytes do chunk]

export const TYPE_REQUEST = 0;
export const TYPE_RESPONSE = 1;

// 15 KB de conteúdo útil por chunk + 13 bytes de cabeçalho de chunk =
// 15.373 bytes por mensagem no fio, com folga confortável abaixo de 16 KB
// (o limite mais restritivo que existe por aí sem negociação de
// max-message-size). Espelhado em WebRtcFrame.CHUNK_SIZE no lado Kotlin —
// se mudar aqui, muda lá também.
export const CHUNK_SIZE = 15 * 1024;

const CHUNK_HEADER_SIZE = 1 + 4 + 4 + 4 + 4;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function toUint8(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  throw new Error('payload precisa ser Uint8Array ou ArrayBuffer');
}

/** Codifica o frame lógico inteiro (header + payload), sem fatiar — usado só por encodeChunks(). */
function encodeInner(header, payloadBytes) {
  const headerBytes = textEncoder.encode(JSON.stringify(header || {}));
  const payload = payloadBytes ? toUint8(payloadBytes) : new Uint8Array(0);
  const buf = new Uint8Array(4 + headerBytes.length + payload.length);
  const view = new DataView(buf.buffer);
  view.setUint32(0, headerBytes.length, false);
  buf.set(headerBytes, 4);
  buf.set(payload, 4 + headerBytes.length);
  return buf;
}

/**
 * Gera a lista de chunks — já prontos pra dc.send(), um de cada vez, NA
 * ORDEM — que representam um frame lógico inteiro. Sempre pelo menos 1
 * chunk, mesmo pra frames pequenos/vazios: mantém um único caminho de
 * código dos dois lados, sem "caso especial" de mensagem pequena não-fatiada.
 * @returns {ArrayBuffer[]}
 */
export function encodeChunks(type, requestId, header, payloadBytes) {
  const inner = encodeInner(header, payloadBytes);
  const totalLength = inner.length;
  const totalChunks = Math.max(1, Math.ceil(totalLength / CHUNK_SIZE));
  const chunks = [];
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, totalLength);
    const chunkLen = end - start;
    const buf = new ArrayBuffer(CHUNK_HEADER_SIZE + chunkLen);
    const view = new DataView(buf);
    let offset = 0;
    view.setUint8(offset, type);
    offset += 1;
    view.setInt32(offset, requestId, false);
    offset += 4;
    view.setInt32(offset, i, false);
    offset += 4;
    view.setInt32(offset, totalChunks, false);
    offset += 4;
    view.setInt32(offset, totalLength, false);
    offset += 4;
    if (chunkLen > 0) new Uint8Array(buf, offset, chunkLen).set(inner.subarray(start, end));
    chunks.push(buf);
  }
  return chunks;
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {{type:number, requestId:number, chunkIndex:number, totalChunks:number, totalLength:number, chunkBytes:Uint8Array}}
 */
export function decodeChunk(buffer) {
  const view = new DataView(buffer);
  let offset = 0;
  const type = view.getUint8(offset);
  offset += 1;
  const requestId = view.getInt32(offset, false);
  offset += 4;
  const chunkIndex = view.getInt32(offset, false);
  offset += 4;
  const totalChunks = view.getInt32(offset, false);
  offset += 4;
  const totalLength = view.getInt32(offset, false);
  offset += 4;
  if (totalChunks < 1 || totalChunks > 1_000_000) {
    throw new Error(`totalChunks inválido: ${totalChunks}`);
  }
  if (totalLength < 0 || totalLength > 256 * 1024 * 1024) {
    throw new Error(`totalLength inválido: ${totalLength}`);
  }
  if (chunkIndex < 0 || chunkIndex >= totalChunks) {
    throw new Error(`chunkIndex fora do range: ${chunkIndex}/${totalChunks}`);
  }
  const chunkBytes = new Uint8Array(buffer, offset).slice();
  return { type, requestId, chunkIndex, totalChunks, totalLength, chunkBytes };
}

function decodeInner(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = view.getUint32(0, false);
  if (headerLen < 0 || headerLen > 4 * 1024 * 1024) {
    throw new Error(`header de tamanho inválido: ${headerLen}`);
  }
  const headerBytes = bytes.subarray(4, 4 + headerLen);
  const header = JSON.parse(textDecoder.decode(headerBytes));
  const payloadBytes = bytes.subarray(4 + headerLen);
  const payload = payloadBytes.length > 0 ? payloadBytes.slice() : null;
  return { header, payload };
}

/**
 * Remonta os chunks recebidos em um frame completo só quando o último chunk
 * daquele (type, requestId) chega. Remonta por índice (não por ordem de
 * chegada) — o data channel é `ordered: true` então na prática chega tudo
 * em ordem mesmo, mas isso custa nada e evita corrupção silenciosa se um
 * dia isso mudar. Uma instância por WebRtcTransport (por peer).
 */
export class Reassembler {
  constructor() {
    this._inProgress = new Map(); // "type:requestId" -> { totalLength, chunks: Array<Uint8Array|null>, received }
  }

  /**
   * @param {{type:number, requestId:number, chunkIndex:number, totalChunks:number, totalLength:number, chunkBytes:Uint8Array}} chunk
   * @returns {{type:number, requestId:number, header:object, payload:Uint8Array|null}|null} frame completo, ou null se ainda faltam chunks
   */
  accept(chunk) {
    const key = `${chunk.type}:${chunk.requestId}`;
    let entry = this._inProgress.get(key);
    if (!entry) {
      entry = { totalLength: chunk.totalLength, chunks: new Array(chunk.totalChunks).fill(null), received: 0 };
      this._inProgress.set(key, entry);
    }
    if (chunk.chunkIndex < 0 || chunk.chunkIndex >= entry.chunks.length) return null; // fora do range, ignora

    if (entry.chunks[chunk.chunkIndex] === null) {
      entry.chunks[chunk.chunkIndex] = chunk.chunkBytes;
      entry.received += 1;
    }
    if (entry.received < entry.chunks.length) return null;

    this._inProgress.delete(key);
    const inner = new Uint8Array(entry.totalLength);
    let offset = 0;
    for (const part of entry.chunks) {
      inner.set(part, offset);
      offset += part.length;
    }
    const { header, payload } = decodeInner(inner);
    return { type: chunk.type, requestId: chunk.requestId, header, payload };
  }

  /** Descarta transferências incompletas — chamar no close() do transport. */
  clear() {
    this._inProgress.clear();
  }
}