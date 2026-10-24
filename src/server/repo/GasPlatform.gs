/**
 * Adapter platform Google Apps Script. Hanya file di repo/ yang boleh
 * memanggil SpreadsheetApp, CacheService, LockService, dan PropertiesService.
 * Di Fase 2 file ini diganti adapter PostgreSQL/Redis dengan antarmuka sama:
 *
 *   store():  readAll(db, sheet) -> { header: [], rows: [[]] }
 *             append(db, sheet, rows)          (dipanggil di dalam withLock)
 *             appendRow(db, sheet, values)     (tanpa kunci; aman untuk penulisan serentak)
 *             writeRow(db, sheet, dataIndex, values)
 *   cache():  get, put, remove, getAll, putAll
 *   withLock(fn), uuid(), now(), hmacSha256Hex(key, msg), randomToken(), prop(key)
 */
var Platform = (function () {
  var spreadsheets = {};

  function prop(key) {
    return PropertiesService.getScriptProperties().getProperty(key);
  }

  function setProp(key, value) {
    PropertiesService.getScriptProperties().setProperty(key, value);
  }

  // Galat sementara layanan Google (mis. "Service Spreadsheets timed out", "too many simultaneous
  // invocations") muncul saat banyak eksekusi menyentuh spreadsheet yang sama. Diulang dua kali
  // dengan jeda singkat. Penulisan ganda akibat pengulangan aman: pembaca memakai baris paling awal per id.
  var TRANSIENT = /timed out|too many|simultaneous|unexpected error|service error|server error|try again|internal error|busy|failed while accessing/i;

  function retrying(fn) {
    for (var i = 0; ; i++) {
      try {
        return fn();
      } catch (e) {
        if (i >= 2 || !TRANSIENT.test(String(e && e.message || e))) throw e;
        Utilities.sleep(300 * (i + 1) + Math.floor(Math.random() * 400));
      }
    }
  }

  function spreadsheet(db) {
    if (spreadsheets[db]) return spreadsheets[db];
    var id = prop(db + '_ID');
    if (!id) throw new Error('Spreadsheet ' + db + ' belum dibuat. Jalankan setupSiulin() dulu.');
    spreadsheets[db] = retrying(function () { return SpreadsheetApp.openById(id); });
    return spreadsheets[db];
  }

  function sheet(db, name) {
    var sh = spreadsheet(db).getSheetByName(name);
    if (!sh) throw new Error('Sheet ' + name + ' tidak ada di ' + db + '. Jalankan setupSiulin().');
    return sh;
  }

  /** Tambah blok baris cadangan berformat teks. Hanya satu eksekusi yang mengerjakannya. */
  function provisionRows(sh) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(Config.LOCK_WAIT_MS)) return; // eksekusi lain sedang menambah baris
    try {
      if (sh.getMaxRows() - sh.getLastRow() >= Config.SPARE_ROWS_MIN) return;
      var extra = Config.SPARE_ROWS_BLOCK;
      sh.insertRowsAfter(sh.getMaxRows(), extra);
      sh.getRange(sh.getMaxRows() - extra + 1, 1, extra, sh.getMaxColumns()).setNumberFormat('@');
    } finally {
      lock.releaseLock();
    }
  }

  var store = {
    readAll: function (db, name) {
      var values = retrying(function () { return sheet(db, name).getDataRange().getValues(); });
      return { header: values[0] || [], rows: values.slice(1) };
    },
    append: function (db, name, rows) {
      if (!rows.length) return;
      var sh = sheet(db, name);
      var start = sh.getLastRow() + 1;
      var needed = start + rows.length - 1 - sh.getMaxRows();
      if (needed > 0) {
        // Tambah baris dalam blok besar agar jarang terjadi, dan pastikan formatnya teks.
        var extra = needed + 1000;
        sh.insertRowsAfter(sh.getMaxRows(), extra);
        sh.getRange(sh.getMaxRows() - extra + 1, 1, extra, sh.getMaxColumns()).setNumberFormat('@');
      }
      sh.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
    },
    appendRow: function (db, name, values) {
      // Sheet.appendRow atomik: banyak eksekusi bisa menambah baris bersamaan tanpa saling menimpa,
      // jadi auto-save, submit, login, dan mulai tes tidak perlu antre di kunci global.
      // Baris cadangan berformat teks disiapkan lebih dulu supaya nilai tidak diubah Sheets jadi tanggal/angka.
      retrying(function () {
        var sh = sheet(db, name);
        if (sh.getMaxRows() - sh.getLastRow() < Config.SPARE_ROWS_MIN) provisionRows(sh);
        sh.appendRow(values);
      });
    },
    writeRow: function (db, name, dataIndex, values) {
      // dataIndex 0 = baris ke-2 (baris 1 adalah header).
      sheet(db, name).getRange(dataIndex + 2, 1, 1, values.length).setValues([values]);
    }
  };

  var cacheApi = {
    // Baca cache tidak boleh menggagalkan permintaan: bila CacheService galat, anggap kosong
    // dan pemanggil membaca sheet. Tulis tetap melempar galat supaya pemanggil tahu.
    get: function (k) { try { return CacheService.getScriptCache().get(k); } catch (e) { return null; } },
    put: function (k, v, ttl) { CacheService.getScriptCache().put(k, v, ttl); },
    remove: function (k) { CacheService.getScriptCache().remove(k); },
    getAll: function (keys) { try { return CacheService.getScriptCache().getAll(keys); } catch (e) { return {}; } },
    putAll: function (obj, ttl) { CacheService.getScriptCache().putAll(obj, ttl); }
  };

  function withLock(fn) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(Config.LOCK_WAIT_MS)) {
      throw new Utils.AppError('BUSY', 'Server sedang sibuk, coba lagi sebentar.');
    }
    try {
      return fn();
    } finally {
      lock.releaseLock();
    }
  }

  function toHex(bytes) {
    return bytes.map(function (b) {
      var v = (b < 0 ? b + 256 : b).toString(16);
      return v.length === 1 ? '0' + v : v;
    }).join('');
  }

  function hmacSha256Hex(key, message) {
    return toHex(Utilities.computeHmacSha256Signature(message, key));
  }

  function randomToken() {
    return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  }

  return {
    store: function () { return store; },
    cache: function () { return cacheApi; },
    withLock: withLock,
    uuid: function () { return Utilities.getUuid(); },
    now: function () { return new Date(); },
    hmacSha256Hex: hmacSha256Hex,
    randomToken: randomToken,
    prop: prop,
    setProp: setProp
  };
})();
