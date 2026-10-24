const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/load');

const call = (sid, route, payload) => Api.handle(route, sid, payload);
const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.error)); return r.data; };
const loginAs = (kode, username, password) => ok(call(null, 'auth.login', { kode_sekolah: kode, username, password })).session_id;

const NOW = Date.parse('2026-10-24T01:00:00.000Z');
const at = (minutes) => new Date(NOW + minutes * 60000).toISOString();

function seed() {
  const platform = loadApp({ now: NOW });
  Repos.users().insert(Auth.SYSTEM, Object.assign({ school_id: '', role: 'SUPER_ADMIN', username: 'root', nama: 'Root', status: 'AKTIF' }, Auth.makePasswordFields('rootpass')));
  const root = loginAs('PUSAT', 'root', 'rootpass');
  const topic = ok(call(root, 'topic.create', { nama_topik: 'ASAT', inisial: 'ASAT', tahun_ajaran: '2026/2027' }));
  const s = { root };
  for (const code of ['ESPEGE', 'LAIN']) {
    const school = ok(call(root, 'school.create', { nama_sekolah: code, nama_unik: code }));
    ok(call(root, 'user.create', { target_school: school.school_id, username: 'admin', nama: 'Admin', role: 'ADMIN', password: 'adminpass' }));
    s[code] = loginAs(code, 'admin', 'adminpass');
  }
  ok(call(s.ESPEGE, 'user.create', { username: 'pengawas', nama: 'Pengawas', role: 'PENGAWAS', password: 'pengawas1' }));
  s.pengawas = loginAs('ESPEGE', 'pengawas', 'pengawas1');
  const exam = ok(call(s.ESPEGE, 'exam.create', { topic_id: topic.topic_id, kode_mapel: 'MTK', nama_mapel: 'Matematika', kelas: '7' }));
  const empty = ok(call(s.ESPEGE, 'exam.create', { topic_id: topic.topic_id, kode_mapel: 'IPA', nama_mapel: 'IPA', kelas: '7' }));
  const q = ok(call(s.ESPEGE, 'question.create', { exam_ref: exam.exam_id, tipe: 'PG', teks: 'x', opsi: [{ teks: '1' }, { teks: '2' }], kunci: 'A' }));
  return { platform, s, exam, empty, q };
}

const testInput = (exam, extra = {}) => Object.assign({
  exam_ref: exam.exam_id, judul: 'ASAT MTK 7', mulai: at(60), selesai: at(180), durasi_menit: 90,
  acak_soal: true, acak_opsi: false, kkm: 75, kelas_peserta: '7a, 7B, 7a'
}, extra);

test('membuat jadwal tes dengan validasi', () => {
  const { s, exam, empty } = seed();
  const t = ok(call(s.ESPEGE, 'test.create', testInput(exam)));
  assert.deepEqual(t.kelas_peserta, ['7A', '7B']);
  assert.equal(t.acak_soal, true);
  assert.equal(t.kkm, 75);
  const bad = (extra) => call(s.ESPEGE, 'test.create', testInput(exam, extra)).error.code;
  assert.equal(bad({ selesai: at(30) }), 'INVALID_INPUT');            // selesai sebelum mulai
  assert.equal(bad({ durasi_menit: 200 }), 'INVALID_INPUT');          // lebih panjang dari rentang
  assert.equal(bad({ kkm: 120 }), 'INVALID_INPUT');
  assert.equal(bad({ kelas_peserta: '' }), 'INVALID_INPUT');
  assert.equal(bad({ mulai: at(-200), selesai: at(-10) }), 'INVALID_INPUT'); // sudah lewat
  assert.equal(bad({ mulai: 'besok' }), 'INVALID_INPUT');
  assert.equal(call(s.ESPEGE, 'test.create', testInput(empty)).error.code, 'INVALID_INPUT'); // ujian tanpa soal
  assert.equal(call(s.LAIN, 'test.create', testInput(exam)).error.code, 'INVALID_INPUT');  // ujian sekolah lain
  assert.equal(call(s.pengawas, 'test.create', testInput(exam)).error.code, 'FORBIDDEN');
});

test('status tes mengikuti waktu; tes yang sudah mulai terkunci', () => {
  const { platform, s, exam } = seed();
  const t = ok(call(s.ESPEGE, 'test.create', testInput(exam)));
  assert.equal(ok(call(s.ESPEGE, 'test.list', {})).at(0).status, 'BELUM');
  ok(call(s.ESPEGE, 'test.update', { test_ref: t.test_id, judul: 'Baru' }));
  platform._advance(61 * 60);
  const listed = ok(call(s.ESPEGE, 'test.list', {}));
  assert.equal(listed[0].status, 'BERLANGSUNG');
  assert.equal(listed[0].nama_ujian, exam.nama_ujian);
  assert.equal(call(s.ESPEGE, 'test.update', { test_ref: t.test_id, judul: 'X' }).error.code, 'LOCKED');
  assert.equal(call(s.ESPEGE, 'test.remove', { test_ref: t.test_id }).error.code, 'LOCKED');
  platform._advance(120 * 60);
  assert.equal(ok(call(s.ESPEGE, 'test.list', { status: 'SELESAI' })).length, 1);
});

test('soal dan ujian terkunci setelah tes dimulai', () => {
  const { platform, s, exam, q } = seed();
  ok(call(s.ESPEGE, 'test.create', testInput(exam)));
  ok(call(s.ESPEGE, 'question.update', { question_ref: q.question_id, tipe: 'PG', teks: 'y', opsi: [{ teks: '1' }, { teks: '2' }], kunci: 'B' }));
  assert.equal(call(s.ESPEGE, 'exam.remove', { exam_ref: exam.exam_id }).error.code, 'IN_USE');
  platform._advance(61 * 60);
  const locked = (route, p) => assert.equal(call(s.ESPEGE, route, p).error.code, 'LOCKED', route);
  locked('question.update', { question_ref: q.question_id, tipe: 'PG', teks: 'z', opsi: [{ teks: '1' }, { teks: '2' }], kunci: 'A' });
  locked('question.create', { exam_ref: exam.exam_id, tipe: 'PG', teks: 'x', opsi: [{ teks: '1' }, { teks: '2' }], kunci: 'A' });
  locked('question.remove', { question_ref: q.question_id });
  locked('question.import', { exam_ref: exam.exam_id, rows: [{ tipe: 'PG', teks: 'x', a: '1', b: '2', kunci: 'A' }] });
  locked('exam.update', { exam_ref: exam.exam_id, kelas: '8' });
});

test('token: dibuat pengawas, menggantikan token lama, kedaluwarsa', () => {
  const { platform, s, exam } = seed();
  const t = ok(call(s.ESPEGE, 'test.create', testInput(exam)));
  assert.equal(ok(call(s.pengawas, 'token.list')).at(0).token, null);

  const tok1 = ok(call(s.pengawas, 'token.generate', { test_ref: t.test_id, berlaku_menit: 15 }));
  assert.match(tok1.kode, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.equal(tok1.berlaku_sampai, at(15));
  const ctx = { role: 'ADMIN', schoolId: ok(call(s.ESPEGE, 'auth.me')).user.school_id };
  assert.equal(TokenService.verify(ctx, t.test_id, tok1.kode.toLowerCase()), true);

  const tok2 = ok(call(s.pengawas, 'token.generate', { test_ref: t.test_id }));
  assert.equal(TokenService.verify(ctx, t.test_id, tok1.kode), tok1.kode === tok2.kode); // token lama tidak berlaku lagi
  assert.equal(TokenService.verify(ctx, t.test_id, tok2.kode), true);
  assert.equal(ok(call(s.pengawas, 'token.list')).at(0).token.kode, tok2.kode);

  platform._advance(16 * 60);
  assert.equal(TokenService.verify(ctx, t.test_id, tok2.kode), false);
  assert.equal(ok(call(s.pengawas, 'token.list')).at(0).token, null);
  assert.equal(TokenService.verify(ctx, t.test_id, ''), false);
});

test('token tidak berlaku melewati waktu selesai tes, dan terisolasi per sekolah', () => {
  const { s, exam } = seed();
  const t = ok(call(s.ESPEGE, 'test.create', testInput(exam)));
  const tok = ok(call(s.ESPEGE, 'token.generate', { test_ref: t.test_id, berlaku_menit: 600 }));
  assert.equal(tok.berlaku_sampai, at(180));
  assert.equal(call(s.LAIN, 'token.generate', { test_ref: t.test_id }).error.code, 'NOT_FOUND');
  assert.equal(ok(call(s.LAIN, 'token.list')).length, 0);
  assert.equal(call(s.ESPEGE, 'token.generate', { test_ref: t.test_id, berlaku_menit: 0 }).error.code, 'INVALID_INPUT');
});
