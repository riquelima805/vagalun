// Busca k shards bons entre `placements`, que já devem vir ORDENADOS do preferido
// (mais perto do visitante) pro menos preferido.
//
// Sem opts: comportamento antigo (dispara TODOS de uma vez, fica com os k primeiros).
// Com opts:
//   initial   quantos disparar de cara (mín. k). O chamador passa k: só os k mais
//             perto gastam banda de celular.
//   reserveMs se passou esse tempo sem juntar k, dispara UM a mais (o "k+1" de reserva).
//   hedgeMs   se ainda não juntou k, dispara TODO o resto (celular lento/travado).
// Além disso, quando um em voo FALHA (offline, hash errado) e o que sobra em voo + o que
// já chegou não completa k, o próximo da fila entra na hora, sem esperar timer.
//
// fetchOne(p) resolve com os bytes do shard, ou null/throw se falhou.
async function fetchShardsMultiSource(placements, k, fetchOne, opts = {}) {
  if (placements.length === 0) throw new Error('sem placements pra buscar o shard');

  const total = placements.length;
  const initial = Math.max(k, Math.min(opts.initial == null ? total : opts.initial, total));
  const reserveMs = opts.reserveMs || 0;
  const hedgeMs = opts.hedgeMs || 0;

  return new Promise((resolve, reject) => {
    const results = [];
    let launched = 0;
    let settled = 0;
    let done = false;
    const timers = [];

    const finish = (fn, value) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      fn(value);
    };

    const launch = () => {
      const p = placements[launched++];
      Promise.resolve()
        .then(() => fetchOne(p))
        .catch(() => null)
        .then((data) => {
          settled++;
          if (done) return;
          if (data) {
            results.push({ index: p.shardIndex, data });
            if (results.length >= k) return finish(resolve, results);
          }
          // o que está em voo + o que já chegou não completa k: puxa o próximo agora
          while (launched < total && results.length + (launched - settled) < k) launch();
          if (results.length < k && launched === total && settled === launched) {
            finish(reject, new Error(`só consegui ${results.length} de ${k} shards necessários (nós vivos insuficientes)`));
          }
        });
    };

    const later = (ms, fn) => {
      const t = setTimeout(() => { if (!done) fn(); }, ms);
      if (t.unref) t.unref();
      timers.push(t);
    };

    for (let i = 0; i < initial; i++) launch();

    if (initial < total) {
      if (reserveMs > 0) later(reserveMs, () => { if (launched < total) launch(); });
      if (hedgeMs > 0) later(hedgeMs, () => { while (!done && launched < total) launch(); });
    }
  });
}

module.exports = { fetchShardsMultiSource };
