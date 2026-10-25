// Platform tiruan di memori untuk unit test di Node.js, antarmuka sama dengan GasPlatform.gs.
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const Schema = require('../../src/server/Schema.gs');
const Config = require('../../src/server/Config.gs');

/** Baca satu file dari ZIP lewat central directory (pengganti Utilities.unzip). */
function unzipEntry(base64, name) {
  const buf = Buffer.from(base64, 'base64');
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Could not unzip: invalid archive');
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const skip = nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (buf.toString('utf8', p + 46, p + 46 + nameLen) === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return (method === 8 ? zlib.inflateRawSync(data) : data).toString('utf8');
    }
    p += 46 + skip;
  }
  return null;
}

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
    // Sama dengan GasPlatform: penghitung di cache, dihitung ulang dari baris terakhir + SLOT_GAP bila hilang.
    reserveRows(group, list, count) {
      return global.Platform.withLock(() => reserve(group, list, count));
    },
    writeRow(db, name, dataIndex, values) {
      const s = sheets[key(db, name)];
      while (s.rows.length < dataIndex) s.rows.push(s.header.map(() => ''));
      s.rows[dataIndex] = values.slice();
    }
  };
  const reserved = [];
  function reserve(group, list, count) {
    const k = 'slot:' + group;
    let next = live(k) === null ? NaN : Number(live(k));
    if (!(next >= 0)) next = Math.max(0, ...list.map((t) => sheets[key(t.db, t.name)].rows.length)) + Config.SLOT_GAP;
    put(k, String(next + count), 21600);
    reserved.push({ group, first: next, count });
    return next;
  }

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
    unzipEntry,
    // khusus test
    _sheets: sheets,
    _cache: cache,
    _reserved: reserved,
    _advance(seconds) { clock = new Date(clock.getTime() + seconds * 1000); }
  };
}

module.exports = { createMemoryPlatform };
