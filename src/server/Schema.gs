/**
 * Definisi semua sheet. Satu sumber kebenaran untuk Setup (membuat header),
 * BaseRepo (memetakan baris ke objek), dan nanti migrasi PostgreSQL.
 *
 * Tipe kolom: string | number | bool | json. Semua sel disimpan sebagai teks
 * (format '@') lalu dikonversi oleh BaseRepo sesuai tipe ini.
 *
 * scope:
 *   'school'  -> baris difilter dengan school_id sesi (kecuali SUPER_ADMIN/sistem)
 *   'global'  -> tidak terikat sekolah
 */
var Schema = (function () {
  // Spreadsheet (db): MASTER (data induk + sesi), ATTEMPT (Attempts), JAWABAN (auto-save + jawaban akhir),
  // HASIL (Results). Dipisah karena Sheets memproses penulisan ke satu spreadsheet secara berurutan:
  // login, mulai, auto-save, dan submit yang serentak tidak antre di spreadsheet yang sama.
  var STD = [['created_at', 'string'], ['updated_at', 'string'], ['deleted_at', 'string']];

  function table(db, id, scope, cols, opts) {
    opts = opts || {};
    var columns = cols.concat(STD).map(function (c) { return { name: c[0], type: c[1] }; });
    return {
      db: db,
      id: id,
      scope: scope,
      columns: columns,
      cache: !!opts.cache,
      // Baris dengan kondisi ini terbaca oleh semua sekolah (mis. soal GLOBAL).
      sharedRead: opts.sharedRead || null
    };
  }

  var TABLES = {
    Schools: table('MASTER', 'school_id', 'school', [
      ['school_id', 'string'], ['nama_sekolah', 'string'], ['nama_unik', 'string'],
      ['jenjang', 'string'], ['alamat', 'string'], ['status', 'string']
    ], { cache: true }),

    Users: table('MASTER', 'user_id', 'school', [
      ['user_id', 'string'], ['school_id', 'string'], ['role', 'string'],
      ['username', 'string'], ['password_hash', 'string'], ['salt', 'string'],
      ['hash_algo', 'string'], ['nama', 'string'], ['kelas', 'string'],
      ['mapel_diampu', 'json'], ['status', 'string']
    ], { cache: true }),

    Topics: table('MASTER', 'topic_id', 'global', [
      ['topic_id', 'string'], ['nama_topik', 'string'], ['inisial', 'string'],
      ['tahun_ajaran', 'string'], ['status', 'string']
    ], { cache: true }),

    Exams: table('MASTER', 'exam_id', 'school', [
      ['exam_id', 'string'], ['school_id', 'string'], ['topic_id', 'string'],
      ['kode_mapel', 'string'], ['nama_mapel', 'string'], ['kelas', 'string'],
      ['nama_ujian', 'string']
    ], { cache: true, sharedRead: function (row) { return row.school_id === ''; } }), // ujian pusat (bank soal global)

    Questions: table('MASTER', 'question_id', 'school', [
      ['question_id', 'string'], ['exam_id', 'string'], ['scope', 'string'],
      ['school_id', 'string'], ['tipe', 'string'], ['teks', 'string'],
      ['media_url', 'string'], ['opsi', 'json'], ['kunci', 'json'],
      ['bobot', 'number'], ['created_by', 'string'], ['status_review', 'string']
    ], { cache: true, sharedRead: function (row) { return row.scope === 'GLOBAL'; } }),

    Tests: table('MASTER', 'test_id', 'school', [
      ['test_id', 'string'], ['school_id', 'string'], ['exam_id', 'string'],
      ['judul', 'string'], ['mulai', 'string'], ['selesai', 'string'],
      ['durasi_menit', 'number'], ['acak_soal', 'bool'], ['acak_opsi', 'bool'],
      ['kkm', 'number'], ['kelas_peserta', 'json']
    ], { cache: true }),

    Tokens: table('MASTER', 'token_id', 'school', [
      ['token_id', 'string'], ['test_id', 'string'], ['school_id', 'string'],
      ['kode', 'string'], ['berlaku_dari', 'string'], ['berlaku_sampai', 'string'],
      ['dibuat_oleh', 'string'], ['status', 'string']
    ], { cache: true }),

    Sessions: table('MASTER', 'session_id', 'global', [
      ['session_id', 'string'], ['user_id', 'string'], ['school_id', 'string'],
      ['role', 'string'], ['expires_at', 'string']
    ]),

    Attempts: table('ATTEMPT', 'attempt_id', 'school', [
      ['attempt_id', 'string'], ['test_id', 'string'], ['school_id', 'string'],
      ['user_id', 'string'], ['mulai', 'string'], ['batas_waktu', 'string'],
      ['selesai', 'string'], ['status', 'string'], ['urutan_soal', 'json'],
      ['ip_ua', 'string'], ['jumlah_pindah_tab', 'number']
    ]),

    AnswerBatches: table('JAWABAN', 'batch_id', 'school', [
      ['batch_id', 'string'], ['attempt_id', 'string'], ['school_id', 'string'],
      ['seq', 'number'], ['jawaban_json', 'json'], ['jumlah_pindah_tab', 'number'],
      ['client_ts', 'string'], ['server_ts', 'string']
    ]),

    // Jawaban akhir satu baris per attempt (satu appendRow saat submit, tanpa kunci).
    // jawaban = { question_id: jawaban }, skor = { question_id: skor }.
    // PostgreSQL: dipecah jadi tabel answers (attempt_id, question_id) saat migrasi.
    Answers: table('JAWABAN', 'attempt_id', 'school', [
      ['attempt_id', 'string'], ['test_id', 'string'], ['school_id', 'string'],
      ['jawaban', 'json'], ['skor', 'json']
    ]),

    // Baris Results = attempt sudah ditutup. status/selesai/jumlah_pindah_tab di sini yang berlaku;
    // kolom yang sama di Attempts disalin oleh trigger berkala. Bila ada dua baris (submit ganda
    // bersamaan), yang paling awal yang berlaku.
    Results: table('HASIL', 'attempt_id', 'school', [
      ['attempt_id', 'string'], ['test_id', 'string'], ['school_id', 'string'],
      ['user_id', 'string'], ['status', 'string'], ['selesai', 'string'],
      ['jumlah_pindah_tab', 'number'], ['skor_otomatis', 'number'], ['skor_uraian', 'number'],
      ['nilai_akhir', 'number'], ['status_koreksi', 'string']
    ])
  };

  function get(name) {
    var t = TABLES[name];
    if (!t) throw new Error('Tabel tidak dikenal: ' + name);
    return t;
  }

  function names() { return Object.keys(TABLES); }

  /** Daftar spreadsheet sesuai urutan kemunculan di TABLES. */
  function dbs() {
    var out = [];
    names().forEach(function (n) { if (out.indexOf(TABLES[n].db) < 0) out.push(TABLES[n].db); });
    return out;
  }

  return { get: get, names: names, dbs: dbs, TABLES: TABLES };
})();

if (typeof module !== 'undefined') module.exports = Schema;
