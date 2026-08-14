import { z } from 'zod';

export const DIVISIONS = ['prepaid_snd', 'marcomm', 'postpaid'];
export const CATEGORIES = ['acquisition', 'arpu', 'loyalty', 'visibility', 'partnership'];
export const GEO_LEVELS = ['region', 'area', 'sales_area', 'cluster', 'kabkot', 'kecamatan', 'outlet'];

/**
 * Skema kanonik -- kontrak antara file Excel yang bentuknya bebas dan mesin
 * evaluasi. LLM diminta memetakan kolom Excel ke sini; manusia mengonfirmasi.
 * Deskripsi di bawah dikirim apa adanya ke dalam prompt, jadi kalau ada resep
 * evaluasi baru yang butuh field baru, cukup tambah di sini.
 */
export const CANONICAL_FIELDS = [
  { field: 'tanggal', type: 'date', required: true, desc: 'Tanggal kejadian/pelaksanaan. Bukan tanggal rencana.' },
  { field: 'geo_value', type: 'string', required: true, desc: 'Nama wilayah: branch, kota, kecamatan, cluster, atau kode outlet.' },
  { field: 'metric_value', type: 'number', required: true, desc: 'Angka hasil. Kolom wide (beberapa varian produk) di-unpivot jadi banyak baris.' },
  { field: 'metric_name', type: 'string', required: true, desc: 'Nama hasil, mis. "sp_3gb", "unit_iphone_bundling", "jumlah_poster".' },
  { field: 'unit', type: 'string', required: false, desc: 'Satuan: pcs, unit, rupiah, orang.' },
  { field: 'cost', type: 'number', required: false, desc: 'Biaya yang menempel pada baris ini, dalam rupiah.' },
  { field: 'is_executed', type: 'boolean', required: false, desc: 'FALSE untuk baris rencana yang belum terlaksana. Baris ini dikecualikan dari perhitungan.' },
];

export const columnRoleSchema = z.object({
  source_column: z.string(),
  role: z.enum(['tanggal', 'geo_value', 'metric_value', 'metric_name', 'unit', 'cost', 'is_executed', 'detail', 'ignore']),
  metric_name: z.string().optional(),
  unit: z.string().optional(),
  note: z.string().optional(),
});

export const mappingSchema = z.object({
  header_row_index: z.number().int().min(0).default(0),
  geo_level: z.enum(GEO_LEVELS),
  division: z.enum(DIVISIONS),
  category: z.enum(CATEGORIES),
  date_format: z.string().optional(),
  columns: z.array(columnRoleSchema).min(1),
  // Kolom wide yang harus dijadikan baris. Satu kolom = satu metric_name.
  unpivot: z
    .array(z.object({ source_column: z.string(), metric_name: z.string(), unit: z.string().optional() }))
    .default([]),
  row_filters: z
    .array(z.object({ source_column: z.string(), op: z.enum(['equals', 'not_equals', 'not_empty', 'is_empty']), value: z.string().optional() }))
    .default([]),
  warnings: z.array(z.string()).default([]),
});
