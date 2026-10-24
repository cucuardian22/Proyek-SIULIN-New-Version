/**
 * Mesin ujian untuk SISWA: daftar tes, mulai dengan token, paket soal, auto-save, submit.
 *
 * Bagian ini dipanggil serentak oleh ratusan siswa. Penulisan tidak memakai appendRow (yang bisa
 * saling menimpa bila serentak), tetapi nomor baris (slot) milik attempt:
 *  - Mulai: memesan satu slot (kunci singkat, hanya penghitung) lalu menulis baris Attempts ke slot itu.
 *    attempt_id diturunkan dari test_id + user_id dan urutan acak diturunkan dari attempt_id, jadi dua
 *    klik "Mulai" bersamaan menghasilkan attempt yang sama.
 *  - Auto-save: selalu ke cache ('ans:'), dan paling sering tiap Config.SAVE_SHEET_SECONDS menimpa
 *    baris AnswerBatches di slot attempt. Lanjut di perangkat lain membaca cache dulu, lalu sheet.
 *  - Submit: baris Answers (semua jawaban + skor) dan baris Results di slot attempt, tanpa kunci.
 *    Baris Results menandai attempt sudah ditutup; status di Attempts disalin trigger berkala (syncClosed).
 *
 * urutan_soal di Attempts: [{ q: question_id, o: [id opsi sesuai tampilan] | null }].
 * Jawaban selalu memakai id opsi asli, jadi pengacakan hanya memengaruhi tampilan.
 */
var ExamEngine = (function () {
  var SAVE_GRACE_SECONDS = 120;  // toleransi koneksi lambat setelah batas waktu
  var CACHE_SECONDS = 6 * 60 * 60;
  var AUTO_SUBMIT_SLACK_SECONDS = 15;  // selisih jam perangkat yang masih dianggap "waktu habis"
  var MAX_EXTEND_MINUTES = 60;
  var SYNC_MAX = 60;
  var SYSTEM = { system: true };

  function nowMs() { return Platform.now().getTime(); }

  /** Angka acak 0..1 yang selalu sama untuk seed yang sama (mulberry32). */
  function seededRandom(seedHex) {
    var a = parseInt(String(seedHex).replace(/[^0-9a-f]/gi, '').slice(0, 8) || '1', 16) >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffle(list, rand) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /** Satu siswa, satu tes, satu attempt_id: dua permintaan "Mulai" bersamaan menulis attempt yang sama. */
  function attemptIdFor(testId, userId) {
    return Platform.hmacSha256Hex('siulin-attempt', testId + ':' + userId).slice(0, 32);
  }

  // ---------- cache ----------

  function cacheKey(id) { return 'att:' + id; }
  function progressKey(id) { return 'prog:' + id; }  // ringkasan untuk monitoring pengawas
  function savedKey(id) { return 'ans:' + id; }      // auto-save terakhir (seluruh jawaban)
  function resultKey(id) { return 'res:' + id; }     // penanda attempt sudah ditutup

  function cacheGet(key) {
    try { var v = Platform.cache().get(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }

  function cachePut(obj) {
    var text = {};
    Object.keys(obj).forEach(function (k) { text[k] = JSON.stringify(obj[k]); });
    try { Platform.cache().putAll(text, CACHE_SECONDS); return true; } catch (e) { return false; }
  }

  function cacheAttempt(a) {
    var o = {};
    o[cacheKey(a.attempt_id)] = a;
    cachePut(o);
  }

  // ---------- status attempt (baris Results = sudah ditutup) ----------

  /** { attempt_id: result } dengan baris paling awal bila ada submit ganda. */
  function closedResults(filter) {
    var map = {};
    Repos.results().findMany(SYSTEM, filter || {}).forEach(function (r) {
      var prev = map[r.attempt_id];
      if (!prev || r.created_at < prev.created_at) map[r.attempt_id] = r;
    });
    return map;
  }

  function resultOf(attemptId) {
    return cacheGet(resultKey(attemptId)) || closedResults({ attempt_id: attemptId })[attemptId] || null;
  }

  /** Salinan attempt dengan status dari Results (Attempts di sheet bisa tertinggal sampai trigger berjalan). */
  function applyResult(a, r) {
    if (!r) return a;
    var out = {};
    for (var k in a) out[k] = a[k];
    out.status = r.status;
    out.selesai = r.selesai;
    out.jumlah_pindah_tab = Math.max(Number(r.jumlah_pindah_tab) || 0, Number(a.jumlah_pindah_tab) || 0);
    return out;
  }

  /** Attempt unik per id (baris pertama), urut dari yang paling awal. */
  function uniqueAttempts(list) {
    var seen = {};
    return list.filter(function (a) {
      if (seen[a.attempt_id]) return false;
      seen[a.attempt_id] = true;
      return true;
    }).sort(function (x, y) { return (x.created_at + x.attempt_id).localeCompare(y.created_at + y.attempt_id); });
  }

  /** Attempts dengan status terkini. Results hanya dibaca bila ada attempt yang masih PROGRESS di sheet. */
  function withResults(list, results) {
    if (!results && !list.some(function (a) { return a.status === 'PROGRESS'; })) return list;
    results = results || closedResults();
    return list.map(function (a) { return a.status === 'PROGRESS' ? applyResult(a, results[a.attempt_id]) : a; });
  }

  /** Slot attempt; null untuk attempt lama tanpa slot (penulisannya memesan slot baru). */
  function slotOf(a) { return a.slot === null || a.slot === undefined || a.slot === '' ? null : Number(a.slot); }

  function owns(ctx, a) { return a && a.user_id === ctx.userId && a.school_id === ctx.schoolId; }

  function loadAttempt(ctx, attemptId) {
    var a = cacheGet(cacheKey(attemptId));
    if (!a) {
      a = Repos.attempts().findById(ctx, attemptId);
      if (a && a.status === 'PROGRESS') a = applyResult(a, resultOf(a.attempt_id));
      if (owns(ctx, a)) cacheAttempt(a);
    }
    if (!owns(ctx, a)) Utils.fail('NOT_FOUND', 'Sesi ujian tidak ditemukan.');
    return a;
  }

  function countAnswered(jawaban) {
    return Object.keys(jawaban).filter(function (k) {
      var v = jawaban[k];
      if (v === null || v === undefined || v === '') return false;
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === 'object') return Object.keys(v).length > 0;
      return String(v).trim() !== '';
    }).length;
  }

  /** { attempt_id: {seq, terjawab, pindah_tab, ts} } untuk attempt yang pernah auto-save sejak cache terakhir hilang. */
  function progressOf(attemptIds) {
    if (!attemptIds.length) return {};
    var raw = {};
    try { raw = Platform.cache().getAll(attemptIds.map(progressKey)) || {}; } catch (e) { return {}; }
    var out = {};
    attemptIds.forEach(function (id) { if (raw[progressKey(id)]) out[id] = JSON.parse(raw[progressKey(id)]); });
    return out;
  }

  function expired(a) { return nowMs() > Date.parse(a.batas_waktu) + SAVE_GRACE_SECONDS * 1000; }

  function myAttempts(ctx, testId) {
    var filter = { user_id: ctx.userId };
    if (testId) filter.test_id = testId;
    return withResults(uniqueAttempts(Repos.attempts().findMany(ctx, filter)));
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

  function buildOrder(test, attemptId) {
    var rand = seededRandom(attemptId);
    var qs = Repos.questions().findMany(SYSTEM, { exam_id: test.exam_id }).sort(function (a, b) {
      return (a.created_at + a.question_id).localeCompare(b.created_at + b.question_id);
    });
    if (!qs.length) Utils.fail('INVALID_INPUT', 'Tes ini belum punya soal. Hubungi guru.');
    if (test.acak_soal) qs = shuffle(qs, rand);
    return qs.map(function (q) {
      var shuffleOptions = test.acak_opsi && (q.tipe === 'PG' || q.tipe === 'PGK');
      return { q: q.question_id, o: shuffleOptions ? shuffle(q.opsi.map(function (o) { return o.id; }), rand) : null };
    });
  }

  /** Auto-save terakhir: cache dulu (selalu paling baru), lalu sheet AnswerBatches. */
  function latestSaved(attemptId) {
    var c = cacheGet(savedKey(attemptId));
    if (c) return { seq: c.seq, jawaban: c.jawaban || {}, jumlah_pindah_tab: c.jumlah_pindah_tab || 0 };
    var b = Repos.answerBatches().findMany(SYSTEM, { attempt_id: attemptId }).sort(function (x, y) { return y.seq - x.seq; })[0];
    return b ? { seq: b.seq, jawaban: b.jawaban_json || {}, jumlah_pindah_tab: b.jumlah_pindah_tab || 0 } : null;
  }

  function packageFor(attempt, test, saved) {
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
    return {
      attempt_id: attempt.attempt_id,
      test: { test_id: test.test_id, judul: test.judul, durasi_menit: test.durasi_menit },
      batas_waktu: attempt.batas_waktu,
      server_now: Utils.nowIso(),
      questions: questions,
      saved: saved || null
    };
  }

  // ---------- penilaian ----------

  /**
   * Nilai dan tutup attempt: baris Answers lalu Results di slot attempt, tanpa kunci.
   * jawaban null = pakai auto-save terakhir. Mengembalikan baris Results yang berlaku.
   */
  function finalize(attempt, jawaban, pindahTab, status) {
    var existing = resultOf(attempt.attempt_id);
    if (existing) return existing;
    if (jawaban === null) {
      var saved = latestSaved(attempt.attempt_id);
      jawaban = saved ? saved.jawaban : {};
      if (pindahTab === null) pindahTab = saved ? saved.jumlah_pindah_tab : 0;
    }
    var map = questionsById(attempt.urutan_soal.map(function (u) { return u.q; }));
    var questions = attempt.urutan_soal.map(function (u) { return map[u.q]; }).filter(Boolean);
    var score = ScoringService.scoreAttempt(questions, jawaban);
    var skor = {};
    var final = {};
    score.items.forEach(function (item) {
      skor[item.question_id] = item.skor;
      if (jawaban[item.question_id] !== undefined) final[item.question_id] = jawaban[item.question_id];
    });

    Repos.answers().insert(SYSTEM, {
      attempt_id: attempt.attempt_id, test_id: attempt.test_id, school_id: attempt.school_id, jawaban: final, skor: skor
    }, slotOf(attempt));
    var result = Repos.results().insert(SYSTEM, {
      attempt_id: attempt.attempt_id, test_id: attempt.test_id, school_id: attempt.school_id, user_id: attempt.user_id,
      status: status, selesai: Utils.nowIso(),
      jumlah_pindah_tab: Math.max(Number(pindahTab) || 0, Number(attempt.jumlah_pindah_tab) || 0),
      skor_otomatis: score.skor_otomatis, skor_uraian: null, nilai_akhir: score.nilai,
      status_koreksi: score.perlu_koreksi ? 'MENUNGGU' : 'SELESAI'
    }, slotOf(attempt));
    var o = {};
    o[resultKey(attempt.attempt_id)] = result;
    o[cacheKey(attempt.attempt_id)] = applyResult(attempt, result);
    cachePut(o);
    return result;
  }

  // ---------- rute ----------

  /** Tes untuk kelas siswa: yang belum selesai, ditambah yang pernah dikerjakan. */
  function available(ctx) {
    var user = me(ctx);
    var attempts = {};
    myAttempts(ctx).forEach(function (a) {
      if (a.status === 'PROGRESS' && expired(a)) a = applyResult(a, finalize(a, null, null, 'TIMEOUT'));
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

    var id = attemptIdFor(test.test_id, ctx.userId);
    var cached = cacheGet(cacheKey(id));
    var current = owns(ctx, cached) ? cached : myAttempts(ctx, test.test_id)[0];
    if (current) {
      if (current.status !== 'PROGRESS') Utils.fail('DONE', 'Anda sudah menyelesaikan tes ini.');
      if (expired(current)) {
        finalize(current, null, null, 'TIMEOUT');
        Utils.fail('DONE', 'Waktu mengerjakan sudah habis. Jawaban tersimpan terakhir sudah dikumpulkan.');
      }
      cacheAttempt(current);
      return packageFor(current, test, latestSaved(current.attempt_id));
    }

    var status = TestService.statusOf(test);
    if (status === 'BELUM') Utils.fail('NOT_STARTED', 'Tes belum dimulai.');
    if (status === 'SELESAI') Utils.fail('DONE', 'Waktu tes sudah berakhir.');
    if (!TokenService.verify(ctx, test.test_id, payload.token)) Utils.fail('BAD_TOKEN', 'Token salah atau sudah tidak berlaku.');

    var batas = Math.min(nowMs() + test.durasi_menit * 60000, Date.parse(test.selesai));
    var order = buildOrder(test, id);
    var slot = Repos.attempts().reserve(1);
    var created = Repos.attempts().insert(ctx, {
      attempt_id: id, test_id: test.test_id, user_id: ctx.userId, mulai: Utils.nowIso(), batas_waktu: new Date(batas).toISOString(),
      selesai: '', status: 'PROGRESS', urutan_soal: order,
      ip_ua: String(payload.user_agent || '').slice(0, 300), jumlah_pindah_tab: 0, slot: slot
    }, slot);
    cacheAttempt(created);
    return packageFor(created, test, null);
  }

  function cleanAnswers(jawaban) {
    jawaban = jawaban && typeof jawaban === 'object' && !Array.isArray(jawaban) ? jawaban : {};
    if (JSON.stringify(jawaban).length > 45000) Utils.fail('INVALID_INPUT', 'Jawaban terlalu panjang.');
    return jawaban;
  }

  /**
   * Auto-save: seluruh jawaban saat ini ke cache, dan ke sheet AnswerBatches bila simpanan sheet
   * terakhir sudah lebih lama dari Config.SAVE_SHEET_SECONDS (atau cache gagal/hilang).
   * @param {{attempt_ref, seq:number, jawaban:Object, jumlah_pindah_tab:number, client_ts?:string}} payload
   */
  function save(ctx, payload) {
    var a = loadAttempt(ctx, payload.attempt_ref);
    if (a.status !== 'PROGRESS') Utils.fail('DONE', 'Tes sudah dikumpulkan.');
    if (expired(a)) Utils.fail('TIME_UP', 'Waktu mengerjakan sudah habis.');
    var jawaban = cleanAnswers(payload.jawaban);
    var seq = Number(payload.seq) || 0;
    var tab = Number(payload.jumlah_pindah_tab) || 0;
    var now = Utils.nowIso();
    var reply = { saved_seq: seq, server_now: now, batas_waktu: a.batas_waktu };

    var prev = cacheGet(savedKey(a.attempt_id));
    if (prev && prev.seq > seq) return reply; // simpanan lama yang datang terlambat

    var toSheet = !prev || !prev.sheet_ts || nowMs() - Date.parse(prev.sheet_ts) >= Config.SAVE_SHEET_SECONDS * 1000;
    if (toSheet) writeBatch(a, seq, jawaban, tab, payload.client_ts, now);
    var o = {};
    o[savedKey(a.attempt_id)] = { seq: seq, jawaban: jawaban, jumlah_pindah_tab: tab, ts: now, sheet_ts: toSheet ? now : prev.sheet_ts };
    o[progressKey(a.attempt_id)] = { seq: seq, terjawab: countAnswered(jawaban), pindah_tab: tab, ts: now };
    if (!cachePut(o) && !toSheet) writeBatch(a, seq, jawaban, tab, payload.client_ts, now); // cache gagal: jangan sampai hilang
    // batas_waktu ikut dikirim supaya timer siswa ikut berubah bila pengawas menambah waktu.
    return reply;
  }

  function writeBatch(a, seq, jawaban, tab, clientTs, now) {
    Repos.answerBatches().insert(SYSTEM, {
      attempt_id: a.attempt_id, school_id: a.school_id, seq: seq, jawaban_json: jawaban, jumlah_pindah_tab: tab,
      client_ts: String(clientTs || '').slice(0, 40), server_ts: now
    }, slotOf(a));
  }

  /**
   * Kumpulkan jawaban akhir dan nilai. Aman dipanggil ulang (hasil yang sama).
   * payload.auto = true dikirim saat timer siswa habis: bila pengawas sudah menambah waktu,
   * attempt tidak dikumpulkan dan batas waktu baru dikembalikan.
   */
  function submit(ctx, payload) {
    var a = loadAttempt(ctx, payload.attempt_ref);
    if (payload.auto && a.status === 'PROGRESS' && nowMs() < Date.parse(a.batas_waktu) - AUTO_SUBMIT_SLACK_SECONDS * 1000) {
      return { status: 'PROGRESS', batas_waktu: a.batas_waktu, server_now: Utils.nowIso() };
    }
    if (a.status !== 'PROGRESS') return { status: a.status, selesai: a.selesai };
    var r = expired(a)
      ? finalize(a, null, null, 'TIMEOUT') // terlambat: yang dinilai adalah auto-save terakhir sebelum batas waktu
      : finalize(a, cleanAnswers(payload.jawaban), payload.jumlah_pindah_tab, 'SUBMITTED');
    return { status: r.status, selesai: r.selesai };
  }

  /**
   * Kumpulkan attempt yang waktunya habis tanpa submit.
   * testId opsional: hanya untuk satu tes (dipakai rekap nilai dan monitoring sebelum menampilkan hasil).
   */
  function finalizeExpired(testId) {
    var done = 0;
    var filter = { status: 'PROGRESS' };
    if (testId) filter.test_id = testId;
    var open = uniqueAttempts(Repos.attempts().findMany(SYSTEM, filter)).filter(expired);
    if (!open.length) return 0;
    withResults(open, closedResults(testId ? { test_id: testId } : {})).forEach(function (a) {
      if (a.status !== 'PROGRESS') return;
      try { finalize(a, null, null, 'TIMEOUT'); done++; }
      catch (e) { Utils.log('error', 'finalize gagal', { attempt_id: a.attempt_id, error: String(e) }); }
    });
    return done;
  }

  /**
   * Salin status dari Results ke Attempts dengan satu kunci (trigger berkala). Paling banyak
   * SYNC_MAX baris per jalan, supaya kunci tidak lama tertahan (login dan mulai tes ikut memakainya
   * untuk memesan slot). Sisanya disalin pada jalan berikutnya; pembaca memakai Results lebih dulu.
   */
  function syncClosed() {
    var results = closedResults();
    var patches = {};
    var n = 0;
    uniqueAttempts(Repos.attempts().findMany(SYSTEM, { status: 'PROGRESS' })).forEach(function (a) {
      var r = results[a.attempt_id];
      if (r && n < SYNC_MAX) { n++; patches[a.attempt_id] = { status: r.status, selesai: r.selesai, jumlah_pindah_tab: applyResult(a, r).jumlah_pindah_tab }; }
    });
    return Repos.attempts().updateMany(SYSTEM, patches);
  }

  // ---------- tindakan pengawas (hak akses dicek MonitorService) ----------

  function openAttempt(attemptId) {
    var a = Repos.attempts().findById(SYSTEM, attemptId);
    if (!a) Utils.fail('NOT_FOUND', 'Data pengerjaan tidak ditemukan.');
    a = applyResult(a, resultOf(a.attempt_id));
    if (a.status !== 'PROGRESS') Utils.fail('DONE', 'Siswa ini sudah selesai.');
    if (expired(a)) {
      finalize(a, null, null, 'TIMEOUT');
      Utils.fail('DONE', 'Waktu siswa ini sudah habis dan jawabannya sudah dikumpulkan.');
    }
    return a;
  }

  /** Tambah waktu satu siswa. Timer siswa ikut berubah pada auto-save berikutnya (paling lama 1 menit). */
  function extend(attemptId, minutes) {
    minutes = Number(minutes);
    if (!(minutes >= 1 && minutes <= MAX_EXTEND_MINUTES) || Math.floor(minutes) !== minutes) {
      Utils.fail('INVALID_INPUT', 'Tambahan waktu 1 sampai ' + MAX_EXTEND_MINUTES + ' menit.');
    }
    var a = openAttempt(attemptId);
    var batas = new Date(Math.max(Date.parse(a.batas_waktu), nowMs()) + minutes * 60000).toISOString();
    var updated = Repos.attempts().update(SYSTEM, a.attempt_id, { batas_waktu: batas });
    cacheAttempt(updated);
    return updated;
  }

  /** Kumpulkan paksa: yang dinilai adalah auto-save terakhir siswa. */
  function forceSubmit(attemptId) {
    var a = openAttempt(attemptId);
    return applyResult(a, finalize(a, null, null, 'SUBMITTED'));
  }

  return {
    SAVE_GRACE_SECONDS: SAVE_GRACE_SECONDS,
    available: available, start: start, save: save, submit: submit, finalizeExpired: finalizeExpired, syncClosed: syncClosed,
    attemptIdFor: attemptIdFor, progressOf: progressOf, closedResults: closedResults, applyResult: applyResult, uniqueAttempts: uniqueAttempts,
    extend: extend, forceSubmit: forceSubmit
  };
})();

/** Target trigger berkala (dipasang oleh setupTriggers di Setup.gs). */
function finalizeExpiredAttempts() {
  var done = ExamEngine.finalizeExpired();
  ExamEngine.syncClosed();
  return done;
}

if (typeof module !== 'undefined') module.exports = ExamEngine;
