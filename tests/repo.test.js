const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/load');

const A = { userId: 'u-a', schoolId: 'school-a', role: 'ADMIN' };
const B = { userId: 'u-b', schoolId: 'school-b', role: 'ADMIN' };

test('repository menolak akses tanpa ctx', () => {
  loadApp();
  assert.throws(() => Repos.exams().findMany(null), { code: 'NO_CONTEXT' });
  assert.throws(() => Repos.exams().insert(undefined, {}), { code: 'NO_CONTEXT' });
});

test('insert memaksa school_id dari sesi, bukan dari data', () => {
  loadApp();
  const row = Repos.exams().insert(A, { nama_mapel: 'IPA', school_id: 'school-b' });
  assert.equal(row.school_id, 'school-a');
  assert.match(row.exam_id, /^[0-9a-f-]{36}$/);
  assert.ok(row.created_at);
});

test('sekolah lain tidak bisa membaca, mengubah, atau menghapus data', () => {
  loadApp();
  const a = Repos.exams().insert(A, { nama_mapel: 'IPA' });
  Repos.exams().insert(B, { nama_mapel: 'IPS' });

  assert.deepEqual(Repos.exams().findMany(A).map((e) => e.nama_mapel), ['IPA']);
  assert.equal(Repos.exams().findById(B, a.exam_id), null);
  assert.throws(() => Repos.exams().update(B, a.exam_id, { nama_mapel: 'X' }), { code: 'NOT_FOUND' });
  assert.throws(() => Repos.exams().softDelete(B, a.exam_id), { code: 'NOT_FOUND' });
  assert.equal(Repos.exams().findMany({ role: 'SUPER_ADMIN' }).length, 2);
});

test('update tidak bisa memindahkan baris ke sekolah lain', () => {
  loadApp();
  const a = Repos.exams().insert(A, { nama_mapel: 'IPA' });
  const next = Repos.exams().update(A, a.exam_id, { nama_mapel: 'Fisika', school_id: 'school-b', exam_id: 'lain' });
  assert.equal(next.nama_mapel, 'Fisika');
  assert.equal(next.school_id, 'school-a');
  assert.equal(next.exam_id, a.exam_id);
});

test('soal GLOBAL terbaca semua sekolah tetapi hanya pemiliknya yang bisa mengubah', () => {
  loadApp();
  const g = Repos.questions().insert(A, { scope: 'GLOBAL', tipe: 'PG', teks: 'g', bobot: 1 });
  Repos.questions().insert(A, { scope: 'SCHOOL', tipe: 'PG', teks: 's', bobot: 1 });
  assert.deepEqual(Repos.questions().findMany(B).map((q) => q.teks), ['g']);
  assert.throws(() => Repos.questions().update(B, g.question_id, { teks: 'ubah' }), { code: 'NOT_FOUND' });
});

test('hapus lunak menyembunyikan baris', () => {
  loadApp();
  const a = Repos.exams().insert(A, { nama_mapel: 'IPA' });
  Repos.exams().softDelete(A, a.exam_id);
  assert.equal(Repos.exams().findById(A, a.exam_id), null);
});

test('tipe kolom tersimpan sebagai teks dan terbaca kembali dengan benar', () => {
  const p = loadApp();
  const t = Repos.tests().insert(A, { judul: '=HYPERLINK("x")', durasi_menit: 90, acak_soal: true, acak_opsi: false });
  const raw = p._sheets['MASTER:Tests'];
  const row = raw.rows[0];
  const col = (n) => row[raw.header.indexOf(n)];
  assert.equal(col('durasi_menit'), '90');
  assert.equal(col('acak_soal'), 'TRUE');
  assert.equal(col('judul').startsWith("'="), true);

  const back = Repos.tests().findById(A, t.test_id);
  assert.equal(back.durasi_menit, 90);
  assert.equal(back.acak_soal, true);
  assert.equal(back.acak_opsi, false);

  const u = Repos.users().insert(A, { username: 'x', mapel_diampu: ['MTK', 'IPA'] });
  assert.deepEqual(Repos.users().findById(A, u.user_id).mapel_diampu, ['MTK', 'IPA']);
});

test('cache tabel dibuang setelah tulis', () => {
  loadApp();
  Repos.exams().insert(A, { nama_mapel: 'IPA' });
  assert.equal(Repos.exams().findMany(A).length, 1); // mengisi cache
  Repos.exams().insert(A, { nama_mapel: 'IPS' });
  assert.equal(Repos.exams().findMany(A).length, 2);
});
