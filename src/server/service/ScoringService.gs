/**
 * Penilaian otomatis. Murni (tanpa layanan Google), sehingga file ini dipakai
 * apa adanya di Node.js pada Fase 2 dan diuji di tests/scoring.test.js.
 *
 * Bentuk data per tipe soal:
 *   PG    opsi [{id:'A', teks}],     kunci 'A',                jawaban 'A'
 *   PGK   opsi [{id:'A', teks}],     kunci ['A','C'],          jawaban ['A','B']
 *   PGBS  opsi [{id:'1', teks}],     kunci {'1':'B','2':'S'},  jawaban {'1':'B','2':'B'}   (B = Benar, S = Salah)
 *   PGST  opsi [{id:'1', teks}],     kunci {'1':'S','2':'TS'}, jawaban {'1':'S'}           (S = Setuju, TS = Tidak Setuju)
 *   ISIAN opsi [],                   kunci ['25','dua puluh lima'], jawaban 'Dua  puluh lima'
 *         -> bobot penuh bila sama dengan salah satu kunci (abaikan huruf besar dan spasi berlebih)
 *   URAIAN -> dinilai manual (skor null) pada Tahap 3.
 *
 * Aturan proporsional bersih:
 *   PGK        skor = max(0, (benar dipilih - salah dipilih) / jumlah kunci) x bobot
 *   PGBS/PGST  skor = (pernyataan dijawab benar / jumlah pernyataan) x bobot
 */
var ScoringService = (function () {
  var AUTO_TYPES = ['PG', 'PGK', 'PGBS', 'PGST', 'ISIAN'];
  var ALL_TYPES = AUTO_TYPES.concat(['URAIAN']);
  var STATEMENT_VALUES = { PGBS: ['B', 'S'], PGST: ['S', 'TS'] };

  function norm(v) { return String(v === null || v === undefined ? '' : v).trim().toUpperCase(); }

  function round2(n) { return Math.round(n * 100) / 100; }

  function uniqueList(v) {
    var list = Array.isArray(v) ? v : (v === null || v === undefined || v === '' ? [] : [v]);
    var seen = {};
    var out = [];
    list.forEach(function (x) {
      var k = norm(x);
      if (k && !seen[k]) { seen[k] = true; out.push(k); }
    });
    return out;
  }

  function scorePG(kunci, jawaban, bobot) {
    var key = uniqueList(kunci)[0];
    var ans = uniqueList(jawaban);
    return ans.length === 1 && ans[0] === key ? bobot : 0;
  }

  function scorePGK(kunci, jawaban, bobot) {
    var keys = uniqueList(kunci);
    if (!keys.length) return 0;
    var benar = 0;
    var salah = 0;
    uniqueList(jawaban).forEach(function (a) {
      if (keys.indexOf(a) >= 0) benar++; else salah++;
    });
    return round2(Math.max(0, (benar - salah) / keys.length) * bobot);
  }

  function squash(v) { return String(v === null || v === undefined ? '' : v).trim().replace(/\s+/g, ' ').toLowerCase(); }

  function scoreIsian(kunci, jawaban, bobot) {
    var ans = squash(Array.isArray(jawaban) ? jawaban[0] : jawaban);
    if (!ans) return 0;
    var keys = (Array.isArray(kunci) ? kunci : [kunci]).map(squash);
    return keys.indexOf(ans) >= 0 ? bobot : 0;
  }

  function scoreStatements(kunci, jawaban, bobot) {
    var ids = Object.keys(kunci || {});
    if (!ids.length) return 0;
    var ans = jawaban && typeof jawaban === 'object' && !Array.isArray(jawaban) ? jawaban : {};
    var benar = 0;
    ids.forEach(function (id) {
      if (norm(ans[id]) !== '' && norm(ans[id]) === norm(kunci[id])) benar++;
    });
    return round2(benar / ids.length * bobot);
  }

  /**
   * Skor satu soal, atau null bila soal dinilai manual.
   * @param {{tipe:string, kunci:*, bobot:number}} question
   */
  function scoreQuestion(question, jawaban) {
    var bobot = Number(question.bobot) || 0;
    switch (question.tipe) {
      case 'PG': return scorePG(question.kunci, jawaban, bobot);
      case 'PGK': return scorePGK(question.kunci, jawaban, bobot);
      case 'PGBS':
      case 'PGST': return scoreStatements(question.kunci, jawaban, bobot);
      case 'ISIAN': return scoreIsian(question.kunci, jawaban, bobot);
      case 'URAIAN': return null;
      default: throw new Error('Tipe soal tidak dikenal: ' + question.tipe);
    }
  }

  /**
   * Skor seluruh lembar jawaban.
   * @param {Array<Object>} questions  soal yang diujikan (dengan kunci)
   * @param {Object} answers           { question_id: jawaban }
   * @return {{items: Array<{question_id, skor}>, skor_otomatis:number, bobot_total:number,
   *           perlu_koreksi:boolean, nilai:number}}
   *   nilai = skor otomatis dalam skala 0-100 dari total bobot semua soal.
   */
  function scoreAttempt(questions, answers) {
    answers = answers || {};
    var total = 0;
    var bobotTotal = 0;
    var manual = false;
    var items = questions.map(function (q) {
      var skor = scoreQuestion(q, answers[q.question_id]);
      bobotTotal += Number(q.bobot) || 0;
      if (skor === null) manual = true; else total += skor;
      return { question_id: q.question_id, skor: skor };
    });
    return {
      items: items,
      skor_otomatis: round2(total),
      bobot_total: round2(bobotTotal),
      perlu_koreksi: manual,
      nilai: bobotTotal > 0 ? round2(total / bobotTotal * 100) : 0
    };
  }

  /** Daftar kesalahan isi soal (kosong = valid). Dipakai form dan import soal. */
  function validateQuestion(q) {
    var errors = [];
    if (ALL_TYPES.indexOf(q.tipe) < 0) return ['Tipe soal harus salah satu dari ' + ALL_TYPES.join(', ') + '.'];
    if (!(Number(q.bobot) > 0)) errors.push('Bobot harus lebih dari 0.');
    if (!String(q.teks || '').trim() && !q.media_url) errors.push('Teks soal wajib diisi.');
    if (q.tipe === 'URAIAN') return errors;
    if (q.tipe === 'ISIAN') {
      if (!uniqueList(q.kunci).length) errors.push('Kunci ISIAN wajib diisi.');
      return errors;
    }

    var opsi = Array.isArray(q.opsi) ? q.opsi : [];
    var ids = opsi.map(function (o) { return norm(o && o.id); });
    if (!opsi.length) errors.push('Opsi/pernyataan wajib diisi.');
    if (ids.some(function (id) { return !id; })) errors.push('Setiap opsi wajib punya id.');
    if (uniqueList(ids).length !== ids.length) errors.push('Id opsi tidak boleh kembar.');

    if (q.tipe === 'PG' || q.tipe === 'PGK') {
      var keys = uniqueList(q.kunci);
      if (q.tipe === 'PG' && keys.length !== 1) errors.push('Kunci PG harus tepat satu opsi.');
      if (q.tipe === 'PGK' && keys.length < 1) errors.push('Kunci PGK minimal satu opsi.');
      keys.forEach(function (k) { if (ids.indexOf(k) < 0) errors.push('Kunci ' + k + ' tidak ada di opsi.'); });
      if (q.tipe === 'PG' && opsi.length < 2) errors.push('Soal PG minimal dua opsi.');
    } else {
      var allowed = STATEMENT_VALUES[q.tipe];
      var kunci = q.kunci && typeof q.kunci === 'object' && !Array.isArray(q.kunci) ? q.kunci : null;
      if (!kunci) {
        errors.push('Kunci ' + q.tipe + ' harus berupa pasangan id pernyataan dan jawaban.');
      } else {
        ids.forEach(function (id) {
          var v = norm(kunci[id] !== undefined ? kunci[id] : kunci[id.toLowerCase()]);
          if (allowed.indexOf(v) < 0) errors.push('Kunci pernyataan ' + id + ' harus ' + allowed.join(' atau ') + '.');
        });
        Object.keys(kunci).forEach(function (k) {
          if (ids.indexOf(norm(k)) < 0) errors.push('Kunci ' + k + ' tidak ada di daftar pernyataan.');
        });
      }
    }
    return errors;
  }

  return {
    AUTO_TYPES: AUTO_TYPES,
    ALL_TYPES: ALL_TYPES,
    scoreQuestion: scoreQuestion,
    scoreAttempt: scoreAttempt,
    validateQuestion: validateQuestion
  };
})();

if (typeof module !== 'undefined') module.exports = ScoringService;
