#!/usr/bin/env node
/**
 * Uji beban SIULIN terhadap web app Apps Script yang sudah disiapkan dengan setupLoadTest().
 * Node.js 18+, tanpa dependensi.
 *
 *   node tools/loadtest.js --url https://script.google.com/macros/s/XXX/exec --token ABCDEF \
 *     --password rahasia123 --students 200 --minutes 10
 *
 * Setiap siswa virtual meniru browser: login, daftar tes, mulai dengan token, menjawab satu
 * soal lalu auto-save tiap --save-every detik (seperti Exam.html), lalu kumpulkan.
 * --watchers pengawas virtual memanggil monitor.list tiap 30 detik.
 * Login siswa disebar merata selama --ramp detik, seperti siswa yang datang bergiliran.
 *
 * Hasil: waktu respons per rute (p50, p95, maks), jumlah gagal per kode, dan file JSON.
 */
'use strict';
const fs = require('node:fs');

const DEFAULTS = {
  url: '', token: '', password: '', school: 'UJIBEBAN', prefix: 'ub',
  students: 200, start: 1, minutes: 10, 'save-every': 60, ramp: 120, watchers: 2,
  timeout: 60, out: 'loadtest-result.json'
};

function parseArgs(argv) {
  const opts = Object.assign({}, DEFAULTS);
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (!m || !(m[1] in DEFAULTS)) throw new Error('Argumen tidak dikenal: ' + argv[i]);
    const v = argv[++i];
    opts[m[1]] = typeof DEFAULTS[m[1]] === 'number' ? Number(v) : v;
  }
  for (const k of ['url', 'token', 'password']) if (!opts[k]) throw new Error('--' + k + ' wajib diisi.');
  if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(opts.url) && !/^http:\/\/localhost[:/]/.test(opts.url)) {
    throw new Error('--url harus alamat web app dari Deploy > Manage deployments, berbentuk ' +
      'https://script.google.com/macros/s/.../exec (yang tertulis: ' + opts.url + ').');
  }
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms * (0.8 + Math.random() * 0.4);

function createClient(opts) {
  const calls = [];
  async function call(route, sessionId, payload) {
    const started = Date.now();
    let res = null;
    let code = '';
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeout * 1000);
      // Apps Script membalas POST dengan 302; fetch mengikutinya dengan GET ke URL hasil (perilaku yang diharapkan).
      const r = await fetch(opts.url, {
        method: 'POST', redirect: 'follow', signal: ctrl.signal,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ route, session_id: sessionId, payload })
      });
      clearTimeout(timer);
      const text = await r.text();
      try { res = JSON.parse(text); } catch (e) { code = 'HTTP_' + r.status + (/<html/i.test(text) ? '_HTML' : ''); }
    } catch (e) {
      code = e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK';
    }
    if (res && !res.ok) code = (res.error && res.error.code) || 'ERROR';
    const entry = { route, ms: Date.now() - started, ok: !code, code, at: started };
    if (res && res.error && res.error.detail) entry.detail = res.error.detail;
    calls.push(entry);
    if (code) {
      const err = new Error(route + ' gagal: ' + code + (res && res.error ? ' ' + res.error.message : ''));
      err.code = code;
      throw err;
    }
    return res.data;
  }
  return { call, calls };
}

function fakeAnswer(q) {
  if (q.tipe === 'PG') return q.opsi[Math.floor(Math.random() * q.opsi.length)].id;
  if (q.tipe === 'PGK') return q.opsi.slice(0, 2).map((o) => o.id);
  if (q.tipe === 'PGBS' || q.tipe === 'PGST') {
    const v = {};
    q.opsi.forEach((o) => { v[o.id] = q.tipe === 'PGBS' ? (Math.random() < 0.5 ? 'B' : 'S') : (Math.random() < 0.5 ? 'S' : 'TS'); });
    return v;
  }
  return String(Math.floor(Math.random() * 500));
}

/** Satu call dengan satu kali ulang, seperti siswa yang menekan tombol lagi. */
async function retry(fn) {
  try { return await fn(); } catch (e) {
    if (['DONE', 'TIME_UP', 'BAD_TOKEN', 'FORBIDDEN', 'UNAUTHENTICATED'].includes(e.code)) throw e;
    await sleep(jitter(3000));
    return fn();
  }
}

/** Submit seperti Exam.html: diulang otomatis dengan jeda makin panjang bila server penuh. */
const SUBMIT_RETRY_MS = [3000, 6000, 12000, 20000, 30000];
async function retrySubmit(fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (!['NETWORK', 'BUSY', 'INTERNAL', 'TIMEOUT'].includes(e.code) && !/^HTTP_/.test(e.code)) throw e;
      if (i >= SUBMIT_RETRY_MS.length) throw e;
      await sleep(jitter(SUBMIT_RETRY_MS[i]));
    }
  }
}

async function student(client, opts, n, state) {
  const username = opts.prefix + String(n).padStart(3, '0');
  await sleep(Math.random() * opts.ramp * 1000);
  try {
    const sid = (await retry(() => client.call('auth.login', null, { kode_sekolah: opts.school, username, password: opts.password }))).session_id;
    const tests = await retry(() => client.call('attempt.list', sid, {}));
    const t = tests.find((x) => x.status === 'BERLANGSUNG');
    if (!t) throw new Error('tidak ada tes berlangsung untuk ' + username);
    const pkg = await retry(() => client.call('attempt.start', sid, { test_ref: t.test_id, token: opts.token }));
    state.started++;

    const jawaban = Object.assign({}, pkg.saved ? pkg.saved.jawaban : {});
    let seq = pkg.saved ? pkg.saved.seq : 0;
    const endAt = Date.now() + opts.minutes * 60000;
    let i = 0;
    while (Date.now() + opts['save-every'] * 1000 < endAt) {
      await sleep(jitter(opts['save-every'] * 1000));
      const q = pkg.questions[i++ % pkg.questions.length];
      jawaban[q.question_id] = fakeAnswer(q);
      seq++;
      // Browser tidak mengulang auto-save yang gagal; simpanan berikutnya membawa semua jawaban.
      await client.call('attempt.save', sid, { attempt_ref: pkg.attempt_id, seq, jawaban, jumlah_pindah_tab: 0, client_ts: new Date().toISOString() }).catch(() => {});
    }
    await retrySubmit(() => client.call('attempt.submit', sid, { attempt_ref: pkg.attempt_id, seq: seq + 1, jawaban, jumlah_pindah_tab: 0, client_ts: new Date().toISOString() }));
    state.submitted++;
  } catch (e) {
    state.failed.push(username + ': ' + e.message);
  }
}

async function watcher(client, opts, state) {
  try {
    const sid = (await retry(() => client.call('auth.login', null, { kode_sekolah: opts.school, username: opts.prefix + 'awas', password: opts.password }))).session_id;
    const tests = await retry(() => client.call('monitor.tests', sid, {}));
    if (!tests.length) throw new Error('monitor.tests kosong');
    while (!state.done) {
      await client.call('monitor.list', sid, { test_ref: tests[0].test_id }).catch(() => {});
      await sleep(jitter(30000));
    }
  } catch (e) {
    state.failed.push('pengawas: ' + e.message);
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p / 100 * sorted.length))];
}

function summarize(calls) {
  const byRoute = {};
  for (const c of calls) (byRoute[c.route] = byRoute[c.route] || []).push(c);
  const rows = Object.keys(byRoute).sort().map((route) => {
    const list = byRoute[route];
    const ms = list.filter((c) => c.ok).map((c) => c.ms).sort((a, b) => a - b);
    const codes = {};
    list.filter((c) => !c.ok).forEach((c) => { codes[c.code] = (codes[c.code] || 0) + 1; });
    return { route, total: list.length, gagal: list.length - ms.length, p50: percentile(ms, 50), p95: percentile(ms, 95), maks: ms[ms.length - 1] || 0, kode_gagal: codes };
  });
  return rows;
}

/** Puncak permintaan per menit, untuk dibandingkan dengan batas 30 eksekusi serentak. */
function peakPerMinute(calls) {
  const buckets = {};
  calls.forEach((c) => { const k = Math.floor(c.at / 60000); buckets[k] = (buckets[k] || 0) + 1; });
  return Math.max(0, ...Object.values(buckets));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const client = createClient(opts);
  const state = { started: 0, submitted: 0, failed: [], done: false };
  const t0 = Date.now();
  console.log('Uji beban: ' + opts.students + ' siswa, ' + opts.minutes + ' menit, simpan tiap ' + opts['save-every'] +
    ' dtk, login disebar ' + opts.ramp + ' dtk, ' + opts.watchers + ' pengawas.');

  const progress = setInterval(() => {
    const recent = client.calls.filter((c) => c.at > Date.now() - 60000);
    const bad = recent.filter((c) => !c.ok);
    console.log('[' + Math.round((Date.now() - t0) / 1000) + ' dtk] mulai ' + state.started + '/' + opts.students +
      ', kumpul ' + state.submitted + ', panggilan 1 menit terakhir ' + recent.length + ' (gagal ' + bad.length + ')' +
      (bad.length ? ', gagal terakhir: ' + bad[bad.length - 1].route + ' ' + bad[bad.length - 1].code : ''));
  }, 30000);

  const watchers = [];
  for (let w = 0; w < opts.watchers; w++) watchers.push(watcher(client, opts, state));
  const students = [];
  for (let n = opts.start; n < opts.start + opts.students; n++) students.push(student(client, opts, n, state));
  await Promise.all(students);
  state.done = true;
  await Promise.all(watchers);
  clearInterval(progress);

  const rows = summarize(client.calls);
  const total = client.calls.length;
  const failed = client.calls.filter((c) => !c.ok).length;
  console.log('\nRute              Total  Gagal   p50 ms   p95 ms   maks ms  Kode gagal');
  rows.forEach((r) => console.log(
    r.route.padEnd(16) + String(r.total).padStart(7) + String(r.gagal).padStart(7) + String(r.p50).padStart(9) +
    String(r.p95).padStart(9) + String(r.maks).padStart(10) + '  ' + JSON.stringify(r.kode_gagal)));
  console.log('\nSiswa mulai ' + state.started + '/' + opts.students + ', kumpul ' + state.submitted + '/' + opts.students +
    '. Panggilan ' + total + ', gagal ' + failed + ' (' + (total ? (failed / total * 100).toFixed(2) : 0) + '%). Puncak ' + peakPerMinute(client.calls) + ' panggilan/menit.');
  const details = {};
  client.calls.filter((c) => c.detail).forEach((c) => { const k = c.route + ': ' + c.detail; details[k] = (details[k] || 0) + 1; });
  if (Object.keys(details).length) {
    console.log('\nPesan galat server (INTERNAL):');
    Object.keys(details).sort((a, b) => details[b] - details[a]).slice(0, 10).forEach((k) => console.log('  ' + details[k] + 'x  ' + k));
  }
  if (state.failed.length) console.log('Siswa/pengawas gagal (' + state.failed.length + '):\n  ' + state.failed.slice(0, 20).join('\n  '));

  const save = rows.find((r) => r.route === 'attempt.save');
  const passed = state.submitted === opts.students && failed / Math.max(1, total) < 0.01 && (!save || save.p95 < 5000);
  console.log('\nKesimpulan: ' + (passed ? 'LULUS' : 'TIDAK LULUS') +
    ' (syarat: semua siswa terkumpul, gagal < 1%, p95 auto-save < 5 detik).');

  fs.writeFileSync(opts.out, JSON.stringify({ opts: Object.assign({}, opts, { password: '***' }), summary: rows, state, calls: client.calls }, null, 1));
  console.log('Detail tersimpan di ' + opts.out);
  process.exitCode = passed ? 0 : 1;
}

main().catch((e) => { console.error(e.message); process.exit(2); });
