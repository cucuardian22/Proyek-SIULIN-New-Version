/**
 * Data sekolah. Hanya SUPER_ADMIN (izin school.manage) yang memanggil ini.
 */
var SchoolService = (function () {
  var STATUSES = ['AKTIF', 'NONAKTIF'];
  var CODE_PATTERN = /^[A-Z0-9_]{3,20}$/;

  function clean(p) {
    var out = {};
    if (p.nama_sekolah !== undefined) out.nama_sekolah = String(p.nama_sekolah).trim();
    if (p.nama_unik !== undefined) out.nama_unik = String(p.nama_unik).trim().toUpperCase();
    if (p.jenjang !== undefined) out.jenjang = String(p.jenjang).trim().toUpperCase();
    if (p.alamat !== undefined) out.alamat = String(p.alamat).trim();
    if (p.status !== undefined) out.status = String(p.status).trim().toUpperCase();
    return out;
  }

  function validate(ctx, data, existingId) {
    if (data.nama_sekolah !== undefined && !data.nama_sekolah) Utils.fail('INVALID_INPUT', 'Nama sekolah wajib diisi.');
    if (data.nama_unik !== undefined) {
      if (!CODE_PATTERN.test(data.nama_unik)) {
        Utils.fail('INVALID_INPUT', 'Kode sekolah 3-20 karakter: huruf besar, angka, atau garis bawah.');
      }
      if (data.nama_unik === Config.SUPER_ADMIN_SCHOOL_CODE) Utils.fail('INVALID_INPUT', 'Kode ' + data.nama_unik + ' dipakai sistem.');
      var other = SchoolRepo.findByCode(ctx, data.nama_unik);
      if (other && other.school_id !== existingId) Utils.fail('DUPLICATE', 'Kode sekolah ' + data.nama_unik + ' sudah dipakai.');
    }
    if (data.status !== undefined && STATUSES.indexOf(data.status) < 0) Utils.fail('INVALID_INPUT', 'Status harus AKTIF atau NONAKTIF.');
  }

  function list(ctx) {
    return Repos.schools().findMany(ctx).sort(function (a, b) {
      return a.nama_sekolah.localeCompare(b.nama_sekolah);
    });
  }

  function create(ctx, payload) {
    var data = clean(payload);
    if (!data.nama_sekolah || !data.nama_unik) Utils.fail('INVALID_INPUT', 'Nama dan kode sekolah wajib diisi.');
    if (!data.status) data.status = 'AKTIF';
    validate(ctx, data, null);
    return Repos.schools().insert(ctx, data);
  }

  function update(ctx, payload) {
    if (Utils.isBlank(payload.school_ref)) Utils.fail('INVALID_INPUT', 'Sekolah yang diubah belum dipilih.');
    var data = clean(payload);
    validate(ctx, data, payload.school_ref);
    return Repos.schools().update(ctx, payload.school_ref, data);
  }

  return { list: list, create: create, update: update };
})();

if (typeof module !== 'undefined') module.exports = SchoolService;
