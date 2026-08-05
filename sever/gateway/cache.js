// LRU bem simples baseado em Map (ordem de inserção == ordem de "recência").
// Guarda blocos JÁ DECODIFICADOS (plaintext), que é o que dá o efeito "CDN":
// bloco quente não precisa re-buscar shard nem rodar RS/AES de novo.

class LRUCache {
  constructor(maxEntries = 256) {
    this.max = maxEntries;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const val = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, val); // reinsere no fim = mais recente
    return val;
  }

  set(key, val) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, val);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  has(key) {
    return this.map.has(key);
  }

  size() {
    return this.map.size;
  }

  clear() {
    this.map.clear();
  }
}

module.exports = { LRUCache };
