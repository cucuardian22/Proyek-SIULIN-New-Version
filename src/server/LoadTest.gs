/**
 * Uji beban. Dipakai HANYA di project Apps Script terpisah ("SIULIN Uji Beban") dengan
 * spreadsheet sendiri, jangan di klaster yang dipakai sekolah.
 *
 *  prepare()     membuat sekolah UJIBEBAN, siswa ub001..ubNNN, pengawas, ujian, tes yang
 *                sedang berlangsung, dan token. Dipanggil setupLoadTest() di Setup.gs.
 *  handlePost()  isi doPost: meneruskan JSON {route, session_id, payload} ke Api.handle,
 *                hanya bila Script Property LOADTEST_ENABLED = 'true' dan hanya untuk rute
 *                yang dipakai siswa dan pengawas saat ujian. Skrip tools/loadtest.js memanggilnya.
 *
 * doPost berjalan dengan kuota yang sama dengan google.script.run (eksekusi sebagai pemilik),
 * jadi hasilnya mewakili beban browser siswa sungguhan.
 */
var LoadTest = (function () {
  var SCHOOL_CODE = 'UJIBEBAN';
  var KELAS = 'UB';
  var ROUTES = ['auth.login', 'attempt.list', 'attempt.start', 'attempt.save', 'attempt.submit', 'monitor.tests', 'monitor.list'];

  function pad(n, width) { var s = String(n); while (s.length < width) s = '0' + s; return s; }

  /** 40 soal campuran: 25 PG, 5 PGK, 5 PGBS, 5 ISIAN. */
  function questionRows() {
    var rows = [];
    for (var i = 1; i <= 40; i++) {
      if (i <= 25) rows.push({ tipe: 'PG', teks: 'Soal PG nomor ' + i + ': berapakah ' + i + ' + ' + i + '?', bobot: '1',
        a: String(i * 2), b: String(i * 2 + 1), c: String(i * 2 - 1), d: String(i * 3), e: String(i), kunci: 'A' });
      else if (i <= 30) rows.push({ tipe: 'PGK', teks: 'Soal PGK nomor ' + i + ': pilih bilangan genap.', bobot: '2',
        a: '2', b: '3', c: '4', d: '5', kunci: 'A,C' });
      else if (i <= 35) rows.push({ tipe: 'PGBS', teks: 'Soal PGBS nomor ' + i + ': benar atau salah.', bobot: '2',
        a: '1 + 1 = 2', b: '2 + 2 = 5', c: '3 x 3 = 9', kunci: 'B,S,B' });
      else rows.push({ tipe: 'ISIAN', teks: 'Soal ISIAN nomor ' + i + ': 10 x ' + i + ' = ...', bobot: '1', kunci: String(10 * i) });
    }
    return rows;
  }

  /**
   * @param {{students:number, password:string, durasi_menit?:number, jam_berlaku?:number}} opts
   * @return {{kode_sekolah, kelas, test_id, token, students, pengawas}}
   */
  function prepare(opts) {
    var students = Number(opts.students);
    if (!(students >= 1 && students <= 2000)) Utils.fail('INVALID_INPUT', 'Jumlah siswa 1 sampai 2000.');
    if (String(opts.password || '').length < 8) Utils.fail('INVALID_INPUT', 'Password uji beban minimal 8 karakter.');
    if (SchoolRepo.findByCode(Auth.SYSTEM, SCHOOL_CODE)) {
      Utils.fail('CONFLICT', 'Sekolah ' + SCHOOL_CODE + ' sudah ada. Pakai project uji beban yang baru, atau pakai data yang sudah ada.');
    }
    var durasi = Number(opts.durasi_menit) || 90;
    var jam = Number(opts.jam_berlaku) || 4;

    var root = { userId: 'loadtest', schoolId: '', role: 'SUPER_ADMIN' };
    var school = SchoolService.create(root, { nama_sekolah: 'Sekolah Uji Beban', nama_unik: SCHOOL_CODE });
    var topic = TopicService.create(root, { nama_topik: 'Uji Beban', inisial: 'UB', tahun_ajaran: '2026/2027' });
    var admin = { userId: 'loadtest', schoolId: school.school_id, role: 'ADMIN' };

    var exam = ExamService.create(admin, { topic_id: topic.topic_id, kode_mapel: 'UB', nama_mapel: 'Uji Beban', kelas: KELAS });
    var imported = QuestionService.importRows(admin, { exam_ref: exam.exam_id, rows: questionRows() });
    if (imported.errors.length) throw new Error('Soal uji beban tidak valid: ' + JSON.stringify(imported.errors));

    // Satu hash untuk semua akun uji: menghitung ratusan hash satu per satu bisa melewati batas 6 menit.
    var pw = Auth.makePasswordFields(opts.password);
    var users = [];
    for (var i = 1; i <= students; i++) {
      users.push({ role: 'SISWA', username: 'ub' + pad(i, 3), nama: 'Siswa Uji ' + pad(i, 3), kelas: KELAS });
    }
    users.push({ role: 'PENGAWAS', username: 'ubawas', nama: 'Pengawas Uji', kelas: '' });
    Repos.users().insertMany(admin, users.map(function (u) {
      return { role: u.role, username: u.username, nama: u.nama, kelas: u.kelas, mapel_diampu: [], status: 'AKTIF',
        password_hash: pw.password_hash, salt: pw.salt, hash_algo: pw.hash_algo };
    }));

    var now = Platform.now().getTime();
    var test = TestService.create(admin, {
      exam_ref: exam.exam_id, judul: 'Tes Uji Beban', kelas_peserta: KELAS,
      mulai: new Date(now - 60000).toISOString(), selesai: new Date(now + jam * 3600000).toISOString(),
      durasi_menit: durasi, acak_soal: true, acak_opsi: true, kkm: 70
    });
    var token = TokenService.generate(admin, { test_ref: test.test_id, berlaku_menit: jam * 60 });
    return { kode_sekolah: SCHOOL_CODE, kelas: KELAS, test_id: test.test_id, token: token.kode, students: students, pengawas: 'ubawas' };
  }

  /** @param {string} text  isi body POST */
  function handlePost(text) {
    if (Platform.prop('LOADTEST_ENABLED') !== 'true') {
      return { ok: false, error: { code: 'DISABLED', message: 'Mode uji beban tidak aktif.' } };
    }
    var body;
    try { body = JSON.parse(text || ''); } catch (e) {
      return { ok: false, error: { code: 'INVALID_INPUT', message: 'Body harus JSON.' } };
    }
    if (!body || ROUTES.indexOf(body.route) < 0) {
      return { ok: false, error: { code: 'NOT_FOUND', message: 'Rute tidak tersedia untuk uji beban.' } };
    }
    return Api.handle(body.route, body.session_id || null, body.payload || {});
  }

  return { SCHOOL_CODE: SCHOOL_CODE, ROUTES: ROUTES, prepare: prepare, handlePost: handlePost };
})();

if (typeof module !== 'undefined') module.exports = LoadTest;
