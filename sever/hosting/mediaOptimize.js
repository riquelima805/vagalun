// mediaOptimize.js
//
// Pipeline de otimização de mídia rodado UMA VEZ, no upload (host), antes do
// arquivo ser gravado na pasta do site / replicado pros nós.
//
// - Vídeo: remux com -movflags +faststart (moov atom pro início do arquivo)
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

// Descobre o codec de vídeo/áudio do arquivo via ffprobe.
function probeCodecs(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
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
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`ffprobe saiu com código ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

// Codecs de vídeo que os navegadores tocam nativamente via <video>.
// Qualquer outra coisa (mpeg4/DivX/Xvid, wmv, mpeg2, etc.) precisa recodificar.
const WEB_SAFE_VIDEO_CODECS = new Set(['h264', 'vp9', 'vp8', 'av1']);

// ---- Vídeo: faststart (remux) quando já é H.264/VP9/AV1;
// transcodifica pra H.264+AAC quando o codec original não roda no navegador ----
async function optimizeVideo(filePath) {
  const ext = extOf(filePath);
  const out = await tmpPathFor(filePath, ext);

  let codec = null;
  try {
    codec = await probeCodecs(filePath);
  } catch {
    // Se nem o ffprobe conseguir ler, segue pro remux simples e deixa o
    // ffmpeg reclamar se o arquivo estiver realmente quebrado.
  }

  const needsTranscode = !codec || !WEB_SAFE_VIDEO_CODECS.has(codec.toLowerCase());

  try {
    if (needsTranscode) {
      await run('ffmpeg', [
        '-y',
        '-i', filePath,
        '-c:v', 'libx264',
        '-profile:v', 'high',
        '-pix_fmt', 'yuv420p', // compatibilidade máxima (evita 4:2:2/10-bit que trava em alguns navegadores)
        '-preset', 'veryfast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        out,
      ]);
    } else {
      await run('ffmpeg', [
        '-y',
        '-i', filePath,
        '-c', 'copy',
        '-movflags', '+faststart',
        out,
      ]);
    }
    await fsp.rename(out, filePath);
    return {
      processed: true,
      method: needsTranscode ? `transcode-h264(${codec || 'unknown'}->h264)+faststart` : 'faststart',
    };
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

export const _internal = { classify, extOf };
