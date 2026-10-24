const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/load');

const call = (sid, route, payload) => Api.handle(route, sid, payload);
const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.error)); return r.data; };
const err = (r) => { assert.equal(r.ok, false, 'harusnya gagal'); return r.error.code; };
const loginAs = (kode, username, password) => ok(call(null, 'auth.login', { kode_sekolah: kode, username, password })).session_id;

const NOW = Date.parse('2026-10-24T01:00:00.000Z');
const at = (minutes) => new Date(NOW + minutes * 60000).toISOString();

function seed(testExtra = {}) {
  const platform = loadApp({ now: NOW });
  Repos.users().insert(Auth.SYSTEM, Object.assign({ school_id: '', role: 'SUPER_ADMIN', username: 'root', nama: 'Root', status: 'AKTIF' }, Auth.makePasswordFields('rootpass')));
  const root = loginAs('PUSAT', 'root', 'rootpass');
  const topic = ok(call(root, 'topic.create', { nama_topik: 'ASAT', inisial: 'ASAT', tahun_ajaran: '2026/2027' }));
  const school = ok(call(root, 'school.create', { nama_sekolah: 'SMP', nama_unik: 'ESPEGE' }));
  ok(call(root, 'user.create', { target_school: school.school_id, username: 'admin', nama: 'Admin', role: 'ADMIN', password: 'adminpass' }));
  const admin = loginAs('ESPEGE', 'admin', 'adminpass');
  ok(call(admin, 'user.import', { rows: [
    { username: 'ani', nama: 'Ani', kelas: '7A', password: 'siswa123' },
    { username: 'budi', nama: 'Budi', kelas: '7A', password: 'siswa123' },
    { username: 'citra', nama: 'Citra', kelas: '8A', password: 'siswa123' }
  ] }));
  const exam = ok(call(admin, 'exam.create', { topic_id: topic.topic_id, kode_mapel: 'MTK', nama_mapel: 'Matematika', kelas: '7' }));
  ok(call(admin, 'question.import', { exam_ref: exam.exam_id, rows: [
    { tipe: 'PG', teks: '12x12', bobot: '2', a: '124', b: '144', c: '154', kunci: 'B' },
    { tipe: 'PGK', teks: 'prima', bobot: '4', a: '2', b: '4', c: '5', d: '9', kunci: 'A,C' },
    { tipe: 'PGBS', teks: 'b/s', bobot: '2', a: 'p1', b: 'p2', kunci: 'B,S' },
    { tipe: 'ISIAN', teks: '5x5', bobot: '2', kunci: '25' }
  ] }));
  const t = ok(call(admin, 'test.create', Object.assign({ exam_ref: exam.exam_id, mulai: at(10), selesai: at(130), durasi_menit: 60, acak_soal: true, acak_opsi: true, kkm: 70, kelas_peserta: '7A' }, testExtra)));
  return { platform, admin, t, ani: loginAs('ESPEGE', 'ani', 'siswa123'), budi: loginAs('ESPEGE', 'budi', 'siswa123'), citra: loginAs('ESPEGE', 'citra', 'siswa123') };
}

function openTest(env) {
  env.platform._advance(11 * 60);
  return ok(call(env.admin, 'token.generate', { test_ref: env.t.test_id })).kode;
}

test('siswa melihat tes kelasnya saja', () => {
  const env = seed();
  const list = ok(call(env.ani, 'attempt.list'));
  assert.equal(list.length, 1);
  assert.equal(list[0].status, 'BELUM');
  assert.equal(ok(call(env.citra, 'attempt.list')).length, 0);
  assert.equal(err(call(env.admin, 'attempt.list')), 'FORBIDDEN');
});

test('mulai: tes harus berlangsung dan token harus benar', () => {
  const env = seed();
  assert.equal(err(call(env.ani, 'attempt.start', { test_ref: env.t.test_id, token: 'ABCDEF' })), 'NOT_STARTED');
  const kode = openTest(env);
  assert.equal(err(call(env.ani, 'attempt.start', { test_ref: env.t.test_id, token: 'SALAH1' })), 'BAD_TOKEN');
  assert.equal(err(call(env.citra, 'attempt.start', { test_ref: env.t.test_id, token: kode })), 'FORBIDDEN');
  const pkg = ok(call(env.ani, 'attempt.start', { test_ref: env.t.test_id, token: kode.toLowerCase() }));
  assert.equal(pkg.questions.length, 4);
  assert.equal(pkg.batas_waktu, at(71));
  assert.equal(pkg.saved, null);
  for (const q of pkg.questions) assert.equal(q.kunci, undefined, 'kunci tidak boleh terkirim');
  assert.equal(JSON.stringify(pkg).includes('"kunci"'), false);
  const pg = pkg.questions.find((q) => q.tipe === 'PG');
  assert.deepEqual(pg.opsi.map((o) => o.id).sort(), ['A', 'B', 'C']);
});

test('batas waktu tidak melewati selesainya tes', () => {
  const env = seed({ mulai: at(10), selesai: at(40), durasi_menit: 30 });
  const kode = openTest(env);
  env.platform._advance(5 * 60); // mulai terlambat
  assert.equal(ok(call(env.ani, 'attempt.start', { test_ref: env.t.test_id, token: kode })).batas_waktu, at(40));
});

test('auto-save lalu lanjut di perangkat lain tanpa token, jawaban terakhir kembali', () => {
  const env = seed();
  const kode = openTest(env);
  const pkg = ok(call(env.ani, 'attempt.start', { test_ref: env.t.test_id, token: kode }));
  const pg = pkg.questions.find((q) => q.tipe === 'PG');
  ok(call(env.ani, 'attempt.save', { attempt_ref: pkg.attempt_id, seq: 1, jawaban: { [pg.question_id]: 'A' }, jumlah_pindah_tab: 0 }));
  ok(call(env.ani, 'attempt.save', { attempt_ref: pkg.attempt_id, seq: 2, jawaban: { [pg.question_id]: 'B' }, jumlah_pindah_tab: 1 }));
  Platform._cache.clear(); // cache hilang: attempt dibaca dari sheet
  const again = ok(call(env.ani, 'attempt.start', { test_ref: env.t.test_id }));
  assert.equal(again.attempt_id, pkg.attempt_id);
  assert.deepEqual(again.questions.map((q) => q.question_id), pkg.questions.map((q) => q.question_id)); // urutan acak tetap
  assert.deepEqual(again.saved, { seq: 2, jawaban: { [pg.question_id]: 'B' }, jumlah_pindah_tab: 1 });
  assert.equal(err(call(env.budi, 'attempt.save', { attempt_ref: pkg.attempt_id, seq: 3, jawaban: {} })), 'NOT_FOUND'); // milik siswa lain
});

test('submit menilai dengan rumus yang berlaku dan tidak bisa diulang', () => {
  const env = seed();
  const kode = openTest(env);
  const pkg = ok(call(env.ani, 'attempt.start', { test_ref: env.t.test_id, token: kode }));
  const id = (tipe) => pkg.questions.find((q) => q.tipe === tipe).question_id;
  const pgbs = pkg.questions.find((q) => q.tipe === 'PGBS');
  const jawaban = {
    [id('PG')]: 'B',                 // 2
    [id('PGK')]: ['A', 'B'],         // (1-1)/2*4 = 0
    [pgbs.question_id]: { 1: 'B', 2: 'B' }, // 1/2*2 = 1
    [id('ISIAN')]: ' 25 '            // 2
  };
  const r = ok(call(env.ani, 'attempt.submit', { attempt_ref: pkg.attempt_id, seq: 5, jawaban, jumlah_pindah_tab: 3 }));
  assert.equal(r.status, 'SUBMITTED');
  const result = Repos.results().findById(Auth.SYSTEM, pkg.attempt_id);
  assert.equal(result.skor_otomatis, 5);
  assert.equal(result.nilai_akhir, 50); // 5 / 10 * 100
  assert.equal(result.status_koreksi, 'SELESAI');
  assert.equal(Repos.answers().findMany(Auth.SYSTEM, { attempt_id: pkg.attempt_id }).length, 4);
  assert.equal(Repos.attempts().findById(Auth.SYSTEM, pkg.attempt_id).jumlah_pindah_tab, 3);

  // submit ulang dan mulai ulang tidak mengubah apa pun
  ok(call(env.ani, 'attempt.submit', { attempt_ref: pkg.attempt_id, seq: 6, jawaban: {} }));
  assert.equal(Repos.results().findMany(Auth.SYSTEM, {}).length, 1);
  assert.equal(err(call(env.ani, 'attempt.start', { test_ref: env.t.test_id, token: kode })), 'DONE');
  assert.equal(err(call(env.ani, 'attempt.save', { attempt_ref: pkg.attempt_id, seq: 7, jawaban: {} })), 'DONE');
  assert.equal(ok(call(env.ani, 'attempt.list'))[0].attempt.status, 'SUBMITTED');
});

test('waktu habis: auto-save terakhir yang dinilai, lewat trigger maupun saat siswa membuka daftar', () => {
  const env = seed();
  const kode = openTest(env);
  const a = ok(call(env.ani, 'attempt.start', { test_ref: env.t.test_id, token: kode }));
  const b = ok(call(env.budi, 'attempt.start', { test_ref: env.t.test_id, token: kode }));
  const pgA = a.questions.find((q) => q.tipe === 'PG').question_id;
  ok(call(env.ani, 'attempt.save', { attempt_ref: a.attempt_id, seq: 1, jawaban: { [pgA]: 'B' } }));

  env.platform._advance(60 * 60 + ExamEngine.SAVE_GRACE_SECONDS + 1);
  assert.equal(err(call(env.ani, 'attempt.save', { attempt_ref: a.attempt_id, seq: 2, jawaban: {} })), 'TIME_UP');
  // submit terlambat: jawaban kiriman diabaikan, auto-save terakhir dipakai
  assert.equal(ok(call(env.ani, 'attempt.submit', { attempt_ref: a.attempt_id, seq: 2, jawaban: { [pgA]: 'A' } })).status, 'TIMEOUT');
  assert.equal(Repos.results().findById(Auth.SYSTEM, a.attempt_id).skor_otomatis, 2);

  assert.equal(ExamEngine.finalizeExpired(), 1); // budi
  assert.equal(Repos.results().findById(Auth.SYSTEM, b.attempt_id).skor_otomatis, 0);
  assert.equal(ExamEngine.finalizeExpired(), 0);
});

test('soal URAIAN membuat status koreksi MENUNGGU', () => {
  const env = seed();
  const exam = Repos.exams().findMany(Auth.SYSTEM)[0];
  Repos.questions().insert(Auth.SYSTEM, { exam_id: exam.exam_id, scope: 'SCHOOL', school_id: exam.school_id, tipe: 'URAIAN', teks: 'jelaskan', opsi: [], kunci: '', bobot: 5 });
  const kode = openTest(env);
  const pkg = ok(call(env.ani, 'attempt.start', { test_ref: env.t.test_id, token: kode }));
  ok(call(env.ani, 'attempt.submit', { attempt_ref: pkg.attempt_id, seq: 1, jawaban: {} }));
  assert.equal(Repos.results().findById(Auth.SYSTEM, pkg.attempt_id).status_koreksi, 'MENUNGGU');
});
