/**
 * Token tes. Peserta wajib memasukkan token yang masih berlaku untuk memulai tes.
 * Membuat token baru menonaktifkan token lama tes yang sama (seperti token ANBK).
 */
var TokenService = (function () {
  var ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // tanpa O/0 dan I/1
  var LENGTH = 6;
  var DEFAULT_MINUTES = 15;
  var MAX_MINUTES = 600;

  function nowMs() { return Platform.now().getTime(); }

  function randomCode() {
    var hex = Platform.randomToken();
    var out = '';
    for (var i = 0; i < LENGTH; i++) out += ALPHABET.charAt(parseInt(hex.substr(i * 2, 2), 16) % ALPHABET.length);
    return out;
  }

  function isLive(token) {
    var now = nowMs();
    return token.status === 'AKTIF' && Date.parse(token.berlaku_dari) <= now && now < Date.parse(token.berlaku_sampai);
  }

  function liveToken(ctx, testId) {
    return Repos.tokens().findMany(ctx, { test_id: testId }).filter(isLive)
      .sort(function (a, b) { return b.berlaku_dari.localeCompare(a.berlaku_dari); })[0] || null;
  }

  function publicToken(t) {
    return t ? Utils.pick(t, ['token_id', 'kode', 'berlaku_dari', 'berlaku_sampai']) : null;
  }

  /** Tes yang belum selesai beserta token aktifnya (untuk halaman Token pengawas/guru). */
  function list(ctx) {
    var examsById = {};
    Repos.exams().findMany(ctx).forEach(function (e) { examsById[e.exam_id] = e; });
    return Repos.tests().findMany(ctx)
      .filter(function (t) { return TestService.statusOf(t) !== 'SELESAI'; })
      .map(function (t) {
        var exam = examsById[t.exam_id];
        return {
          test_id: t.test_id, judul: t.judul, mulai: t.mulai, selesai: t.selesai,
          kelas_peserta: t.kelas_peserta, nama_ujian: exam ? exam.nama_ujian : '',
          status: TestService.statusOf(t), token: publicToken(liveToken(ctx, t.test_id))
        };
      })
      .sort(function (a, b) { return a.mulai.localeCompare(b.mulai); });
  }

  /**
   * Buat token baru untuk satu tes. Token lama tes itu dinonaktifkan.
   * @param {{test_ref: string, berlaku_menit?: number}} payload
   */
  function generate(ctx, payload) {
    var test = Repos.tests().findById(ctx, payload.test_ref);
    if (!test) Utils.fail('NOT_FOUND', 'Tes tidak ditemukan.');
    if (TestService.statusOf(test) === 'SELESAI') Utils.fail('INVALID_INPUT', 'Tes sudah selesai.');
    var minutes = payload.berlaku_menit === undefined || payload.berlaku_menit === '' ? DEFAULT_MINUTES : Number(payload.berlaku_menit);
    if (!(minutes >= 1 && minutes <= MAX_MINUTES)) Utils.fail('INVALID_INPUT', 'Masa berlaku token 1 sampai ' + MAX_MINUTES + ' menit.');

    Repos.tokens().findMany(ctx, { test_id: test.test_id, status: 'AKTIF' }).forEach(function (t) {
      Repos.tokens().update(ctx, t.token_id, { status: 'DIGANTI' });
    });

    var now = Utils.nowIso();
    var until = Math.min(nowMs() + minutes * 60000, Date.parse(test.selesai));
    var token = Repos.tokens().insert(ctx, {
      test_id: test.test_id,
      school_id: test.school_id,
      kode: randomCode(),
      berlaku_dari: now,
      berlaku_sampai: new Date(until).toISOString(),
      dibuat_oleh: ctx.userId,
      status: 'AKTIF'
    });
    return publicToken(token);
  }

  /** Dipakai mesin ujian: true bila kode cocok dengan token tes yang masih berlaku. */
  function verify(ctx, testId, kode) {
    var wanted = String(kode || '').trim().toUpperCase();
    if (!wanted) return false;
    return Repos.tokens().findMany(ctx, { test_id: testId }).some(function (t) {
      return isLive(t) && t.kode === wanted;
    });
  }

  return { list: list, generate: generate, verify: verify, randomCode: randomCode };
})();

if (typeof module !== 'undefined') module.exports = TokenService;
