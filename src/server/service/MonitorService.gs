/**
 * Monitoring tes yang sedang berjalan untuk PENGAWAS, GURU (mapel yang diampu), dan ADMIN.
 *
 * Dipanggil berkala (tiap 30 detik) oleh beberapa pengawas sekaligus, jadi sengaja ringan:
 * progres siswa dibaca dari cache yang diisi auto-save, bukan dari sheet AnswerBatches.
 * Nilai tidak ditampilkan di sini (pengawas tidak punya izin result.view).
 */
var MonitorService = (function () {
  var RECENT_HOURS = 6;        // tes yang selesai dalam rentang ini masih bisa dibuka
  var IDLE_SECONDS = 180;      // tanpa auto-save selama ini = mungkin terputus
  var STATUS = { PROGRESS: 'MENGERJAKAN', SUBMITTED: 'SELESAI', TIMEOUT: 'WAKTU_HABIS' };

  function nowMs() { return Platform.now().getTime(); }

  /** Tes yang sedang berlangsung atau baru selesai. */
  function tests(ctx) {
    var since = nowMs() - RECENT_HOURS * 3600000;
    return TestService.list(ctx, {}).filter(function (t) {
      return t.status === 'BERLANGSUNG' || (t.status === 'SELESAI' && Date.parse(t.selesai) >= since);
    }).map(function (t) {
      return { test_id: t.test_id, judul: t.judul, nama_ujian: t.nama_ujian, kelas_peserta: t.kelas_peserta,
        mulai: t.mulai, selesai: t.selesai, durasi_menit: t.durasi_menit, status: t.status };
    });
  }

  /** @param {{test_ref:string}} payload */
  function list(ctx, payload) {
    var own = TestService.getOwn(ctx, payload.test_ref);
    var test = own.test;
    ExamEngine.finalizeExpired(test.test_id);

    var attempts = {};
    Repos.attempts().findMany(ctx, { test_id: test.test_id }).forEach(function (a) {
      var prev = attempts[a.user_id];
      if (!prev || (a.created_at + a.attempt_id) < (prev.created_at + prev.attempt_id)) attempts[a.user_id] = a;
    });
    var kelas = test.kelas_peserta || [];
    var students = Repos.users().findMany(ctx, { role: 'SISWA' }).filter(function (u) {
      return attempts[u.user_id] || kelas.indexOf(String(u.kelas || '').trim().toUpperCase()) >= 0;
    });
    var progress = ExamEngine.progressOf(Object.keys(attempts).map(function (k) { return attempts[k].attempt_id; }));
    var now = nowMs();

    var rows = students.map(function (u) {
      var a = attempts[u.user_id];
      var p = a ? progress[a.attempt_id] : null;
      var status = a ? STATUS[a.status] || a.status : 'BELUM';
      var lastSeen = p ? Date.parse(p.ts) : a ? Date.parse(a.mulai) : 0;
      return {
        user_id: u.user_id, username: u.username, nama: u.nama, kelas: u.kelas,
        attempt_id: a ? a.attempt_id : '',
        status: status,
        mulai: a ? a.mulai : '', batas_waktu: a ? a.batas_waktu : '', selesai: a ? a.selesai : '',
        sisa_detik: status === 'MENGERJAKAN' ? Math.max(0, Math.floor((Date.parse(a.batas_waktu) - now) / 1000)) : null,
        jumlah_soal: a ? (a.urutan_soal || []).length : null,
        terjawab: p ? p.terjawab : null,
        terakhir_simpan: p ? p.ts : '',
        pindah_tab: Math.max(p ? p.pindah_tab : 0, a ? a.jumlah_pindah_tab || 0 : 0),
        terputus: status === 'MENGERJAKAN' && now - lastSeen > IDLE_SECONDS * 1000
      };
    }).sort(function (x, y) {
      return String(x.kelas).localeCompare(String(y.kelas)) || String(x.nama).localeCompare(String(y.nama));
    });

    var count = function (s) { return rows.filter(function (r) { return r.status === s; }).length; };
    return {
      test: {
        test_id: test.test_id, judul: test.judul, nama_ujian: own.exam.nama_ujian, kelas_peserta: kelas,
        mulai: test.mulai, selesai: test.selesai, durasi_menit: test.durasi_menit, status: TestService.statusOf(test)
      },
      server_now: Utils.nowIso(),
      rows: rows,
      summary: {
        peserta: rows.length, belum: count('BELUM'), mengerjakan: count('MENGERJAKAN'),
        selesai: count('SELESAI') + count('WAKTU_HABIS'),
        terputus: rows.filter(function (r) { return r.terputus; }).length
      }
    };
  }

  /** Attempt di sekolah ctx, pada tes yang boleh dipantau ctx. */
  function ownAttempt(ctx, attemptRef) {
    var a = Repos.attempts().findById(ctx, attemptRef);
    if (!a) Utils.fail('NOT_FOUND', 'Data pengerjaan tidak ditemukan.');
    TestService.getOwn(ctx, a.test_id);
    return a;
  }

  /** @param {{attempt_ref:string, menit:number}} payload */
  function extend(ctx, payload) {
    var a = ownAttempt(ctx, payload.attempt_ref);
    var updated = ExamEngine.extend(a.attempt_id, payload.menit);
    Utils.log('info', 'tambah waktu', { attempt_id: a.attempt_id, menit: payload.menit, oleh: ctx.userId });
    return { attempt_id: updated.attempt_id, batas_waktu: updated.batas_waktu };
  }

  /** @param {{attempt_ref:string}} payload */
  function forceSubmit(ctx, payload) {
    var a = ownAttempt(ctx, payload.attempt_ref);
    var done = ExamEngine.forceSubmit(a.attempt_id);
    Utils.log('info', 'kumpulkan paksa', { attempt_id: a.attempt_id, oleh: ctx.userId });
    return { attempt_id: done.attempt_id, status: STATUS[done.status] || done.status };
  }

  return { tests: tests, list: list, extend: extend, forceSubmit: forceSubmit };
})();

if (typeof module !== 'undefined') module.exports = MonitorService;
