// Tiga region yang di-scope project ini. Semua query BigQuery memfilter di sini,
// jadi menambah region = ubah satu baris, bukan menyisir belasan query.
export const REGIONS = ['EAST JAVA', 'CENTRAL JAVA', 'BALI NUSRA'];

// Nama area di tabel cashback tidak memakai kolom region, jadi dipetakan manual.
export const AREAS_IN_SCOPE = [
  'SOUTH CENTRAL JAVA',
  'NORTH CENTRAL JAVA',
  'EASTERN EAST JAVA',
  'WESTERN EAST JAVA',
  'BALI NUSRA',
];

export const TRANSACTION_CATEGORY = Object.freeze({
  'Purchase Data Package': 'Rebuy',
  '3ID CVM': 'Rebuy',
  'Bulk Purchase Package Transaction': 'Rebuy',
  '3ID Top Up Package': 'Rebuy',
  '3ID FRC Transaction': 'SP',
  VoucherCardInjection: 'Vou',
  'Bulk Voucher Card Injection': 'Vou',
  '3ID Bulk Unlock': 'Vou',
  '3ID Unlock': 'Vou',
});

export const TRANSACTION_TYPES = Object.keys(TRANSACTION_CATEGORY);

// Nilai kolom `operator` di ar_kec_fbms untuk merek milik sendiri.
// CEK NILAI ASLINYA sekali, lalu sesuaikan daftar ini:
//   bq query 'SELECT DISTINCT operator FROM `data-java-prd-97b9.java_usg.ar_kec_fbms` LIMIT 20'
// Kalau ada yang meleset, pangsa pasar akan terhitung terlalu rendah tanpa
// error apa pun -- jenis kesalahan yang paling sulit disadari.
export const OWN_OPERATORS = ['INDOSAT', 'HUTCHISON'];