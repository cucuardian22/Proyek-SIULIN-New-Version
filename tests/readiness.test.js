const test = require('node:test');
const assert = require('node:assert');
const Readiness = require('../src/server/Readiness.gs');

function ready(over = {}) {
  return Object.assign({
    timeZone: 'Asia/Jakarta',
    dbs: ['MASTER', 'ATTEMPT', 'JAWABAN', 'HASIL'].map((db) => ({ db, ok: true, sheets: [{ name: 'X', ok: true }] })),
    superAdmins: 1, setupPasswordLeft: false, triggerInstalled: true,
    loadTestEnabled: false, loadTestSchool: false,
    schools: [{ nama_unik: 'SMPN1', status: 'AKTIF', admin: 1, guru: 5, pengawas: 2, siswa: 180, tes: 3 }]
  }, over);
}
const levels = (r, level) => r.filter((x) => x.level === level).map((x) => x.pesan);

test('klaster lengkap dinyatakan SIAP tanpa peringatan', () => {
  const r = Readiness.evaluate(ready());
  assert.deepStrictEqual(levels(r, 'GAGAL'), []);
  assert.deepStrictEqual(levels(r, 'PERINGATAN'), []);
  assert.match(Readiness.format(r), /\nSIAP\.$/);
});

test('mode uji beban, trigger, dan SUPER_ADMIN yang hilang adalah GAGAL', () => {
  const r = Readiness.evaluate(ready({ loadTestEnabled: true, triggerInstalled: false, superAdmins: 0 }));
  const fails = levels(r, 'GAGAL').join('\n');
  assert.match(fails, /stopLoadTest/);
  assert.match(fails, /setupTriggers/);
  assert.match(fails, /setupSuperAdmin/);
  assert.match(Readiness.format(r), /BELUM SIAP: 3 masalah/);
});

test('spreadsheet belum dibuat dan header berbeda dilaporkan per sheet', () => {
  const r = Readiness.evaluate(ready({ dbs: [
    { db: 'MASTER', ok: false, error: 'belum dibuat' },
    { db: 'HASIL', ok: true, sheets: [{ name: 'Results', ok: false, error: 'header berbeda dengan Schema.gs' }] }
  ] }));
  assert.deepStrictEqual(levels(r, 'GAGAL'), [
    'Spreadsheet MASTER: belum dibuat. Jalankan setupSiulin.',
    'Sheet HASIL/Results: header berbeda dengan Schema.gs'
  ]);
});

test('peringatan: akun sekolah kurang, siswa di atas kapasitas, sisa data uji beban', () => {
  const r = Readiness.evaluate(ready({
    setupPasswordLeft: true, loadTestSchool: true, timeZone: 'UTC',
    schools: [
      { nama_unik: 'UJIBEBAN', status: 'AKTIF', admin: 0, guru: 0, pengawas: 1, siswa: 600, tes: 1 },
      { nama_unik: 'SMAN2', status: 'AKTIF', admin: 1, guru: 0, pengawas: 0, siswa: 320, tes: 0 }
    ]
  }));
  const warns = levels(r, 'PERINGATAN').join('\n');
  assert.match(warns, /SETUP_ADMIN_PASSWORD/);
  assert.match(warns, /UJIBEBAN/);
  assert.match(warns, /Asia\/Jakarta/);
  assert.match(warns, /SMAN2 belum punya akun GURU, PENGAWAS/);
  assert.match(warns, /320 siswa/);
  assert.doesNotMatch(warns, /Sekolah UJIBEBAN belum punya/);
  assert.match(Readiness.format(r), /SIAP dengan 5 peringatan/);
});

test('tanpa sekolah: peringatan untuk menambah sekolah', () => {
  const r = Readiness.evaluate(ready({ schools: [] }));
  assert.match(levels(r, 'PERINGATAN')[0], /tambah sekolah/);
});
