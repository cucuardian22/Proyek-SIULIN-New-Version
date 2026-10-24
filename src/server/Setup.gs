/**
 * Jalankan dari editor Apps Script (bukan dari web app).
 *
 * 1. setupSiulin()       -> membuat spreadsheet MASTER dan ATTEMPT (bila belum ada),
 *                           semua sheet, header, dan format kolom teks.
 * 2. Isi Script Properties SETUP_ADMIN_USER dan SETUP_ADMIN_PASSWORD, lalu
 *    setupSuperAdmin()   -> membuat akun SUPER_ADMIN (login dengan kode sekolah PUSAT).
 *    Password dihapus dari Script Properties setelah dipakai.
 *
 * 3. setupTriggers()     -> memasang trigger tiap 10 menit yang mengumpulkan ujian
 *                           yang waktunya habis tanpa ditekan "Selesai".
 *
 * Aman dijalankan berulang: sheet yang sudah benar tidak diubah.
 *
 * Khusus project uji beban (bukan klaster sekolah): setupLoadTest() dan stopLoadTest(),
 * lihat bagian "Uji beban" di README.
 */
function setupSiulin() {
  ['MASTER', 'ATTEMPT'].forEach(function (db) {
    var ss = openOrCreateSpreadsheet_(db);
    Schema.names().forEach(function (name) {
      var t = Schema.get(name);
      if (t.db === db) ensureSheet_(ss, name, t);
    });
    var blank = ss.getSheetByName('Sheet1');
    if (blank && ss.getSheets().length > 1) ss.deleteSheet(blank);
    Logger.log(db + ': ' + ss.getUrl());
  });
}

function openOrCreateSpreadsheet_(db) {
  var key = db + '_ID';
  var id = PropertiesService.getScriptProperties().getProperty(key);
  if (id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.create('SIULIN_' + db);
  PropertiesService.getScriptProperties().setProperty(key, ss.getId());
  return ss;
}

function ensureSheet_(ss, name, table) {
  var header = table.columns.map(function (c) { return c.name; });
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);

  if (sh.getLastRow() > 1) {
    var current = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    if (current.join('|') !== header.join('|')) {
      throw new Error('Header sheet ' + name + ' berbeda dengan Schema dan sheet sudah berisi data. ' +
        'Sesuaikan kolom secara manual (urutan harus sama dengan Schema.gs).');
    }
    return;
  }

  if (sh.getMaxColumns() < header.length) sh.insertColumnsAfter(sh.getMaxColumns(), header.length - sh.getMaxColumns());
  // Semua kolom disimpan sebagai teks agar NISN/kode tidak kehilangan nol di depan dan tanggal tidak diubah.
  sh.getRange(1, 1, sh.getMaxRows(), header.length).setNumberFormat('@');
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  sh.setFrozenRows(1);
}

function setupSuperAdmin() {
  var props = PropertiesService.getScriptProperties();
  var username = props.getProperty('SETUP_ADMIN_USER');
  var password = props.getProperty('SETUP_ADMIN_PASSWORD');
  if (!username || !password) {
    throw new Error('Isi Script Properties SETUP_ADMIN_USER dan SETUP_ADMIN_PASSWORD dulu.');
  }
  if (UserRepo.findByLogin(Auth.SYSTEM, '', username)) {
    throw new Error('SUPER_ADMIN dengan username ' + username + ' sudah ada.');
  }

  var started = Date.now();
  var fields = Auth.makePasswordFields(password);
  Logger.log('Waktu hash password: ' + (Date.now() - started) + ' ms (target < 300 ms, atur Config.HASH_ITERATIONS)');

  Repos.users().insert(Auth.SYSTEM, {
    school_id: '',
    role: 'SUPER_ADMIN',
    username: username,
    password_hash: fields.password_hash,
    salt: fields.salt,
    hash_algo: fields.hash_algo,
    nama: 'Super Admin',
    kelas: '',
    mapel_diampu: [],
    status: 'AKTIF'
  });
  props.deleteProperty('SETUP_ADMIN_PASSWORD');
  Logger.log('SUPER_ADMIN dibuat. Login dengan kode sekolah ' + Config.SUPER_ADMIN_SCHOOL_CODE + '.');
}

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'finalizeExpiredAttempts') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('finalizeExpiredAttempts').timeBased().everyMinutes(10).create();
  Logger.log('Trigger finalizeExpiredAttempts terpasang (tiap 10 menit).');
}

/**
 * Project uji beban saja. Isi Script Properties LOADTEST_PASSWORD (min. 8 karakter) dan
 * opsional LOADTEST_STUDENTS (bawaan 200), jalankan setupSiulin() lalu fungsi ini.
 */
function setupLoadTest() {
  var props = PropertiesService.getScriptProperties();
  var info = LoadTest.prepare({
    students: Number(props.getProperty('LOADTEST_STUDENTS') || 200),
    password: props.getProperty('LOADTEST_PASSWORD') || ''
  });
  props.setProperty('LOADTEST_ENABLED', 'true');
  Logger.log('Uji beban siap. Kode sekolah ' + info.kode_sekolah + ', siswa ub001 s.d. ub' +
    ('00' + info.students).slice(-3) + ', pengawas ' + info.pengawas + ', token ' + info.token + '.');
  Logger.log('Deploy sebagai Web app, lalu jalankan: node tools/loadtest.js --url <URL web app> --token ' + info.token +
    ' --students ' + info.students + ' --password <LOADTEST_PASSWORD>');
}

/** Matikan pintu uji beban (doPost) setelah selesai. */
function stopLoadTest() {
  PropertiesService.getScriptProperties().setProperty('LOADTEST_ENABLED', 'false');
  Logger.log('Mode uji beban dimatikan.');
}
