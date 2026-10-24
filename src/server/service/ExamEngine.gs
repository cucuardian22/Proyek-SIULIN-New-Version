/**
 * Mesin ujian untuk SISWA: daftar tes, mulai dengan token, paket soal, auto-save, submit.
 *
 * Beban dijaga sekecil mungkin karena inilah bagian yang dipanggil serentak:
 *  - Paket soal dikirim sekali saat mulai/lanjut, tanpa kunci jawaban.
 *  - Auto-save hanya menambah satu baris AnswerBatches (append), tanpa membaca sheet;
 *    data attempt diambil dari CacheService.
 *  - Penilaian dilakukan sekali saat submit, atau oleh finalizeExpiredAttempts()
 *    (trigger berkala) untuk attempt yang waktunya habis tanpa submit.
 *
 * urutan_soal di Attempts: [{ q: question_id, o: [id opsi sesuai tampilan] | null }].
 * Jawaban selalu memakai id opsi asli, jadi pengacakan hanya memengaruhi tampilan.
 */
var ExamEngine = (function () {
  var SAVE_GRACE_SECONDS = 120;  // toleransi koneksi lambat setelah batas waktu
  var CACHE_SECONDS = 6 * 60 * 60;
  var SYSTEM = { system: true };

  function nowMs() { return Platform.now().getTime(); }

  function shuffle(list) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  // ---------- attempt + cache ----------

  function cacheKey(id) { return 'att:' + id; }

  function cacheAttempt(a) {
    try { Platform.cache().put(cacheKey(a.attempt_id), JSON.stringify(a), CACHE_SECONDS); } catch (e) { /* cache opsional */ }
  }

  function loadAttempt(ctx, attemptId) {
    var cached = Platform.cache().get(cacheKey(attemptId));
    var a = cached ? JSON.parse(cached) : Repos.attempts().findById(ctx, attemptId);
    if (!a || a.user_id !== ctx.userId || a.school_id !== ctx.schoolId) Utils.fail('NOT_FOUND', 'Sesi ujian tidak ditemukan.');
    if (!cached) cacheAttempt(a);
    return a;
  }

  function expired(a) { return nowMs() > Date.parse(a.batas_waktu) + SAVE_GRACE_SECONDS * 1000; }

  function myAttempts(ctx, testId) {
    var filter = { user_id: ctx.userId };
    if (testId) filter.test_id = testId;
    return Repos.attempts().findMany(ctx, filter).sort(function (x, y) {
      return (x.created_at + x.attempt_id).localeCompare(y.created_at + y.attempt_id);
    });
  }

  function me(ctx) {
    var user = Repos.users().findById(ctx, ctx.userId);
    if (!user) Utils.fail('NOT_FOUND', 'Akun tidak ditemukan.');
    return user;
  }

  function isParticipant(test, user) {
    return (test.kelas_peserta || []).indexOf(String(user.kelas || '').trim().toUpperCase()) >= 0;
  }

  // ---------- paket soal ----------

  function questionsById(ids) {
    var wanted = {};
    ids.forEach(function (id) { wanted[id] = true; });
    var map = {};
    // SYSTEM: soal pusat (GLOBAL) dan soal yang sudah dihapus setelah tes dimulai tetap terbaca.
    Repos.questions()._all().forEach(function (q) { if (wanted[q.question_id]) map[q.question_id] = q; });
    return map;
  }

  function buildOrder(test) {
    var qs = Repos.questions().findMany(SYSTEM, { exam_id: test.exam_id }).sort(function (a, b) {
      return a.created_at.localeCompare(b.created_at);
    });
    if (!qs.length) Utils.fail('INVALID_INPUT', 'Tes ini belum punya soal. Hubungi guru.');
    if (test.acak_soal) qs = shuffle(qs);
    return qs.map(function (q) {
      var shuffleOptions = test.acak_opsi && (q.tipe === 'PG' || q.tipe === 'PGK');
      return { q: q.question_id, o: shuffleOptions ? shuffle(q.opsi.map(function (o) { return o.id; })) : null };
    });
  }

  function latestBatch(ctx, attemptId) {
    return Repos.answerBatches().findMany(ctx, { attempt_id: attemptId }).sort(function (a, b) { return b.seq - a.seq; })[0] || null;
  }

  function packageFor(ctx, attempt, test) {
    var map = questionsById(attempt.urutan_soal.map(function (u) { return u.q; }));
    var questions = attempt.urutan_soal.map(function (u) {
      var q = map[u.q];
      var opsi = q.opsi || [];
      if (u.o) {
        var byId = {};
        opsi.forEach(function (o) { byId[o.id] = o; });
        opsi = u.o.map(function (id) { return byId[id]; }).filter(Boolean);
      }
      // Kunci tidak pernah dikirim ke browser.
      return { question_id: q.question_id, tipe: q.tipe, teks: q.teks, media_url: q.media_url, bobot: q.bobot,
        opsi: opsi.map(function (o) { return { id: o.id, teks: o.teks }; }) };
    });
    var saved = latestBatch(ctx, attempt.attempt_id);
    return {
      attempt_id: attempt.attempt_id,
      test: { test_id: test.test_id, judul: test.judul, durasi_menit: test.durasi_menit },
      batas_waktu: attempt.batas_waktu,
      server_now: Utils.nowIso(),
      questions: questions,
      saved: saved ? { seq: saved.seq, jawaban: saved.jawaban_json || {}, jumlah_pindah_tab: saved.jumlah_pindah_tab || 0 } : null
    };
  }

  // ---------- penilaian ----------

  /** Nilai dan tutup attempt. jawaban null = pakai auto-save terakhir. */
  function finalize(ctx, attempt, jawaban, pindahTab, status) {
    var existing = Repos.results().findById(SYSTEM, attempt.attempt_id);
    if (existing) return existing;
    if (jawaban === null) {
      var batch = latestBatch(SYSTEM, attempt.attempt_id);
      jawaban = batch ? batch.jawaban_json || {} : {};
      if (pindahTab === null) pindahTab = batch ? batch.jumlah_pindah_tab || 0 : attempt.jumlah_pindah_tab || 0;
    }
    var map = questionsById(attempt.urutan_soal.map(function (u) { return u.q; }));
    var questions = attempt.urutan_soal.map(function (u) { return map[u.q]; }).filter(Boolean);
    var score = ScoringService.scoreAttempt(questions, jawaban);
    var now = Utils.nowIso();

    Repos.answers().insertMany(SYSTEM, score.items.map(function (item) {
      return {
        attempt_id: attempt.attempt_id, school_id: attempt.school_id, question_id: item.question_id,
        jawaban: jawaban[item.question_id] === undefined ? null : jawaban[item.question_id], waktu_simpan: now, skor: item.skor
      };
    }));
    var result = Repos.results().insert(SYSTEM, {
      attempt_id: attempt.attempt_id, test_id: attempt.test_id, school_id: attempt.school_id, user_id: attempt.user_id,
      skor_otomatis: score.skor_otomatis, skor_uraian: null, nilai_akhir: score.nilai,
      status_koreksi: score.perlu_koreksi ? 'MENUNGGU' : 'SELESAI'
    });
    var closed = Repos.attempts().update(SYSTEM, attempt.attempt_id, {
      status: status, selesai: now, jumlah_pindah_tab: Math.max(Number(pindahTab) || 0, attempt.jumlah_pindah_tab || 0)
    });
    cacheAttempt(closed);
    return result;
  }

  // ---------- rute ----------

  /** Tes untuk kelas siswa: yang belum selesai, ditambah yang pernah dikerjakan. */
  function available(ctx) {
    var user = me(ctx);
    var attempts = {};
    myAttempts(ctx).forEach(function (a) {
      if (a.status === 'PROGRESS' && expired(a)) a = Repos.attempts().findById(ctx, finalize(ctx, a, null, null, 'TIMEOUT').attempt_id);
      if (!attempts[a.test_id]) attempts[a.test_id] = a;
    });
    return Repos.tests().findMany(ctx).filter(function (t) {
      return attempts[t.test_id] || (isParticipant(t, user) && TestService.statusOf(t) !== 'SELESAI');
    }).map(function (t) {
      var a = attempts[t.test_id];
      return {
        test_id: t.test_id, judul: t.judul, mulai: t.mulai, selesai: t.selesai, durasi_menit: t.durasi_menit,
        status: TestService.statusOf(t),
        attempt: a ? { attempt_id: a.attempt_id, status: a.status, batas_waktu: a.batas_waktu, selesai: a.selesai } : null
      };
    }).sort(function (a, b) { return a.mulai.localeCompare(b.mulai); });
  }

  /**
   * Mulai tes (wajib token) atau lanjutkan attempt yang masih berjalan (tanpa token).
   * @param {{test_ref, token?, user_agent?}} payload
   */
  function start(ctx, payload) {
    var test = Repos.tests().findById(ctx, payload.test_ref);
    if (!test) Utils.fail('NOT_FOUND', 'Tes tidak ditemukan.');
    var user = me(ctx);
    if (!isParticipant(test, user)) Utils.fail('FORBIDDEN', 'Tes ini bukan untuk kelas Anda.');

    var current = myAttempts(ctx, test.test_id)[0];
    if (current) {
      if (current.status !== 'PROGRESS') Utils.fail('DONE', 'Anda sudah menyelesaikan tes ini.');
      if (expired(current)) {
        finalize(ctx, current, null, null, 'TIMEOUT');
        Utils.fail('DONE', 'Waktu mengerjakan sudah habis. Jawaban tersimpan terakhir sudah dikumpulkan.');
      }
      cacheAttempt(current);
      return packageFor(ctx, current, test);
    }

    var status = TestService.statusOf(test);
    if (status === 'BELUM') Utils.fail('NOT_STARTED', 'Tes belum dimulai.');
    if (status === 'SELESAI') Utils.fail('DONE', 'Waktu tes sudah berakhir.');
    if (!TokenService.verify(ctx, test.test_id, payload.token)) Utils.fail('BAD_TOKEN', 'Token salah atau sudah tidak berlaku.');

    var batas = Math.min(nowMs() + test.durasi_menit * 60000, Date.parse(test.selesai));
    Repos.attempts().insert(ctx, {
      test_id: test.test_id, user_id: ctx.userId, mulai: Utils.nowIso(), batas_waktu: new Date(batas).toISOString(),
      selesai: '', status: 'PROGRESS', urutan_soal: buildOrder(test),
      ip_ua: String(payload.user_agent || '').slice(0, 300), jumlah_pindah_tab: 0
    });
    // Dua klik "Mulai" yang bersamaan bisa membuat dua attempt: pakai yang paling awal, hapus sisanya.
    var all = myAttempts(ctx, test.test_id);
    all.slice(1).forEach(function (dupe) { Repos.attempts().softDelete(ctx, dupe.attempt_id); });
    cacheAttempt(all[0]);
    return packageFor(ctx, all[0], test);
  }

  /**
   * Auto-save: tambahkan satu baris berisi seluruh jawaban saat ini.
   * @param {{attempt_ref, seq:number, jawaban:Object, jumlah_pindah_tab:number, client_ts?:string}} payload
   */
  function save(ctx, payload) {
    var a = loadAttempt(ctx, payload.attempt_ref);
    if (a.status !== 'PROGRESS') Utils.fail('DONE', 'Tes sudah dikumpulkan.');
    if (expired(a)) Utils.fail('TIME_UP', 'Waktu mengerjakan sudah habis.');
    var jawaban = payload.jawaban && typeof payload.jawaban === 'object' && !Array.isArray(payload.jawaban) ? payload.jawaban : {};
    if (JSON.stringify(jawaban).length > 45000) Utils.fail('INVALID_INPUT', 'Jawaban terlalu panjang.');
    Repos.answerBatches().insert(ctx, {
      attempt_id: a.attempt_id, seq: Number(payload.seq) || 0, jawaban_json: jawaban,
      jumlah_pindah_tab: Number(payload.jumlah_pindah_tab) || 0,
      client_ts: String(payload.client_ts || '').slice(0, 40), server_ts: Utils.nowIso()
    });
    return { saved_seq: Number(payload.seq) || 0, server_now: Utils.nowIso() };
  }

  /** Kumpulkan jawaban akhir dan nilai. Aman dipanggil ulang (hasil yang sama). */
  function submit(ctx, payload) {
    var a = loadAttempt(ctx, payload.attempt_ref);
    if (a.status === 'PROGRESS' && !expired(a)) {
      var jawaban = payload.jawaban && typeof payload.jawaban === 'object' && !Array.isArray(payload.jawaban) ? payload.jawaban : {};
      save(ctx, { attempt_ref: a.attempt_id, seq: payload.seq, jawaban: jawaban, jumlah_pindah_tab: payload.jumlah_pindah_tab, client_ts: payload.client_ts });
      finalize(ctx, a, jawaban, payload.jumlah_pindah_tab, 'SUBMITTED');
    } else if (a.status === 'PROGRESS') {
      // Terlambat: yang dinilai adalah auto-save terakhir sebelum batas waktu.
      finalize(ctx, a, null, null, 'TIMEOUT');
    }
    var fresh = Repos.attempts().findById(ctx, a.attempt_id);
    return { status: fresh.status, selesai: fresh.selesai };
  }

  /**
   * Dipanggil trigger berkala: kumpulkan attempt yang waktunya habis tanpa submit.
   * testId opsional: hanya untuk satu tes (dipakai rekap nilai sebelum menampilkan hasil).
   */
  function finalizeExpired(testId) {
    var done = 0;
    var filter = { status: 'PROGRESS' };
    if (testId) filter.test_id = testId;
    Repos.attempts().findMany(SYSTEM, filter).forEach(function (a) {
      if (!expired(a)) return;
      try { finalize(SYSTEM, a, null, null, 'TIMEOUT'); done++; }
      catch (e) { Utils.log('error', 'finalize gagal', { attempt_id: a.attempt_id, error: String(e) }); }
    });
    return done;
  }

  return {
    SAVE_GRACE_SECONDS: SAVE_GRACE_SECONDS,
    available: available, start: start, save: save, submit: submit, finalizeExpired: finalizeExpired
  };
})();

/** Target trigger berkala (dipasang oleh setupTriggers di Setup.gs). */
function finalizeExpiredAttempts() {
  return ExamEngine.finalizeExpired();
}

if (typeof module !== 'undefined') module.exports = ExamEngine;
