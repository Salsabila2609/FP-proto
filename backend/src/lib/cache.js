// LRU + TTL sederhana, cukup untuk cache hasil agregasi per proses.
// Kalau nanti scale ke banyak instance, ganti isi kelas ini dengan Redis --
// permukaan API-nya sengaja dibuat minimal supaya gampang ditukar.
export class Cache {
  constructor({ max = 500, ttlMs = 5 * 60 * 1000 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expires) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  }

  async wrap(key, fn, ttlMs) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    return this.set(key, await fn(), ttlMs);
  }

  clear(prefix) {
    if (!prefix) return this.map.clear();
    for (const k of this.map.keys()) if (k.startsWith(prefix)) this.map.delete(k);
  }
}

export const queryCache = new Cache({ max: 800, ttlMs: 10 * 60 * 1000 });
export const llmCache = new Cache({ max: 300, ttlMs: 24 * 60 * 60 * 1000 });
