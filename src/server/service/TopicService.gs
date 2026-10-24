/**
 * Topik ujian nasional (mis. ASAT Genap 2026/2027). Dibuat SUPER_ADMIN, dibaca semua sekolah.
 */
var TopicService = (function () {
  var INITIAL_PATTERN = /^[A-Za-z0-9_]{2,30}$/;
  var YEAR_PATTERN = /^\d{4}\/\d{4}$/;

  function clean(p) {
    var out = {};
    if (p.nama_topik !== undefined) out.nama_topik = String(p.nama_topik).trim();
    if (p.inisial !== undefined) out.inisial = String(p.inisial).trim();
    if (p.tahun_ajaran !== undefined) out.tahun_ajaran = String(p.tahun_ajaran).trim();
    if (p.status !== undefined) out.status = String(p.status).trim().toUpperCase();
    return out;
  }

  function validate(ctx, data, existingId) {
    if (data.nama_topik !== undefined && !data.nama_topik) Utils.fail('INVALID_INPUT', 'Nama topik wajib diisi.');
    if (data.inisial !== undefined) {
      if (!INITIAL_PATTERN.test(data.inisial)) Utils.fail('INVALID_INPUT', 'Inisial 2-30 karakter: huruf, angka, atau garis bawah. Contoh: ASAT_Genap');
      var same = Repos.topics().findMany(ctx).filter(function (t) {
        return t.inisial.toLowerCase() === data.inisial.toLowerCase() && t.topic_id !== existingId &&
          (data.tahun_ajaran === undefined || t.tahun_ajaran === data.tahun_ajaran);
      });
      if (same.length) Utils.fail('DUPLICATE', 'Inisial ' + data.inisial + ' sudah dipakai di tahun ajaran yang sama.');
    }
    if (data.tahun_ajaran !== undefined && !YEAR_PATTERN.test(data.tahun_ajaran)) Utils.fail('INVALID_INPUT', 'Tahun ajaran ditulis seperti 2026/2027.');
    if (data.status !== undefined && ['AKTIF', 'NONAKTIF'].indexOf(data.status) < 0) Utils.fail('INVALID_INPUT', 'Status harus AKTIF atau NONAKTIF.');
  }

  function list(ctx, payload) {
    var rows = Repos.topics().findMany(ctx);
    if (payload && payload.active_only) rows = rows.filter(function (t) { return t.status === 'AKTIF'; });
    return rows.sort(function (a, b) {
      return (b.tahun_ajaran + a.nama_topik).localeCompare(a.tahun_ajaran + b.nama_topik);
    });
  }

  function create(ctx, payload) {
    var data = clean(payload);
    if (!data.nama_topik || !data.inisial || !data.tahun_ajaran) Utils.fail('INVALID_INPUT', 'Nama topik, inisial, dan tahun ajaran wajib diisi.');
    if (!data.status) data.status = 'AKTIF';
    validate(ctx, data, null);
    return Repos.topics().insert(ctx, data);
  }

  function update(ctx, payload) {
    var current = Repos.topics().findById(ctx, payload.topic_ref);
    if (!current) Utils.fail('NOT_FOUND', 'Topik tidak ditemukan.');
    var data = clean(payload);
    if (data.inisial !== undefined && data.tahun_ajaran === undefined) data.tahun_ajaran = current.tahun_ajaran;
    validate(ctx, data, current.topic_id);
    return Repos.topics().update(ctx, current.topic_id, data);
  }

  return { list: list, create: create, update: update };
})();

if (typeof module !== 'undefined') module.exports = TopicService;
