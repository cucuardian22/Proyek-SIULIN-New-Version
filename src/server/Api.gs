/**
 * Satu pintu masuk untuk semua panggilan dari client: apiCall(route, sessionId, payload).
 *
 * Aturan yang dijamin di sini, bukan di tiap fungsi:
 *  1. Setiap rute non-publik memvalidasi sesi lewat Auth.getSession.
 *  2. Izin peran dicek lewat Rbac sebelum handler dipanggil.
 *  3. school_id kiriman client dibuang; handler menerima ctx dari sesi server.
 *  4. Hasil selalu berbentuk { ok: true, data } atau { ok: false, error: { code, message } }.
 *
 * Nama rute sengaja mirip REST supaya di Fase 2 bisa menjadi POST /api/<route>.
 */
var Api = (function () {
  var ROUTES = {
    'auth.login': {
      public: true,
      handler: function (ctx, payload) { return Auth.login(payload); }
    },
    'auth.logout': {
      permission: 'self',
      handler: function (ctx, payload, session) { Auth.logout(session.session_id); return true; }
    },
    'auth.me': {
      permission: 'self',
      handler: function (ctx, payload, session) {
        return { user: session.user, expires_at: session.expires_at };
      }
    }
  };

  function sanitize(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
    var clean = {};
    for (var k in payload) {
      if (Object.prototype.hasOwnProperty.call(payload, k) && k !== 'school_id') clean[k] = payload[k];
    }
    return clean;
  }

  function handle(route, sessionId, payload) {
    try {
      var def = ROUTES[route];
      if (!def) throw new Utils.AppError('NOT_FOUND', 'Rute tidak dikenal: ' + route);

      var session = null;
      var ctx = null;
      if (!def.public) {
        session = Auth.getSession(sessionId);
        if (!session) throw new Utils.AppError('UNAUTHENTICATED', 'Sesi berakhir, silakan login lagi.');
        Rbac.assert(session, def.permission);
        ctx = Auth.contextOf(session);
      }

      return { ok: true, data: def.handler(ctx, sanitize(payload), session) };
    } catch (e) {
      if (e instanceof Utils.AppError) {
        return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
      }
      Utils.log('error', 'apiCall gagal', { route: route, error: String(e && e.stack || e) });
      return { ok: false, error: { code: 'INTERNAL', message: 'Terjadi kesalahan di server.' } };
    }
  }

  /** Daftarkan rute dari service lain (dipakai tahap berikutnya). */
  function register(route, def) {
    if (ROUTES[route]) throw new Error('Rute sudah ada: ' + route);
    if (!def.public && !def.permission) throw new Error('Rute ' + route + ' wajib punya permission.');
    ROUTES[route] = def;
  }

  return { handle: handle, register: register, ROUTES: ROUTES };
})();

/** Dipanggil dari client lewat google.script.run.apiCall(...). */
function apiCall(route, sessionId, payload) {
  return Api.handle(route, sessionId, payload);
}

if (typeof module !== 'undefined') module.exports = Api;
