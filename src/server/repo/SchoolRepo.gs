var SchoolRepo = {
  /** Cari sekolah aktif berdasarkan kode unik (mis. ESPEGE), tanpa membedakan huruf besar. */
  findByCode: function (ctx, code) {
    var wanted = String(code || '').trim().toUpperCase();
    if (!wanted) return null;
    return Repos.schools().findMany(ctx).filter(function (s) {
      return String(s.nama_unik).toUpperCase() === wanted;
    })[0] || null;
  }
};

if (typeof module !== 'undefined') module.exports = SchoolRepo;
