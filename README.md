# Evaluasi Program — Prepaid S&D, Marcomm, Postpaid

Aplikasi internal untuk menilai apakah sebuah program benar-benar berhasil, bukan
sekadar menampilkan hasilnya. Sumbernya dua: tabel BigQuery (prepaid S&D dan market
share) dan file Excel dari divisi lain yang susunan kolomnya berbeda-beda.

Prinsip yang dipegang di seluruh kode:

> **Angka dihitung SQL. AI hanya memetakan kolom dan menarasikan hasil.**
> Tidak ada jalur di aplikasi ini yang membiarkan model bahasa menentukan
> metodologi evaluasi atau menghitung sebuah metrik.

---

## Menjalankan

```bash
cp .env.example .env          # isi JWT_SECRET dan BOOTSTRAP_ADMIN_*
openssl rand -hex 32          # untuk JWT_SECRET

cd backend && npm install && npm run migrate && npm run dev
cd ../frontend && npm install && npm run dev   # http://localhost:5173
```

Tanpa `GCP_PROJECT_ID`, backend jalan dengan data contoh yang bentuknya sama
dengan produksi — cukup untuk mengembangkan UI dan menguji resep evaluasi.
Tanpa `GEMINI_API_KEY`, semua fitur non-AI tetap berfungsi; pemetaan kolom
tinggal diisi manual.

Kredensial BigQuery lewat ADC:

```bash
gcloud auth application-default login
gcloud config set project data-dtp-prd-aa1a
```

Untuk server, pakai service account dengan peran **BigQuery Job User** +
**BigQuery Data Viewer** saja. Tidak ada operasi tulis ke GCP di aplikasi ini.

Isi data pertama kali:

```bash
cd backend
node src/cli/sync.js backfill 2026-05-01 2026-08-11
```

---

## Struktur

```
backend/src/
  config/        validasi env (gagal cepat kalau ada yang salah)
  db/            koneksi DuckDB, migrasi, bulk loader, normalisasi tipe
  registry/      DAFTAR TABEL BIGQUERY + skema kanonik program  ← paling sering disentuh
  services/
    sync          tarik BigQuery → DuckDB, idempoten per partisi
    health        isi tabel, rentang, deteksi partisi bolong
    excel         parsing + penerapan mapping (deterministik, ada unit test)
    mapping       usulan pemetaan kolom dari Gemini
    geo           padankan nama wilayah Excel ke nilai kanonik
    metrics/      PUSTAKA RESEP EVALUASI                        ← inti nilai aplikasi
    evaluation    jalankan resep, simpan, ranking lintas program
    narrator      ubah angka jadi kalimat (Gemini)
  routes/        HTTP
  middleware/    auth, rate limit, upload, error
  jobs/          antrean latar + penjadwal
frontend/src/    React + Vite, empat tab
```

Empat tab: **Kesehatan data**, **Unggah program**, **Evaluasi**, **Peringkat**.

---

## Alur data

1. **Sync** — cron harian memasukkan job ke antrean; registry di-loop, tiap
   partisi ditarik dan dimuat ulang. Backfill memakai jalur yang sama.
2. **Unggah** — Excel diprofilkan, Gemini mengusulkan pemetaan kolom, kamu
   mengoreksi di form, pratinjau menunjukkan hasil transform, baru commit.
   Pemetaan yang dikonfirmasi disimpan per susunan header dan dipakai ulang
   otomatis — upload berikutnya dengan format sama tidak memanggil AI lagi.
3. **Evaluasi** — resep dijalankan berurutan; yang syaratnya tidak terpenuhi
   dilewati dengan alasan tertulis.
4. **Narasi** — hanya hasil agregat yang dikirim ke Gemini, tidak pernah data mentah.

---

## Menambah sumber atau metrik baru

**Tabel BigQuery baru** → tambah satu objek di `backend/src/registry/tables.js`
dan satu `CREATE TABLE` di migrasi baru. Sync service, tab Kesehatan Data, dan
backfill langsung mengenalinya tanpa perubahan lain.

**Resep evaluasi baru** → tambah satu entri di
`backend/src/services/metrics/recipes.js` dengan `appliesTo`, `explain`, dan
`run`. Kembalikan `{ skip: 'alasan' }` kalau syaratnya tidak terpenuhi.
UI merender resep apa pun secara generik.

---

## Dokumen lain

- [`docs/arsitektur.md`](docs/arsitektur.md) — keputusan teknis dan alasannya
- [`docs/metodologi.md`](docs/metodologi.md) — rumus tiap resep dan batasannya
- [`docs/keamanan.md`](docs/keamanan.md) — daftar periksa sebelum deploy
