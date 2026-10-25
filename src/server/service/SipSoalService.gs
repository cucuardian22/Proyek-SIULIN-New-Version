/**
 * Ambil soal dari SIP SOAL: baca file Word "Form Import Soal" hasil unduhan SIP SOAL
 * dan ubah menjadi baris template import biasa. Pemeriksaan dan penyimpanan tetap
 * lewat QuestionService.importRows, jadi aturan soal sama persis dengan import CSV.
 *
 * Isi file: satu tabel berkolom No | Tipe | Jenis | Isi | Skor.
 *   Jenis = Soal     -> teks soal; No dan Tipe diisi di baris ini
 *   Jenis = Jawaban  -> satu opsi, berurutan menjadi A, B, C, ...; Skor > 0 berarti kunci
 * SIP SOAL tidak punya bobot, jadi setiap soal berbobot 1 (bisa diubah setelah import).
 */
var SipSoalService = (function () {
  var MAX_BYTES = 5 * 1024 * 1024;
  var LETTERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

  function decode(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, function (m, e) {
      if (e.charAt(0) === '#') return String.fromCharCode(e.charAt(1).toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[e.toLowerCase()];
    });
  }

  /** Teks sel tabel: satu baris per paragraf. */
  function cellText(xml) {
    var paragraphs = xml.match(/<w:p\b[^>]*?(?:\/>|>[\s\S]*?<\/w:p>)/g) || [];
    return paragraphs.map(function (p) {
      var out = '';
      p.replace(/<w:t\b[^>]*>([^<]*)<\/w:t>|<w:tab\/>|<w:br\b[^>]*\/>/g, function (m, t) {
        out += t !== undefined ? decode(t) : m.indexOf('<w:tab') === 0 ? '\t' : '\n';
        return m;
      });
      return out;
    }).join('\n').replace(/^\s+|\s+$/g, '');
  }

  function cells(rowXml) {
    return (rowXml.match(/<w:tc\b[\s\S]*?<\/w:tc>/g) || []).map(function (c) {
      return { text: cellText(c), media: /<w:drawing\b|<w:pict\b|<w:object\b/.test(c), math: /<m:oMath\b/.test(c) };
    });
  }

  /**
   * document.xml -> baris template ({_row, tipe, teks, bobot, a..h, kunci, media_url}) dan peringatan.
   * Fungsi murni, tanpa layanan Google.
   */
  function parseDocumentXml(xml) {
    var tables = String(xml || '').match(/<w:tbl\b[\s\S]*?<\/w:tbl>/g) || [];
    var col = null, rows = null;
    for (var t = 0; t < tables.length && !col; t++) {
      rows = (tables[t].match(/<w:tr\b[\s\S]*?<\/w:tr>/g) || []).map(cells);
      if (!rows.length) continue;
      var head = rows[0].map(function (c) { return c.text.toLowerCase(); });
      if (head.indexOf('jenis') >= 0 && head.indexOf('isi') >= 0) {
        col = { no: head.indexOf('no'), tipe: head.indexOf('tipe'), jenis: head.indexOf('jenis'), isi: head.indexOf('isi'), skor: head.indexOf('skor') };
      }
    }
    if (!col) Utils.fail('INVALID_INPUT', 'Tabel soal SIP SOAL (kolom No, Tipe, Jenis, Isi, Skor) tidak ditemukan di file ini.');

    var questions = [];
    var warnings = [];
    var current = null;
    var get = function (row, i) { return i >= 0 && row[i] ? row[i] : { text: '' }; };

    rows.slice(1).forEach(function (row) {
      var jenis = get(row, col.jenis).text.toLowerCase();
      var isi = get(row, col.isi);
      if (jenis === 'soal') {
        current = { no: get(row, col.no).text || String(questions.length + 1), tipe: get(row, col.tipe).text.toUpperCase(), teks: isi.text, opsi: [], media: isi.media, math: isi.math };
        questions.push(current);
      } else if (jenis === 'jawaban') {
        if (!current) return;
        current.opsi.push({ teks: isi.text.replace(/\s*\n\s*/g, ' '), skor: Number(get(row, col.skor).text.replace(',', '.')) || 0 });
        current.media = current.media || isi.media;
        current.math = current.math || isi.math;
      }
    });

    var out = questions.map(function (q) {
      var r = { _row: q.no, tipe: q.tipe, teks: q.teks, bobot: 1, kunci: '', media_url: '' };
      var keys = [];
      q.opsi.forEach(function (o, i) {
        if (i >= LETTERS.length) return;
        r[LETTERS[i]] = o.teks;
        if (o.skor > 0) keys.push(LETTERS[i].toUpperCase());
      });
      // PG berskor > 0 lebih dari satu dikosongkan supaya pemeriksaan import menyebut "Kunci PG harus tepat satu opsi".
      r.kunci = q.tipe === 'PG' && keys.length > 1 ? '' : keys.join(',');
      if (q.tipe === 'PG' && keys.length > 1) warnings.push('Soal ' + q.no + ': soal PG punya ' + keys.length + ' jawaban berskor lebih dari 0. Jadikan PGK di SIP SOAL atau pilih satu kunci.');
      if (q.opsi.length > LETTERS.length) warnings.push('Soal ' + q.no + ': hanya ' + LETTERS.length + ' opsi pertama yang terbawa.');
      if (q.media) warnings.push('Soal ' + q.no + ': gambar di dalam file tidak ikut terbawa. Tambahkan link gambar setelah import.');
      if (q.math) warnings.push('Soal ' + q.no + ': rumus Word (equation) tidak ikut terbawa. Periksa teks soal setelah import.');
      return r;
    });
    if (!out.length) Utils.fail('INVALID_INPUT', 'Tidak ada soal di tabel SIP SOAL.');
    return { rows: out, warnings: warnings };
  }

  /** @param {{exam_ref, file_base64}} payload  file .docx hasil unduhan SIP SOAL */
  function read(ctx, payload) {
    var exam = ExamService.getEditable(ctx, payload.exam_ref);
    TestService.assertExamUnlocked(exam.exam_id);
    var b64 = String(payload.file_base64 || '').replace(/^data:[^,]*,/, '');
    if (!b64) Utils.fail('INVALID_INPUT', 'Pilih file Word (.docx) dari SIP SOAL.');
    if (b64.length * 3 / 4 > MAX_BYTES) Utils.fail('INVALID_INPUT', 'File maksimal 5 MB.');
    var xml;
    try {
      xml = Platform.unzipEntry(b64, 'word/document.xml');
    } catch (e) {
      xml = null;
    }
    if (!xml) Utils.fail('INVALID_INPUT', 'File bukan dokumen Word .docx. Unduh ulang dari SIP SOAL lalu pilih file .docx-nya.');
    return parseDocumentXml(xml);
  }

  return { read: read, parseDocumentXml: parseDocumentXml };
})();

if (typeof module !== 'undefined') module.exports = SipSoalService;
