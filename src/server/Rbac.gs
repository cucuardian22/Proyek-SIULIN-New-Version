/**
 * Peta hak akses per peran. Setiap rute di Api.gs menyebut satu izin.
 */
var Rbac = (function () {
  var PERMISSIONS = {
    'school.manage':   ['SUPER_ADMIN'],
    'topic.manage':    ['SUPER_ADMIN'],
    'user.manage':     ['SUPER_ADMIN', 'ADMIN'],
    'exam.manage':     ['SUPER_ADMIN', 'ADMIN', 'GURU'],
    'question.manage': ['SUPER_ADMIN', 'ADMIN', 'GURU'],
    'test.manage':     ['ADMIN', 'GURU'],
    'token.manage':    ['ADMIN', 'GURU', 'PENGAWAS'],
    'monitor.view':    ['ADMIN', 'GURU', 'PENGAWAS'],
    'result.view':     ['ADMIN', 'GURU'],
    'exam.take':       ['SISWA'],
    'self':            ['SUPER_ADMIN', 'ADMIN', 'GURU', 'PENGAWAS', 'SISWA']
  };

  function can(role, permission) {
    var roles = PERMISSIONS[permission];
    if (!roles) throw new Error('Izin tidak dikenal: ' + permission);
    return roles.indexOf(role) >= 0;
  }

  function assert(session, permission) {
    if (!can(session.role, permission)) {
      throw new Utils.AppError('FORBIDDEN', 'Anda tidak punya akses untuk tindakan ini.');
    }
  }

  return { PERMISSIONS: PERMISSIONS, can: can, assert: assert };
})();

if (typeof module !== 'undefined') module.exports = Rbac;
