/**
 * Konstanta aplikasi. ID spreadsheet tidak ditulis di sini, tetapi disimpan
 * di Script Properties (MASTER_ID, ATTEMPT_ID, JAWABAN_ID, HASIL_ID) oleh Setup.gs, supaya satu kode
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

  LOCK_WAIT_MS: 20000,

  // Tabel ber-slot (Sessions, Attempts, dan tabel per attempt): nomor baris dipesan di bawah kunci singkat,
  // lalu ditulis tanpa kunci. Baris kosong berformat teks disiapkan per blok supaya pemesanan tetap cepat.
  SPARE_ROWS_MIN: 300,
  SPARE_ROWS_BLOCK: 2000,
  // Bila penghitung slot hilang dari cache, nomor berikutnya dihitung ulang dari baris terakhir + jarak ini,
  // supaya slot yang sudah dipesan tetapi belum ditulis (paling banyak 30 eksekusi serentak) tidak terpakai dua kali.
  SLOT_GAP: 50,

  // Auto-save selalu masuk cache; ke sheet AnswerBatches paling sering sekali per selang ini.
  SAVE_SHEET_SECONDS: 180
};

if (typeof module !== 'undefined') module.exports = Config;
