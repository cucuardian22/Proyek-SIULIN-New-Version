/**
 * Ujian per mapel dan kelas di bawah satu topik. nama_ujian dibuat otomatis:
 *   <KodeSekolah>_<InisialTopik>_<KodeMapel>_<Kelas>, mis. ESPEGE_ASAT_Genap_MTK_7
 *
 * Ujian milik sekolah dikelola ADMIN/GURU sekolah itu. Ujian pusat (school_id kosong)
 * dikelola SUPER_ADMIN, soalnya ber-scope GLOBAL dan bisa dipakai semua sekolah.
 * GURU hanya boleh mengelola mapel yang ada di mapel_diampu-nya.
 */
var ExamService = (function () {
  var MAPEL_PATTERN = /^[A-Z0-9]{2,10}$/;
  var KELAS_PATTERN = /^[A-Z0-9]{1,5}$/;

  /** school_id yang dikelola ctx: '' untuk SUPER_ADMIN (pusat). */
  function ownerSchool(ctx) { return ctx.role === 'SUPER_ADMIN' ? '' : ctx.schoolId; }

  function teacherSubjects(ctx) {
    if (ctx.role !== 'GURU') return null;
    var me = Repos.users().findById(ctx, ctx.userId);
    return (me && me.mapel_diampu) || [];
  }

  function assertTeaches(ctx, kodeMapel) {
    var subjects = teacherSubjects(ctx);
    if (subjects && subjects.indexOf(kodeMapel) < 0) {
      Utils.fail('FORBIDDEN', 'Mapel ' + kodeMapel + ' tidak ada di daftar mapel yang Anda ampu.');
    }
  }

  /** Ujian yang boleh diubah ctx (bukan sekadar dibaca). */
  function getEditable(ctx, examId) {
    var exam = Repos.exams().findById(ctx, examId);
    if (!exam || exam.school_id !== ownerSchool(ctx)) Utils.fail('NOT_FOUND', 'Ujian tidak ditemukan atau bukan milik Anda.');
    assertTeaches(ctx, exam.kode_mapel);
    return exam;
  }

  function schoolCode(ctx) {
    if (ctx.role === 'SUPER_ADMIN') return Config.SUPER_ADMIN_SCHOOL_CODE;
    var school = Repos.schools().findById(ctx, ctx.schoolId);
    if (!school) Utils.fail('NOT_FOUND', 'Sekolah tidak ditemukan.');
    return school.nama_unik;
  }

  function clean(p) {
    var out = {};
    if (p.topic_id !== undefined) out.topic_id = String(p.topic_id).trim();
    if (p.kode_mapel !== undefined) out.kode_mapel = String(p.kode_mapel).trim().toUpperCase();
    if (p.nama_mapel !== undefined) out.nama_mapel = String(p.nama_mapel).trim();
    if (p.kelas !== undefined) out.kelas = String(p.kelas).trim().toUpperCase();
    return out;
  }

  function build(ctx, data, existingId) {
    if (!MAPEL_PATTERN.test(data.kode_mapel || '')) Utils.fail('INVALID_INPUT', 'Kode mapel 2-10 huruf/angka, mis. MTK.');
    if (!data.nama_mapel) Utils.fail('INVALID_INPUT', 'Nama mapel wajib diisi.');
    if (!KELAS_PATTERN.test(data.kelas || '')) Utils.fail('INVALID_INPUT', 'Kelas 1-5 huruf/angka, mis. 7 atau X.');
    var topic = Repos.topics().findById(ctx, data.topic_id);
    if (!topic || topic.status !== 'AKTIF') Utils.fail('INVALID_INPUT', 'Pilih topik ujian yang aktif.');
    assertTeaches(ctx, data.kode_mapel);

    var owner = ownerSchool(ctx);
    var dupe = Repos.exams().findMany(ctx, { school_id: owner, topic_id: data.topic_id, kode_mapel: data.kode_mapel, kelas: data.kelas })
      .filter(function (e) { return e.exam_id !== existingId; });
    if (dupe.length) Utils.fail('DUPLICATE', 'Ujian ' + dupe[0].nama_ujian + ' sudah ada.');

    data.school_id = owner;
    data.nama_ujian = [schoolCode(ctx), topic.inisial, data.kode_mapel, data.kelas].join('_');
    return data;
  }

  /**
   * Ujian yang terlihat: milik sekolah sendiri + ujian pusat. SUPER_ADMIN hanya ujian pusat.
   * GURU hanya mapel yang diampu. Setiap baris diberi jumlah_soal dan editable.
   */
  function list(ctx, payload) {
    payload = payload || {};
    var subjects = teacherSubjects(ctx);
    var owner = ownerSchool(ctx);
    var exams = Repos.exams().findMany(ctx).filter(function (e) {
      if (ctx.role === 'SUPER_ADMIN' && e.school_id !== '') return false;
      if (payload.topic_id && e.topic_id !== payload.topic_id) return false;
      if (payload.only_own && e.school_id !== owner) return false;
      return !subjects || subjects.indexOf(e.kode_mapel) >= 0;
    });
    var counts = {};
    Repos.questions().findMany(ctx).forEach(function (q) { counts[q.exam_id] = (counts[q.exam_id] || 0) + 1; });
    return exams.map(function (e) {
      var out = {};
      for (var k in e) out[k] = e[k];
      out.jumlah_soal = counts[e.exam_id] || 0;
      out.editable = e.school_id === owner;
      return out;
    }).sort(function (a, b) { return a.nama_ujian.localeCompare(b.nama_ujian); });
  }

  function create(ctx, payload) {
    return Repos.exams().insert(ctx, build(ctx, clean(payload), null));
  }

  function update(ctx, payload) {
    var exam = getEditable(ctx, payload.exam_ref);
    var data = clean(payload);
    var merged = {
      topic_id: data.topic_id !== undefined ? data.topic_id : exam.topic_id,
      kode_mapel: data.kode_mapel !== undefined ? data.kode_mapel : exam.kode_mapel,
      nama_mapel: data.nama_mapel !== undefined ? data.nama_mapel : exam.nama_mapel,
      kelas: data.kelas !== undefined ? data.kelas : exam.kelas
    };
    return Repos.exams().update(ctx, exam.exam_id, build(ctx, merged, exam.exam_id));
  }

  function remove(ctx, payload) {
    var exam = getEditable(ctx, payload.exam_ref);
    if (Repos.questions().findMany(ctx, { exam_id: exam.exam_id }).length) {
      Utils.fail('IN_USE', 'Hapus semua soal di ujian ini dulu.');
    }
    Repos.exams().softDelete(ctx, exam.exam_id);
    return true;
  }

  return {
    list: list, create: create, update: update, remove: remove,
    getEditable: getEditable, ownerSchool: ownerSchool, assertTeaches: assertTeaches
  };
})();

if (typeof module !== 'undefined') module.exports = ExamService;
