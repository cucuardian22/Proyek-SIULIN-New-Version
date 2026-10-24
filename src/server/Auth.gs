/**
 * Login, logout, sesi, dan hash password.
 *
 * Sesi disimpan di CacheService (cepat) dan di sheet Sessions (cadangan bila
 * cache terhapus). Client hanya memegang session_id; school_id dan role
 * selalu dibaca dari sesi di server.
 */
var Auth = (function () {
  var SYSTEM = { system: true };

  // ---------- password ----------

  function hashPassword(password, salt, iterations) {
    var h = Platform.hmacSha256Hex(salt, String(password));
    for (var i = 1; i < iterations; i++) h = Platform.hmacSha256Hex(salt, h + String(password));
    return h;
  }

  function algoFor(iterations) { return Config.HASH_ALGO_PREFIX + ':' + iterations; }

  function iterationsOf(algo) {
    var m = /^hmac-sha256-iter:(\d+)$/.exec(String(algo || ''));
    if (!m) throw new Utils.AppError('BAD_HASH', 'Format hash password tidak dikenal.');
    return Number(m[1]);
  }

  function safeEqual(a, b) {
    a = String(a); b = String(b);
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  /** Kolom password untuk pengguna baru atau ganti password. */
  function makePasswordFields(password) {
    if (Utils.isBlank(password) || String(password).length < 6) {
      throw new Utils.AppError('WEAK_PASSWORD', 'Password minimal 6 karakter.');
    }
    var salt = Platform.randomToken().slice(0, 32);
    return {
      salt: salt,
      hash_algo: algoFor(Config.HASH_ITERATIONS),
      password_hash: hashPassword(password, salt, Config.HASH_ITERATIONS)
    };
  }

  function verifyPassword(user, password) {
    var hash = hashPassword(password, user.salt, iterationsOf(user.hash_algo));
    return safeEqual(hash, user.password_hash);
  }

  // ---------- batas percobaan login ----------

  function failKey(code, username) {
    return 'lf:' + String(code).toUpperCase() + ':' + String(username).toLowerCase();
  }

  function failCount(key) { return Number(Platform.cache().get(key) || 0); }

  function recordFail(key) {
    Platform.cache().put(key, String(failCount(key) + 1), Config.LOGIN_LOCK_SECONDS);
  }

  // ---------- sesi ----------

  function sessionKey(id) { return 'sess:' + id; }

  function cacheSession(s) {
    var ttl = Math.floor((Date.parse(s.expires_at) - Platform.now().getTime()) / 1000);
    if (ttl > 0) Platform.cache().put(sessionKey(s.session_id), JSON.stringify(s), Math.min(ttl, 21600));
  }

  function publicUser(user, school) {
    return {
      user_id: user.user_id,
      nama: user.nama,
      username: user.username,
      role: user.role,
      kelas: user.kelas,
      school_id: user.school_id,
      nama_sekolah: school ? school.nama_sekolah : 'Pusat'
    };
  }

  /**
   * @param {{kode_sekolah:string, username:string, password:string}} p
   * @return {{session_id:string, user:Object, expires_at:string}}
   */
  function login(p) {
    p = p || {};
    var code = String(p.kode_sekolah || '').trim().toUpperCase();
    var username = String(p.username || '').trim();
    if (!code || !username || Utils.isBlank(p.password)) {
      throw new Utils.AppError('INVALID_INPUT', 'Kode sekolah, username, dan password wajib diisi.');
    }

    var key = failKey(code, username);
    if (failCount(key) >= Config.LOGIN_MAX_FAILS) {
      throw new Utils.AppError('LOCKED', 'Terlalu banyak percobaan gagal. Coba lagi 15 menit lagi.');
    }

    var invalid = new Utils.AppError('INVALID_LOGIN', 'Kode sekolah, username, atau password salah.');
    var school = null;
    var schoolId = '';
    if (code !== Config.SUPER_ADMIN_SCHOOL_CODE) {
      school = SchoolRepo.findByCode(SYSTEM, code);
      if (!school || school.status !== 'AKTIF') { recordFail(key); throw invalid; }
      schoolId = school.school_id;
    }

    var user = UserRepo.findByLogin(SYSTEM, schoolId, username);
    var ok = user && user.status === 'AKTIF' && verifyPassword(user, p.password) &&
      (school ? user.role !== 'SUPER_ADMIN' : user.role === 'SUPER_ADMIN');
    if (!ok) { recordFail(key); throw invalid; }

    Platform.cache().remove(key);

    var session = {
      session_id: Platform.randomToken(),
      user_id: user.user_id,
      school_id: user.school_id,
      role: user.role,
      expires_at: Utils.addSeconds(Utils.nowIso(), Config.SESSION_TTL_SECONDS)
    };
    Repos.sessions().insert(SYSTEM, session);
    session.user = publicUser(user, school);
    cacheSession(session);

    return { session_id: session.session_id, user: session.user, expires_at: session.expires_at };
  }

  /**
   * Sesi yang masih berlaku, atau null.
   * @return {{session_id, user_id, school_id, role, expires_at, user}|null}
   */
  function getSession(sessionId) {
    if (Utils.isBlank(sessionId)) return null;
    var now = Platform.now().getTime();

    var cached = Platform.cache().get(sessionKey(sessionId));
    if (cached) {
      var s = JSON.parse(cached);
      return Date.parse(s.expires_at) > now ? s : null;
    }

    var row = Repos.sessions().findById(SYSTEM, sessionId);
    if (!row || Date.parse(row.expires_at) <= now) return null;
    var user = Repos.users().findById(SYSTEM, row.user_id);
    if (!user || user.status !== 'AKTIF') return null;
    var school = user.school_id ? Repos.schools().findById(SYSTEM, user.school_id) : null;

    var session = Utils.pick(row, ['session_id', 'user_id', 'school_id', 'role', 'expires_at']);
    session.user = publicUser(user, school);
    cacheSession(session);
    return session;
  }

  function logout(sessionId) {
    if (Utils.isBlank(sessionId)) return;
    Platform.cache().remove(sessionKey(sessionId));
    try {
      Repos.sessions().softDelete(SYSTEM, sessionId);
    } catch (e) {
      if (!(e instanceof Utils.AppError && e.code === 'NOT_FOUND')) throw e;
    }
  }

  /** ctx untuk repository, dibangun hanya dari sesi server. */
  function contextOf(session) {
    return { userId: session.user_id, schoolId: session.school_id, role: session.role };
  }

  return {
    SYSTEM: SYSTEM,
    login: login,
    logout: logout,
    getSession: getSession,
    contextOf: contextOf,
    makePasswordFields: makePasswordFields,
    verifyPassword: verifyPassword,
    hashPassword: hashPassword
  };
})();

if (typeof module !== 'undefined') module.exports = Auth;
