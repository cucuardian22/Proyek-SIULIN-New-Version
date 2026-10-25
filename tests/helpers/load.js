// Memuat file .gs ke global seperti di Apps Script, dengan Platform tiruan.
const path = require('node:path');
const { createMemoryPlatform } = require('./memoryPlatform');

const SRC = path.join(__dirname, '..', '..', 'src', 'server');
const FILES = {
  Config: 'Config.gs',
  Schema: 'Schema.gs',
  Utils: 'Utils.gs',
  Rbac: 'Rbac.gs',
  BaseRepo: 'repo/BaseRepo.gs',
  Repos: 'repo/Repos.gs',
  SchoolRepo: 'repo/SchoolRepo.gs',
  UserRepo: 'repo/UserRepo.gs',
  Auth: 'Auth.gs',
  Api: 'Api.gs',
  ScoringService: 'service/ScoringService.gs',
  SchoolService: 'service/SchoolService.gs',
  UserService: 'service/UserService.gs',
  TopicService: 'service/TopicService.gs',
  ExamService: 'service/ExamService.gs',
  QuestionService: 'service/QuestionService.gs',
  SipSoalService: 'service/SipSoalService.gs',
  TestService: 'service/TestService.gs',
  TokenService: 'service/TokenService.gs',
  ExamEngine: 'service/ExamEngine.gs',
  ResultService: 'service/ResultService.gs',
  MonitorService: 'service/MonitorService.gs',
  LoadTest: 'LoadTest.gs'
};

function loadApp(opts) {
  const platform = createMemoryPlatform(opts);
  global.Platform = platform;
  for (const [name, file] of Object.entries(FILES)) {
    global[name] = require(path.join(SRC, file));
  }
  global.Repos._reset();
  return platform;
}

module.exports = { loadApp };
