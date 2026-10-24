/**
 * Rekap nilai untuk ADMIN dan GURU (GURU hanya tes mapel yang diampu).
 *
 *  list      satu baris per siswa peserta: status mengerjakan, nilai, tuntas/belum, plus ringkasan kelas
 *  detail    jawaban satu siswa per soal, lengkap dengan kunci dan skor
 *  analysis  analisis butir: rata-rata skor per soal dan sebaran pilihan PG/PGK
 *
 * Sebelum menampilkan apa pun, attempt tes ini yang waktunya habis dikumpulkan dulu,
 * supaya rekap tidak menunggu trigger berkala.
 */
var ResultService = (function () {
  var SYSTEM = { system: true };
  var STATUS = { PROGRESS: 'MENGERJAKAN', SUBMITTED: 'SELESAI', TIMEOUT: 'WAKTU_HABIS' };

  function round2(n) { return Math.round(n * 100) / 100; }

  function byId(list, key) {
    var map = {};
    list.forEach(function (x) { map[x[key]] = x; });
    return map;
  }

  /** Soal yang dipakai tes, termasuk soal pusat dan soal yang dihapus setelah tes dimulai. */
  function questionsById(ids) {
    var wanted = {};
    ids.forEach(function (id) { wanted[id] = true; });
    var map = {};
    Repos.questions()._all().forEach(function (q) { if (wanted[q.question_id]) map[q.question_id] = q; });
    return map;
  }

  function openTest(ctx, testRef) {
    var own = TestService.getOwn(ctx, testRef);
    ExamEngine.finalizeExpired(own.test.test_id);
    return own;
  }

  function testInfo(own) {
    var t = own.test;
    return {
      test_id: t.test_id, judul: t.judul, nama_ujian: own.exam.nama_ujian, kelas_peserta: t.kelas_peserta,
      mulai: t.mulai, selesai: t.selesai, durasi_menit: t.durasi_menit, kkm: t.kkm, status: TestService.statusOf(t)
    };
  }

  /** @param {{test_ref:string}} payload */
  function list(ctx, payload) {
    var own = openTest(ctx, payload.test_ref);
    var test = own.test;
    var kelas = test.kelas_peserta || [];
    var attempts = {};
    Repos.attempts().findMany(ctx, { test_id: test.test_id }).forEach(function (a) {
      var prev = attempts[a.user_id];
      if (!prev || (a.created_at + a.attempt_id) < (prev.created_at + prev.attempt_id)) attempts[a.user_id] = a;
    });
    var results = byId(Repos.results().findMany(ctx, { test_id: test.test_id }), 'attempt_id');

    // Peserta = siswa kelas peserta, ditambah siswa yang sudah mengerjakan lalu pindah kelas.
    var students = Repos.users().findMany(ctx, { role: 'SISWA' }).filter(function (u) {
      return attempts[u.user_id] || kelas.indexOf(String(u.kelas || '').trim().toUpperCase()) >= 0;
    });

    var rows = students.map(function (u) {
      var a = attempts[u.user_id];
      var r = a ? results[a.attempt_id] : null;
      return {
        user_id: u.user_id, username: u.username, nama: u.nama, kelas: u.kelas,
        attempt_id: a ? a.attempt_id : '',
        status: a ? STATUS[a.status] || a.status : 'BELUM',
        mulai: a ? a.mulai : '', selesai: a ? a.selesai : '',
        jumlah_pindah_tab: a ? a.jumlah_pindah_tab || 0 : 0,
        skor_otomatis: r ? r.skor_otomatis : null,
        nilai_akhir: r ? r.nilai_akhir : null,
        status_koreksi: r ? r.status_koreksi : '',
        tuntas: r ? r.nilai_akhir >= (test.kkm || 0) : null
      };
    }).sort(function (x, y) {
      return String(x.kelas).localeCompare(String(y.kelas)) || String(x.nama).localeCompare(String(y.nama));
    });

    var scored = rows.filter(function (r) { return r.nilai_akhir !== null; });
    var nilai = scored.map(function (r) { return r.nilai_akhir; });
    var count = function (status) { return rows.filter(function (r) { return r.status === status; }).length; };
    return {
      test: testInfo(own),
      rows: rows,
      summary: {
        peserta: rows.length,
        belum: count('BELUM'),
        mengerjakan: count('MENGERJAKAN'),
        selesai: scored.length,
        rata_rata: nilai.length ? round2(nilai.reduce(function (s, n) { return s + n; }, 0) / nilai.length) : null,
        tertinggi: nilai.length ? Math.max.apply(null, nilai) : null,
        terendah: nilai.length ? Math.min.apply(null, nilai) : null,
        tuntas: scored.filter(function (r) { return r.tuntas; }).length,
        menunggu_koreksi: scored.filter(function (r) { return r.status_koreksi === 'MENUNGGU'; }).length
      }
    };
  }

  /** @param {{attempt_ref:string}} payload */
  function detail(ctx, payload) {
    var a = Repos.attempts().findById(ctx, payload.attempt_ref);
    if (!a) Utils.fail('NOT_FOUND', 'Data pengerjaan tidak ditemukan.');
    var own = openTest(ctx, a.test_id);
    a = Repos.attempts().findById(ctx, a.attempt_id);
    var user = Repos.users().findById(ctx, a.user_id) || {};
    var result = Repos.results().findById(ctx, a.attempt_id);
    var answers = byId(Repos.answers().findMany(ctx, { attempt_id: a.attempt_id }), 'question_id');
    var map = questionsById(a.urutan_soal.map(function (u) { return u.q; }));

    var items = a.urutan_soal.map(function (u, i) {
      var q = map[u.q];
      var ans = answers[u.q];
      if (!q) return { no: i + 1, question_id: u.q, tipe: '', teks: '(soal tidak ditemukan)', opsi: [], kunci: null, bobot: 0, jawaban: ans ? ans.jawaban : null, skor: ans ? ans.skor : null };
      return {
        no: i + 1, question_id: q.question_id, tipe: q.tipe, teks: q.teks, media_url: q.media_url,
        opsi: (q.opsi || []).map(function (o) { return { id: o.id, teks: o.teks }; }),
        kunci: q.kunci, bobot: q.bobot,
        jawaban: ans ? ans.jawaban : null,
        skor: ans ? ans.skor : null
      };
    });
    return {
      test: testInfo(own),
      siswa: { user_id: user.user_id, username: user.username, nama: user.nama, kelas: user.kelas },
      attempt: { attempt_id: a.attempt_id, status: STATUS[a.status] || a.status, mulai: a.mulai, selesai: a.selesai, jumlah_pindah_tab: a.jumlah_pindah_tab || 0 },
      result: result ? { skor_otomatis: result.skor_otomatis, nilai_akhir: result.nilai_akhir, status_koreksi: result.status_koreksi } : null,
      items: items
    };
  }

  /** @param {{test_ref:string}} payload */
  function analysis(ctx, payload) {
    var own = openTest(ctx, payload.test_ref);
    var attemptIds = {};
    Repos.results().findMany(ctx, { test_id: own.test.test_id }).forEach(function (r) { attemptIds[r.attempt_id] = true; });
    var stats = {};
    Repos.answers().findMany(ctx).forEach(function (ans) {
      if (!attemptIds[ans.attempt_id]) return;
      var s = stats[ans.question_id] || (stats[ans.question_id] = { peserta: 0, dijawab: 0, total_skor: 0, pilihan: {} });
      s.peserta++;
      var empty = ans.jawaban === null || ans.jawaban === '' || (Array.isArray(ans.jawaban) && !ans.jawaban.length) ||
        (typeof ans.jawaban === 'object' && !Array.isArray(ans.jawaban) && !Object.keys(ans.jawaban).length);
      if (!empty) s.dijawab++;
      if (ans.skor !== null) s.total_skor += Number(ans.skor) || 0;
      if (!empty && (typeof ans.jawaban === 'string' || Array.isArray(ans.jawaban))) {
        (Array.isArray(ans.jawaban) ? ans.jawaban : [ans.jawaban]).forEach(function (id) {
          var k = String(id).toUpperCase();
          s.pilihan[k] = (s.pilihan[k] || 0) + 1;
        });
      }
    });

    // Urutan bank soal (urutan baris sheet), bukan urutan acak yang dilihat siswa.
    var questions = Repos.questions()._all().filter(function (q) { return stats[q.question_id]; });
    return {
      test: testInfo(own),
      peserta: Object.keys(attemptIds).length,
      items: questions.map(function (q, i) {
        var s = stats[q.question_id];
        var choice = q.tipe === 'PG' || q.tipe === 'PGK';
        return {
          no: i + 1, question_id: q.question_id, tipe: q.tipe, teks: q.teks, bobot: q.bobot, kunci: q.kunci,
          peserta: s.peserta, dijawab: s.dijawab,
          // Rata-rata skor dibagi bobot: 1 = semua menjawab benar. null untuk URAIAN (belum dinilai).
          tingkat_benar: q.tipe === 'URAIAN' || !s.peserta || !q.bobot ? null : round2(s.total_skor / (s.peserta * q.bobot)),
          pilihan: choice ? (q.opsi || []).map(function (o) { return { id: o.id, teks: o.teks, jumlah: s.pilihan[String(o.id).toUpperCase()] || 0 }; }) : null
        };
      })
    };
  }

  return { list: list, detail: detail, analysis: analysis };
})();

if (typeof module !== 'undefined') module.exports = ResultService;
