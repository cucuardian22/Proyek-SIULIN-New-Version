/**
 * Bank soal per ujian: daftar, tambah, ubah, hapus, import dari template.
 *
 * Soal di ujian sekolah ber-scope SCHOOL; soal di ujian pusat ber-scope GLOBAL.
 * Scope dan school_id selalu ditentukan dari ujiannya, bukan dari client.
 *
 * Template import (satu baris per soal, baris pertama judul kolom):
 *   tipe | teks | bobot | a | b | c | d | e | kunci | media_url
 *   PG    a-e = opsi,        kunci = B
 *   PGK   a-e = opsi,        kunci = A,C
 *   PGBS  a-e = pernyataan,  kunci = B,S,B   (urut sesuai pernyataan; B = Benar, S = Salah)
 *   PGST  a-e = pernyataan,  kunci = S,TS,S  (S = Setuju, TS = Tidak Setuju)
 *   ISIAN kunci = jawaban yang diterima, pisahkan dengan |
 *   URAIAN kunci boleh kosong (pedoman penskoran bisa ditulis di kunci)
 */
var QuestionService = (function () {
  var OPTION_COLUMNS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  var IMPORT_MAX_ROWS = 100;
  var TEXT_MAX = 20000;

  function splitList(v, sep) {
    if (Array.isArray(v)) return v.map(function (x) { return String(x).trim(); }).filter(String);
    return String(v === null || v === undefined ? '' : v).split(sep).map(function (x) { return x.trim(); }).filter(String);
  }

  /**
   * Bentuk soal yang disimpan dari input form (opsi dan kunci sudah terstruktur).
   * opsi: [{id, teks}] ; kunci sesuai tipe (lihat ScoringService).
   */
  function normalize(input) {
    var tipe = String(input.tipe || '').trim().toUpperCase();
    var q = {
      tipe: tipe,
      teks: String(input.teks || '').trim(),
      media_url: String(input.media_url || '').trim(),
      bobot: input.bobot === '' || input.bobot === undefined || input.bobot === null ? 1 : Number(input.bobot),
      opsi: [],
      kunci: null
    };
    var opsi = Array.isArray(input.opsi) ? input.opsi : [];
    var statements = tipe === 'PGBS' || tipe === 'PGST';
    q.opsi = opsi.map(function (o, i) {
      var id = String(o && o.id !== undefined && o.id !== '' ? o.id : (statements ? i + 1 : OPTION_COLUMNS[i] || i + 1)).trim();
      return { id: statements ? id : id.toUpperCase(), teks: String(o && o.teks || '').trim() };
    }).filter(function (o) { return o.teks; });

    if (tipe === 'PG') q.kunci = String(input.kunci || '').trim().toUpperCase();
    else if (tipe === 'PGK') q.kunci = splitList(input.kunci, /[,;\s]+/).map(function (k) { return k.toUpperCase(); });
    else if (statements) {
      var map = {};
      var src = input.kunci && typeof input.kunci === 'object' ? input.kunci : {};
      for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) map[String(k).trim()] = String(src[k]).trim().toUpperCase();
      q.kunci = map;
    } else if (tipe === 'ISIAN') q.kunci = splitList(input.kunci, '|');
    else if (tipe === 'URAIAN') q.kunci = String(input.kunci || '').trim();
    return q;
  }

  function validate(q) {
    var errors = ScoringService.validateQuestion(q);
    if (q.teks.length > TEXT_MAX) errors.push('Teks soal maksimal ' + TEXT_MAX + ' karakter.');
    if (q.media_url && !/^https:\/\//.test(q.media_url)) errors.push('media_url harus diawali https://');
    if (q.tipe === 'PGK' && q.kunci && q.opsi.length && q.kunci.length >= q.opsi.length) {
      errors.push('Kunci PGK harus lebih sedikit dari jumlah opsi.');
    }
    return errors;
  }

  /** Baris template import -> input form. */
  function fromTemplateRow(row) {
    var tipe = String(row.tipe || '').trim().toUpperCase();
    var opsi = [];
    OPTION_COLUMNS.forEach(function (col, i) {
      var teks = String(row[col] || '').trim();
      if (teks) opsi.push({ id: tipe === 'PGBS' || tipe === 'PGST' ? String(i + 1) : col.toUpperCase(), teks: teks });
    });
    var kunci = row.kunci;
    if (tipe === 'PGBS' || tipe === 'PGST') {
      var values = splitList(row.kunci, /[,;\s]+/);
      kunci = {};
      opsi.forEach(function (o, i) { kunci[o.id] = values[i] || ''; });
      if (values.length !== opsi.length) kunci._jumlah = values.length; // ditandai untuk pesan kesalahan
    }
    return { tipe: tipe, teks: row.teks, bobot: row.bobot, media_url: row.media_url, opsi: opsi, kunci: kunci };
  }

  function stored(ctx, exam, q) {
    return {
      exam_id: exam.exam_id,
      scope: exam.school_id === '' ? 'GLOBAL' : 'SCHOOL',
      school_id: exam.school_id,
      tipe: q.tipe,
      teks: q.teks,
      media_url: q.media_url,
      opsi: q.opsi,
      kunci: q.kunci,
      bobot: q.bobot,
      created_by: ctx.userId,
      status_review: 'BARU'
    };
  }

  // ---------- rute ----------

  /** Soal satu ujian, lengkap dengan kunci (hanya untuk peran pengelola soal). */
  function list(ctx, payload) {
    var exam = Repos.exams().findById(ctx, payload.exam_ref);
    if (!exam) Utils.fail('NOT_FOUND', 'Ujian tidak ditemukan.');
    ExamService.assertTeaches(ctx, exam.kode_mapel);
    return {
      exam: exam,
      editable: exam.school_id === ExamService.ownerSchool(ctx),
      questions: Repos.questions().findMany(ctx, { exam_id: exam.exam_id }).sort(function (a, b) {
        return a.created_at.localeCompare(b.created_at);
      })
    };
  }

  function create(ctx, payload) {
    var exam = ExamService.getEditable(ctx, payload.exam_ref);
    var q = normalize(payload);
    var errors = validate(q);
    if (errors.length) Utils.fail('INVALID_INPUT', errors.join(' '));
    return Repos.questions().insert(ctx, stored(ctx, exam, q));
  }

  function update(ctx, payload) {
    var current = Repos.questions().findById(ctx, payload.question_ref);
    if (!current) Utils.fail('NOT_FOUND', 'Soal tidak ditemukan.');
    var exam = ExamService.getEditable(ctx, current.exam_id);
    var q = normalize(payload);
    var errors = validate(q);
    if (errors.length) Utils.fail('INVALID_INPUT', errors.join(' '));
    var data = stored(ctx, exam, q);
    delete data.created_by;
    return Repos.questions().update(ctx, current.question_id, data);
  }

  function remove(ctx, payload) {
    var current = Repos.questions().findById(ctx, payload.question_ref);
    if (!current) Utils.fail('NOT_FOUND', 'Soal tidak ditemukan.');
    ExamService.getEditable(ctx, current.exam_id);
    Repos.questions().softDelete(ctx, current.question_id);
    return true;
  }

  /**
   * @param {{exam_ref, rows: Array<Object>, dry_run?: boolean}} payload  rows = baris template (_row = nomor baris file)
   * @return {{inserted:number, errors:Array<{row, messages}>}}
   */
  function importRows(ctx, payload) {
    var exam = ExamService.getEditable(ctx, payload.exam_ref);
    var rows = Array.isArray(payload.rows) ? payload.rows : [];
    if (!rows.length) Utils.fail('INVALID_INPUT', 'Tidak ada baris untuk diimport.');
    if (rows.length > IMPORT_MAX_ROWS) Utils.fail('INVALID_INPUT', 'Maksimal ' + IMPORT_MAX_ROWS + ' baris per kiriman.');

    var errors = [];
    var ready = [];
    rows.forEach(function (row, i) {
      var input = fromTemplateRow(row || {});
      var extra = [];
      if (input.kunci && input.kunci._jumlah !== undefined) {
        extra.push('Jumlah kunci (' + input.kunci._jumlah + ') tidak sama dengan jumlah pernyataan (' + input.opsi.length + ').');
        delete input.kunci._jumlah;
      }
      var q = normalize(input);
      var messages = extra.concat(validate(q));
      if (messages.length) errors.push({ row: Number(row && row._row) || i + 1, messages: messages });
      else ready.push(stored(ctx, exam, q));
    });
    if (errors.length || payload.dry_run) return { inserted: 0, errors: errors };
    Repos.questions().insertMany(ctx, ready);
    return { inserted: ready.length, errors: [] };
  }

  return {
    IMPORT_MAX_ROWS: IMPORT_MAX_ROWS,
    list: list, create: create, update: update, remove: remove, importRows: importRows,
    normalize: normalize, fromTemplateRow: fromTemplateRow
  };
})();

if (typeof module !== 'undefined') module.exports = QuestionService;
