/**
 * Titik akses repository. Instans dibuat saat pertama dipakai, sehingga urutan
 * file di project GAS tidak berpengaruh.
 */
var Repos = (function () {
  var instances = {};

  function get(tableName) {
    if (!instances[tableName]) instances[tableName] = new BaseRepo(tableName);
    return instances[tableName];
  }

  return {
    get: get,
    schools: function () { return get('Schools'); },
    users: function () { return get('Users'); },
    topics: function () { return get('Topics'); },
    exams: function () { return get('Exams'); },
    questions: function () { return get('Questions'); },
    tests: function () { return get('Tests'); },
    tokens: function () { return get('Tokens'); },
    sessions: function () { return get('Sessions'); },
    attempts: function () { return get('Attempts'); },
    answerBatches: function () { return get('AnswerBatches'); },
    answers: function () { return get('Answers'); },
    results: function () { return get('Results'); },
    _reset: function () { instances = {}; }
  };
})();

if (typeof module !== 'undefined') module.exports = Repos;
