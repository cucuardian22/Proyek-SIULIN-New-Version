/**
 * Konstanta aplikasi. ID spreadsheet tidak ditulis di sini, tetapi disimpan
 * di Script Properties (MASTER_ID, ATTEMPT_ID) oleh Setup.gs, supaya satu kode
 * yang sama bisa di-deploy ke banyak klaster.
 */
var Config = {
  APP_NAME: 'SIULIN',

  // Kode sekolah khusus untuk login SUPER_ADMIN (tidak terikat sekolah).
  SUPER_ADMIN_SCHOOL_CODE: 'PUSAT',

  ROLES: ['SUPER_ADMIN', 'ADMIN', 'GURU', 'PENGAWAS', 'SISWA'],

  SESSION_TTL_SECONDS: 6 * 60 * 60,

  LOGIN_MAX_FAILS: 5,
  LOGIN_LOCK_SECONDS: 15 * 60,

  // Jumlah putaran HMAC untuk hash password. Ukur di GAS: target < 300 ms.
  HASH_ITERATIONS: 500,
  HASH_ALGO_PREFIX: 'hmac-sha256-iter',

  // Cache baca untuk sheet yang jarang berubah.
  TABLE_CACHE_SECONDS: 10 * 60,
  CACHE_CHUNK_CHARS: 90000,

  LOCK_WAIT_MS: 20000
};

if (typeof module !== 'undefined') module.exports = Config;
