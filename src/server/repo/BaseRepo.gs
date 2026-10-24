/**
 * CRUD generik di atas Platform.store(). Metodenya sengaja sama dengan repo
 * PostgreSQL di Fase 2: findById, findMany, findOne, insert, insertMany,
 * update, updateMany, softDelete.
 *
 * Setiap metode wajib menerima ctx dari sesi server:
 *   { userId, schoolId, role }    -> pengguna yang login
 *   { system: true }              -> proses internal (login, setup)
 * Untuk tabel ber-scope 'school', school_id dari ctx selalu disuntikkan ke
 * filter dan ke baris baru. Nilai school_id dari client tidak pernah dipakai.
 */
var BaseRepo = (function () {
  function BaseRepo(tableName) {
    this.tableName = tableName;
    this.table = Schema.get(tableName);
    var types = {};
    this.table.columns.forEach(function (c) { types[c.name] = c.type; });
    this.types = types;
  }

  function assertCtx(ctx) {
    if (!ctx || (!ctx.system && !ctx.role)) {
      throw new Utils.AppError('NO_CONTEXT', 'Akses data tanpa konteks sesi ditolak.');
    }
  }

  function unrestricted(ctx) {
    return !!(ctx.system || ctx.role === 'SUPER_ADMIN');
  }

  // ---------- konversi sel <-> nilai ----------

  function encode(type, v) {
    if (v === null || v === undefined) return '';
    switch (type) {
      case 'json': return JSON.stringify(v);
      case 'bool': return v ? 'TRUE' : 'FALSE';
      case 'number': return String(v);
      default:
        v = String(v);
        // Cegah teks dibaca Sheets sebagai rumus (formula injection).
        return /^[=+@]/.test(v) ? "'" + v : v;
    }
  }

  function decode(type, v) {
    var blank = v === null || v === undefined || v === '';
    switch (type) {
      case 'json': return blank ? null : (typeof v === 'string' ? JSON.parse(v) : v);
      case 'bool': return v === true || v === 'TRUE' || v === 'true';
      case 'number': return blank ? null : Number(v);
      default: return blank ? '' : String(v);
    }
  }

  /** Baris sel sesuai urutan header sheet (default: urutan Schema, yang dipakai Setup). */
  BaseRepo.prototype._toRow = function (obj, header) {
    var types = this.types;
    var names = header || this.table.columns.map(function (c) { return c.name; });
    return names.map(function (name) { return encode(types[name] || 'string', obj[name]); });
  };

  BaseRepo.prototype._toObj = function (header, row) {
    var obj = {};
    var types = this.types;
    header.forEach(function (name, i) {
      if (types[name]) obj[name] = decode(types[name], row[i]);
    });
    return obj;
  };

  // ---------- baca (dengan cache untuk tabel yang jarang berubah) ----------

  BaseRepo.prototype._cacheKey = function () { return 'tbl:' + this.tableName; };

  BaseRepo.prototype._readCached = function () {
    var cache = Platform.cache();
    var meta = cache.get(this._cacheKey());
    if (!meta) return null;
    var n = Number(meta);
    var keys = [];
    for (var i = 0; i < n; i++) keys.push(this._cacheKey() + ':' + i);
    var parts = cache.getAll(keys);
    var text = '';
    for (var j = 0; j < n; j++) {
      if (parts[keys[j]] === undefined) return null;
      text += parts[keys[j]];
    }
    // Potongan dari dua versi berbeda (cache sedang ditulis ulang) tidak bisa di-parse: baca sheet saja.
    try { return JSON.parse(text); } catch (e) { return null; }
  };

  BaseRepo.prototype._writeCache = function (objs) {
    var text = JSON.stringify(objs);
    var size = Config.CACHE_CHUNK_CHARS;
    var chunks = {};
    var n = Math.ceil(text.length / size) || 1;
    for (var i = 0; i < n; i++) chunks[this._cacheKey() + ':' + i] = text.substr(i * size, size);
    try {
      var cache = Platform.cache();
      cache.putAll(chunks, Config.TABLE_CACHE_SECONDS);
      cache.put(this._cacheKey(), String(n), Config.TABLE_CACHE_SECONDS);
    } catch (e) {
      // Cache penuh/gagal bukan kesalahan fatal; data tetap dibaca dari sheet.
      Utils.log('warn', 'cache gagal ditulis', { table: this.tableName, error: String(e) });
    }
  };

  BaseRepo.prototype._invalidate = function () {
    if (this.table.cache) Platform.cache().remove(this._cacheKey());
  };

  /** Semua baris (termasuk yang dihapus lunak), tanpa filter sekolah. */
  BaseRepo.prototype._all = function (fresh) {
    if (this.table.cache && !fresh) {
      var cached = this._readCached();
      if (cached) return cached;
    }
    var data = Platform.store().readAll(this.table.db, this.tableName);
    var self = this;
    var objs = data.rows.map(function (r) { return self._toObj(data.header, r); });
    if (this.table.cache) this._writeCache(objs);
    return objs;
  };

  BaseRepo.prototype._visible = function (ctx, row) {
    if (row.deleted_at) return false;
    if (this.table.scope !== 'school' || unrestricted(ctx)) return true;
    if (row.school_id === ctx.schoolId) return true;
    return !!(this.table.sharedRead && this.table.sharedRead(row));
  };

  function matches(row, filter) {
    for (var k in filter) {
      if (Object.prototype.hasOwnProperty.call(filter, k) && row[k] !== filter[k]) return false;
    }
    return true;
  }

  BaseRepo.prototype.findMany = function (ctx, filter) {
    assertCtx(ctx);
    filter = filter || {};
    var self = this;
    return this._all().filter(function (r) { return self._visible(ctx, r) && matches(r, filter); });
  };

  BaseRepo.prototype.findOne = function (ctx, filter) {
    return this.findMany(ctx, filter)[0] || null;
  };

  BaseRepo.prototype.findById = function (ctx, id) {
    var f = {};
    f[this.table.id] = id;
    return this.findOne(ctx, f);
  };

  // ---------- tulis ----------

  BaseRepo.prototype._prepareNew = function (ctx, obj) {
    var now = Utils.nowIso();
    var row = {};
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) row[k] = obj[k];
    if (!row[this.table.id]) row[this.table.id] = Utils.uuid();
    if (this.table.scope === 'school' && !unrestricted(ctx)) row.school_id = ctx.schoolId;
    row.created_at = now;
    row.updated_at = now;
    row.deleted_at = '';
    return row;
  };

  BaseRepo.prototype.insertMany = function (ctx, objs) {
    assertCtx(ctx);
    var self = this;
    var rows = objs.map(function (o) { return self._prepareNew(ctx, o); });
    Platform.withLock(function () {
      Platform.store().append(self.table.db, self.tableName, rows.map(function (r) { return self._toRow(r); }));
      self._invalidate();
    });
    return rows;
  };

  /** Satu baris: appendRow tanpa kunci global, supaya penulisan serentak (auto-save, submit, login) tidak antre. */
  BaseRepo.prototype.insert = function (ctx, obj) {
    assertCtx(ctx);
    var row = this._prepareNew(ctx, obj);
    Platform.store().appendRow(this.table.db, this.tableName, this._toRow(row));
    this._invalidate();
    return row;
  };

  /** Terapkan patch ke baris pertama dengan id tsb. Dipanggil di dalam kunci. */
  BaseRepo.prototype._patchRow = function (ctx, data, id, patch) {
    var idCol = data.header.indexOf(this.table.id);
    var index = -1;
    for (var i = 0; i < data.rows.length; i++) {
      if (String(data.rows[i][idCol]) === String(id)) { index = i; break; }
    }
    if (index < 0) throw new Utils.AppError('NOT_FOUND', 'Data tidak ditemukan.');
    var current = this._toObj(data.header, data.rows[index]);
    // Baris bersama (soal GLOBAL) boleh dibaca semua sekolah, tetapi hanya pemiliknya yang boleh mengubah.
    var owned = this.table.scope !== 'school' || unrestricted(ctx) || current.school_id === ctx.schoolId;
    if (current.deleted_at || !owned) throw new Utils.AppError('NOT_FOUND', 'Data tidak ditemukan.');

    var next = {};
    for (var k in current) next[k] = current[k];
    for (var p in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, p)) continue;
      if (p === this.table.id || p === 'created_at') continue;
      if (p === 'school_id' && this.table.scope === 'school' && !unrestricted(ctx)) continue;
      next[p] = patch[p];
    }
    next.updated_at = Utils.nowIso();
    Platform.store().writeRow(this.table.db, this.tableName, index, this._toRow(next, data.header));
    return next;
  };

  BaseRepo.prototype.update = function (ctx, id, patch) {
    assertCtx(ctx);
    var self = this;
    return Platform.withLock(function () {
      var next = self._patchRow(ctx, Platform.store().readAll(self.table.db, self.tableName), id, patch);
      self._invalidate();
      return next;
    });
  };

  /**
   * Banyak patch sekaligus dengan satu kunci dan satu kali baca sheet (dipakai trigger berkala).
   * @param {Object<string, Object>} patches  { id: patch }
   * @return {number} jumlah baris yang diubah
   */
  BaseRepo.prototype.updateMany = function (ctx, patches) {
    assertCtx(ctx);
    var ids = Object.keys(patches);
    if (!ids.length) return 0;
    var self = this;
    return Platform.withLock(function () {
      var data = Platform.store().readAll(self.table.db, self.tableName);
      ids.forEach(function (id) { self._patchRow(ctx, data, id, patches[id]); });
      self._invalidate();
      return ids.length;
    });
  };

  BaseRepo.prototype.softDelete = function (ctx, id) {
    return this.update(ctx, id, { deleted_at: Utils.nowIso() });
  };

  BaseRepo.encode = encode;
  BaseRepo.decode = decode;
  return BaseRepo;
})();

if (typeof module !== 'undefined') module.exports = BaseRepo;
