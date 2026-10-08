// Parser mínimo de MP4 (ISO BMFF) — só o que o player precisa pra tocar um
// arquivo fragmentado (fMP4) via MediaSource:
//   - achar ftyp/moov/sidx no começo do arquivo,
//   - descobrir os codecs (string `avc1.640028`, `mp4a.40.2`...) lendo o moov,
//   - ler o `sidx` (índice tempo -> byte de cada fragmento), que é o que
//     permite SEEK em vídeo longo sem baixar o arquivo inteiro.
// Sem DOM, sem dependências: roda igual no navegador e no Node (testes).

const u8 = (b, o) => b[o];
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
// seguro até 2^53 (sobra de longe pra qualquer arquivo)
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const hex2 = (n) => n.toString(16).padStart(2, '0').toUpperCase();
const hex2l = (n) => n.toString(16).padStart(2, '0');

/**
 * Lê o cabeçalho de uma box em `o`. `size === null` significa "vai até o fim
 * do arquivo" (size 0 na spec).
 * @returns {{type:string,size:number|null,hdr:number}|null}
 */
export function readBoxHeader(b, o = 0, limit = b.length) {
  if (o + 8 > limit) return null;
  let size = u32(b, o);
  const type = fourcc(b, o + 4);
  let hdr = 8;
  if (size === 1) {
    if (o + 16 > limit) return null;
    size = u64(b, o + 8);
    hdr = 16;
  } else if (size === 0) {
    size = null;
  }
  return { type, size, hdr };
}

/** Itera as boxes COMPLETAS entre [start,end) de um buffer. */
export function* iterBoxes(b, start = 0, end = b.length) {
  let o = start;
  while (o + 8 <= end) {
    const h = readBoxHeader(b, o, end);
    if (!h) return;
    const size = h.size === null ? end - o : h.size;
    if (size < h.hdr || o + size > end) return; // truncada/corrompida
    yield { type: h.type, start: o, end: o + size, payload: o + h.hdr };
    o += size;
  }
}

function child(b, box, type) {
  for (const c of iterBoxes(b, box.payload, box.end)) if (c.type === type) return c;
  return null;
}

function path(b, box, ...types) {
  let cur = box;
  for (const t of types) {
    if (!cur) return null;
    cur = child(b, cur, t);
  }
  return cur;
}

// ---------------------------------------------------------------- codecs

function indexOfFourcc(b, start, end, cc) {
  for (let i = start; i + 4 <= end; i++) {
    if (b[i] === cc.charCodeAt(0) && b[i + 1] === cc.charCodeAt(1) && b[i + 2] === cc.charCodeAt(2) && b[i + 3] === cc.charCodeAt(3)) {
      return i;
    }
  }
  return -1;
}

function avcCodec(b, s, e) {
  const i = indexOfFourcc(b, s, e, 'avcC');
  if (i < 0) return null;
  const p = i + 4; // [0]=version [1]=profile [2]=compat [3]=level
  return `avc1.${hex2l(b[p + 1])}${hex2l(b[p + 2])}${hex2l(b[p + 3])}`;
}

function reverseBits32(n) {
  let r = 0;
  for (let i = 0; i < 32; i++) {
    r = (r << 1) | ((n >>> i) & 1);
  }
  return r >>> 0;
}

function hevcCodec(b, s, e, entryType) {
  const i = indexOfFourcc(b, s, e, 'hvcC');
  if (i < 0) return null;
  const p = i + 4;
  const profileSpace = b[p + 1] >> 6;
  const tier = (b[p + 1] >> 5) & 1;
  const profileIdc = b[p + 1] & 0x1f;
  const compat = reverseBits32(u32(b, p + 2)).toString(16).toUpperCase();
  const level = b[p + 12];
  const constraints = [];
  for (let k = 0; k < 6; k++) constraints.push(b[p + 6 + k]);
  while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop();
  const space = ['', 'A', 'B', 'C'][profileSpace];
  const tail = constraints.length ? '.' + constraints.map(hex2).join('.') : '';
  return `${entryType}.${space}${profileIdc}.${compat}.${tier ? 'H' : 'L'}${level}${tail}`;
}

function av1Codec(b, s, e) {
  const i = indexOfFourcc(b, s, e, 'av1C');
  if (i < 0) return null;
  const p = i + 4;
  const profile = b[p + 1] >> 5;
  const level = b[p + 1] & 0x1f;
  const tier = (b[p + 2] >> 7) & 1;
  const high = (b[p + 2] >> 6) & 1;
  const twelve = (b[p + 2] >> 5) & 1;
  const depth = twelve ? 12 : high ? 10 : 8;
  return `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.${String(depth).padStart(2, '0')}`;
}

function vp9Codec(b, s, e) {
  const i = indexOfFourcc(b, s, e, 'vpcC');
  if (i < 0) return null;
  const p = i + 4 + 4; // pula version/flags do FullBox
  const profile = b[p];
  const level = b[p + 1];
  const depth = b[p + 2] >> 4;
  return `vp09.${String(profile).padStart(2, '0')}.${String(level).padStart(2, '0')}.${String(depth).padStart(2, '0')}`;
}

function readDescLen(b, o) {
  let len = 0;
  let n = 0;
  for (; n < 4; n++) {
    const x = b[o + n];
    len = (len << 7) | (x & 0x7f);
    if (!(x & 0x80)) { n++; break; }
  }
  return { len, n };
}

function mp4aCodec(b, s, e) {
  const i = indexOfFourcc(b, s, e, 'esds');
  if (i < 0) return 'mp4a.40.2'; // sem esds: AAC-LC é o chute seguro
  let o = i + 4 + 4; // fourcc + version/flags
  const end = e;
  // ES_Descriptor (0x03) -> DecoderConfigDescriptor (0x04) -> DecoderSpecificInfo (0x05)
  if (b[o] !== 0x03) return 'mp4a.40.2';
  let l = readDescLen(b, o + 1);
  o += 1 + l.n + 3; // ES_ID(2) + flags(1)  (flags raramente ligam streamDependence/URL aqui)
  if (b[o] !== 0x04) return 'mp4a.40.2';
  l = readDescLen(b, o + 1);
  o += 1 + l.n;
  const oti = b[o]; // objectTypeIndication
  o += 13; // oti(1) streamType(1) bufferSize(3) maxBitrate(4) avgBitrate(4)
  if (oti === 0x6b || oti === 0x69) return `mp4a.${hex2(oti)}`; // MP3
  let aot = 2;
  if (o < end && b[o] === 0x05) {
    l = readDescLen(b, o + 1);
    aot = b[o + 1 + l.n] >> 3;
    if (aot === 31) aot = 32 + (((b[o + 1 + l.n] & 7) << 3) | (b[o + 2 + l.n] >> 5));
  }
  return `mp4a.${hex2l(oti)}.${aot}`;
}

function codecFromSampleEntry(b, entry) {
  const t = entry.type;
  const s = entry.payload;
  const e = entry.end;
  switch (t) {
    case 'avc1':
    case 'avc3': return avcCodec(b, s, e);
    case 'hvc1':
    case 'hev1': return hevcCodec(b, s, e, t);
    case 'av01': return av1Codec(b, s, e);
    case 'vp09': return vp9Codec(b, s, e);
    case 'mp4a': return mp4aCodec(b, s, e);
    case 'Opus': return 'opus';
    case 'fLaC': return 'flac';
    case 'ac-3': return 'ac-3';
    case 'ec-3': return 'ec-3';
    default: return null;
  }
}

// ---------------------------------------------------------------- moov

/**
 * @param {Uint8Array} moovBytes a box moov COMPLETA (com cabeçalho)
 * @returns {{hasMvex:boolean, tracks:Array<{id:number,timescale:number,handler:string,codec:string|null,entry:string|null}>}}
 */
export function parseMoov(moovBytes) {
  const h = readBoxHeader(moovBytes, 0);
  if (!h || h.type !== 'moov') throw new Error('não é uma box moov');
  const root = { payload: h.hdr, end: h.size === null ? moovBytes.length : h.size };
  const tracks = [];
  for (const trak of iterBoxes(moovBytes, root.payload, root.end)) {
    if (trak.type !== 'trak') continue;
    const tkhd = child(moovBytes, trak, 'tkhd');
    const mdia = child(moovBytes, trak, 'mdia');
    if (!tkhd || !mdia) continue;
    const tkV = moovBytes[tkhd.payload];
    const id = u32(moovBytes, tkhd.payload + (tkV === 1 ? 20 : 12));
    const mdhd = child(moovBytes, mdia, 'mdhd');
    const hdlr = child(moovBytes, mdia, 'hdlr');
    const mdV = mdhd ? moovBytes[mdhd.payload] : 0;
    const timescale = mdhd ? u32(moovBytes, mdhd.payload + (mdV === 1 ? 20 : 12)) : 1;
    const handler = hdlr ? fourcc(moovBytes, hdlr.payload + 8) : '';
    const stsd = path(moovBytes, mdia, 'minf', 'stbl', 'stsd');
    let codec = null;
    let entryType = null;
    if (stsd) {
      for (const entry of iterBoxes(moovBytes, stsd.payload + 8, stsd.end)) {
        entryType = entry.type;
        codec = codecFromSampleEntry(moovBytes, entry);
        break; // 1ª entrada basta
      }
    }
    tracks.push({ id, timescale, handler, codec, entry: entryType });
  }
  return { hasMvex: !!child(moovBytes, root, 'mvex'), tracks };
}

// ---------------------------------------------------------------- sidx

/**
 * @param {Uint8Array} sidxBytes a box sidx COMPLETA (com cabeçalho)
 * @param {number} boxEndAbs offset ABSOLUTO (no arquivo) do fim da box — os
 *   first_offset/size do sidx são relativos a esse ponto.
 */
export function parseSidx(sidxBytes, boxEndAbs) {
  const h = readBoxHeader(sidxBytes, 0);
  if (!h || h.type !== 'sidx') throw new Error('não é uma box sidx');
  let o = h.hdr;
  const version = u8(sidxBytes, o);
  o += 4; // version + flags
  const referenceId = u32(sidxBytes, o); o += 4;
  const timescale = u32(sidxBytes, o); o += 4;
  let earliest, firstOffset;
  if (version === 0) {
    earliest = u32(sidxBytes, o); o += 4;
    firstOffset = u32(sidxBytes, o); o += 4;
  } else {
    earliest = u64(sidxBytes, o); o += 8;
    firstOffset = u64(sidxBytes, o); o += 8;
  }
  o += 2; // reserved
  const count = u16(sidxBytes, o); o += 2;
  const refs = [];
  let hierarchical = false;
  for (let i = 0; i < count; i++) {
    const w = u32(sidxBytes, o);
    const refType = w >>> 31;
    const size = w & 0x7fffffff;
    const dur = u32(sidxBytes, o + 4);
    const sap = u32(sidxBytes, o + 8) >>> 31;
    if (refType === 1) hierarchical = true;
    refs.push({ size, dur, sap });
    o += 12;
  }
  let pos = boxEndAbs + firstOffset;
  let ticks = earliest;
  const units = refs.map((r) => {
    const unit = { start: pos, end: pos + r.size, t: ticks / timescale, dur: r.dur / timescale, sap: !!r.sap };
    pos += r.size;
    ticks += r.dur;
    return unit;
  });
  return { referenceId, timescale, hierarchical, units, duration: ticks / timescale };
}

/**
 * Lê os últimos 16 bytes do arquivo e, se terminarem num `mfro` (índice de
 * acesso aleatório que o ffmpeg põe no fim), devolve o tamanho da `mfra` —
 * pra não mandar essa box no meio do stream do MSE.
 * @param {Uint8Array} tail últimos bytes do arquivo (>= 16)
 * @returns {number} tamanho em bytes da mfra (0 se não existir)
 */
export function mfraSizeFromTail(tail) {
  if (tail.length < 16) return 0;
  const n = tail.length;
  if (fourcc(tail, n - 12) !== 'mfro') return 0;
  return u32(tail, n - 4);
}

export function concatBytes(...parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
