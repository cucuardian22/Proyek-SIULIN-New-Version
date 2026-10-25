const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { loadApp } = require('./helpers/load');

const call = (sid, route, payload) => Api.handle(route, sid, payload);
const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.error)); return r.data; };
const loginAs = (kode, username, password) => ok(call(null, 'auth.login', { kode_sekolah: kode, username, password })).session_id;

// ---------- file .docx tiruan dengan bentuk tabel seperti unduhan SIP SOAL ----------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const para = (t) => '<w:p><w:pPr><w:spacing w:before="0"/></w:pPr><w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">' + esc(t) + '</w:t></w:r></w:p>';
const cell = (content) => '<w:tc><w:tcPr><w:tcW w:w="600" w:type="dxa"/></w:tcPr>' + (content === '' ? '<w:p><w:pPr/></w:p>' : content) + '</w:tc>';
const row = (no, tipe, jenis, isi, skor) => '<w:tr><w:trPr/>' + [no, tipe, jenis].map((t) => cell(t ? para(t) : '')).join('') +
  cell([].concat(isi).map((p) => (p.startsWith('<') ? p : para(p))).join('')) + cell(skor === '' ? '' : para(String(skor))) + '</w:tr>';

function documentXml(rows) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    para('Form Import Soal berdasarkan Topik yang dipilih') + '<w:tbl><w:tblPr/>' + row('No', 'Tipe', 'Jenis', 'Isi', 'Skor') + rows.join('') + '</w:tbl></w:body></w:document>';
}

function zip(files) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8');
    const data = zlib.deflateRawSync(raw);
    const n = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(zlib.crc32(raw), 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(zlib.crc32(raw), 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    locals.push(h, n, data);
    central.push(c, n);
    offset += h.length + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([cd, end])).toString('base64');
}

const docx = (rows) => zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': documentXml(rows) });

const SAMPLE = [
  row('1', 'PG', 'Soal', ['Perhatikan bilangan berikut!', '(1) 2', '(2) 9', 'Bilangan prima ditunjukkan oleh nomor ....'], ''),
  row('', '', 'Jawaban', '(2)', 0),
  row('', '', 'Jawaban', '(1)', 1),
  row('', '', 'Jawaban', '(1) & (2)', 0),
  row('2', 'PGK', 'Soal', 'Manakah bilangan genap? (Pilih lebih dari satu jawaban benar)', ''),
  row('', '', 'Jawaban', '4', 1),
  row('', '', 'Jawaban', '7', 0),
  row('', '', 'Jawaban', ['10', 'sepuluh'], 1),
  row('', '', 'Jawaban', '15', 0)
];

function seed() {
  loadApp();
  Repos.users().insert(Auth.SYSTEM, Object.assign({ school_id: '', role: 'SUPER_ADMIN', username: 'root', nama: 'Root', status: 'AKTIF' }, Auth.makePasswordFields('rootpass')));
  const root = loginAs('PUSAT', 'root', 'rootpass');
  const topic = ok(call(root, 'topic.create', { nama_topik: 'ASAJ', inisial: 'ASAJ', tahun_ajaran: '2026/2027' }));
  const school = ok(call(root, 'school.create', { nama_sekolah: 'Sekolah A', nama_unik: 'SKA' }));
  ok(call(root, 'user.create', { target_school: school.school_id, username: 'admin', nama: 'Admin', role: 'ADMIN', password: 'adminpass' }));
  const admin = loginAs('SKA', 'admin', 'adminpass');
  ok(call(admin, 'user.create', { username: 'guru', nama: 'Guru', role: 'GURU', password: 'gurupass', mapel_diampu: 'MTK' }));
  const guru = loginAs('SKA', 'guru', 'gurupass');
  const exam = ok(call(guru, 'exam.create', { topic_id: topic.topic_id, kode_mapel: 'MTK', nama_mapel: 'Matematika', kelas: '7' }));
  const ipa = ok(call(admin, 'exam.create', { topic_id: topic.topic_id, kode_mapel: 'IPA', nama_mapel: 'IPA', kelas: '7' }));
  return { guru, exam, ipa };
}

test('SIP SOAL: tabel No/Tipe/Jenis/Isi/Skor menjadi baris template, kunci dari skor > 0', () => {
  const { guru, exam } = seed();
  const r = ok(call(guru, 'question.readSipSoal', { exam_ref: exam.exam_id, file_base64: docx(SAMPLE) }));
  assert.deepEqual(r.warnings, []);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows[0], {
    _row: '1', tipe: 'PG', teks: 'Perhatikan bilangan berikut!\n(1) 2\n(2) 9\nBilangan prima ditunjukkan oleh nomor ....',
    bobot: 1, kunci: 'B', media_url: '', a: '(2)', b: '(1)', c: '(1) & (2)'
  });
  assert.equal(r.rows[1].kunci, 'A,C');
  assert.equal(r.rows[1].c, '10 sepuluh');

  // Baris hasil baca langsung bisa diimport lewat jalur import biasa.
  const saved = ok(call(guru, 'question.import', { exam_ref: exam.exam_id, rows: r.rows }));
  assert.equal(saved.inserted, 2);
  const qs = ok(call(guru, 'question.list', { exam_ref: exam.exam_id })).questions;
  assert.deepEqual(qs.map((q) => [q.tipe, q.kunci]), [['PG', 'B'], ['PGK', ['A', 'C']]]);
});

test('SIP SOAL: kesalahan soal dilaporkan per nomor soal saat diperiksa', () => {
  const { guru, exam } = seed();
  const read = ok(call(guru, 'question.readSipSoal', {
    exam_ref: exam.exam_id,
    file_base64: docx([
      row('1', 'PG', 'Soal', 'Dua kunci?', ''), row('', '', 'Jawaban', 'a', 1), row('', '', 'Jawaban', 'b', 1),
      row('2', 'MENJODOHKAN', 'Soal', 'Pasangkan.', '')
    ])
  }));
  assert.match(read.warnings[0], /^Soal 1: soal PG punya 2 jawaban/);
  const check = ok(call(guru, 'question.import', { exam_ref: exam.exam_id, rows: read.rows, dry_run: true }));
  assert.deepEqual(check.errors.map((e) => e.row), [1, 2]);
  assert.match(check.errors[0].messages.join(' '), /tepat satu/);
  assert.match(check.errors[1].messages.join(' '), /Tipe soal/);
});

test('SIP SOAL: gambar dan rumus diberi peringatan, file salah ditolak, hak akses tetap berlaku', () => {
  const { guru, exam, ipa } = seed();
  const withImage = row('1', 'PG', 'Soal', ['Perhatikan gambar!', '<w:p><w:r><w:drawing><wp:inline/></w:drawing></w:r></w:p>'], '');
  const withMath = row('', '', 'Jawaban', '<w:p><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></w:p>', 1);
  const r = ok(call(guru, 'question.readSipSoal', { exam_ref: exam.exam_id, file_base64: docx([withImage, withMath, row('', '', 'Jawaban', 'b', 0)]) }));
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings[0], /^Soal 1: gambar/);
  assert.match(r.warnings[1], /rumus/);

  assert.match(call(guru, 'question.readSipSoal', { exam_ref: exam.exam_id, file_base64: Buffer.from('bukan zip').toString('base64') }).error.message, /bukan dokumen Word/);
  const noTable = zip({ 'word/document.xml': documentXml([]).replace(/<w:tbl>[\s\S]*<\/w:tbl>/, '') });
  assert.match(call(guru, 'question.readSipSoal', { exam_ref: exam.exam_id, file_base64: noTable }).error.message, /tidak ditemukan/);
  assert.equal(call(guru, 'question.readSipSoal', { exam_ref: ipa.exam_id, file_base64: docx(SAMPLE) }).error.code, 'FORBIDDEN');
});
