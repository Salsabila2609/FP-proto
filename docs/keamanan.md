# Daftar periksa keamanan

## Yang sudah ada di kode

**Autentikasi.** JWT di cookie `httpOnly` `sameSite=lax`, `secure` di produksi.
Kata sandi bcrypt cost 12. Login dibatasi 10 percobaan per 15 menit per IP, dan
perbandingan hash tetap dijalankan walau email tidak terdaftar supaya waktu
respons tidak membocorkan email mana yang ada.

**Otorisasi.** Tiga peran bertingkat. `viewer` hanya membaca; `analyst` boleh
sync, unggah, dan evaluasi; `admin` boleh menghapus.

**Injeksi SQL.** Semua nilai lewat parameter binding. Nama tabel dan kolom tidak
bisa diparameterkan, jadi identifier apa pun harus lolos `assertIdentifier()`
**dan** berasal dari registry — tidak pernah langsung dari input pengguna.

**Unggahan berkas.** Ekstensi dibatasi, ukuran dibatasi, nama file dari pengguna
tidak pernah dipakai di disk (diganti UUID) sehingga tidak ada path traversal,
dan isi berkas diperiksa tanda tangan ZIP karena ekstensi bisa dipalsukan.

**Prompt injection.** Isi Excel masuk ke prompt, jadi ini permukaan serangan
nyata. Tiga lapis: konten dibungkus penanda `<data>` dengan instruksi eksplisit
untuk memperlakukannya sebagai data; keluaran dipaksa mengikuti `responseSchema`
sehingga bentuknya tidak bisa dibelokkan; hasilnya divalidasi zod dan tidak
pernah dieksekusi sebagai SQL atau kode. Pemetaan hasil AI juga selalu
dikonfirmasi manusia sebelum berlaku.

**Rahasia.** Kunci Gemini dan kredensial GCP hanya di sisi server. Frontend
memanggil `/api`; tidak ada kunci yang pernah dikirim ke browser.

**Log.** `pino` menyensor header authorization, cookie, dan field bernama
`password` atau `apiKey`.

**Biaya.** `maximumBytesBilled` pada setiap query BigQuery; token bucket lokal
untuk Gemini agar tidak memicu 429 beruntun.

## Yang harus kamu lakukan sebelum deploy

- [ ] `JWT_SECRET` hasil `openssl rand -hex 32`, bukan nilai contoh
- [ ] `CORS_ORIGINS` diisi domain nyata, bukan `*`
- [ ] HTTPS di depan (reverse proxy); `NODE_ENV=production` supaya cookie `secure` aktif
- [ ] Service account GCP hanya **BigQuery Job User** + **Data Viewer**, tanpa peran tulis
- [ ] `data/` dan `uploads/` di volume yang dicadangkan dan tidak bisa diakses publik
- [ ] Hapus akun `BOOTSTRAP_ADMIN_*` dari `.env` setelah admin pertama dibuat
- [ ] Tinjau `RETENTION_DAYS` terhadap kebijakan retensi data perusahaan
- [ ] Kalau data outlet tergolong data pribadi, pastikan sudah lewat tinjauan
      privasi internal sebelum disimpan di luar GCP
