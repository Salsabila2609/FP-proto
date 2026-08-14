# Metodologi evaluasi

Semua rumus di bawah ada di `backend/src/services/metrics/recipes.js` dan
berjalan sebagai SQL. Gemini tidak pernah menghitung, memilih, atau mengubahnya.

## Kenapa pertumbuhan mentah tidak dipakai

Kalau seluruh region naik 10% dan wilayah program naik 12%, keberhasilan program
adalah **2 poin persen**, bukan 12%. Melaporkan 12% berarti mengklaim tren pasar
sebagai hasil kerja sendiri.

## did_acquisition / did_revenue

Difference-in-differences yang disederhanakan.

```
periode_sebelum = sepanjang durasi program, tepat sebelum tanggal mulai
wilayah_pembanding = level geo yang sama, region yang sama, tidak kena program

uplift_pp   = pertumbuhan(wilayah_program) − pertumbuhan(wilayah_pembanding)
perkiraan   = nilai_sebelum_program × (1 + pertumbuhan_pembanding)
inkremental = nilai_sesudah_program − perkiraan
```

Dilewati kalau: tidak ada wilayah pembanding, atau periode sebelum program kosong.

**Batasan.** Ini bukan eksperimen acak. Kalau wilayah program dipilih justru
karena sedang tumbuh cepat, uplift akan bias ke atas. Perlakukan hasilnya
sebagai indikasi kuat, bukan bukti kausal.

## arpu_health

Untuk program ARPU dan loyalty. Revenue rebuy dibagi jumlah outlet aktif.

| Pola | Vonis |
|---|---|
| ARPU naik, basis stabil/naik | sehat |
| ARPU naik, basis turun | `arpu_naik_basis_turun` — pendapatan dari memeras pelanggan lama |
| ARPU turun | `arpu_turun` |

## marketshare_delta

Validasi silang paling penting. Membandingkan pangsa gross-add IOH di bulan awal
dan akhir program. **Revenue naik + pangsa datar = ikut tren industri.**
Pangsa naik = benar-benar merebut pelanggan.

Dilewati kalau program berjalan dalam satu bulan (belum ada dua titik pengamatan).

## event_window

Untuk aktivitas marcomm yang tidak bisa diatribusikan ke transaksi individual —
school attack, booth, sponsorship.

```
jendela   = H-3 sampai H+7 di wilayah event
baseline  = rata-rata harian wilayah yang sama, H-45 sampai H-4
lift      = SP_jendela / (baseline_harian × 11) − 1
```

Dilewati kalau kurang dari 3 event terlaksana dengan tanggal dan wilayah jelas.

**Batasan.** Jendela event bisa tumpang tindih dengan program lain di wilayah
yang sama. Angka ini indikatif; `hit_rate` (berapa banyak event yang liftnya
positif) sering lebih informatif daripada rata-ratanya.

## cost_efficiency

```
biaya_per_hasil_inkremental = biaya_total / hasil_inkremental
porsi_organik               = 1 − hasil_inkremental / hasil_total
```

Pembaginya inkremental, bukan total. Program mahal yang sebagian besar hasilnya
organik akan terlihat buruk di sini, dan memang seharusnya begitu.

## Skor komposit

Tiap metrik dinormalisasi 0–100 **di dalam kategori yang sama**, lalu dirata-rata.
Program akuisisi tidak pernah dibandingkan dengan program loyalty: satuan KPI-nya
berbeda, jadi angkanya akan terlihat rapi tapi tidak berarti apa-apa.

## Tingkat keyakinan

| Tingkat | Syarat |
|---|---|
| tinggi | ≥8 wilayah program, ≥8 wilayah pembanding, periode sebelum lengkap |
| sedang | ≥3 wilayah, pembanding ada |
| rendah | di bawah itu, atau >30% nama wilayah tidak cocok dengan warehouse |

Nama wilayah yang tidak cocok menurunkan keyakinan apa pun kata rumusnya —
sebagian program tidak terhitung, jadi hasilnya tidak lengkap. Di UI, angka
berkeyakinan rendah sengaja dirender lebih pudar.
