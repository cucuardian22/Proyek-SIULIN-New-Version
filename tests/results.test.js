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


function finish(env, sid, kode, pick) {
  const pkg = ok(call(sid, 'attempt.start', { test_ref: env.t.test_id, token: kode }));
  const jawaban = {};
  for (const q of pkg.questions) { const v = pick(q); if (v !== undefined) jawaban[q.question_id] = v; }
  ok(call(sid, 'attempt.submit', { attempt_ref: pkg.attempt_id, seq: 1, jawaban }));
  return pkg;
}
const ALL_RIGHT = (q) => ({ PG: 'B', PGK: ['A', 'C'], PGBS: { 1: 'B', 2: 'S' }, ISIAN: '25' })[q.tipe];

test('rekap: semua peserta kelas tampil dengan status, nilai, dan ringkasan', () => {
  const env = seed();
  const kode = openTest(env);
  finish(env, env.ani, kode, ALL_RIGHT);                                   // 100
  ok(call(env.budi, 'attempt.start', { test_ref: env.t.test_id, token: kode })); // masih mengerjakan

  let r = ok(call(env.admin, 'result.list', { test_ref: env.t.test_id }));
  assert.deepEqual(r.rows.map((x) => [x.username, x.status, x.nilai_akhir, x.tuntas]), [
    ['ani', 'SELESAI', 100, true], ['budi', 'MENGERJAKAN', null, null]
  ]);
  assert.equal(r.summary.peserta, 2);
  assert.equal(r.summary.selesai, 1);
  assert.equal(r.summary.rata_rata, 100);
  assert.equal(r.test.kkm, 70);

  // waktu habis: rekap langsung mengumpulkan attempt budi tanpa menunggu trigger
  env.platform._advance(60 * 60 + ExamEngine.SAVE_GRACE_SECONDS + 1);
  r = ok(call(env.admin, 'result.list', { test_ref: env.t.test_id }));
  const budi = r.rows.find((x) => x.username === 'budi');
  assert.equal(budi.status, 'WAKTU_HABIS');
  assert.equal(budi.nilai_akhir, 0);
  assert.equal(budi.tuntas, false);
  assert.deepEqual([r.summary.selesai, r.summary.rata_rata, r.summary.tertinggi, r.summary.terendah, r.summary.tuntas], [2, 50, 100, 0, 1]);
});

test('rekap: detail jawaban dengan kunci, dan analisis butir', () => {
  const env = seed();
  const kode = openTest(env);
  const a = finish(env, env.ani, kode, ALL_RIGHT);
  finish(env, env.budi, kode, (q) => ({ PG: 'A', PGK: ['A'] })[q.tipe]);

  const d = ok(call(env.admin, 'result.detail', { attempt_ref: a.attempt_id }));
  assert.equal(d.siswa.username, 'ani');
  assert.deepEqual(d.items.map((i) => i.question_id), a.questions.map((q) => q.question_id)); // urutan sesuai yang dilihat siswa
  const pg = d.items.find((i) => i.tipe === 'PG');
  assert.deepEqual([pg.kunci, pg.jawaban, pg.skor], ['B', 'B', 2]);

  const an = ok(call(env.admin, 'result.analysis', { test_ref: env.t.test_id }));
  assert.equal(an.peserta, 2);
  const byTipe = (t) => an.items.find((i) => i.tipe === t);
  assert.equal(byTipe('PG').tingkat_benar, 0.5);
  assert.deepEqual(byTipe('PG').pilihan.map((o) => [o.id, o.jumlah]), [['A', 1], ['B', 1], ['C', 0]]);
  assert.equal(byTipe('PGK').tingkat_benar, 0.75); // (4 + 2) / (2 x 4)
  assert.equal(byTipe('ISIAN').dijawab, 1);
  assert.equal(byTipe('ISIAN').pilihan, null);
});

test('rekap: hanya ADMIN dan GURU pengampu, dan hanya sekolah sendiri', () => {
  const env = seed();
  ok(call(env.admin, 'user.create', { username: 'gurumtk', nama: 'Guru MTK', role: 'GURU', password: 'guru1234', mapel_diampu: 'MTK' }));
  ok(call(env.admin, 'user.create', { username: 'guruipa', nama: 'Guru IPA', role: 'GURU', password: 'guru1234', mapel_diampu: 'IPA' }));
  ok(call(env.admin, 'user.create', { username: 'awas', nama: 'Pengawas', role: 'PENGAWAS', password: 'awas1234' }));
  const kode = openTest(env);
  const a = finish(env, env.ani, kode, ALL_RIGHT);

  ok(call(loginAs('ESPEGE', 'gurumtk', 'guru1234'), 'result.list', { test_ref: env.t.test_id }));
  const ipa = loginAs('ESPEGE', 'guruipa', 'guru1234');
  assert.equal(err(call(ipa, 'result.list', { test_ref: env.t.test_id })), 'FORBIDDEN');
  assert.equal(err(call(ipa, 'result.detail', { attempt_ref: a.attempt_id })), 'FORBIDDEN');
  assert.equal(err(call(loginAs('ESPEGE', 'awas', 'awas1234'), 'result.list', { test_ref: env.t.test_id })), 'FORBIDDEN');
  assert.equal(err(call(env.ani, 'result.detail', { attempt_ref: a.attempt_id })), 'FORBIDDEN');

  const root = loginAs('PUSAT', 'root', 'rootpass');
  const other = ok(call(root, 'school.create', { nama_sekolah: 'SMP Lain', nama_unik: 'LAIN' }));
  ok(call(root, 'user.create', { target_school: other.school_id, username: 'admin2', nama: 'Admin 2', role: 'ADMIN', password: 'adminpass' }));
  const admin2 = loginAs('LAIN', 'admin2', 'adminpass');
  assert.equal(err(call(admin2, 'result.list', { test_ref: env.t.test_id })), 'NOT_FOUND');
  assert.equal(err(call(admin2, 'result.detail', { attempt_ref: a.attempt_id })), 'NOT_FOUND');
});
