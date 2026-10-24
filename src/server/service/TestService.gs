/**
 * Jadwal tes: satu ujian (bank soal) yang dikerjakan kelas tertentu dalam rentang waktu.
 * Waktu disimpan ISO 8601 UTC; client mengubah dari/ke waktu lokal (WIB/WITA/WIT).
 *
 * Status (dihitung, tidak disimpan): BELUM sebelum mulai, BERLANGSUNG di antara mulai
 * dan selesai, SELESAI setelahnya. Tes yang sudah mulai tidak bisa diubah atau dihapus,
 * dan soal ujiannya terkunci (lihat assertExamUnlocked).
 */
var TestService = (function () {
  var KELAS_PATTERN = /^[A-Za-z0-9 ._-]{1,20}$/;

  function nowMs() { return Platform.now().getTime(); }

  function statusOf(test) {
    var now = nowMs();
    if (now < Date.parse(test.mulai)) return 'BELUM';
    if (now < Date.parse(test.selesai)) return 'BERLANGSUNG';
    return 'SELESAI';
  }

  function parseTime(v, label) {
    var ms = Date.parse(String(v || ''));
    if (isNaN(ms)) Utils.fail('INVALID_INPUT', label + ' tidak valid.');
    return new Date(ms).toISOString();
  }

  function parseKelas(v) {
    var list = Array.isArray(v) ? v : String(v || '').split(/[,;]/);
    var seen = {};
    return list.map(function (k) { return String(k).trim().toUpperCase(); }).filter(function (k) {
      if (!k || seen[k]) return false;
      seen[k] = true;
      return true;
    });
  }

  /** Tes milik sekolah ctx (GURU: hanya mapel yang diampu). */
  function getOwn(ctx, testId) {
    var test = Repos.tests().findById(ctx, testId);
    if (!test) Utils.fail('NOT_FOUND', 'Tes tidak ditemukan.');
    var exam = Repos.exams().findById(ctx, test.exam_id);
    if (!exam) Utils.fail('NOT_FOUND', 'Ujian untuk tes ini tidak ditemukan.');
    ExamService.assertTeaches(ctx, exam.kode_mapel);
    return { test: test, exam: exam };
  }

  function build(ctx, input) {
    var exam = Repos.exams().findById(ctx, input.exam_id);
    if (!exam) Utils.fail('INVALID_INPUT', 'Pilih ujian (bank soal) untuk tes ini.');
    ExamService.assertTeaches(ctx, exam.kode_mapel);
    if (!Repos.questions().findMany(ctx, { exam_id: exam.exam_id }).length) {
      Utils.fail('INVALID_INPUT', 'Ujian ' + exam.nama_ujian + ' belum punya soal.');
    }

    var judul = String(input.judul || '').trim() || exam.nama_mapel + ' kelas ' + exam.kelas;
    var mulai = parseTime(input.mulai, 'Waktu mulai');
    var selesai = parseTime(input.selesai, 'Waktu selesai');
    var durasi = Number(input.durasi_menit);
    var kkm = input.kkm === '' || input.kkm === undefined || input.kkm === null ? 0 : Number(input.kkm);
    var kelas = parseKelas(input.kelas_peserta);

    if (Date.parse(selesai) <= Date.parse(mulai)) Utils.fail('INVALID_INPUT', 'Waktu selesai harus setelah waktu mulai.');
    if (!(durasi >= 1 && durasi <= 600) || Math.floor(durasi) !== durasi) Utils.fail('INVALID_INPUT', 'Durasi 1 sampai 600 menit.');
    if (durasi * 60000 > Date.parse(selesai) - Date.parse(mulai)) Utils.fail('INVALID_INPUT', 'Durasi lebih panjang dari rentang waktu tes.');
    if (!(kkm >= 0 && kkm <= 100)) Utils.fail('INVALID_INPUT', 'KKM 0 sampai 100.');
    if (!kelas.length) Utils.fail('INVALID_INPUT', 'Isi kelas peserta, mis. 7A, 7B.');
    kelas.forEach(function (k) { if (!KELAS_PATTERN.test(k)) Utils.fail('INVALID_INPUT', 'Nama kelas tidak valid: ' + k); });

    return {
      exam_id: exam.exam_id,
      judul: judul,
      mulai: mulai,
      selesai: selesai,
      durasi_menit: durasi,
      acak_soal: !!input.acak_soal,
      acak_opsi: !!input.acak_opsi,
      kkm: kkm,
      kelas_peserta: kelas
    };
  }

  function decorate(test, examsById) {
    var out = {};
    for (var k in test) out[k] = test[k];
    var exam = examsById[test.exam_id];
    out.nama_ujian = exam ? exam.nama_ujian : '(ujian dihapus)';
    out.kode_mapel = exam ? exam.kode_mapel : '';
    out.status = statusOf(test);
    return out;
  }

  /** @param {{status?: string}} payload  filter status opsional */
  function list(ctx, payload) {
    payload = payload || {};
    var examsById = {};
    Repos.exams().findMany(ctx).forEach(function (e) { examsById[e.exam_id] = e; });
    var subjects = null;
    if (ctx.role === 'GURU') {
      var me = Repos.users().findById(ctx, ctx.userId);
      subjects = (me && me.mapel_diampu) || [];
    }
    return Repos.tests().findMany(ctx)
      .map(function (t) { return decorate(t, examsById); })
      .filter(function (t) {
        if (subjects && subjects.indexOf(t.kode_mapel) < 0) return false;
        return !payload.status || t.status === payload.status;
      })
      .sort(function (a, b) { return b.mulai.localeCompare(a.mulai); });
  }

  function create(ctx, payload) {
    var data = build(ctx, { exam_id: payload.exam_ref, judul: payload.judul, mulai: payload.mulai, selesai: payload.selesai,
      durasi_menit: payload.durasi_menit, acak_soal: payload.acak_soal, acak_opsi: payload.acak_opsi, kkm: payload.kkm,
      kelas_peserta: payload.kelas_peserta });
    if (Date.parse(data.selesai) <= nowMs()) Utils.fail('INVALID_INPUT', 'Waktu selesai sudah lewat.');
    return Repos.tests().insert(ctx, data);
  }

  function update(ctx, payload) {
    var own = getOwn(ctx, payload.test_ref);
    if (statusOf(own.test) !== 'BELUM') Utils.fail('LOCKED', 'Tes yang sudah dimulai tidak bisa diubah.');
    var t = own.test;
    var pick = function (k, fallback) { return payload[k] !== undefined ? payload[k] : fallback; };
    var data = build(ctx, {
      exam_id: pick('exam_ref', t.exam_id), judul: pick('judul', t.judul), mulai: pick('mulai', t.mulai), selesai: pick('selesai', t.selesai),
      durasi_menit: pick('durasi_menit', t.durasi_menit), acak_soal: pick('acak_soal', t.acak_soal), acak_opsi: pick('acak_opsi', t.acak_opsi),
      kkm: pick('kkm', t.kkm), kelas_peserta: pick('kelas_peserta', t.kelas_peserta)
    });
    if (Date.parse(data.mulai) <= nowMs()) Utils.fail('INVALID_INPUT', 'Waktu mulai harus di masa depan.');
    return Repos.tests().update(ctx, t.test_id, data);
  }

  function remove(ctx, payload) {
    var own = getOwn(ctx, payload.test_ref);
    if (statusOf(own.test) !== 'BELUM') Utils.fail('LOCKED', 'Tes yang sudah dimulai tidak bisa dihapus.');
    Repos.tests().softDelete(ctx, own.test.test_id);
    return true;
  }

  /**
   * Tolak perubahan soal bila ujian sudah dipakai tes yang sudah mulai, supaya
   * semua peserta mengerjakan dan dinilai dengan soal yang sama.
   * Dicek di semua sekolah (ujian pusat bisa dipakai banyak sekolah).
   */
  function assertExamUnlocked(examId) {
    var started = Repos.tests().findMany(Auth.SYSTEM, { exam_id: examId }).filter(function (t) {
      return Date.parse(t.mulai) <= nowMs();
    });
    if (started.length) Utils.fail('LOCKED', 'Soal tidak bisa diubah karena ujian ini sudah dipakai tes yang dimulai (' + started[0].judul + ').');
  }

  return {
    list: list, create: create, update: update, remove: remove,
    statusOf: statusOf, getOwn: getOwn, assertExamUnlocked: assertExamUnlocked
  };
})();

if (typeof module !== 'undefined') module.exports = TestService;
