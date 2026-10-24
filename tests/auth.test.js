const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/load');

function seed() {
  const platform = loadApp();
  const SYS = Auth.SYSTEM;
  const school = Repos.schools().insert(SYS, { nama_sekolah: 'SMP Contoh', nama_unik: 'ESPEGE', status: 'AKTIF' });
  const mk = (role, username, password, extra = {}) => Repos.users().insert(SYS, Object.assign({
    school_id: school.school_id, role, username, nama: username, status: 'AKTIF'
  }, Auth.makePasswordFields(password), extra));
  mk('SISWA', 'siswa1', 'rahasia123');
  mk('ADMIN', 'admin', 'adminpass');
  mk('SISWA', 'nonaktif', 'rahasia123', { status: 'NONAKTIF' });
  mk('SUPER_ADMIN', 'root', 'rootpass', { school_id: '' });
  return { platform, school };
}

const login = (kode_sekolah, username, password) =>
  Api.handle('auth.login', null, { kode_sekolah, username, password });

test('hash password: salt berbeda, verifikasi benar/salah', () => {
  loadApp();
  const a = Auth.makePasswordFields('rahasia123');
  const b = Auth.makePasswordFields('rahasia123');
  assert.notEqual(a.password_hash, b.password_hash);
  assert.equal(Auth.verifyPassword(a, 'rahasia123'), true);
  assert.equal(Auth.verifyPassword(a, 'rahasia124'), false);
  assert.throws(() => Auth.makePasswordFields('123'), { code: 'WEAK_PASSWORD' });
});

test('login siswa berhasil, sesi membawa school_id dari server', () => {
  const { school } = seed();
  const r = login('espege', 'SISWA1', 'rahasia123');
  assert.equal(r.ok, true);
  assert.equal(r.data.user.role, 'SISWA');
  assert.equal(r.data.user.nama_sekolah, 'SMP Contoh');
  assert.equal(r.data.user.password_hash, undefined);
  const s = Auth.getSession(r.data.session_id);
  assert.equal(s.school_id, school.school_id);
});

test('login gagal memberi pesan yang sama untuk semua sebab', () => {
  seed();
  for (const args of [['ESPEGE', 'siswa1', 'salah'], ['ESPEGE', 'tidakada', 'x'], ['LAIN', 'siswa1', 'rahasia123'], ['ESPEGE', 'nonaktif', 'rahasia123'], ['ESPEGE', 'root', 'rootpass']]) {
    const r = login(...args);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'INVALID_LOGIN', args.join(','));
  }
});

test('SUPER_ADMIN login dengan kode PUSAT', () => {
  seed();
  assert.equal(login('PUSAT', 'root', 'rootpass').ok, true);
  assert.equal(login('PUSAT', 'admin', 'adminpass').error.code, 'INVALID_LOGIN');
});

test('dikunci setelah 5 kali gagal, terbuka lagi setelah 15 menit', () => {
  const { platform } = seed();
  for (let i = 0; i < 5; i++) login('ESPEGE', 'siswa1', 'salah');
  assert.equal(login('ESPEGE', 'siswa1', 'rahasia123').error.code, 'LOCKED');
  platform._advance(15 * 60 + 1);
  assert.equal(login('ESPEGE', 'siswa1', 'rahasia123').ok, true);
});

test('sesi tetap berlaku saat cache hilang, dan berakhir setelah 6 jam', () => {
  const { platform } = seed();
  const id = login('ESPEGE', 'siswa1', 'rahasia123').data.session_id;
  platform._cache.clear();
  assert.equal(Api.handle('auth.me', id).ok, true);
  platform._advance(6 * 3600 + 1);
  assert.equal(Api.handle('auth.me', id).error.code, 'UNAUTHENTICATED');
});

test('logout mematikan sesi meski cache dibersihkan', () => {
  const { platform } = seed();
  const id = login('ESPEGE', 'siswa1', 'rahasia123').data.session_id;
  assert.equal(Api.handle('auth.logout', id).ok, true);
  platform._cache.clear();
  assert.equal(Api.handle('auth.me', id).error.code, 'UNAUTHENTICATED');
});

test('Api: rute tanpa sesi ditolak, school_id dari client dibuang, izin peran dicek', () => {
  seed();
  assert.equal(Api.handle('auth.me', 'palsu').error.code, 'UNAUTHENTICATED');
  assert.equal(Api.handle('tidak.ada', null).error.code, 'NOT_FOUND');

  let seen = null;
  Api.register('test.echo', { permission: 'user.manage', handler: (ctx, payload) => { seen = { ctx, payload }; return 1; } });
  const siswa = login('ESPEGE', 'siswa1', 'rahasia123').data.session_id;
  assert.equal(Api.handle('test.echo', siswa, {}).error.code, 'FORBIDDEN');

  const admin = login('ESPEGE', 'admin', 'adminpass').data;
  const r = Api.handle('test.echo', admin.session_id, { school_id: 'sekolah-lain', a: 1 });
  assert.equal(r.ok, true);
  assert.deepEqual(seen.payload, { a: 1 });
  assert.equal(seen.ctx.schoolId, admin.user.school_id);
  delete Api.ROUTES['test.echo'];
});

test('Api: error tak terduga tidak membocorkan detail', () => {
  seed();
  Api.register('test.boom', { public: true, handler: () => { throw new Error('rahasia internal'); } });
  const orig = console.log; console.log = () => {};
  const r = Api.handle('test.boom', null, {});
  console.log = orig;
  assert.deepEqual(r.error, { code: 'INTERNAL', message: 'Terjadi kesalahan di server.' });
  delete Api.ROUTES['test.boom'];
});
