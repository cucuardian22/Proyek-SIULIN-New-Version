const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/load');

const call = (sid, route, payload) => Api.handle(route, sid, payload);
const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.error)); return r.data; };
const loginAs = (kode, username, password) => ok(call(null, 'auth.login', { kode_sekolah: kode, username, password })).session_id;

function seed() {
  loadApp();
  Repos.users().insert(Auth.SYSTEM, Object.assign({ school_id: '', role: 'SUPER_ADMIN', username: 'root', nama: 'Root', status: 'AKTIF' }, Auth.makePasswordFields('rootpass')));
  const root = loginAs('PUSAT', 'root', 'rootpass');
  const topic = ok(call(root, 'topic.create', { nama_topik: 'ASAT Genap', inisial: 'ASAT_Genap', tahun_ajaran: '2026/2027' }));
  const sessions = { root };
  for (const code of ['ESPEGE', 'LAIN']) {
    const school = ok(call(root, 'school.create', { nama_sekolah: 'Sekolah ' + code, nama_unik: code }));
    ok(call(root, 'user.create', { target_school: school.school_id, username: 'admin', nama: 'Admin', role: 'ADMIN', password: 'adminpass' }));
    sessions[code] = loginAs(code, 'admin', 'adminpass');
  }
  ok(call(sessions.ESPEGE, 'user.create', { username: 'guru', nama: 'Guru MTK', role: 'GURU', password: 'gurupass', mapel_diampu: 'MTK' }));
  sessions.guru = loginAs('ESPEGE', 'guru', 'gurupass');
  return { topic, s: sessions };
}

const examInput = (topic, extra = {}) => Object.assign({ topic_id: topic.topic_id, kode_mapel: 'mtk', nama_mapel: 'Matematika', kelas: '7' }, extra);

test('topik: hanya SUPER_ADMIN yang membuat, inisial unik per tahun ajaran', () => {
  const { topic, s } = seed();
  assert.equal(topic.status, 'AKTIF');
  assert.equal(call(s.ESPEGE, 'topic.create', { nama_topik: 'X', inisial: 'X1', tahun_ajaran: '2026/2027' }).error.code, 'FORBIDDEN');
  assert.equal(call(s.root, 'topic.create', { nama_topik: 'X', inisial: 'asat_genap', tahun_ajaran: '2026/2027' }).error.code, 'DUPLICATE');
  ok(call(s.root, 'topic.create', { nama_topik: 'X', inisial: 'ASAT_Genap', tahun_ajaran: '2027/2028' }));
  assert.equal(call(s.root, 'topic.create', { nama_topik: 'X', inisial: 'Y', tahun_ajaran: '2026' }).error.code, 'INVALID_INPUT');
  assert.equal(ok(call(s.guru, 'topic.list', {})).length, 2);
});

test('ujian: nama otomatis, unik per topik/mapel/kelas, terisolasi per sekolah', () => {
  const { topic, s } = seed();
  const e = ok(call(s.ESPEGE, 'exam.create', examInput(topic)));
  assert.equal(e.nama_ujian, 'ESPEGE_ASAT_Genap_MTK_7');
  assert.equal(call(s.ESPEGE, 'exam.create', examInput(topic)).error.code, 'DUPLICATE');
  ok(call(s.LAIN, 'exam.create', examInput(topic))); // sekolah lain boleh punya ujian yang sama
  assert.deepEqual(ok(call(s.LAIN, 'exam.list', {})).map((x) => x.nama_ujian), ['LAIN_ASAT_Genap_MTK_7']);
  assert.equal(call(s.LAIN, 'exam.update', { exam_ref: e.exam_id, kelas: '8' }).error.code, 'NOT_FOUND');
  const u = ok(call(s.ESPEGE, 'exam.update', { exam_ref: e.exam_id, kelas: '8' }));
  assert.equal(u.nama_ujian, 'ESPEGE_ASAT_Genap_MTK_8');
});

test('GURU hanya mengelola mapel yang diampu', () => {
  const { topic, s } = seed();
  ok(call(s.guru, 'exam.create', examInput(topic)));
  assert.equal(call(s.guru, 'exam.create', examInput(topic, { kode_mapel: 'IPA', nama_mapel: 'IPA' })).error.code, 'FORBIDDEN');
  const ipa = ok(call(s.ESPEGE, 'exam.create', examInput(topic, { kode_mapel: 'IPA', nama_mapel: 'IPA' })));
  assert.deepEqual(ok(call(s.guru, 'exam.list', {})).map((x) => x.kode_mapel), ['MTK']);
  assert.equal(call(s.guru, 'question.create', { exam_ref: ipa.exam_id, tipe: 'PG', teks: 'x', opsi: [{ teks: 'a' }, { teks: 'b' }], kunci: 'A' }).error.code, 'FORBIDDEN');
});

test('soal: semua tipe tersimpan dengan bentuk kunci yang benar', () => {
  const { topic, s } = seed();
  const e = ok(call(s.guru, 'exam.create', examInput(topic)));
  const add = (q) => ok(call(s.guru, 'question.create', Object.assign({ exam_ref: e.exam_id, teks: 'Soal', bobot: 2 }, q)));
  const pg = add({ tipe: 'pg', opsi: [{ teks: '1' }, { teks: '2' }, { teks: '3' }], kunci: 'b' });
  assert.deepEqual(pg.opsi.map((o) => o.id), ['A', 'B', 'C']);
  assert.equal(pg.kunci, 'B');
  assert.equal(pg.scope, 'SCHOOL');
  const pgk = add({ tipe: 'PGK', opsi: [{ teks: '1' }, { teks: '2' }, { teks: '3' }], kunci: 'a, c' });
  assert.deepEqual(pgk.kunci, ['A', 'C']);
  const bs = add({ tipe: 'PGBS', opsi: [{ teks: 'p1' }, { teks: 'p2' }], kunci: { 1: 'b', 2: 's' } });
  assert.deepEqual(bs.kunci, { 1: 'B', 2: 'S' });
  const isian = add({ tipe: 'ISIAN', kunci: 'Jakarta|DKI Jakarta' });
  assert.deepEqual(isian.kunci, ['Jakarta', 'DKI Jakarta']);
  add({ tipe: 'URAIAN', kunci: '' });
  assert.equal(call(s.guru, 'question.create', { exam_ref: e.exam_id, tipe: 'PGK', teks: 'x', opsi: [{ teks: '1' }, { teks: '2' }], kunci: 'A,B' }).error.code, 'INVALID_INPUT');
  assert.equal(call(s.guru, 'question.create', { exam_ref: e.exam_id, tipe: 'PG', teks: 'x', opsi: [{ teks: '1' }, { teks: '2' }], kunci: 'A', media_url: 'http://x' }).error.code, 'INVALID_INPUT');

  const listed = ok(call(s.guru, 'question.list', { exam_ref: e.exam_id }));
  assert.equal(listed.questions.length, 5);
  assert.equal(ok(call(s.guru, 'exam.list', {})).at(0).jumlah_soal, 5);
  assert.equal(call(s.ESPEGE, 'exam.remove', { exam_ref: e.exam_id }).error.code, 'IN_USE');

  // skor dengan kunci yang tersimpan
  assert.equal(ScoringService.scoreQuestion(pgk, ['A', 'C']), 2);
  assert.equal(ScoringService.scoreQuestion(bs, { 1: 'B', 2: 'B' }), 1);
});

test('soal sekolah lain tidak bisa dibaca atau diubah', () => {
  const { topic, s } = seed();
  const e = ok(call(s.ESPEGE, 'exam.create', examInput(topic)));
  const q = ok(call(s.ESPEGE, 'question.create', { exam_ref: e.exam_id, tipe: 'PG', teks: 'x', opsi: [{ teks: '1' }, { teks: '2' }], kunci: 'A' }));
  assert.equal(call(s.LAIN, 'question.list', { exam_ref: e.exam_id }).error.code, 'NOT_FOUND');
  assert.equal(call(s.LAIN, 'question.update', { question_ref: q.question_id, tipe: 'PG', teks: 'y', opsi: [{ teks: '1' }, { teks: '2' }], kunci: 'B' }).error.code, 'NOT_FOUND');
  assert.equal(call(s.LAIN, 'question.remove', { question_ref: q.question_id }).error.code, 'NOT_FOUND');
  const upd = ok(call(s.ESPEGE, 'question.update', { question_ref: q.question_id, tipe: 'PG', teks: 'y', opsi: [{ teks: '1' }, { teks: '2' }], kunci: 'B' }));
  assert.equal(upd.kunci, 'B');
  ok(call(s.ESPEGE, 'question.remove', { question_ref: q.question_id }));
  assert.equal(ok(call(s.ESPEGE, 'question.list', { exam_ref: e.exam_id })).questions.length, 0);
});

test('bank soal pusat: GLOBAL, terbaca semua sekolah, hanya pusat yang mengubah', () => {
  const { topic, s } = seed();
  const g = ok(call(s.root, 'exam.create', examInput(topic)));
  assert.equal(g.nama_ujian, 'PUSAT_ASAT_Genap_MTK_7');
  assert.equal(g.school_id, '');
  const q = ok(call(s.root, 'question.create', { exam_ref: g.exam_id, tipe: 'PG', teks: 'x', opsi: [{ teks: '1' }, { teks: '2' }], kunci: 'A' }));
  assert.equal(q.scope, 'GLOBAL');

  const seen = ok(call(s.ESPEGE, 'exam.list', {}));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].editable, false);
  assert.equal(seen[0].jumlah_soal, 1);
  assert.equal(ok(call(s.ESPEGE, 'question.list', { exam_ref: g.exam_id })).editable, false);
  assert.equal(call(s.ESPEGE, 'question.create', { exam_ref: g.exam_id, tipe: 'PG', teks: 'x', opsi: [{ teks: '1' }, { teks: '2' }], kunci: 'A' }).error.code, 'NOT_FOUND');
  assert.equal(call(s.ESPEGE, 'question.remove', { question_ref: q.question_id }).error.code, 'NOT_FOUND');
  // SUPER_ADMIN tidak ikut melihat ujian sekolah di bank soal pusat
  ok(call(s.ESPEGE, 'exam.create', examInput(topic)));
  assert.equal(ok(call(s.root, 'exam.list', {})).length, 1);
});

test('import soal dari template: validasi per baris, semua atau tidak sama sekali', () => {
  const { topic, s } = seed();
  const e = ok(call(s.ESPEGE, 'exam.create', examInput(topic)));
  const rows = [
    { _row: 2, tipe: 'PG', teks: 'Ibu kota Indonesia?', bobot: '1', a: 'Bandung', b: 'Jakarta', c: 'Surabaya', kunci: 'B' },
    { _row: 3, tipe: 'PGK', teks: 'Bilangan prima?', bobot: '2', a: '2', b: '4', c: '5', kunci: 'A,C' },
    { _row: 4, tipe: 'PGBS', teks: 'Benar atau salah', bobot: '3', a: '2+2=4', b: '3>5', c: '0 genap', kunci: 'B,S,B' },
    { _row: 5, tipe: 'PGST', teks: 'Setuju?', bobot: '2', a: 'p1', b: 'p2', kunci: 'S,TS' },
    { _row: 6, tipe: 'ISIAN', teks: '5x5?', kunci: '25|dua puluh lima' },
    { _row: 7, tipe: 'URAIAN', teks: 'Jelaskan', bobot: '5' }
  ];
  const bad = ok(call(s.ESPEGE, 'question.import', { exam_ref: e.exam_id, rows: rows.concat([
    { _row: 8, tipe: 'PG', teks: 'x', a: '1', b: '2', kunci: 'C' },
    { _row: 9, tipe: 'PGBS', teks: 'x', a: '1', b: '2', kunci: 'B' },
    { _row: 10, tipe: 'ESAI', teks: 'x' }
  ]) }));
  assert.equal(bad.inserted, 0);
  assert.deepEqual(bad.errors.map((x) => x.row), [8, 9, 10]);
  assert.match(bad.errors[1].messages.join(' '), /Jumlah kunci \(1\)/);

  assert.equal(ok(call(s.ESPEGE, 'question.import', { exam_ref: e.exam_id, rows, dry_run: true })).inserted, 0);
  assert.equal(ok(call(s.ESPEGE, 'question.import', { exam_ref: e.exam_id, rows })).inserted, 6);
  const qs = ok(call(s.ESPEGE, 'question.list', { exam_ref: e.exam_id })).questions;
  const bs = qs.find((q) => q.tipe === 'PGBS');
  assert.deepEqual(bs.kunci, { 1: 'B', 2: 'S', 3: 'B' });
  assert.equal(bs.bobot, 3);
  assert.equal(qs.find((q) => q.tipe === 'ISIAN').bobot, 1); // bobot kosong = 1
});
