var UserRepo = {
  /** Pengguna dengan username tertentu di satu sekolah ('' untuk SUPER_ADMIN). */
  findByLogin: function (ctx, schoolId, username) {
    var wanted = String(username || '').trim().toLowerCase();
    if (!wanted) return null;
    return Repos.users().findMany(ctx, { school_id: schoolId }).filter(function (u) {
      return String(u.username).toLowerCase() === wanted;
    })[0] || null;
  }
};

if (typeof module !== 'undefined') module.exports = UserRepo;
