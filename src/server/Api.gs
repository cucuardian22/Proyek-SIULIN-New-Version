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
    },

    'school.list':   { permission: 'school.manage', handler: function (ctx) { return SchoolService.list(ctx); } },
    'school.create': { permission: 'school.manage', handler: function (ctx, p) { return SchoolService.create(ctx, p); } },
    'school.update': { permission: 'school.manage', handler: function (ctx, p) { return SchoolService.update(ctx, p); } },

    'user.list':     { permission: 'user.manage', handler: function (ctx, p) { return UserService.list(ctx, p); } },
    'user.create':   { permission: 'user.manage', handler: function (ctx, p) { return UserService.create(ctx, p); } },
    'user.update':   { permission: 'user.manage', handler: function (ctx, p) { return UserService.update(ctx, p); } },
    'user.import':   { permission: 'user.manage', handler: function (ctx, p) { return UserService.importRows(ctx, p); } },

    'topic.list':    { permission: 'self', handler: function (ctx, p) { return TopicService.list(ctx, p); } },
    'topic.create':  { permission: 'topic.manage', handler: function (ctx, p) { return TopicService.create(ctx, p); } },
    'topic.update':  { permission: 'topic.manage', handler: function (ctx, p) { return TopicService.update(ctx, p); } },

    'exam.list':     { permission: 'exam.manage', handler: function (ctx, p) { return ExamService.list(ctx, p); } },
    'exam.create':   { permission: 'exam.manage', handler: function (ctx, p) { return ExamService.create(ctx, p); } },
    'exam.update':   { permission: 'exam.manage', handler: function (ctx, p) { return ExamService.update(ctx, p); } },
    'exam.remove':   { permission: 'exam.manage', handler: function (ctx, p) { return ExamService.remove(ctx, p); } },

    'question.list':   { permission: 'question.manage', handler: function (ctx, p) { return QuestionService.list(ctx, p); } },
    'question.create': { permission: 'question.manage', handler: function (ctx, p) { return QuestionService.create(ctx, p); } },
    'question.update': { permission: 'question.manage', handler: function (ctx, p) { return QuestionService.update(ctx, p); } },
    'question.remove': { permission: 'question.manage', handler: function (ctx, p) { return QuestionService.remove(ctx, p); } },
    'question.import': { permission: 'question.manage', handler: function (ctx, p) { return QuestionService.importRows(ctx, p); } },

    'test.list':     { permission: 'test.manage', handler: function (ctx, p) { return TestService.list(ctx, p); } },
    'test.create':   { permission: 'test.manage', handler: function (ctx, p) { return TestService.create(ctx, p); } },
    'test.update':   { permission: 'test.manage', handler: function (ctx, p) { return TestService.update(ctx, p); } },
    'test.remove':   { permission: 'test.manage', handler: function (ctx, p) { return TestService.remove(ctx, p); } },

    'token.list':     { permission: 'token.manage', handler: function (ctx) { return TokenService.list(ctx); } },
    'token.generate': { permission: 'token.manage', handler: function (ctx, p) { return TokenService.generate(ctx, p); } },

    'attempt.list':   { permission: 'exam.take', handler: function (ctx) { return ExamEngine.available(ctx); } },
    'attempt.start':  { permission: 'exam.take', handler: function (ctx, p) { return ExamEngine.start(ctx, p); } },
    'attempt.save':   { permission: 'exam.take', handler: function (ctx, p) { return ExamEngine.save(ctx, p); } },
    'attempt.submit': { permission: 'exam.take', handler: function (ctx, p) { return ExamEngine.submit(ctx, p); } },

    'result.list':     { permission: 'result.view', handler: function (ctx, p) { return ResultService.list(ctx, p); } },
    'result.detail':   { permission: 'result.view', handler: function (ctx, p) { return ResultService.detail(ctx, p); } },
    'result.analysis': { permission: 'result.view', handler: function (ctx, p) { return ResultService.analysis(ctx, p); } },

    'monitor.tests':  { permission: 'monitor.view', handler: function (ctx) { return MonitorService.tests(ctx); } },
    'monitor.list':   { permission: 'monitor.view', handler: function (ctx, p) { return MonitorService.list(ctx, p); } },
    'monitor.extend': { permission: 'monitor.view', handler: function (ctx, p) { return MonitorService.extend(ctx, p); } },
    'monitor.submit': { permission: 'monitor.view', handler: function (ctx, p) { return MonitorService.forceSubmit(ctx, p); } }
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
