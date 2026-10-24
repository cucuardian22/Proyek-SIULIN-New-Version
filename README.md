# SIULIN - Sistem Ujian Online

Sistem ujian online multi-sekolah. Fase 1 berjalan di Google Apps Script + Google Sheets dan dirancang agar bisa dipindahkan ke Node.js + PostgreSQL (Fase 2) dengan hanya menulis ulang lapisan `repo/`.

## Status

Tahap 1, bagian fondasi:

- Skema 12 sheet (`src/server/Schema.gs`) dan skrip pembuatnya (`Setup.gs`)
- Repository generik dengan isolasi `school_id` dari sesi (`repo/BaseRepo.gs`)
- Login, sesi, batas percobaan login, RBAC 5 peran, satu pintu API (`Auth.gs`, `Rbac.gs`, `Api.gs`)
- Penilaian otomatis PG, PGK, PGBS, PGST, ISIAN (`service/ScoringService.gs`)
- Halaman Login dan Dashboard
- Sekolah (SUPER_ADMIN) dan pengguna: tambah, ubah, reset password, nonaktifkan, import dari tempelan Excel/Sheets atau CSV (dicek seluruhnya sebelum disimpan, dikirim per 100 baris), export CSV

- Topik ujian (SUPER_ADMIN), ujian per mapel/kelas dengan nama otomatis, GURU dibatasi ke mapel yang diampu
- Bank soal: editor 6 tipe (PG, PGK, PGBS, PGST, ISIAN, URAIAN), import dari template, bank soal pusat ber-scope GLOBAL yang terbaca semua sekolah

- Jadwal tes (kelas peserta, rentang waktu, durasi, acak soal/opsi, KKM) dan token tes yang bisa diganti pengawas; soal ujian terkunci setelah tes dimulai

- Mesin ujian (`service/ExamEngine.gs`): siswa masuk dengan token, soal/opsi diacak per siswa tanpa kunci terkirim ke browser, timer dari jam server, tanda ragu-ragu, simpan otomatis tiap 60 detik dan saat pindah tab, lanjut setelah browser tertutup, kumpul otomatis saat waktu habis (trigger tiap 10 menit), nilai dihitung saat submit
- Rekap nilai per tes (`service/ResultService.gs`): status dan nilai tiap siswa peserta, ketuntasan terhadap KKM, ringkasan rata-rata/tertinggi/terendah, filter kelas, unduh CSV, jawaban siswa per soal beserta kunci, dan analisis butir soal (tingkat benar, sebaran pilihan PG/PGK). Ujian yang waktunya habis langsung dikumpulkan saat rekap dibuka.
- Monitoring tes berjalan (`service/MonitorService.gs`) untuk PENGAWAS, GURU, dan ADMIN: status tiap siswa, jumlah soal terjawab, sisa waktu, simpan terakhir, tanda "mungkin terputus", jumlah pindah tab, diperbarui tiap 30 detik. Pengawas bisa menambah waktu satu siswa (timer siswa ikut berubah dalam 1 menit) dan mengumpulkan paksa (yang dinilai simpanan otomatis terakhir). Progres dibaca dari cache, bukan sheet, supaya ringan.
- Alat uji beban (`LoadTest.gs`, `tools/loadtest.js`), lihat bagian Uji beban di bawah.

Berikutnya: menjalankan uji beban di Apps Script sungguhan, lalu menetapkan kapasitas per klaster dari hasilnya.

## Struktur

```
src/
  appsscript.json
  server/
    Code.gs        doGet(), include()
    Config.gs      konstanta
    Schema.gs      definisi semua sheet dan tipe kolom
    Utils.gs       AppError, waktu ISO UTC, UUID
    Auth.gs        login, logout, sesi, hash password
    Rbac.gs        peta izin per peran
    Api.gs         apiCall(route, sessionId, payload): satu pintu untuk client
    Setup.gs       setupSiulin(), setupSuperAdmin(), setupTriggers(), setupLoadTest() (dijalankan dari editor)
    LoadTest.gs    data dan pintu doPost khusus uji beban (mati secara bawaan)
    repo/          SATU-SATUNYA kode yang menyentuh layanan Google
      GasPlatform.gs   adapter SpreadsheetApp/CacheService/LockService/Properties
      BaseRepo.gs      CRUD generik + cache + isolasi sekolah
      Repos.gs, SchoolRepo.gs, UserRepo.gs
    service/       logika bisnis murni
      ScoringService.gs, SchoolService.gs, UserService.gs,
      TopicService.gs, ExamService.gs, QuestionService.gs,
      TestService.gs, TokenService.gs, ExamEngine.gs, ResultService.gs, MonitorService.gs
  client/
    Index.html, Style.html, Core.js.html (callApi, sesi, navigasi, CSV)
    pages/Login.html, pages/Dashboard.html, pages/Schools.html, pages/Users.html,
    pages/Topics.html, pages/Exams.html, pages/Questions.html,
    pages/Tests.html, pages/Tokens.html, pages/Results.html, pages/Monitoring.html, pages/MyExams.html, pages/Exam.html
tests/             unit test Node.js (tidak di-push ke Apps Script)
tools/loadtest.js  skrip uji beban (dijalankan di komputer, bukan di Apps Script)
```

## Aturan arsitektur

1. Hanya file di `server/repo/` yang boleh memanggil `SpreadsheetApp`, `CacheService`, `LockService`, `PropertiesService`. Service dan Api memakai `Repos` dan `Platform`.
2. Semua panggilan client lewat `SIULIN.callApi(route, payload)` di `Core.js.html`, yang memanggil `apiCall` di server.
3. `apiCall` memvalidasi sesi dan izin peran sebelum handler dipanggil, membuang `school_id` dari payload client, lalu memberi handler `ctx = { userId, schoolId, role }` dari sesi server.
4. `BaseRepo` menolak akses tanpa `ctx`, menyuntikkan `school_id` sesi ke setiap filter dan baris baru, dan mencegah perubahan baris milik sekolah lain.
5. Semua sel disimpan sebagai teks; tipe (`number`, `bool`, `json`) dikonversi oleh `BaseRepo` sesuai `Schema.gs`. Waktu disimpan sebagai ISO 8601 UTC.
6. Urutan kolom sheet harus sama dengan `Schema.gs`. `setupSiulin()` menolak berjalan bila sheet berisi data dengan header berbeda.
7. Jalur siswa (login, mulai, auto-save, submit) tidak memakai kunci global. Penulisan satu baris memakai `appendRow` yang atomik; kunci (`Platform.withLock`) hanya untuk mengubah baris yang sudah ada dan impor banyak baris oleh admin. Attempt ditutup oleh baris di `Results`; kolom status di `Attempts` disalin trigger berkala.

## Rumus penilaian

| Tipe | Skor |
| --- | --- |
| PG | bobot bila jawaban sama dengan kunci, selain itu 0 |
| PGK | max(0, (benar dipilih - salah dipilih) / jumlah kunci) x bobot |
| PGBS, PGST | (pernyataan dijawab benar / jumlah pernyataan) x bobot |
| ISIAN | bobot bila sama dengan salah satu jawaban diterima (huruf besar/kecil dan spasi berlebih diabaikan) |
| URAIAN | dinilai manual (Tahap 3) |

Skor dibulatkan dua desimal. Contoh PGK: kunci [A, C], bobot 4. Jawaban [A] = 2, [A, C] = 4, [A, B] = 0, [A, B, C, D] = 0.

## Template import soal

Satu baris per soal; baris pertama judul kolom: `tipe, teks, bobot, a, b, c, d, e, kunci, media_url`.

| Tipe | Kolom a-e | Kunci |
| --- | --- | --- |
| PG | opsi | `B` |
| PGK | opsi | `A,C` |
| PGBS | pernyataan | `B,S,B` (urut pernyataan; B = Benar, S = Salah) |
| PGST | pernyataan | `S,TS` (S = Setuju, TS = Tidak Setuju) |
| ISIAN | kosong | jawaban diterima dipisah `|`, mis. `25|dua puluh lima` |
| URAIAN | kosong | pedoman penskoran (opsional) |

Bobot kosong dianggap 1. Contoh lengkap bisa diunduh dari tombol "Unduh template" di halaman bank soal.

## Menjalankan test

Butuh Node.js 18 atau lebih baru, tanpa dependensi tambahan.

```
npm test
```

## Deploy satu klaster

1. Pasang clasp: `npm install -g @google/clasp`, lalu `clasp login` dengan akun pemilik klaster.
2. Buat project baru di [script.google.com](https://script.google.com) (New project, beri nama mis. "SIULIN Klaster A"), salin Script ID dari Project Settings, lalu salin `.clasp.json.example` menjadi `.clasp.json` dan isi `scriptId`. Jangan pakai `clasp create`: perintah itu menimpa `src/appsscript.json` dengan manifest kosong.
3. `clasp push -f`.
4. Di editor Apps Script, jalankan `setupSiulin` dan izinkan akses. Log menampilkan URL spreadsheet MASTER dan ATTEMPT.
5. Di Project Settings > Script Properties, isi `SETUP_ADMIN_USER` dan `SETUP_ADMIN_PASSWORD`, lalu jalankan `setupSuperAdmin`. Catat waktu hash di log; bila di atas 300 ms, turunkan `Config.HASH_ITERATIONS`.
6. Jalankan `setupTriggers` agar ujian yang waktunya habis tetap dikumpulkan.
7. Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone.
8. Buka URL web app, login dengan kode sekolah `PUSAT`.

Catatan: kolom `kelas_peserta` ditambahkan ke sheet Tests. Bila `setupSiulin()` sudah pernah dijalankan dan sheet Tests masih kosong, jalankan lagi; bila sudah berisi data, tambahkan kolom itu di akhir header secara manual.

Setiap klaster memakai akun Google pemilik yang berbeda, karena batas 30 eksekusi serentak berlaku per akun.

## Uji beban

Tujuannya mengukur berapa siswa yang bisa mengerjakan serentak di satu klaster sebelum respons melambat atau gagal. Batas Apps Script yang paling berpengaruh adalah 30 eksekusi serentak per akun pemilik dan lamanya tiap eksekusi. Auto-save masuk cache setiap kali dan ke sheet paling sering tiap 3 menit (`Config.SAVE_SHEET_SECONDS`).

Jalankan di project Apps Script **terpisah** dengan spreadsheet sendiri, jangan di klaster yang dipakai sekolah. Pakai akun pemilik yang jenisnya sama dengan klaster sungguhan (Workspace atau Gmail), karena kuotanya berbeda.

1. Buat project baru "SIULIN Uji Beban" dengan cara yang sama seperti langkah 2 dan 3 di Deploy satu klaster (project di browser, `.clasp.json`, `clasp push -f`).
2. Di editor, jalankan `setupSiulin`.
3. Di Script Properties isi `LOADTEST_PASSWORD` (minimal 8 karakter) dan `LOADTEST_STUDENTS`, misalnya `600` supaya cukup untuk tiga kali uji 200 siswa.
4. Jalankan `setupLoadTest`. Log menampilkan token dan perintah yang perlu dijalankan. Data yang dibuat: sekolah `UJIBEBAN`, siswa `ub001` dst., pengawas `ubawas`, ujian 40 soal, tes yang sedang berlangsung selama 4 jam.
5. Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone. Salin URL `/exec`.
6. Di komputer (Node.js 18+), mulai dari jumlah kecil lalu naikkan:

```
node tools/loadtest.js --url <URL /exec> --token <TOKEN> --password <LOADTEST_PASSWORD> --students 50  --start 1   --minutes 10
node tools/loadtest.js --url <URL /exec> --token <TOKEN> --password <LOADTEST_PASSWORD> --students 100 --start 51  --minutes 10
node tools/loadtest.js --url <URL /exec> --token <TOKEN> --password <LOADTEST_PASSWORD> --students 200 --start 151 --minutes 15
```

   Setiap siswa hanya bisa mengerjakan sekali, jadi tiap putaran memakai rentang siswa baru (`--start`). Bila token habis masa berlakunya, buat token baru dari halaman Token (login `ubawas`).
7. Selesai: jalankan `stopLoadTest` agar pintu uji ditutup.

Opsi lain: `--save-every` (detik, bawaan 60 seperti browser), `--ramp` (login disebar sekian detik, bawaan 120), `--watchers` (pengawas yang memantau tiap 30 detik, bawaan 2), `--timeout`, `--out`.

Membaca hasil: skrip mencetak waktu respons per rute (p50, p95, maks) dan kode gagal, lalu menyimpan detail ke `loadtest-result.json`. Syarat lulus yang dipakai: semua siswa terkumpul, gagal di bawah 1%, dan p95 auto-save di bawah 5 detik. Kode gagal `BUSY` berarti antrean kunci habis waktu (jalur siswa tidak lagi memakai kunci, jadi kode ini seharusnya tidak muncul); `HTTP_..._HTML` biasanya halaman error Google karena terlalu banyak eksekusi serentak. Jumlah siswa terbesar yang masih lulus adalah kapasitas satu klaster; beri cadangan sekitar 30%.

Uji beban memakai pintu `doPost` yang meneruskan permintaan ke `apiCall` dengan pemeriksaan sesi dan izin yang sama, hanya untuk rute ujian dan monitoring, dan hanya bila Script Property `LOADTEST_ENABLED` bernilai `true`. Di klaster sekolah properti ini tidak pernah diisi.
