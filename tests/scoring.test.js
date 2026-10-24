const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/load');

loadApp();
const S = global.ScoringService;

test('PG: benar dapat bobot penuh, salah 0, tidak peka huruf besar', () => {
  const q = { tipe: 'PG', kunci: 'B', bobot: 2 };
  assert.equal(S.scoreQuestion(q, 'B'), 2);
  assert.equal(S.scoreQuestion(q, ' b '), 2);
  assert.equal(S.scoreQuestion(q, 'A'), 0);
  assert.equal(S.scoreQuestion(q, null), 0);
  assert.equal(S.scoreQuestion(q, ['B', 'C']), 0);
});

test('PGK: contoh dokumen aturan, kunci [A,C] bobot 4', () => {
  const q = { tipe: 'PGK', kunci: ['A', 'C'], bobot: 4 };
  assert.equal(S.scoreQuestion(q, ['A', 'C']), 4);
  assert.equal(S.scoreQuestion(q, ['A']), 2);
  assert.equal(S.scoreQuestion(q, ['A', 'B']), 0); // 1 benar - 1 salah
  assert.equal(S.scoreQuestion(q, ['A', 'B', 'C', 'D']), 0); // centang semua tidak lagi dapat skor penuh
  assert.equal(S.scoreQuestion(q, ['B', 'D']), 0); // tidak negatif
  assert.equal(S.scoreQuestion(q, ['A', 'A', 'C']), 4); // duplikat diabaikan
});

test('PGK: pembulatan dua desimal', () => {
  const q = { tipe: 'PGK', kunci: ['A', 'B', 'C'], bobot: 1 };
  assert.equal(S.scoreQuestion(q, ['A']), 0.33);
  assert.equal(S.scoreQuestion(q, ['A', 'B']), 0.67);
});

test('PGBS dan PGST: proporsional per pernyataan', () => {
  const bs = { tipe: 'PGBS', kunci: { 1: 'B', 2: 'S', 3: 'B', 4: 'S' }, bobot: 4 };
  assert.equal(S.scoreQuestion(bs, { 1: 'B', 2: 'S', 3: 'S' }), 2);
  assert.equal(S.scoreQuestion(bs, {}), 0);
  assert.equal(S.scoreQuestion(bs, 'B'), 0);
  const st = { tipe: 'PGST', kunci: { a: 'S', b: 'TS' }, bobot: 3 };
  assert.equal(S.scoreQuestion(st, { a: 's', b: 'TS' }), 3);
  assert.equal(S.scoreQuestion(st, { a: 'TS', b: 'TS' }), 1.5);
});

test('ISIAN dan URAIAN menunggu koreksi manual', () => {
  assert.equal(S.scoreQuestion({ tipe: 'URAIAN', bobot: 10 }, 'teks'), null);
});

test('scoreAttempt menjumlah skor dan nilai 0-100', () => {
  const qs = [
    { question_id: 'q1', tipe: 'PG', kunci: 'A', bobot: 2 },
    { question_id: 'q2', tipe: 'PGK', kunci: ['A', 'C'], bobot: 4 },
    { question_id: 'q3', tipe: 'URAIAN', bobot: 4 }
  ];
  const r = S.scoreAttempt(qs, { q1: 'A', q2: ['A'] });
  assert.equal(r.skor_otomatis, 4);
  assert.equal(r.bobot_total, 10);
  assert.equal(r.nilai, 40);
  assert.equal(r.perlu_koreksi, true);
  assert.deepEqual(r.items.map((i) => i.skor), [2, 2, null]);
});

test('validateQuestion menangkap kunci yang salah', () => {
  const opsi = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
  assert.deepEqual(S.validateQuestion({ tipe: 'PG', teks: 'x', bobot: 1, opsi, kunci: 'A' }), []);
  assert.ok(S.validateQuestion({ tipe: 'PG', teks: 'x', bobot: 1, opsi, kunci: ['A', 'B'] }).length);
  assert.ok(S.validateQuestion({ tipe: 'PGK', teks: 'x', bobot: 1, opsi, kunci: ['D'] }).length);
  assert.ok(S.validateQuestion({ tipe: 'PG', teks: 'x', bobot: 0, opsi, kunci: 'A' }).length);
  const pernyataan = [{ id: '1' }, { id: '2' }];
  assert.deepEqual(S.validateQuestion({ tipe: 'PGBS', teks: 'x', bobot: 2, opsi: pernyataan, kunci: { 1: 'B', 2: 'S' } }), []);
  assert.ok(S.validateQuestion({ tipe: 'PGBS', teks: 'x', bobot: 2, opsi: pernyataan, kunci: { 1: 'B', 2: 'TS' } }).length);
  assert.ok(S.validateQuestion({ tipe: 'ESAI', teks: 'x', bobot: 1 }).length);
});
