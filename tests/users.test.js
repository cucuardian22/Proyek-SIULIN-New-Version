const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/load');

const call = (sid, route, payload) => Api.handle(route, sid, payload);
const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.error)); return r.data; };

function seed() {
  const platform = loadApp();
  Repos.users().insert(Auth.SYSTEM, Object.assign({ school_id: '', role: 'SUPER_ADMIN', username: 'root', nama: 'Root', status: 'AKTIF' }, Auth.makePasswordFields('rootpass')));
  const root = ok(call(null, 'auth.login', { kode_sekolah: 'PUSAT', username: 'root', password: 'rootpass' })).session_id;
  return { platform, root };
}

function schoolWithAdmin(root, code) {
  const school = ok(call(root, 'school.create', { nama_sekolah: 'Sekolah ' + code, nama_unik: code, jenjang: 'smp' }));
  ok(call(root, 'user.create', { target_school: school.school_id, username: 'admin', nama: 'Admin ' + code, role: 'ADMIN', password: 'adminpass' }));
  const admin = ok(call(null, 'auth.login', { kode_sekolah: code, username: 'admin', password: 'adminpass' })).session_id;
  return { school, admin };
}

test('SUPER_ADMIN membuat sekolah; kode unik, huruf besar, dan tidak boleh PUSAT', () => {
  const { root } = seed();
  const s = ok(call(root, 'school.create', { nama_sekolah: 'SMP 1', nama_unik: 'smp_satu' }));
  assert.equal(s.nama_unik, 'SMP_SATU');
  assert.equal(s.status, 'AKTIF');
  assert.equal(call(root, 'school.create', { nama_sekolah: 'X', nama_unik: 'SMP_SATU' }).error.code, 'DUPLICATE');
  assert.equal(call(root, 'school.create', { nama_sekolah: 'X', nama_unik: 'PUSAT' }).error.code, 'INVALID_INPUT');
  assert.equal(call(root, 'school.create', { nama_sekolah: 'X', nama_unik: 'a b' }).error.code, 'INVALID_INPUT');
  ok(call(root, 'school.update', { school_ref: s.school_id, status: 'NONAKTIF' }));
  assert.equal(ok(call(root, 'school.list')).at(0).status, 'NONAKTIF');
});

test('ADMIN sekolah tidak bisa mengelola sekolah', () => {
  const { root } = seed();
  const { admin } = schoolWithAdmin(root, 'ESPEGE');
  assert.equal(call(admin, 'school.list').error.code, 'FORBIDDEN');
});

test('ADMIN menambah pengguna; password dibuat otomatis bila kosong dan bisa dipakai login', () => {
  const { root } = seed();
  const { admin, school } = schoolWithAdmin(root, 'ESPEGE');
  const r = ok(call(admin, 'user.create', { username: 'siswa1', nama: 'Ani', role: 'siswa', kelas: '7A', school_id: 'sekolah-lain' }));
  assert.equal(r.user.school_id, school.school_id);
  assert.equal(r.user.password_hash, undefined);
  assert.match(r.password, /^[a-z2-9]{8}$/);
  assert.equal(ok(call(null, 'auth.login', { kode_sekolah: 'ESPEGE', username: 'siswa1', password: r.password })).user.nama, 'Ani');

  assert.equal(call(admin, 'user.create', { username: 'SISWA1', nama: 'B', kelas: '7A' }).error.code, 'INVALID_INPUT');
  assert.equal(call(admin, 'user.create', { username: 'x2', nama: 'B', role: 'SUPER_ADMIN' }).error.code, 'INVALID_INPUT');
  assert.equal(call(admin, 'user.create', { username: 'siswa2', nama: 'B', role: 'SISWA' }).error.code, 'INVALID_INPUT'); // tanpa kelas
});

test('ADMIN hanya melihat dan mengubah pengguna sekolahnya', () => {
  const { root } = seed();
  const a = schoolWithAdmin(root, 'AAA');
  const b = schoolWithAdmin(root, 'BBB');
  const sa = ok(call(a.admin, 'user.create', { username: 'siswa1', nama: 'Ani', kelas: '7A' })).user;
  assert.deepEqual(ok(call(b.admin, 'user.list', {})).map((u) => u.username), ['admin']);
  assert.equal(call(b.admin, 'user.update', { user_ref: sa.user_id, nama: 'Diubah' }).error.code, 'NOT_FOUND');
  assert.equal(call(b.admin, 'user.list', { target_school: a.school.school_id }).data.length, 1); // target_school diabaikan untuk ADMIN
});

test('nonaktifkan pengguna langsung mengakhiri sesinya', () => {
  const { root } = seed();
  const { admin } = schoolWithAdmin(root, 'ESPEGE');
  const u = ok(call(admin, 'user.create', { username: 'guru1', nama: 'Pak Guru', role: 'GURU', password: 'gurupass', mapel_diampu: 'mtk, ipa' })).user;
  assert.deepEqual(u.mapel_diampu, ['MTK', 'IPA']);
  const guru = ok(call(null, 'auth.login', { kode_sekolah: 'ESPEGE', username: 'guru1', password: 'gurupass' })).session_id;
  ok(call(admin, 'user.update', { user_ref: u.user_id, status: 'NONAKTIF' }));
  assert.equal(call(guru, 'auth.me').error.code, 'UNAUTHENTICATED');
  assert.equal(call(null, 'auth.login', { kode_sekolah: 'ESPEGE', username: 'guru1', password: 'gurupass' }).error.code, 'INVALID_LOGIN');
});

test('reset password memberi password baru dan sesi lama berakhir', () => {
  const { root } = seed();
  const { admin } = schoolWithAdmin(root, 'ESPEGE');
  const u = ok(call(admin, 'user.create', { username: 'siswa1', nama: 'Ani', kelas: '7A', password: 'lama123' })).user;
  const old = ok(call(null, 'auth.login', { kode_sekolah: 'ESPEGE', username: 'siswa1', password: 'lama123' })).session_id;
  const r = ok(call(admin, 'user.update', { user_ref: u.user_id, reset_password: true }));
  assert.equal(r.password.length, 8);
  assert.equal(call(old, 'auth.me').error.code, 'UNAUTHENTICATED');
  assert.equal(call(null, 'auth.login', { kode_sekolah: 'ESPEGE', username: 'siswa1', password: r.password }).ok, true);
});

test('admin tidak bisa menonaktifkan dirinya sendiri', () => {
  const { root } = seed();
  const { admin } = schoolWithAdmin(root, 'ESPEGE');
  const me = ok(call(admin, 'auth.me')).user;
  assert.equal(call(admin, 'user.update', { user_ref: me.user_id, status: 'NONAKTIF' }).error.code, 'INVALID_INPUT');
});

test('import: semua baris divalidasi dulu, gagal satu berarti tidak ada yang disimpan', () => {
  const { root } = seed();
  const { admin } = schoolWithAdmin(root, 'ESPEGE');
  const bad = ok(call(admin, 'user.import', { rows: [
    { _row: 2, username: 'ani', nama: 'A', kelas: '7A' },
    { _row: 3, username: 'ani', nama: 'Dobel', kelas: '7A' },
    { _row: 4, username: '', nama: '', kelas: '' }
  ] }));
  assert.equal(bad.inserted, 0);
  assert.deepEqual(bad.errors.map((e) => e.row), [3, 4]);
  assert.equal(ok(call(admin, 'user.list', { role: 'SISWA' })).length, 0);

  const good = ok(call(admin, 'user.import', { rows: [
    { username: 'ani', nama: 'A', kelas: '7A' },
    { username: 'budi', nama: 'B', kelas: '7B', password: 'sendiri1' },
    { username: 'guru', nama: 'Guru', role: 'GURU', mapel_diampu: 'IPA' }
  ] }));
  assert.equal(good.inserted, 3);
  assert.equal(good.credentials.length, 3);
  assert.equal(good.credentials[1].password, ''); // password dari file tidak dikembalikan
  assert.equal(ok(call(admin, 'user.list', { role: 'SISWA', kelas: '7A' })).length, 1);

  const many = Array.from({ length: 101 }, (_, i) => ({ username: 'x' + i, nama: 'X', kelas: '7A' }));
  assert.equal(call(admin, 'user.import', { rows: many }).error.code, 'INVALID_INPUT');
});

test('SUPER_ADMIN wajib memilih sekolah untuk mengelola pengguna', () => {
  const { root } = seed();
  assert.equal(call(root, 'user.list', {}).error.code, 'INVALID_INPUT');
  assert.equal(call(root, 'user.list', { target_school: 'tidak-ada' }).error.code, 'NOT_FOUND');
});

test('import dry_run hanya memvalidasi', () => {
  const { root } = seed();
  const { admin } = schoolWithAdmin(root, 'ESPEGE');
  const r = ok(call(admin, 'user.import', { dry_run: true, rows: [{ username: 'ani', nama: 'A', kelas: '7A' }] }));
  assert.deepEqual(r, { inserted: 0, errors: [], credentials: [] });
  assert.equal(ok(call(admin, 'user.list', { role: 'SISWA' })).length, 0);
});
