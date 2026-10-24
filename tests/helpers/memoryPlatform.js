// Platform tiruan di memori untuk unit test di Node.js, antarmuka sama dengan GasPlatform.gs.
const crypto = require('node:crypto');
const Schema = require('../../src/server/Schema.gs');

function createMemoryPlatform(opts = {}) {
  const sheets = {};
  const cache = new Map();
  let clock = opts.now ? new Date(opts.now) : new Date('2026-10-24T01:00:00.000Z');

  for (const name of Schema.names()) {
    const t = Schema.get(name);
    sheets[t.db + ':' + name] = { header: t.columns.map((c) => c.name), rows: [] };
  }

  function key(db, name) {
    const k = db + ':' + name;
    if (!sheets[k]) throw new Error('Sheet tidak ada: ' + k);
    return k;
  }

  const store = {
    readAll(db, name) {
      const s = sheets[key(db, name)];
      return { header: s.header.slice(), rows: s.rows.map((r) => r.slice()) };
    },
    append(db, name, rows) {
      sheets[key(db, name)].rows.push(...rows.map((r) => r.slice()));
    },
    appendRow(db, name, values) {
      sheets[key(db, name)].rows.push(values.slice());
    },
    writeRow(db, name, dataIndex, values) {
      sheets[key(db, name)].rows[dataIndex] = values.slice();
    }
  };

  // Meniru CacheService: nilai kedaluwarsa setelah ttl detik (default 600).
  function live(k) {
    const e = cache.get(k);
    if (!e) return null;
    if (e.exp <= clock.getTime()) { cache.delete(k); return null; }
    return e.v;
  }
  const put = (k, v, ttl) => cache.set(k, { v: String(v), exp: clock.getTime() + (ttl || 600) * 1000 });

  const cacheApi = {
    get: (k) => live(k),
    put,
    remove: (k) => { cache.delete(k); },
    getAll: (keys) => {
      const out = {};
      keys.forEach((k) => { const v = live(k); if (v !== null) out[k] = v; });
      return out;
    },
    putAll: (obj, ttl) => { Object.keys(obj).forEach((k) => put(k, obj[k], ttl)); }
  };

  return {
    store: () => store,
    cache: () => cacheApi,
    withLock: (fn) => fn(),
    uuid: () => crypto.randomUUID(),
    now: () => new Date(clock),
    hmacSha256Hex: (k, m) => crypto.createHmac('sha256', k).update(m).digest('hex'),
    randomToken: () => crypto.randomBytes(32).toString('hex'),
    prop: () => null,
    setProp: () => {},
    // khusus test
    _sheets: sheets,
    _cache: cache,
    _advance(seconds) { clock = new Date(clock.getTime() + seconds * 1000); }
  };
}

module.exports = { createMemoryPlatform };
