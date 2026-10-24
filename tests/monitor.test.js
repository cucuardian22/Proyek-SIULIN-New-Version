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


function withStaff(env) {
  ok(call(env.admin, 'user.create', { username: 'awas', nama: 'Pengawas', role: 'PENGAWAS', password: 'awas1234' }));
  ok(call(env.admin, 'user.create', { username: 'guruipa', nama: 'Guru IPA', role: 'GURU', password: 'guru1234', mapel_diampu: 'IPA' }));
  env.awas = loginAs('ESPEGE', 'awas', 'awas1234');
  env.ipa = loginAs('ESPEGE', 'guruipa', 'guru1234');
  return env;
}
const row = (m, u) => m.rows.find((r) => r.username === u);

test('monitoring: status, progres dari auto-save, dan tanda terputus', () => {
  const env = withStaff(seed());
  assert.equal(ok(call(env.awas, 'monitor.tests')).length, 0); // belum berlangsung
  const kode = openTest(env);
  assert.deepEqual(ok(call(env.awas, 'monitor.tests')).map((t) => t.test_id), [env.t.test_id]);

  const pkg = ok(call(env.ani, 'attempt.start', { test_ref: env.t.test_id, token: kode }));
  const [q1, q2] = pkg.questions;
  ok(call(env.ani, 'attempt.save', { attempt_ref: pkg.attempt_id, seq: 1, jawaban: { [q1.question_id]: 'A', [q2.question_id]: [] }, jumlah_pindah_tab: 2 }));

  let m = ok(call(env.awas, 'monitor.list', { test_ref: env.t.test_id }));
  assert.deepEqual(m.summary, { peserta: 2, belum: 1, mengerjakan: 1, selesai: 0, terputus: 0 });
  const ani = row(m, 'ani');
  assert.deepEqual([ani.status, ani.terjawab, ani.jumlah_soal, ani.pindah_tab, ani.sisa_detik], ['MENGERJAKAN', 1, 4, 2, 3600]);
  assert.equal(ani.nilai_akhir, undefined, 'pengawas tidak melihat nilai');
  assert.equal(row(m, 'budi').status, 'BELUM');

  env.platform._advance(4 * 60);
  m = ok(call(env.awas, 'monitor.list', { test_ref: env.t.test_id }));
  assert.equal(row(m, 'ani').terputus, true);
  assert.equal(m.summary.terputus, 1);
});

test('monitoring: tambah waktu sampai ke timer siswa, dan timer habis lama tidak mengumpulkan', () => {
  const env = withStaff(seed());
  const kode = openTest(env);
  const pkg = ok(call(env.ani, 'attempt.start', { test_ref: env.t.test_id, token: kode }));
  assert.equal(err(call(env.awas, 'monitor.extend', { attempt_ref: pkg.attempt_id, menit: 0 })), 'INVALID_INPUT');
  assert.equal(err(call(env.awas, 'monitor.extend', { attempt_ref: pkg.attempt_id, menit: 61 })), 'INVALID_INPUT');
  assert.equal(ok(call(env.awas, 'monitor.extend', { attempt_ref: pkg.attempt_id, menit: 10 })).batas_waktu, at(81));

  // timer lama di perangkat siswa habis: server menolak mengumpulkan dan mengirim batas baru
  env.platform._advance(60 * 60);
  const r = ok(call(env.ani, 'attempt.submit', { attempt_ref: pkg.attempt_id, seq: 1, jawaban: {}, auto: true }));
  assert.deepEqual([r.status, r.batas_waktu], ['PROGRESS', at(81)]);
  assert.equal(ok(call(env.ani, 'attempt.save', { attempt_ref: pkg.attempt_id, seq: 2, jawaban: {} })).batas_waktu, at(81));

  // setelah batas baru lewat, auto-submit diterima
  env.platform._advance(10 * 60);
  assert.equal(ok(call(env.ani, 'attempt.submit', { attempt_ref: pkg.attempt_id, seq: 3, jawaban: {}, auto: true })).status, 'SUBMITTED');
  assert.equal(err(call(env.awas, 'monitor.extend', { attempt_ref: pkg.attempt_id, menit: 5 })), 'DONE');
});

test('monitoring: kumpulkan paksa memakai auto-save terakhir, siswa lalu mendapat DONE', () => {
  const env = withStaff(seed());
  const kode = openTest(env);
  const pkg = ok(call(env.ani, 'attempt.start', { test_ref: env.t.test_id, token: kode }));
  const pg = pkg.questions.find((q) => q.tipe === 'PG').question_id;
  ok(call(env.ani, 'attempt.save', { attempt_ref: pkg.attempt_id, seq: 1, jawaban: { [pg]: 'B' } }));

  assert.equal(ok(call(env.awas, 'monitor.submit', { attempt_ref: pkg.attempt_id })).status, 'SELESAI');
  assert.equal(Repos.results().findById(Auth.SYSTEM, pkg.attempt_id).skor_otomatis, 2);
  assert.equal(err(call(env.ani, 'attempt.save', { attempt_ref: pkg.attempt_id, seq: 2, jawaban: {} })), 'DONE');
  assert.equal(ok(call(env.ani, 'attempt.submit', { attempt_ref: pkg.attempt_id, seq: 2, jawaban: {}, auto: true })).status, 'SUBMITTED');
  assert.equal(err(call(env.awas, 'monitor.submit', { attempt_ref: pkg.attempt_id })), 'DONE');
  assert.equal(row(ok(call(env.awas, 'monitor.list', { test_ref: env.t.test_id })), 'ani').status, 'SELESAI');
});

test('monitoring: hak akses', () => {
  const env = withStaff(seed());
  const kode = openTest(env);
  const pkg = ok(call(env.ani, 'attempt.start', { test_ref: env.t.test_id, token: kode }));
  assert.equal(ok(call(env.ipa, 'monitor.tests')).length, 0); // guru mapel lain tidak melihat tes MTK
  assert.equal(err(call(env.ipa, 'monitor.list', { test_ref: env.t.test_id })), 'FORBIDDEN');
  assert.equal(err(call(env.ipa, 'monitor.submit', { attempt_ref: pkg.attempt_id })), 'FORBIDDEN');
  assert.equal(err(call(env.ani, 'monitor.list', { test_ref: env.t.test_id })), 'FORBIDDEN');
  assert.equal(err(call(env.budi, 'monitor.extend', { attempt_ref: pkg.attempt_id, menit: 30 })), 'FORBIDDEN');
  ok(call(env.admin, 'monitor.list', { test_ref: env.t.test_id }));

  const root = loginAs('PUSAT', 'root', 'rootpass');
  const other = ok(call(root, 'school.create', { nama_sekolah: 'SMP Lain', nama_unik: 'LAIN' }));
  ok(call(root, 'user.create', { target_school: other.school_id, username: 'awas2', nama: 'Pengawas 2', role: 'PENGAWAS', password: 'awas1234' }));
  const awas2 = loginAs('LAIN', 'awas2', 'awas1234');
  assert.equal(err(call(awas2, 'monitor.list', { test_ref: env.t.test_id })), 'NOT_FOUND');
  assert.equal(err(call(awas2, 'monitor.submit', { attempt_ref: pkg.attempt_id })), 'NOT_FOUND');
});
