import { randomUUID } from 'node:crypto';
import { query, queryOne, execute } from '../db/duckdb.js';
import { BASE_TABLES } from '../registry/fileSources.js';
import { assertIdentifier } from '../lib/sql.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { queryCache } from '../lib/cache.js';

const SPEC = BASE_TABLES.fact_cashback;

/**
 * Program prepaid tidak perlu didefinisikan manual: namanya sudah ada di dalam
 * data cashback, dan cashback itu sendiri adalah biaya yang dikeluarkan
 * perusahaan. Fungsi ini menyisir tabel cashback dan mengembalikan daftar
 * program beserta periode, biaya, dan cakupan wilayahnya -- tinggal dipilih
 * untuk dievaluasi.
 */
export async function discoverPrograms({ from, to } = {}) {
  const col = assertIdentifier(SPEC.programColumn);
  const cost = assertIdentifier(SPEC.costColumn);

  const params = [];
  let where = `WHERE "${col}" IS NOT NULL AND TRIM("${col}") <> ''`;
  if (from) { where += ' AND tanggal >= ?'; params.push(from); }
  if (to) { where += ' AND tanggal <= ?'; params.push(to); }

  const rows = await query(
    `SELECT
       "${col}"                       AS program_name,
       MIN(tanggal)                   AS period_start,
       MAX(tanggal)                   AS period_end,
       SUM("${cost}")                 AS cost_total,
       COUNT(*)                       AS rows_count,
       COUNT(DISTINCT outlet_code)    AS outlet_count,
       COUNT(DISTINCT sales_area_name) AS sales_area_count,
       COUNT(DISTINCT area_name)      AS area_count,
       COUNT(DISTINCT brand)          AS brand_count,
       MAX(brand)                     AS brand
     FROM fact_cashback
     ${where}
     GROUP BY 1
     ORDER BY cost_total DESC`,
    params,
  );

  // Tandai mana yang sudah pernah diimpor supaya tidak dobel.
  const imported = new Set(
    (await query("SELECT name FROM program WHERE division = 'prepaid_snd'")).map((r) => r.name),
  );

  return rows.map((r) => ({
    ...r,
    brand: r.brand_count > 1 ? null : r.brand,
    durationDays: Math.round((new Date(r.period_end) - new Date(r.period_start)) / 86400000) + 1,
    alreadyImported: imported.has(r.program_name),
  }));
}

/**
 * Ubah satu program hasil temuan jadi baris `program` + `program_result`.
 *
 * Wilayah dan biaya diambil langsung dari data cashback, jadi tidak ada yang
 * perlu diketik ulang. Setelah ini, resep evaluasi yang sudah ada (uplift SP,
 * ARPU, pangsa pasar, efisiensi biaya) bisa langsung dijalankan seperti program
 * lain -- yang diukur adalah transaksi di wilayah yang menerima cashback,
 * bukan cashback-nya sendiri.
 */
export async function importProgram({ programName, category = 'acquisition', geoLevel, userId }) {
  const col = assertIdentifier(SPEC.programColumn);
  const cost = assertIdentifier(SPEC.costColumn);
  const level = geoLevel ?? SPEC.defaultGeoLevel;
  const geoCol = SPEC.geoColumns[level];
  if (!geoCol) throw badRequest(`Level wilayah "${level}" tidak tersedia untuk data cashback.`);
  assertIdentifier(geoCol);

  const existing = await queryOne(
    "SELECT id FROM program WHERE name = ? AND division = 'prepaid_snd'", [programName],
  );
  if (existing) throw conflict(`Program "${programName}" sudah pernah diimpor.`);

  const head = await queryOne(
    `SELECT MIN(tanggal) AS period_start, MAX(tanggal) AS period_end,
            SUM("${cost}") AS cost_total, MAX(brand) AS brand, COUNT(DISTINCT brand) AS brand_count
     FROM fact_cashback WHERE "${col}" = ?`,
    [programName],
  );
  if (!head || head.cost_total === null) throw notFound(`Tidak ada data cashback untuk "${programName}".`);

  const detail = await query(
    `SELECT tanggal, "${geoCol}" AS geo_value, SUM("${cost}") AS cost
     FROM fact_cashback
     WHERE "${col}" = ? AND "${geoCol}" IS NOT NULL
     GROUP BY 1,2`,
    [programName],
  );
  if (detail.length === 0) {
    throw badRequest(`Semua baris "${programName}" kosong di level ${level}. Coba level wilayah lain.`);
  }

  const programId = randomUUID();
  await execute(
    `INSERT INTO program
       (id, name, division, category, brand, period_start, period_end, cost_total,
        geo_level, description, base_table, population_filter, created_by)
     VALUES (?,?,'prepaid_snd',?,?,?,?,?,?,?,'fact_cashback',?,?)`,
    [
      programId, programName, category,
      head.brand_count > 1 ? null : head.brand,
      head.period_start, head.period_end, head.cost_total, level,
      'Diimpor otomatis dari data cashback.',
      JSON.stringify([{ column: SPEC.programColumn, op: 'equals', value: programName }]),
      userId ?? null,
    ],
  );

  // Baris hasil di sini merekam BIAYA per wilayah per tanggal, bukan penjualan.
  // Penjualannya diambil resep evaluasi dari fact_trx_prepaid berdasarkan
  // wilayah-wilayah ini -- itulah yang membuat uplift terukur terhadap
  // wilayah pembanding yang tidak menerima cashback.
  for (const d of detail) {
    await execute(
      `INSERT INTO program_result
         (id, program_id, tanggal, geo_level, geo_value, metric_name, metric_value, unit, cost, is_executed, detail)
       VALUES (?,?,?,?,?,'cashback',?,'rupiah',?,TRUE,'{}')`,
      [randomUUID(), programId, d.tanggal, level, d.geo_value, d.cost, d.cost],
    );
  }

  queryCache.clear('eval:');
  return {
    programId,
    name: programName,
    rowsInserted: detail.length,
    geoCount: new Set(detail.map((d) => d.geo_value)).size,
    costTotal: head.cost_total,
  };
}