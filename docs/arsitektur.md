# Keputusan teknis

## DuckDB, bukan Postgres atau SQLite

Beban kerja aplikasi ini analitik: agregasi jutaan baris transaksi per rentang
tanggal dan wilayah. DuckDB kolumnar dan berjalan dalam proses, jadi tidak ada
server terpisah yang harus dijaga. Untuk `SUM(...) GROUP BY sales_area` di atas
data satu tahun, bedanya dengan SQLite bukan persentase — orde besaran.

Konsekuensinya, DuckDB hanya melayani satu penulis pada satu waktu. Karena itu
`db/duckdb.js` memisahkan **pool koneksi baca** dari **satu koneksi tulis yang
diserialkan lewat antrean promise**. Dua puluh orang membuka dashboard tidak
saling menunggu, dan sync harian tidak pernah bentrok dengan dirinya sendiri.

Pindah ke Postgres nanti berarti mengganti isi `db/duckdb.js` dan `db/bulk.js`;
sisa aplikasi memanggil `query()` / `execute()` / `transaction()` dan tidak tahu
apa yang ada di baliknya.

## Muat data lewat NDJSON, bukan INSERT per baris

`db/bulk.js` menulis batch ke berkas NDJSON sementara lalu memanggil
`read_json` milik DuckDB. Parsernya C++ dan multi-thread. Untuk 200 ribu baris
per hari, INSERT satu per satu lewat driver JS makan hitungan menit; jalur ini
detik.

Muat data selalu idempoten: partisi lama dihapus di dalam transaksi yang sama
sebelum yang baru masuk. Backfill boleh diulang berapa kali pun.

## Antrean job, bukan permintaan HTTP panjang

Backfill dua bulan bisa berjam-jam. Route mengembalikan `job id`, frontend
melakukan polling. Konkurensinya sengaja satu: supaya dua backfill tidak berebut
koneksi tulis dan tidak menggandakan tagihan BigQuery secara bersamaan.

Kalau nanti butuh banyak worker atau job yang selamat dari restart, ganti isi
`jobs/queue.js` dengan BullMQ + Redis. Permukaan API-nya sudah dijaga minimal.

## Cache

`lib/cache.js` adalah LRU + TTL per proses, dibersihkan setiap kali sync selesai
sehingga tidak pernah menyajikan angka basi setelah data berubah. Untuk banyak
instance, tukar isinya dengan Redis — pemanggilnya tidak berubah.

## Rem biaya BigQuery

Setiap query dikirim dengan `maximumBytesBilled`. Query yang akan memindai lebih
dari batas ditolak sebelum jalan. Ini yang menyelamatkan dari satu typo di
klausa `WHERE` pada tabel berukuran terabyte.

## Skala berikutnya

Urutan yang masuk akal saat beban naik:

1. Pisahkan proses worker dari proses API (kode job sudah terpisah).
2. Ganti antrean jadi Redis, cache jadi Redis.
3. Kalau warehouse lokal lewat ~50 GB, pindahkan tabel fakta ke Parquet di GCS
   dan biarkan DuckDB membacanya lewat `httpfs` — `bulk.js` yang berubah, bukan
   resep evaluasi.
