// Parser mínimo de RFC 7233 Range: só um range por vez (sem multipart/byteranges,
// que ninguém usa na prática pra esse tipo de gateway).
// Retorna: null (sem Range / não parseável -> serve tudo), 'unsatisfiable' (416),
// ou {start, end} inclusive.
function parseRange(rangeHeader, totalLength) {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) return null;
  const spec = rangeHeader.slice(6).split(',')[0].trim();
  const m = /^(\d*)-(\d*)$/.exec(spec);
  if (!m) return null;
  const [, startStr, endStr] = m;
  if (startStr === '' && endStr === '') return null;

  let start; let end;
  if (startStr === '') {
    // range de sufixo: últimos N bytes
    const n = parseInt(endStr, 10);
    if (Number.isNaN(n) || n <= 0) return null;
    if (totalLength === 0) return 'unsatisfiable';
    start = Math.max(0, totalLength - n);
    end = totalLength - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === '' ? totalLength - 1 : parseInt(endStr, 10);
  }

  if (Number.isNaN(start) || Number.isNaN(end) || start < 0) return null;
  // checa "além do arquivo" ANTES de comparar start > end, porque start-aberto
  // (ex: bytes=5000-) sempre cai em end=totalLength-1, e se start já estourou
  // o arquivo isso ia parecer "start > end" e virar null (200) em vez de 416.
  if (start >= totalLength) return 'unsatisfiable';
  end = Math.min(end, totalLength - 1);
  if (start > end) return null;
  return { start, end };
}

module.exports = { parseRange };
