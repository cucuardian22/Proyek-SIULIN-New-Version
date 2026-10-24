/**
 * Utilitas murni (tanpa layanan Google), bisa dipakai apa adanya di Node.js.
 * Fungsi yang butuh platform (UUID, waktu, kripto) diambil dari Platform.
 */
var Utils = (function () {
  function AppError(code, message, details) {
    this.name = 'AppError';
    this.code = code;
    this.message = message || code;
    this.details = details || null;
  }
  AppError.prototype = Object.create(Error.prototype);
  AppError.prototype.constructor = AppError;

  function fail(code, message, details) { throw new AppError(code, message, details); }

  function uuid() { return Platform.uuid(); }

  /** Waktu sekarang sebagai ISO 8601 UTC, mis. 2026-10-24T01:45:00.000Z */
  function nowIso() { return Platform.now().toISOString(); }

  function addSeconds(iso, seconds) {
    return new Date(Date.parse(iso) + seconds * 1000).toISOString();
  }

  function isBlank(v) { return v === null || v === undefined || String(v).trim() === ''; }

  function round2(n) { return Math.round(n * 100) / 100; }

  function pick(obj, keys) {
    var out = {};
    keys.forEach(function (k) { if (obj && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
  }

  function log(level, message, data) {
    var line = JSON.stringify({ level: level, message: message, data: data || null, ts: nowIso() });
    if (typeof console !== 'undefined') console.log(line);
  }

  return {
    AppError: AppError,
    fail: fail,
    uuid: uuid,
    nowIso: nowIso,
    addSeconds: addSeconds,
    isBlank: isBlank,
    round2: round2,
    pick: pick,
    log: log
  };
})();

if (typeof module !== 'undefined') module.exports = Utils;
