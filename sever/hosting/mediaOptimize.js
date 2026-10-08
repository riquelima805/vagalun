// mediaOptimize.js
//
// Pipeline de otimização de mídia rodado UMA VEZ, no upload (host), antes do
// arquivo ser gravado na pasta do site / replicado pros nós.
//
// - Vídeo: remux pra MP4 FRAGMENTADO (fMP4) com sidx global — pré-requisito do
//   streaming progressivo P2P do player (MediaSource): moov vazio na frente +
//   moof/mdat de ~2s + índice tempo->byte. Sem isso o player só consegue
//   tocar baixando o arquivo inteiro (inviável pra vídeo longo).
// - Áudio: remove capas/ID3 pesados embutidos e força um bitrate constante
// - Imagem: resize pro tamanho máximo útil + converte pra WebP + remove EXIF
//
// Tudo síncrono em relação ao request de upload (await), mas cada chamada
// individual é isolada e falha "suave": se o processamento der erro, cai de
// volta pro arquivo original em vez de derrubar o upload inteiro.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v']);
const AUDIO_EXT = new Set(['.mp3']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

const IMAGE_MAX_DIMENSION = 1600; // px, lado maior
const IMAGE_WEBP_QUALITY = 82;
const AUDIO_BITRATE = '192k';

function extOf(filename) {
  return path.extname(filename || '').toLowerCase();
}

function classify(filename) {
  const ext = extOf(filename);
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (IMAGE_EXT.has(ext)) return 'image';
  return null;
}

// Roda um binário externo e resolve/rejeita no exit code.
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject); // binário não encontrado etc.
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} saiu com código ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

async function tmpPathFor(originalPath, newExt) {
  const dir = path.dirname(originalPath);
  const rand = Math.random().toString(36).slice(2, 8);
  return path.join(dir, `.optimizing-${rand}${newExt}`);
}

// Descobre o codec da 1ª trilha de vídeo e (se houver) da 1ª de áudio via ffprobe.
// Devolve { video: 'h264'|null, audio: 'aac'|null }.
function probeCodecs(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name',
      '-of', 'csv=p=0',
      filePath,
    ];
    const child = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe saiu com código ${code}: ${stderr.slice(-1000)}`));
      const out = { video: null, audio: null };
      for (const line of stdout.split('\n')) {
        const [name, type] = line.trim().split(','); // csv: codec_name,codec_type
        if (type === 'video' && !out.video) out.video = (name || '').toLowerCase();
        if (type === 'audio' && !out.audio) out.audio = (name || '').toLowerCase();
      }
      resolve(out);
    });
  });
}

// Codecs de vídeo que os navegadores tocam nativamente via <video>/MSE.
// Qualquer outra coisa (mpeg4/DivX/Xvid, wmv, mpeg2, etc.) precisa recodificar.
const WEB_SAFE_VIDEO_CODECS = new Set(['h264', 'vp9', 'av1']);
// (vp8 saiu da lista: não existe VP8 dentro de MP4 no padrão — o navegador/MSE rejeita.)
// Áudio que dá pra copiar pra dentro de MP4 e tocar no navegador/MSE.
// ac3/eac3/pcm/dts etc. NÃO tocam no Chrome via MSE -> recodifica só o áudio.
const WEB_SAFE_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'flac']);

// Flags de fragmentação. Cada uma importa:
//  frag_keyframe      — novo fragmento a cada keyframe (seek cai sempre num keyframe)
//  empty_moov         — moov vazio no começo (o player descobre codec sem ler o arquivo todo)
//  default_base_moof  — offsets relativos à moof (exigido pelo MSE/CMAF)
//  global_sidx        — índice tempo->byte no começo: é o que permite SEEK em vídeo longo
//                       sem baixar o que vem antes (só funciona escrevendo em arquivo, o caso aqui)
const FRAG_MOVFLAGS = '+frag_keyframe+empty_moov+default_base_moof+global_sidx';

// ---- Vídeo: remux pra fMP4 (com sidx) quando já é H.264/VP9/AV1;
// transcodifica pra H.264+AAC quando o codec original não roda no navegador ----
async function optimizeVideo(filePath) {
  const ext = extOf(filePath);
  const out = await tmpPathFor(filePath, ext);

  let codecs = { video: null, audio: null };
  let probed = false;
  try {
    codecs = await probeCodecs(filePath);
    probed = true;
  } catch {
    // Se nem o ffprobe conseguir ler, segue pro remux simples e deixa o
    // ffmpeg reclamar se o arquivo estiver realmente quebrado.
  }

  const needsVideoTranscode = !probed || !codecs.video || !WEB_SAFE_VIDEO_CODECS.has(codecs.video);
  // sem trilha de áudio = nada a fazer; com áudio fora da lista, só o áudio é recodificado
  const needsAudioTranscode = !probed || (codecs.audio && !WEB_SAFE_AUDIO_CODECS.has(codecs.audio));

  const args = ['-y', '-i', filePath, '-map', '0:v:0', '-map', '0:a:0?']; // 1 vídeo + 1 áudio (se existir); descarta legendas/dados que o MP4 fragmentado não carrega bem
  if (needsVideoTranscode) {
    args.push(
      '-c:v', 'libx264',
      '-profile:v', 'high',
      '-pix_fmt', 'yuv420p', // compatibilidade máxima (evita 4:2:2/10-bit que trava em alguns navegadores)
      '-preset', 'veryfast',
      '-crf', '23',
      // keyframe a cada 2s EM TEMPO (independe do fps): fragmentos previsíveis (~2s)
      // = seek granular e blocos P2P pequenos. Com -c copy não dá pra mexer nisso:
      // os fragmentos seguem os keyframes que o arquivo já tem.
      '-force_key_frames', 'expr:gte(t,n_forced*2)',
    );
  } else {
    args.push('-c:v', 'copy');
  }
  if (needsAudioTranscode) {
    args.push('-c:a', 'aac', '-b:a', '128k');
  } else {
    args.push('-c:a', 'copy');
  }
  // -f mp4 explícito: o tmp pode ter extensão .mov/.m4v e o ffmpeg escolheria o muxer (e o brand do ftyp) pela extensão
  args.push('-f', 'mp4', '-movflags', FRAG_MOVFLAGS, out);

  try {
    await run('ffmpeg', args);
    await fsp.rename(out, filePath);
    const parts = [];
    if (needsVideoTranscode) parts.push(`transcode-h264(${codecs.video || 'unknown'}->h264)`);
    if (needsAudioTranscode) parts.push(`audio->aac(${codecs.audio || 'unknown'})`);
    parts.push('fmp4+sidx');
    return { processed: true, method: parts.join('+') };
  } catch (err) {
    await fsp.rm(out, { force: true });
    throw err;
  }
}

// ---- Áudio: remove capas/ID3 pesados e normaliza bitrate ----
async function optimizeAudio(filePath) {
  const ext = extOf(filePath);
  const out = await tmpPathFor(filePath, ext);
  try {
    await run('ffmpeg', [
      '-y',
      '-i', filePath,
      '-map', '0:a',       // só o stream de áudio, descarta streams de imagem/capa embutida
      '-map_metadata', '-1', // descarta metadados/ID3 originais (incluindo capa)
      '-c:a', 'libmp3lame',
      '-b:a', AUDIO_BITRATE,
      out,
    ]);
    await fsp.rename(out, filePath);
    return { processed: true, method: 'strip-cover+cbr' };
  } catch (err) {
    await fsp.rm(out, { force: true });
    throw err;
  }
}

// ---- Imagem: resize + WebP + strip EXIF ----
async function optimizeImage(filePath) {
  // sharp é opcional: só carrega se estiver instalado (ver package.json).
  let sharp;
  try {
    ({ default: sharp } = await import('sharp'));
  } catch {
    throw new Error('pacote "sharp" não instalado — pule ou rode `npm install sharp`');
  }

  const dir = path.dirname(filePath);
  const base = path.basename(filePath, extOf(filePath));
  const outPath = path.join(dir, `${base}.webp`);
  const tmpOut = await tmpPathFor(filePath, '.webp');

  await sharp(filePath)
    .rotate() // aplica orientação EXIF antes de descartar os metadados
    .resize({
      width: IMAGE_MAX_DIMENSION,
      height: IMAGE_MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: IMAGE_WEBP_QUALITY })
    .toFile(tmpOut); // sharp já não copia EXIF pro destino a menos que peçamos

  await fsp.rename(tmpOut, outPath);

  // Se o arquivo original não era .webp, o nome final muda — removemos o original.
  if (outPath !== filePath) {
    await fsp.rm(filePath, { force: true });
  }

  return { processed: true, method: 'resize+webp+strip-exif', newPath: outPath };
}

/**
 * Otimiza um arquivo de mídia in-place (ou trocando extensão, no caso de imagem).
 *
 * @param {string} filePath caminho absoluto do arquivo já salvo em disco
 * @param {string} originalname nome original enviado pelo cliente (pra decidir o tipo)
 * @returns {Promise<{skipped:boolean, processed?:boolean, method?:string, newPath?:string, error?:string}>}
 */
export async function optimizeMediaFile(filePath, originalname) {
  const kind = classify(originalname || filePath);
  if (!kind) return { skipped: true, reason: 'tipo não otimizável' };

  try {
    if (kind === 'video') return await optimizeVideo(filePath);
    if (kind === 'audio') return await optimizeAudio(filePath);
    if (kind === 'image') return await optimizeImage(filePath);
  } catch (err) {
    // Falha suave: fica com o arquivo original, upload não quebra.
    console.error(`[mediaOptimize] falha otimizando ${originalname}:`, err.message);
    return { skipped: true, error: err.message };
  }
  return { skipped: true };
}

/**
 * Varre um diretório inteiro recursivamente e otimiza toda mídia encontrada
 * in-place. Usado no deploy de site via .zip, antes de publicar pros nós.
 *
 * @param {string} dir diretório raiz a varrer
 * @returns {Promise<{scanned:number, optimized:number, failed:number}>}
 */
export async function optimizeMediaDir(dir) {
  const stats = { scanned: 0, optimized: 0, failed: 0 };

  async function walk(current) {
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!classify(entry.name)) continue;

      stats.scanned += 1;
      const result = await optimizeMediaFile(full, entry.name);
      if (result?.processed) stats.optimized += 1;
      else if (result?.error) stats.failed += 1;
    }
  }

  await walk(dir);
  return stats;
}

/**
 * Fragmenta (fMP4+sidx) um vídeo que está só em memória (ex.: entrada de .zip).
 * Só mexe em vídeo; qualquer outro tipo, ou qualquer falha, devolve o buffer original.
 *
 * @param {Buffer} buf conteúdo do arquivo
 * @param {string} name nome/caminho do arquivo (decide se é vídeo pela extensão)
 * @returns {Promise<Buffer>}
 */
export async function optimizeVideoBuffer(buf, name) {
  if (classify(name) !== 'video') return buf;
  const tmp = path.join(os.tmpdir(), `vagalun-vid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extOf(name)}`);
  try {
    await fsp.writeFile(tmp, buf);
    const result = await optimizeMediaFile(tmp, name);
    if (result?.processed) {
      console.log(`[mediaOptimize] ${name}: ${result.method}`);
      return await fsp.readFile(tmp);
    }
    return buf;
  } catch (err) {
    console.error(`[mediaOptimize] falha em ${name}, usando original:`, err.message);
    return buf;
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

/**
 * Confere no boot se ffmpeg/ffprobe existem. Sem eles o otimizador "falha suave"
 * (o upload não quebra), então o vídeo subiria SEM fragmentar e ninguém notaria.
 * Devolve true/false e loga bem alto quando faltar.
 */
export async function checkFfmpeg() {
  const test = (bin) => new Promise((resolve) => {
    const c = spawn(bin, ['-version'], { stdio: 'ignore' });
    c.on('error', () => resolve(false));
    c.on('close', (code) => resolve(code === 0));
  });
  const [ff, fp] = await Promise.all([test('ffmpeg'), test('ffprobe')]);
  if (!ff || !fp) {
    console.error(
      `[mediaOptimize] ATENÇÃO: ${!ff ? 'ffmpeg ' : ''}${!fp ? 'ffprobe ' : ''}não encontrado no PATH deste servidor. ` +
      'Vídeos vão subir SEM fragmentar e o player P2P cai no modo "arquivo inteiro". Instale: apt install ffmpeg'
    );
    return false;
  }
  console.log('[mediaOptimize] ffmpeg/ffprobe OK — vídeos serão fragmentados no upload');
  return true;
}

export const _internal = { classify, extOf };

