const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/load');

function setup(enabled = true) {
  const platform = loadApp();
  platform.prop = (k) => (k === 'LOADTEST_ENABLED' && enabled ? 'true' : null);
  return platform;
}
const post = (body) => LoadTest.handlePost(JSON.stringify(body));
const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.error)); return r.data; };

test('prepare membuat sekolah, siswa, tes berlangsung, dan token', () => {
  setup();
  const info = LoadTest.prepare({ students: 30, password: 'ujibeban123' });
  assert.equal(info.kode_sekolah, 'UJIBEBAN');
  assert.equal(info.token.length, 6);
  assert.equal(Repos.users().findMany(Auth.SYSTEM, { role: 'SISWA' }).length, 30);
  assert.equal(Repos.questions().findMany(Auth.SYSTEM).length, 40);
  assert.throws(() => LoadTest.prepare({ students: 30, password: 'ujibeban123' }), /sudah ada/);
});

test('alur siswa dan pengawas lewat handlePost', () => {
  setup();
  const info = LoadTest.prepare({ students: 3, password: 'ujibeban123' });
  const sid = ok(post({ route: 'auth.login', payload: { kode_sekolah: 'ujibeban', username: 'ub002', password: 'ujibeban123' } })).session_id;
  const list = ok(post({ route: 'attempt.list', session_id: sid }));
  assert.equal(list[0].test_id, info.test_id);
  const pkg = ok(post({ route: 'attempt.start', session_id: sid, payload: { test_ref: info.test_id, token: info.token } }));
  assert.equal(pkg.questions.length, 40);
  ok(post({ route: 'attempt.save', session_id: sid, payload: { attempt_ref: pkg.attempt_id, seq: 1, jawaban: { [pkg.questions[0].question_id]: 'A' } } }));
  assert.equal(ok(post({ route: 'attempt.submit', session_id: sid, payload: { attempt_ref: pkg.attempt_id, seq: 2, jawaban: {} } })).status, 'SUBMITTED');

  const awas = ok(post({ route: 'auth.login', payload: { kode_sekolah: 'UJIBEBAN', username: 'ubawas', password: 'ujibeban123' } })).session_id;
  const m = ok(post({ route: 'monitor.list', session_id: awas, payload: { test_ref: info.test_id } }));
  assert.equal(m.summary.peserta, 3);
  assert.equal(m.summary.selesai, 1);
});

test('handlePost mati bila LOADTEST_ENABLED bukan true, dan hanya rute ujian', () => {
  setup(false);
  assert.equal(post({ route: 'auth.login', payload: {} }).error.code, 'DISABLED');
  setup(true);
  assert.equal(post({ route: 'user.create', payload: {} }).error.code, 'NOT_FOUND');
  assert.equal(post({ route: 'result.list', payload: {} }).error.code, 'NOT_FOUND');
  assert.equal(LoadTest.handlePost('bukan json').error.code, 'INVALID_INPUT');
});

test('galat INTERNAL membawa pesan hanya di mode uji beban', () => {
  for (const enabled of [true, false]) {
    setup(enabled);
    const info = LoadTest.prepare({ students: 1, password: 'ujibeban123' });
    const sid = Auth.login({ kode_sekolah: 'UJIBEBAN', username: 'ub001', password: 'ujibeban123' }).session_id;
    const original = ExamEngine.start;
    ExamEngine.start = () => { throw new Error('Service Spreadsheets timed out'); };
    try {
      const r = Api.handle('attempt.start', sid, { test_ref: info.test_id, token: info.token });
      assert.equal(r.error.code, 'INTERNAL');
      assert.equal(r.error.detail, enabled ? 'Service Spreadsheets timed out' : undefined);
    } finally {
      ExamEngine.start = original;
    }
  }
});

test('cache tabel yang potongannya tidak cocok dibaca ulang dari sheet', () => {
  const platform = setup();
  LoadTest.prepare({ students: 2, password: 'ujibeban123' });
  Repos.users().findMany(Auth.SYSTEM); // isi cache
  platform.cache().put('tbl:Users:0', '[{"rusak":', 600);
  assert.equal(Repos.users().findMany(Auth.SYSTEM, { role: 'SISWA' }).length, 2);
});
