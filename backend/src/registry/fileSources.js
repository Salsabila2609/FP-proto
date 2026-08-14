import { REGIONS } from './regions.js';

/**
 * Registry sumber berkas.
 *
 * Dipakai untuk data yang tidak lewat BigQuery -- misalnya postpaid, yang satu
 * file-nya terus diperbarui di folder berbagi OneDrive. Keuntungannya: kalau
 * HQ mengubah template atau menambah kolom, cukup ubah `map` di sini, tanpa
 * mengajukan perubahan query ke pemilik dataset.
 *
 * Dua cara mengambil berkasnya, pilih salah satu per sumber:
 *   url  -> tautan berbagi OneDrive/SharePoint (perlu izin "anyone with link")
 *   path -> folder OneDrive yang tersinkron di mesin server (lebih andal)
 *
 * ------------------------------------------------------------------
 * KEBIJAKAN DATA PRIBADI
 *
 * `keep` adalah ALLOWLIST: hanya kolom di daftar itu yang boleh dibaca.
 * `pii` adalah daftar kolom yang dilarang keras; kalau salah satunya muncul di
 * `keep`, proses muat menolak jalan. Data pribadi (msisdn, nama pelanggan,
 * NIK, NPWP, alamat) tidak pernah disalin ke warehouse -- baris diagregasi
 * lebih dulu, jadi yang tersimpan hanya hitungan dan nilai rupiah.
 * ------------------------------------------------------------------
 */

export const FILE_SOURCES = {
  postpaid_sales: {
    key: 'postpaid_sales',
    label: 'Penjualan postpaid harian',
    target: 'fact_postpaid_sales',
    // Isi salah satu lewat env: FILE_SOURCE_POSTPAID_URL atau _PATH
    url: process.env.FILE_SOURCE_POSTPAID_URL || null,
    path: process.env.FILE_SOURCE_POSTPAID_PATH || null,
    sheet: null, // null = sheet pertama
    replaceAll: true, // file ini selalu berisi keseluruhan data, bukan tambahan

    // Kolom yang HARAM disimpan. Diperiksa saat muat, bukan sekadar catatan.
    pii: [
      'msisdn', 'cust_name', 'id_number', 'nik_pelanggan', 'account_num',
      'npwp_sales', 'alamat_sales', 'nik_sales', 'no_imkas_sales',
      'NIK_SPV', 'no NPWP SPV', 'Alamat SPV', 'no imkas_SPV',
      'nik_Team Leader', 'no NPWP Team Leader', 'Alamat Team Leader', 'no imkas_Team Leader',
    ],

    // kolom sumber -> kolom tujuan
    keep: {
      activation_date: 'tanggal',
      package_name: 'package_name',
      package_group: 'package_group',
      package_type: 'package_type',
      order_type: 'order_type',
      tenure: 'tenure',
      Region_Rev: 'region_name',
      Area_Rev: 'area_name',
      'SALES AREA': 'sales_area_name',
      branch_name: 'branch_name',
      Channel_Rev: 'channel',
      'Store Name_Rev': 'store_name',
      'Agent Type': 'agent_type',
    },

    // Kolom angka yang dijumlahkan saat agregasi.
    measures: {
      'Acq Revenue (mio)': 'acq_revenue',
      'Guaranteed Revenue (Mio)': 'guaranteed_revenue',
    },
    countAs: 'ga_count',

    // Baris di luar tiga region tidak dimuat.
    rowFilter: (row) => REGIONS.includes(String(row.region_name ?? '').toUpperCase()),

    columns: [
      { name: 'tanggal', type: 'DATE' },
      { name: 'package_name', type: 'VARCHAR' },
      { name: 'package_group', type: 'VARCHAR' },
      { name: 'package_type', type: 'VARCHAR' },
      { name: 'order_type', type: 'VARCHAR' },
      { name: 'tenure', type: 'INTEGER' },
      { name: 'region_name', type: 'VARCHAR' },
      { name: 'area_name', type: 'VARCHAR' },
      { name: 'sales_area_name', type: 'VARCHAR' },
      { name: 'branch_name', type: 'VARCHAR' },
      { name: 'channel', type: 'VARCHAR' },
      { name: 'store_name', type: 'VARCHAR' },
      { name: 'agent_type', type: 'VARCHAR' },
      { name: 'ga_count', type: 'BIGINT' },
      { name: 'acq_revenue', type: 'DOUBLE' },
      { name: 'guaranteed_revenue', type: 'DOUBLE' },
    ],
  },
};

export const FILE_SOURCE_KEYS = Object.keys(FILE_SOURCES);
export const getFileSource = (key) => FILE_SOURCES[key] ?? null;

/**
 * Tabel dasar yang boleh dipakai sebagai populasi program, beserta kolom yang
 * boleh difilter. Ini allowlist -- nama kolom dari input pengguna tidak pernah
 * langsung masuk SQL.
 */
export const BASE_TABLES = {
  fact_postpaid_sales: {
    label: 'Penjualan postpaid',
    dateColumn: 'tanggal',
    measures: { ga: 'SUM(ga_count)', revenue: 'SUM(acq_revenue)', guaranteed: 'SUM(guaranteed_revenue)' },
    filterable: ['package_name', 'package_group', 'package_type', 'order_type', 'tenure', 'channel', 'agent_type', 'region_name', 'area_name', 'sales_area_name', 'branch_name', 'store_name'],
    geoColumns: { region: 'region_name', area: 'area_name', sales_area: 'sales_area_name', cluster: 'branch_name', outlet: 'store_name' },
  },
  fact_cashback: {
    label: 'Cashback prepaid',
    dateColumn: 'tanggal',
    // Nama program prepaid sudah tersedia di dalam data, jadi program tidak
    // perlu diinput manual -- sistem menemukannya sendiri dari kolom ini.
    // Kalau di tabelmu namanya `incentivename` (bukan `cashback_type`), ganti
    // di sini SAJA: registry tables.js sudah memberi alias ke `cashback_type`,
    // jadi cukup ubah alias itu dan baris ini tidak perlu disentuh.
    programColumn: 'cashback_type',
    costColumn: 'cashback',
    defaultGeoLevel: 'sales_area',
    measures: { cost: 'SUM(cashback)' },
    filterable: ['cashback_type', 'brand', 'area_name', 'sales_area_name', 'cluster_name', 'kecamatan_nm'],
    geoColumns: { area: 'area_name', sales_area: 'sales_area_name', cluster: 'cluster_name', kecamatan: 'kecamatan_nm', outlet: 'outlet_code' },
  },
};