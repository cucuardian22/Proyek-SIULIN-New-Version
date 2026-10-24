/**
 * Pengguna: daftar, tambah, ubah, import, export.
 *
 * ADMIN mengelola pengguna sekolahnya sendiri (school_id dari sesi).
 * SUPER_ADMIN mengelola pengguna sekolah mana pun dengan menyebut target_school
 * (school_id kiriman client selalu dibuang oleh Api).
 */
var UserService = (function () {
  var MANAGED_ROLES = ['ADMIN', 'GURU', 'PENGAWAS', 'SISWA'];
  var STATUSES = ['AKTIF', 'NONAKTIF'];
  var USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,40}$/;
  var PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // tanpa huruf/angka yang mirip (l, 1, o, 0, i)
  var IMPORT_MAX_ROWS = 100;

  var PUBLIC_FIELDS = ['user_id', 'school_id', 'role', 'username', 'nama', 'kelas', 'mapel_diampu', 'status', 'created_at', 'updated_at'];

  function toPublic(u) { return Utils.pick(u, PUBLIC_FIELDS); }

  /** school_id yang dikelola: milik sesi untuk ADMIN, target_school untuk SUPER_ADMIN. */
  function targetSchool(ctx, payload) {
    if (ctx.role !== 'SUPER_ADMIN') return ctx.schoolId;
    var id = String(payload.target_school || '').trim();
    if (!id) Utils.fail('INVALID_INPUT', 'Pilih sekolah lebih dulu.');
    if (!Repos.schools().findById(ctx, id)) Utils.fail('NOT_FOUND', 'Sekolah tidak ditemukan.');
    return id;
  }

  function generatePassword() {
    var hex = Platform.randomToken();
    var out = '';
    for (var i = 0; i < 8; i++) out += PASSWORD_ALPHABET.charAt(parseInt(hex.substr(i * 2, 2), 16) % PASSWORD_ALPHABET.length);
    return out;
  }

  function parseMapel(v) {
    if (Array.isArray(v)) return v.map(function (x) { return String(x).trim().toUpperCase(); }).filter(String);
    return String(v || '').split(/[,;]/).map(function (x) { return x.trim().toUpperCase(); }).filter(String);
  }

  /** Normalisasi + validasi satu pengguna baru. Mengembalikan { row, errors }. */
  function prepareNew(input, takenUsernames) {
    var errors = [];
    var row = {
      username: String(input.username || '').trim(),
      nama: String(input.nama || '').trim(),
      role: String(input.role || 'SISWA').trim().toUpperCase(),
      kelas: String(input.kelas || '').trim(),
      mapel_diampu: parseMapel(input.mapel_diampu),
      status: 'AKTIF'
    };
    if (!USERNAME_PATTERN.test(row.username)) errors.push('Username 3-40 karakter: huruf, angka, titik, garis bawah, atau strip.');
    else if (takenUsernames[row.username.toLowerCase()]) errors.push('Username ' + row.username + ' sudah dipakai.');
    if (!row.nama) errors.push('Nama wajib diisi.');
    if (MANAGED_ROLES.indexOf(row.role) < 0) errors.push('Peran harus salah satu dari ' + MANAGED_ROLES.join(', ') + '.');
    if (row.role === 'SISWA' && !row.kelas) errors.push('Kelas wajib diisi untuk siswa.');

    var password = String(input.password || '');
    if (password && password.length < 6) errors.push('Password minimal 6 karakter.');
    return { row: row, password: password, errors: errors };
  }

  function usernamesOf(ctx, schoolId) {
    var taken = {};
    Repos.users().findMany(ctx, { school_id: schoolId }).forEach(function (u) { taken[u.username.toLowerCase()] = true; });
    return taken;
  }

  function withPassword(row, password) {
    var fields = Auth.makePasswordFields(password);
    row.password_hash = fields.password_hash;
    row.salt = fields.salt;
    row.hash_algo = fields.hash_algo;
    return row;
  }

  // ---------- rute ----------

  function list(ctx, payload) {
    var schoolId = targetSchool(ctx, payload);
    var filter = { school_id: schoolId };
    if (payload.role) filter.role = String(payload.role).toUpperCase();
    if (payload.kelas) filter.kelas = String(payload.kelas);
    return Repos.users().findMany(ctx, filter).map(toPublic).sort(function (a, b) {
      return (a.role + a.kelas + a.nama).localeCompare(b.role + b.kelas + b.nama);
    });
  }

  /** @return {{user:Object, password:string}} password dikembalikan sekali agar bisa diberikan ke pengguna. */
  function create(ctx, payload) {
    var schoolId = targetSchool(ctx, payload);
    var prepared = prepareNew(payload, usernamesOf(ctx, schoolId));
    if (prepared.errors.length) Utils.fail('INVALID_INPUT', prepared.errors.join(' '));
    var password = prepared.password || generatePassword();
    var row = withPassword(prepared.row, password);
    row.school_id = schoolId;
    return { user: toPublic(Repos.users().insert(ctx, row)), password: prepared.password ? '' : password };
  }

  function update(ctx, payload) {
    var id = String(payload.user_ref || '');
    var current = Repos.users().findById(ctx, id);
    // findById sudah membatasi ADMIN ke sekolahnya sendiri.
    if (!current || current.role === 'SUPER_ADMIN') Utils.fail('NOT_FOUND', 'Pengguna tidak ditemukan.');

    var patch = {};
    if (payload.nama !== undefined) {
      patch.nama = String(payload.nama).trim();
      if (!patch.nama) Utils.fail('INVALID_INPUT', 'Nama wajib diisi.');
    }
    if (payload.kelas !== undefined) patch.kelas = String(payload.kelas).trim();
    if (payload.mapel_diampu !== undefined) patch.mapel_diampu = parseMapel(payload.mapel_diampu);
    if (payload.role !== undefined) {
      patch.role = String(payload.role).toUpperCase();
      if (MANAGED_ROLES.indexOf(patch.role) < 0) Utils.fail('INVALID_INPUT', 'Peran tidak valid.');
    }
    if (payload.status !== undefined) {
      patch.status = String(payload.status).toUpperCase();
      if (STATUSES.indexOf(patch.status) < 0) Utils.fail('INVALID_INPUT', 'Status harus AKTIF atau NONAKTIF.');
    }
    if (id === ctx.userId && (patch.status === 'NONAKTIF' || (patch.role && patch.role !== current.role))) {
      Utils.fail('INVALID_INPUT', 'Anda tidak bisa menonaktifkan atau mengubah peran akun sendiri.');
    }

    var newPassword = '';
    if (payload.reset_password) {
      newPassword = String(payload.new_password || '') || generatePassword();
      withPassword(patch, newPassword);
    }

    var updated = Repos.users().update(ctx, id, patch);
    if (patch.status === 'NONAKTIF' || payload.reset_password) Auth.revokeUserSessions(id);
    return { user: toPublic(updated), password: payload.reset_password && !payload.new_password ? newPassword : '' };
  }

  /**
   * Import paling banyak IMPORT_MAX_ROWS baris per panggilan (client mengirim bertahap).
   * Semua baris divalidasi dulu; bila ada satu yang salah, tidak ada yang disimpan.
   * dry_run: hanya validasi (tanpa hash password), dipakai client untuk memeriksa
   * seluruh file sebelum kiriman pertama disimpan.
   * @param {{rows: Array<Object>, target_school?: string, dry_run?: boolean}} payload
   * @return {{inserted:number, errors:Array<{row:number, messages:string[]}>, credentials:Array<{username, password}>}}
   */
  function importRows(ctx, payload) {
    var schoolId = targetSchool(ctx, payload);
    var rows = Array.isArray(payload.rows) ? payload.rows : [];
    if (!rows.length) Utils.fail('INVALID_INPUT', 'Tidak ada baris untuk diimport.');
    if (rows.length > IMPORT_MAX_ROWS) Utils.fail('INVALID_INPUT', 'Maksimal ' + IMPORT_MAX_ROWS + ' baris per kiriman.');

    var taken = usernamesOf(ctx, schoolId);
    var errors = [];
    var ready = [];
    rows.forEach(function (input, i) {
      var p = prepareNew(input || {}, taken);
      if (p.errors.length) errors.push({ row: Number(input && input._row) || i + 1, messages: p.errors });
      else {
        taken[p.row.username.toLowerCase()] = true;
        ready.push(p);
      }
    });
    if (errors.length || payload.dry_run) return { inserted: 0, errors: errors, credentials: [] };

    var credentials = [];
    var toInsert = ready.map(function (p) {
      var password = p.password || generatePassword();
      credentials.push({ username: p.row.username, nama: p.row.nama, kelas: p.row.kelas, password: p.password ? '' : password });
      var row = withPassword(p.row, password);
      row.school_id = schoolId;
      return row;
    });
    Repos.users().insertMany(ctx, toInsert);
    return { inserted: toInsert.length, errors: [], credentials: credentials };
  }

  return {
    IMPORT_MAX_ROWS: IMPORT_MAX_ROWS,
    list: list,
    create: create,
    update: update,
    importRows: importRows,
    generatePassword: generatePassword
  };
})();

if (typeof module !== 'undefined') module.exports = UserService;
