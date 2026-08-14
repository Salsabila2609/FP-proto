import { REGIONS, AREAS_IN_SCOPE, TRANSACTION_TYPES, TRANSACTION_CATEGORY } from './regions.js';

/**
 * Registry tabel sumber.
 *
 * Setiap entry mendeklarasikan: query BigQuery-nya, kolom tujuan di DuckDB,
 * dan granularitas partisi. Sync service tidak tahu apa-apa soal tabel spesifik
 * -- dia cuma me-loop registry ini. Menambah tabel baru = menambah satu objek
 * di bawah, tidak menyentuh kode sync, route, atau UI Data Health.
 *
 * grain:
 *   daily    -> partisi per tanggal 'YYYY-MM-DD'
 *   monthly  -> partisi per bulan 'YYYY-MM'
 *   snapshot -> tabel dimensi, seluruh isi diganti tiap refresh
 *
 * ------------------------------------------------------------------
 * CATATAN TIPE KOLOM -- sumber sebagian besar error saat setup awal.
 *
 * Di dataset `data-dtp-prd-aa1a.stg`, kolom partisi `dt_id` selalu TIMESTAMP,
 * sementara kolom tanggal bisnisnya sering STRING dengan format berbeda-beda:
 *
 *   ifrs_prepaid_salmo         datetime   STRING     process_id TIMESTAMP (partisi)
 *   cashback                   data_date  STRING     dt_id      TIMESTAMP (partisi)
 *   stock_balance_daily        data_date  STRING     dt_id      TIMESTAMP (partisi)
 *   mobo_allocation_org_to_org datetime   TIMESTAMP  dt_id      TIMESTAMP (partisi)
 *   mobi_master_hierarchy_feed --                    dt_id      TIMESTAMP (partisi)
 *   ar_kec_fbms (java_usg)     dt_id      INTEGER    month_id   INTEGER
 *
 * Karena itu filter partisi selalu ditulis sebagai RENTANG timestamp
 * (`>= X AND < X+1 hari`), bukan `DATE(dt_id) = @dt`. Membungkus kolom partisi
 * dalam fungsi mematikan partition pruning, dan BigQuery akan memindai seluruh
 * tabel -- mahal, dan pada beberapa tabel langsung ditolak karena
 * require_partition_filter.
 *
 * Kolom tanggal bisnis bertipe STRING dibaca lewat helper DATE_FROM_STRING di
 * bawah, yang menerima 'YYYY-MM-DD', 'YYYY-MM-DD HH:MM:SS', maupun 'YYYYMMDD'
 * tanpa perlu tahu mana yang dipakai tabel tertentu.
 * ------------------------------------------------------------------
 */

/** Baca kolom tanggal bertipe STRING apa pun formatnya, tanpa meledak. */
const DATE_FROM_STRING = (col) => `COALESCE(
      DATE(SAFE_CAST(${col} AS TIMESTAMP)),
      SAFE.PARSE_DATE('%Y%m%d', ${col})
    )`;

/** Rentang satu hari WIB pada kolom partisi TIMESTAMP. */
const DAY_RANGE = (col, param = '@dt') =>
  `${col} >= TIMESTAMP(${param}, 'Asia/Jakarta')
   AND ${col} <  TIMESTAMP_ADD(TIMESTAMP(${param}, 'Asia/Jakarta'), INTERVAL 1 DAY)`;

export const TABLES = {
  territory: {
    key: 'territory',
    label: 'Hierarki wilayah outlet',
    target: 'dim_territory',
    grain: 'snapshot',
    partitionColumn: 'snapshot_date',
    replaceAll: true,
    description:
      'Sumber kebenaran tunggal untuk region/area/sales area. Semua tabel fakta di-join lewat outlet_code, bukan lewat kolom region masing-masing.',
    columns: [
      { name: 'outlet_code', type: 'VARCHAR' },
      { name: 'region_name', type: 'VARCHAR' },
      { name: 'area_name', type: 'VARCHAR' },
      { name: 'sub_area_name', type: 'VARCHAR' },
      { name: 'sales_area_name', type: 'VARCHAR' },
      { name: 'cluster_name', type: 'VARCHAR' },
      { name: 'kabkot_nm', type: 'VARCHAR' },
      { name: 'kecamatan_nm', type: 'VARCHAR' },
      { name: 'channel', type: 'VARCHAR' },
      { name: 'brand', type: 'VARCHAR' },
      { name: 'snapshot_date', type: 'DATE' },
    ],
    buildQuery: (partitionValue) => ({
      query: `
        -- dim_territory bergrain SATU BARIS PER OUTLET (itu primary key-nya).
        -- Tanpa QUALIFY, satu outlet yang terdaftar di dua brand menghasilkan
        -- dua baris dan pemuatan ke DuckDB gagal karena duplicate key.
        -- Baris yang dipertahankan adalah yang paling lengkap datanya.
        SELECT
          CAST(outlet_code AS STRING) AS outlet_code,
          region_name,
          -- Hierarki di tabel ini: region > sub_area > sales_area > cluster.
          -- Tidak ada kolom "area" tersendiri, jadi level area dipetakan ke
          -- sub_area supaya penamaan level geo di aplikasi tetap konsisten.
          sub_area_name AS area_name,
          sub_area_name,
          sales_area_name,
          cluster_name,
          -- Kabupaten tidak tersedia di feed ini. Kalau nanti dibutuhkan untuk
          -- join ke market share level kabkot, sumbernya ada di stg.cashback
          -- (kolom kabupaten) atau perlu tabel referensi terpisah.
          CAST(NULL AS STRING) AS kabkot_nm,
          kecamatan_name AS kecamatan_nm,
          channel,
          brand
        FROM \`data-dtp-prd-aa1a.stg.mobi_master_hierarchy_feed\`
        WHERE ${DAY_RANGE('dt_id')}
          AND region_name IN UNNEST(@regions)
        QUALIFY ROW_NUMBER() OVER (
          PARTITION BY CAST(outlet_code AS STRING)
          ORDER BY
            cluster_name IS NULL,
            kecamatan_name IS NULL,
            sales_area_name IS NULL,
            brand
        ) = 1
      `,
      params: { dt: partitionValue, regions: REGIONS },
    }),
    transform: (row, partitionValue) => ({ ...row, snapshot_date: partitionValue }),
  },

  trx_prepaid: {
    key: 'trx_prepaid',
    label: 'Transaksi prepaid (SALMO)',
    target: 'fact_trx_prepaid',
    grain: 'daily',
    partitionColumn: 'tanggal',
    description: 'Basis semua metrik SP, rebuy, dan voucher.',
    columns: [
      { name: 'tanggal', type: 'DATE' },
      { name: 'transaction_type', type: 'VARCHAR' },
      { name: 'trx_category', type: 'VARCHAR' },
      { name: 'region_name', type: 'VARCHAR' },
      { name: 'area_name', type: 'VARCHAR' },
      { name: 'sales_area_name', type: 'VARCHAR' },
      { name: 'cluster_name', type: 'VARCHAR' },
      { name: 'organization_id', type: 'VARCHAR' },
      { name: 'organization_name', type: 'VARCHAR' },
      { name: 'product_name', type: 'VARCHAR' },
      { name: 'channel', type: 'VARCHAR' },
      { name: 'brand', type: 'VARCHAR' },
      { name: 'jumlah_transaksi', type: 'BIGINT' },
      { name: 'total_revenue', type: 'DOUBLE' },
    ],
    // process_id adalah kolom partisi dan WAJIB difilter (require_partition_filter).
    // Konvensi di tabel ini: data tanggal D diproses pada D+1.
    buildQuery: (dateStr) => ({
      query: `
        SELECT
          ${DATE_FROM_STRING('datetime')} AS tanggal,
          transaction_type,
          region AS region_name,
          area AS area_name,
          sales_area AS sales_area_name,
          cluster AS cluster_name,
          CAST(organization_id AS STRING) AS organization_id,
          organization_name,
          product_name,
          channel,
          CASE
            WHEN brand IS NULL AND ${DATE_FROM_STRING('datetime')} < DATE '2026-05-01' THEN 'IM3'
            ELSE brand
          END AS brand,
          COUNT(*) AS jumlah_transaksi,
          SUM(SAFE_CAST(amount_debit AS FLOAT64)) AS total_revenue
        FROM \`data-dtp-prd-aa1a.stg.ifrs_prepaid_salmo\`
        WHERE process_id >= TIMESTAMP_ADD(TIMESTAMP(@dt), INTERVAL 1 DAY)
          AND process_id <  TIMESTAMP_ADD(TIMESTAMP(@dt), INTERVAL 2 DAY)
          AND ${DATE_FROM_STRING('datetime')} = DATE(@dt)
          AND transaction_status = 'Completed'
          AND region IN UNNEST(@regions)
          AND transaction_type IN UNNEST(@types)
        GROUP BY 1,2,3,4,5,6,7,8,9,10,11
      `,
      params: { dt: dateStr, regions: REGIONS, types: TRANSACTION_TYPES },
    }),
    transform: (row) => ({
      ...row,
      trx_category: TRANSACTION_CATEGORY[row.transaction_type] ?? 'Lainnya',
    }),
  },

  cashback: {
    key: 'cashback',
    label: 'Cashback program',
    target: 'fact_cashback',
    grain: 'daily',
    partitionColumn: 'tanggal',
    description: 'Biaya program prepaid. cashback_type dipakai sebagai nama program.',
    columns: [
      { name: 'tanggal', type: 'DATE' },
      { name: 'area_name', type: 'VARCHAR' },
      { name: 'sales_area_name', type: 'VARCHAR' },
      { name: 'cluster_name', type: 'VARCHAR' },
      { name: 'outlet_code', type: 'VARCHAR' },
      { name: 'outlet_name', type: 'VARCHAR' },
      { name: 'cashback_type', type: 'VARCHAR' },
      { name: 'cashback', type: 'DOUBLE' },
      { name: 'brand', type: 'VARCHAR' },
      { name: 'kecamatan_nm', type: 'VARCHAR' },
      { name: 'kabkot_nm', type: 'VARCHAR' },
    ],
    buildQuery: (dateStr) => ({
      query: `
        SELECT
          ${DATE_FROM_STRING('data_date')} AS tanggal,
          area_name,
          sales_area_name,
          cluster_name,
          CAST(short_code AS STRING) AS outlet_code,
          biz_org_name AS outlet_name,
          cashback_type,
          brand,
          kecamatan AS kecamatan_nm,
          kabupaten AS kabkot_nm,
          SUM(SAFE_CAST(cashback_value AS FLOAT64)) AS cashback
        FROM \`data-dtp-prd-aa1a.stg.cashback\`
        WHERE ${DAY_RANGE('dt_id')}
          AND area_name IN UNNEST(@areas)
        GROUP BY 1,2,3,4,5,6,7,8,9,10
      `,
      params: { dt: dateStr, areas: AREAS_IN_SCOPE },
    }),
  },

  stock_balance: {
    key: 'stock_balance',
    label: 'Injeksi saldo outlet',
    target: 'fact_stock_balance',
    grain: 'daily',
    partitionColumn: 'tanggal',
    columns: [
      { name: 'tanggal', type: 'DATE' },
      { name: 'outlet_code', type: 'VARCHAR' },
      { name: 'outlet_name', type: 'VARCHAR' },
      { name: 'region_name', type: 'VARCHAR' },
      { name: 'sub_area_name', type: 'VARCHAR' },
      { name: 'sales_area_name', type: 'VARCHAR' },
      { name: 'brand', type: 'VARCHAR' },
      { name: 'amount', type: 'DOUBLE' },
    ],
    buildQuery: (dateStr) => ({
      query: `
        WITH territory AS (
          SELECT DISTINCT CAST(outlet_code AS STRING) AS outlet_code,
                 region_name, sub_area_name, sales_area_name
          FROM \`data-dtp-prd-aa1a.stg.mobi_master_hierarchy_feed\`
          WHERE ${DAY_RANGE('dt_id')}
            AND region_name IN UNNEST(@regions)
        )
        SELECT
          ${DATE_FROM_STRING('m.data_date')} AS tanggal,
          CAST(m.short_code AS STRING) AS outlet_code,
          m.biz_org_name AS outlet_name,
          t.region_name,
          t.sub_area_name,
          t.sales_area_name,
          m.brand,
          SUM(SAFE_CAST(m.total_debit_amt AS FLOAT64)) AS amount
        FROM \`data-dtp-prd-aa1a.stg.stock_balance_daily\` m
        JOIN territory t ON CAST(m.short_code AS STRING) = t.outlet_code
        WHERE ${DAY_RANGE('m.dt_id')}
          AND m.sales_channel = 'SALMOBO'
        GROUP BY 1,2,3,4,5,6,7
        HAVING SUM(SAFE_CAST(m.total_debit_amt AS FLOAT64)) > 0
      `,
      params: { dt: dateStr, regions: REGIONS },
    }),
  },

  allocation: {
    key: 'allocation',
    label: 'Alokasi org-to-org',
    target: 'fact_allocation',
    grain: 'daily',
    partitionColumn: 'tanggal',
    columns: [
      { name: 'tanggal', type: 'DATE' },
      { name: 'brand', type: 'VARCHAR' },
      { name: 'outlet_code', type: 'VARCHAR' },
      { name: 'region_name', type: 'VARCHAR' },
      { name: 'sub_area_name', type: 'VARCHAR' },
      { name: 'sales_area_name', type: 'VARCHAR' },
      { name: 'daily_amount', type: 'DOUBLE' },
    ],
    buildQuery: (dateStr) => ({
      query: `
        WITH territory AS (
          SELECT DISTINCT CAST(outlet_code AS STRING) AS outlet_code,
                 region_name, sub_area_name, sales_area_name
          FROM \`data-dtp-prd-aa1a.stg.mobi_master_hierarchy_feed\`
          WHERE ${DAY_RANGE('dt_id')}
            AND region_name IN UNNEST(@regions)
        )
        SELECT
          DATE(a.dt_id, 'Asia/Jakarta') AS tanggal,
          a.brand,
          CAST(a.credit_party_id AS STRING) AS outlet_code,
          t.region_name, t.sub_area_name, t.sales_area_name,
          SUM(SAFE_CAST(a.amount AS FLOAT64)) AS daily_amount
        FROM \`data-dtp-prd-aa1a.stg.mobo_allocation_org_to_org\` a
        JOIN territory t ON CAST(a.credit_party_id AS STRING) = t.outlet_code
        WHERE ${DAY_RANGE('a.dt_id')}
          AND REGEXP_CONTAINS(a.credit_party_id, r'^[0-9]+$')
          AND a.organization_type IN ('Dealer', 'SDP')
          AND a.transaction_status = 'Completed'
        GROUP BY 1,2,3,4,5,6
      `,
      params: { dt: dateStr, regions: REGIONS },
    }),
  },

  marketshare: {
    key: 'marketshare',
    label: 'Market share per kecamatan',
    target: 'fact_marketshare',
    grain: 'monthly',
    partitionColumn: 'month_id',
    description:
      'Validasi silang. Revenue naik tapi share stagnan = ikut tren industri, bukan program. Sumbernya berdenyut MINGGUAN, jadi satu partisi bulan berisi beberapa tanggal snapshot -- pangsa dihitung per snapshot, tidak dijumlahkan antar minggu.',
    columns: [
      { name: 'tanggal', type: 'DATE' },
      { name: 'month_id', type: 'VARCHAR' },
      { name: 'region_name', type: 'VARCHAR' },
      { name: 'area_name', type: 'VARCHAR' },
      { name: 'sales_area_name', type: 'VARCHAR' },
      { name: 'kabkot_nm', type: 'VARCHAR' },
      { name: 'kecamatan_nm', type: 'VARCHAR' },
      { name: 'operator', type: 'VARCHAR' },
      { name: 'total_base_ori', type: 'DOUBLE' },
      { name: 'base_share_pct', type: 'DOUBLE' },
      { name: 'total_ga_ori', type: 'DOUBLE' },
      { name: 'ga_share_pct', type: 'DOUBLE' },
    ],
    // Data sumbernya mingguan. Baris disimpan per tanggal snapshot, BUKAN
    // dikolapskan per bulan: base_ori_abs adalah stok, jadi menjumlahkan empat
    // snapshot mingguan akan melipatgandakan angkanya. Pangsa pun dihitung
    // dalam satu snapshot (PARTITION BY dt_id), bukan lintas minggu.
    //
    // Di tabel ini dt_id dan month_id bertipe INTEGER (YYYYMMDD dan YYYYMM),
    // bukan TIMESTAMP seperti tabel stg. Batas bulan dihitung di JS supaya
    // filternya berupa literal integer -- kalau dihitung lewat CTE, BigQuery
    // belum tentu bisa melakukan partition pruning.
    //
    // Agregasi dipisah ke CTE `agg` lebih dulu. Kalau SUM(...) OVER (...) ditulis
    // sekelas dengan GROUP BY sementara ada alias keluaran bernama sama dengan
    // kolom sumber (month_id), PARTITION BY akan menunjuk ke alias dan BigQuery
    // menolak dengan "neither grouped nor aggregated".
    buildQuery: (monthStr) => {
      const [y, m] = monthStr.split('-').map(Number);
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const pad = (n) => String(n).padStart(2, '0');
      return {
        query: `
        WITH agg AS (
          SELECT
            dt_id, month_id, region, area, sales_area, kabkot_nm, kecamatan_nm, operator,
            SUM(base_ori_abs) AS total_base_ori,
            SUM(ga_ori_abs)   AS total_ga_ori
          FROM \`data-java-prd-97b9.java_usg.ar_kec_fbms\`
          WHERE dt_id BETWEEN @lo AND @hi
            AND region IN UNNEST(@regions)
          GROUP BY 1,2,3,4,5,6,7,8
        )
        SELECT
          PARSE_DATE('%Y%m%d', CAST(agg.dt_id AS STRING)) AS tanggal,
          CAST(agg.month_id AS STRING) AS month_id,
          agg.region       AS region_name,
          agg.area         AS area_name,
          agg.sales_area   AS sales_area_name,
          agg.kabkot_nm,
          agg.kecamatan_nm,
          agg.operator,
          agg.total_base_ori,
          ROUND(SAFE_DIVIDE(agg.total_base_ori, SUM(agg.total_base_ori) OVER (
            PARTITION BY agg.dt_id, agg.region, agg.area, agg.sales_area,
                         agg.kabkot_nm, agg.kecamatan_nm)) * 100, 2) AS base_share_pct,
          agg.total_ga_ori,
          ROUND(SAFE_DIVIDE(agg.total_ga_ori, SUM(agg.total_ga_ori) OVER (
            PARTITION BY agg.dt_id, agg.region, agg.area, agg.sales_area,
                         agg.kabkot_nm, agg.kecamatan_nm)) * 100, 2) AS ga_share_pct
        FROM agg
      `,
        params: {
          lo: Number(`${y}${pad(m)}01`),
          hi: Number(`${y}${pad(m)}${pad(lastDay)}`),
          first_day: `${y}-${pad(m)}-01`,
          regions: REGIONS,
        },
        types: { lo: 'INT64', hi: 'INT64', first_day: 'STRING' },
      };
    },
    transform: (row, partitionValue) => ({
      ...row,
      month_id: String(row.month_id ?? partitionValue.replace('-', '')),
    }),
  },
};

export const TABLE_KEYS = Object.keys(TABLES);
export const getTable = (key) => TABLES[key] ?? null;