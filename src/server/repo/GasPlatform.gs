/**
 * Adapter platform Google Apps Script. Hanya file di repo/ yang boleh
 * memanggil SpreadsheetApp, CacheService, LockService, dan PropertiesService.
 * Di Fase 2 file ini diganti adapter PostgreSQL/Redis dengan antarmuka sama:
 *
 *   store():  readAll(db, sheet) -> { header: [], rows: [[]] }
 *             append(db, sheet, rows)          (dipanggil di dalam withLock)
 *             reserveRows(group, sheets, n)    -> dataIndex pertama dari n baris yang dipesan (kunci singkat)
 *             writeRow(db, sheet, dataIndex, values)  (tanpa kunci untuk baris yang sudah dipesan)
 *   cache():  get, put, remove, getAll, putAll
 *   withLock(fn), uuid(), now(), hmacSha256Hex(key, msg), randomToken(), prop(key)
 *   unzipEntry(base64, name) -> isi teks satu file di dalam ZIP (mis. word/document.xml di .docx), null jika tidak ada
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

  /** Pastikan setiap sheet punya baris sampai dataIndex rows-1, berformat teks. Mengembalikan kapasitas terkecil. */
  function ensureRows(sheets, rows) {
    var cap = Infinity;
    sheets.forEach(function (t) {
      var sh = sheet(t.db, t.name);
      var max = sh.getMaxRows();
      if (max < rows + 1) {
        var extra = rows + 1 - max;
        sh.insertRowsAfter(max, extra);
        sh.getRange(max + 1, 1, extra, sh.getMaxColumns()).setNumberFormat('@');
        max += extra;
      }
      cap = Math.min(cap, max - 1);
    });
    return cap;
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
    reserveRows: function (group, sheets, count) {
      // Hanya penghitung yang dikerjakan di dalam kunci (dua akses cache), kecuali saat penghitung
      // hilang dari cache atau baris cadangan perlu ditambah (sekali tiap Config.SPARE_ROWS_BLOCK baris).
      var nextKey = 'slot:' + group;
      var capKey = 'slotcap:' + group;
      return withLock(function () {
        var c = cacheApi.getAll([nextKey, capKey]);
        var next = c[nextKey] === undefined || c[nextKey] === null ? NaN : Number(c[nextKey]);
        if (!(next >= 0)) {
          next = 0;
          sheets.forEach(function (t) { next = Math.max(next, sheet(t.db, t.name).getLastRow() - 1); });
          next += Config.SLOT_GAP;
        }
        var cap = c[capKey] === undefined || c[capKey] === null ? NaN : Number(c[capKey]);
        if (!(cap > 0) || next + count + Config.SPARE_ROWS_MIN > cap) {
          cap = ensureRows(sheets, next + count + Config.SPARE_ROWS_BLOCK);
        }
        var o = {};
        o[nextKey] = String(next + count);
        o[capKey] = String(cap);
        try { cacheApi.putAll(o, 21600); } catch (e) { /* penghitung dihitung ulang dengan jarak aman */ }
        return next;
      });
    },
    writeRow: function (db, name, dataIndex, values) {
      // dataIndex 0 = baris ke-2 (baris 1 adalah header).
      retrying(function () { sheet(db, name).getRange(dataIndex + 2, 1, 1, values.length).setValues([values]); });
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

  function unzipEntry(base64, name) {
    var files = Utilities.unzip(Utilities.newBlob(Utilities.base64Decode(base64), 'application/zip', 'file.zip'));
    for (var i = 0; i < files.length; i++) {
      if (files[i].getName() === name) return files[i].getDataAsString('UTF-8');
    }
    return null;
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
    setProp: setProp,
    unzipEntry: unzipEntry
  };
})();
