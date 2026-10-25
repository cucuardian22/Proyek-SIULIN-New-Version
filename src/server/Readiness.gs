/**
 * Cek kesiapan klaster sebelum dipakai sekolah. Murni: hanya menilai fakta yang dikumpulkan
 * cekKesiapan() di Setup.gs, supaya bisa diuji di Node.js.
 *
 * facts = {
 *   timeZone: 'Asia/Jakarta',
 *   dbs: [{ db, ok, error, sheets: [{ name, ok, error }] }],
 *   superAdmins: number, setupPasswordLeft: bool,
 *   triggerInstalled: bool, loadTestEnabled: bool, loadTestSchool: bool,
 *   schools: [{ nama_unik, status, admin, guru, pengawas, siswa, tes }]
 * }
 * Hasil: [{ level: 'OK' | 'PERINGATAN' | 'GAGAL', pesan }]
 */
var Readiness = (function () {
  function evaluate(f) {
    var out = [];
    function add(level, pesan) { out.push({ level: level, pesan: pesan }); }

    (f.dbs || []).forEach(function (d) {
      if (!d.ok) { add('GAGAL', 'Spreadsheet ' + d.db + ': ' + (d.error || 'belum dibuat') + '. Jalankan setupSiulin.'); return; }
      var bad = (d.sheets || []).filter(function (s) { return !s.ok; });
      if (bad.length) bad.forEach(function (s) { add('GAGAL', 'Sheet ' + d.db + '/' + s.name + ': ' + s.error); });
      else add('OK', 'Spreadsheet ' + d.db + ' dan semua sheet-nya sesuai skema.');
    });

    if (f.timeZone !== 'Asia/Jakarta') add('PERINGATAN', 'Zona waktu project ' + f.timeZone + ', seharusnya Asia/Jakarta.');

    if (!f.superAdmins) add('GAGAL', 'Belum ada akun SUPER_ADMIN. Jalankan setupSuperAdmin.');
    else add('OK', 'Akun SUPER_ADMIN: ' + f.superAdmins + '.');
    if (f.setupPasswordLeft) add('PERINGATAN', 'Script Property SETUP_ADMIN_PASSWORD masih ada. Hapus dari Project Settings.');

    if (!f.triggerInstalled) add('GAGAL', 'Trigger finalizeExpiredAttempts belum terpasang. Jalankan setupTriggers.');
    else add('OK', 'Trigger pengumpulan otomatis terpasang.');

    if (f.loadTestEnabled) add('GAGAL', 'LOADTEST_ENABLED = true. Ini klaster sekolah: jalankan stopLoadTest.');
    if (f.loadTestSchool) add('PERINGATAN', 'Ada sekolah UJIBEBAN. Klaster sekolah sebaiknya memakai project dan spreadsheet baru, bukan project uji beban.');

    var schools = (f.schools || []).filter(function (s) { return s.nama_unik !== 'UJIBEBAN'; });
    if (!schools.length) add('PERINGATAN', 'Belum ada sekolah. Login sebagai SUPER_ADMIN (kode PUSAT) lalu tambah sekolah.');
    schools.forEach(function (s) {
      var name = 'Sekolah ' + s.nama_unik;
      if (s.status !== 'AKTIF') { add('PERINGATAN', name + ' berstatus ' + s.status + '.'); return; }
      var missing = [];
      if (!s.admin) missing.push('ADMIN');
      if (!s.guru) missing.push('GURU');
      if (!s.pengawas) missing.push('PENGAWAS');
      if (!s.siswa) missing.push('SISWA');
      if (missing.length) add('PERINGATAN', name + ' belum punya akun ' + missing.join(', ') + '.');
      if (s.siswa > 200) {
        add('PERINGATAN', name + ' punya ' + s.siswa + ' siswa. Kapasitas uji beban 200 siswa serentak: bagi ke beberapa sesi.');
      }
      add('OK', name + ': ' + s.admin + ' admin, ' + s.guru + ' guru, ' + s.pengawas + ' pengawas, ' + s.siswa + ' siswa, ' + s.tes + ' tes.');
    });
    return out;
  }

  /** Teks siap cetak di Logger. */
  function format(results) {
    var gagal = results.filter(function (r) { return r.level === 'GAGAL'; }).length;
    var warn = results.filter(function (r) { return r.level === 'PERINGATAN'; }).length;
    var lines = results.map(function (r) { return '[' + r.level + '] ' + r.pesan; });
    lines.push(gagal ? 'BELUM SIAP: ' + gagal + ' masalah harus diperbaiki.' :
      (warn ? 'SIAP dengan ' + warn + ' peringatan.' : 'SIAP.'));
    return lines.join('\n');
  }

  return { evaluate: evaluate, format: format };
})();

if (typeof module !== 'undefined') module.exports = Readiness;
