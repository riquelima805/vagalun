
async function fetchShardsMultiSource(placements, k, fetchOne) {
  if (placements.length === 0) throw new Error('sem placements pra buscar o shard');

  return new Promise((resolve, reject) => {
    const results = [];
    let settledCount = 0;
    let done = false;

    for (const p of placements) {
      Promise.resolve()
        .then(() => fetchOne(p))
        .catch(() => null)
        .then((data) => {
          settledCount++;
          if (done) return;

          if (data) {
            results.push({ index: p.shardIndex, data });
            if (results.length >= k) {
              done = true;
              resolve(results);
              return;
            }
          }

          if (settledCount === placements.length && results.length < k) {
            done = true;
            reject(new Error(`só consegui ${results.length} de ${k} shards necessários (nós vivos insuficientes)`));
          }
        });
    }
  });
}

module.exports = { fetchShardsMultiSource };
