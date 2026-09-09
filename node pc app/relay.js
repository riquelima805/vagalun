'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Executa a parte prática do "relay/fan-out de live" (ver sever/server.js
 * -> ensureRelayCapacity): quando o server central manda, na resposta do
 * heartbeat, `relayAssignments: [{ streamPath, pullUrl }]`, é aqui que a
 * gente de fato PUXA o vídeo do node de origem (pullUrl, HTTP-FLV) e
 * REPUBLICA localmente via RTMP — daí em diante esse node passa a
 * aparecer no próprio heartbeat como mais um servidor daquele streamPath
 * (media.js já reporta isso sozinho, sem saber que veio de um relay), e
 * o gateway central passa a poder mandar espectadores novos pra cá.
 *
 * Sem ffmpeg disponível, essa camada fica desligada e o node simplesmente
 * nunca vira relay — não quebra nada do resto (transmitir/assistir direto
 * continua funcionando normal).
 */

// Onde procurar o ffmpeg, nessa ordem:
//   1) VAGALUN_FFMPEG_PATH, se a pessoa configurou explicitamente
//   2) EMBUTIDO no .exe: se o build foi feito com um ffmpeg dentro de
//      vagalun-pc-node-final/bin/ (ver pkg.assets no package.json), o
//      pkg empacota esse arquivo dentro do executável. Um binário nativo
//      não pode ser EXECUTADO de dentro do snapshot do pkg, então na
//      primeira vez que o node liga, a gente copia esse ffmpeg embutido
//      pra uma pasta temporária de verdade no disco e roda a partir de
//      lá — pra quem usa o .exe isso é transparente, continua sendo "um
//      arquivo só" na hora de baixar/distribuir.
//   3) uma pasta bin/ do lado do projeto (rodando com `node index.js`
//      direto, sem empacotar) — útil em desenvolvimento/teste.
//   4) "ffmpeg" do PATH do sistema, se a pessoa já tiver instalado geral
function resolveFfmpegBin(onLog) {
  if (process.env.VAGALUN_FFMPEG_PATH) return process.env.VAGALUN_FFMPEG_PATH;

  const binName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

  if (process.pkg) {
    try {
      const embedded = path.join(__dirname, 'bin', binName); // dentro do snapshot
      if (fs.existsSync(embedded)) {
        const destDir = path.join(os.tmpdir(), 'vagalun-ffmpeg');
        const dest = path.join(destDir, binName);
        if (!fs.existsSync(dest)) {
          fs.mkdirSync(destDir, { recursive: true });
          fs.copyFileSync(embedded, dest); // pkg deixa ler/copiar de dentro do snapshot pra fora
          if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
        }
        return dest;
      }
    } catch (err) {
      onLog?.('relay', `falha ao extrair ffmpeg embutido (${err.message}), tentando outras opções`);
    }
  } else {
    const bundled = path.join(__dirname, 'bin', binName); // dev: rodando com node direto
    try { if (fs.existsSync(bundled)) return bundled; } catch (_) {}
  }

  return 'ffmpeg'; // confia no PATH do sistema
}

function createRelayManager({ localRtmpPort, mediaSecret, signStreamUrl, publicHost, onLog }) {
  const FFMPEG_BIN = resolveFfmpegBin(onLog);
  onLog?.('relay', `ffmpeg do relay: ${FFMPEG_BIN}`);
  const active = new Map(); // streamPath -> { proc, pullUrl, startedAt, restarts }
  const MAX_RESTARTS = 5; // evita loop infinito reiniciando um pull que nunca vai funcionar

  function localPushUrl(streamPath) {
    // relay empurra pra si mesmo (localhost), então não precisa nem do
    // publicHost real — só a porta RTMP local, já assinado como um
    // publisher normal (auth_key), pra respeitar pushRequiresAuth se
    // estiver ligado.
    return signStreamUrl({
      host: '127.0.0.1', rtmpPort: localRtmpPort, httpPort: 0,
      secret: mediaSecret, streamPath, kind: 'push',
    });
  }

  function stop(streamPath, reason) {
    const rec = active.get(streamPath);
    if (!rec) return;
    active.delete(streamPath);
    onLog?.('relay', `parando relay de ${streamPath}${reason ? ` (${reason})` : ''}`);
    try { rec.proc.kill('SIGTERM'); } catch (_) {}
  }

  function start(streamPath, pullUrl) {
    const existing = active.get(streamPath);
    if (existing && existing.pullUrl === pullUrl) return; // já rodando exatamente essa atribuição
    if (existing) stop(streamPath, 'fonte mudou'); // origem trocou (raro), reinicia com a nova

    const pushUrl = localPushUrl(streamPath);
    onLog?.('relay', `iniciando relay de ${streamPath} (puxando de outro node)`);

    const args = [
      '-loglevel', 'warning',
      '-i', pullUrl,
      '-c', 'copy', // sem reencode: só repassa os bytes, custo de CPU mínimo
      '-f', 'flv',
      pushUrl,
    ];

    const rec = { pullUrl, startedAt: Date.now(), restarts: 0, proc: null };
    active.set(streamPath, rec);

    function spawnProc() {
      const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      rec.proc = proc;
      proc.stderr?.on('data', (chunk) => {
        // ffmpeg é barulhento em stderr por padrão mesmo sem erro; só
        // guarda a última linha pra log de diagnóstico, não despeja tudo.
        rec.lastErrLine = chunk.toString('utf8').trim().split('\n').pop();
      });
      proc.on('exit', (code, signal) => {
        if (!active.has(streamPath) || active.get(streamPath) !== rec) return; // foi parado de propósito (stop())
        rec.restarts += 1;
        if (rec.restarts > MAX_RESTARTS) {
          onLog?.('relay', `relay de ${streamPath} falhou repetidas vezes (${rec.lastErrLine || `código ${code}`}), desistindo`);
          active.delete(streamPath);
          return;
        }
        onLog?.('relay', `relay de ${streamPath} caiu (sinal ${signal || code}), tentando de novo em 3s`);
        setTimeout(() => { if (active.get(streamPath) === rec) spawnProc(); }, 3000);
      });
      proc.on('error', (err) => {
        onLog?.('relay', `ffmpeg indisponível pra relay (${err.message}) — configure VAGALUN_FFMPEG_PATH ou instale ffmpeg`);
        active.delete(streamPath);
      });
    }
    spawnProc();
  }

  /**
   * Chamado a cada heartbeat com a lista atual de atribuições que o
   * server central mandou (normalmente 0 ou 1 item). Sobe o que falta
   * e derruba relay que não é mais necessário (server já tem folga sem
   * ele, ou a live acabou).
   */
  function reconcile(assignments) {
    const wanted = new Map((assignments || []).map((a) => [a.streamPath, a.pullUrl]));
    for (const streamPath of active.keys()) {
      if (!wanted.has(streamPath)) stop(streamPath, 'não é mais necessário');
    }
    for (const [streamPath, pullUrl] of wanted) {
      start(streamPath, pullUrl);
    }
  }

  function stopAll() {
    for (const streamPath of [...active.keys()]) stop(streamPath, 'encerrando node');
  }

  return { reconcile, stopAll, get activeCount() { return active.size; } };
}

module.exports = { createRelayManager };
