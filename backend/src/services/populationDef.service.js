import { randomUUID } from 'node:crypto';
import { query, execute } from '../db/duckdb.js';
import { BASE_TABLES } from '../registry/fileSources.js';
import { buildPopulationWhere, populationTotal, complementTotal, populationByGeo } from './metrics/population.js';
import { assertIdentifier } from '../lib/sql.js';
import { badRequest } from '../lib/errors.js';
import { queryCache } from '../lib/cache.js';

/** Tabel dasar yang boleh dipakai mendefinisikan program, untuk mengisi form. */
export function listBaseTables() {
  return Object.entries(BASE_TABLES).map(([key, spec]) => ({
    key,
    label: spec.label,
    dateColumn: spec.dateColumn,
    filterable: spec.filterable,
    measures: Object.keys(spec.measures),
    geoLevels: Object.keys(spec.geoColumns),
  }));
}

/**
 * Nilai yang benar-benar ada di satu kolom, untuk mengisi dropdown.
 * Tanpa ini pengguna harus mengetik nama paket persis, dan satu salah ketik
 * membuat populasi program kosong tanpa penjelasan.
 */
export async function distinctValues(baseTable, column, search) {
  const spec = BASE_TABLES[baseTable];
  if (!spec) throw badRequest(`Tabel dasar "${baseTable}" tidak dikenal.`);
  if (!spec.filterable.includes(column)) throw badRequest(`Kolom "${column}" tidak boleh difilter.`);
  assertIdentifier(baseTable);
  assertIdentifier(column);

  const params = [];
  let where = `WHERE "${column}" IS NOT NULL`;
  if (search) {
    where += ` AND UPPER(CAST("${column}" AS VARCHAR)) LIKE UPPER(?)`;
    params.push(`%${search}%`);
  }

  return query(
    `SELECT CAST("${column}" AS VARCHAR) AS value, COUNT(*) AS rows_count
     FROM "${baseTable}" ${where}
     GROUP BY 1 ORDER BY 2 DESC LIMIT 80`,
    params,
  );
}

/**
 * Pratinjau populasi sebelum program disimpan.
 *
 * Menampilkan berapa yang kena filter DAN berapa sisanya, di periode sebelum
 * maupun selama program. Ini penting: kalau periode sebelum kosong, program
 * tidak akan bisa dievaluasi sama sekali, dan lebih baik ketahuan sekarang
 * daripada setelah disimpan.
 */
export async function previewPopulation({ baseTable, filters, periodStart, periodEnd, measure }) {
  const spec = BASE_TABLES[baseTable];
  if (!spec) throw badRequest(`Tabel dasar "${baseTable}" tidak dikenal.`);
  const m = measure ?? (spec.measures.ga ? 'ga' : Object.keys(spec.measures)[0]);
  buildPopulationWhere(baseTable, filters); // validasi lebih awal

  const days = Math.round((new Date(periodEnd) - new Date(periodStart)) / 86400000) + 1;
  const preStart = new Date(new Date(periodStart).getTime() - days * 86400000).toISOString().slice(0, 10);
  const preEnd = new Date(new Date(periodStart).getTime() - 86400000).toISOString().slice(0, 10);

  const [tPre, tPost, cPre, cPost, byGeo] = await Promise.all([
    populationTotal({ baseTable, filters, measure: m, start: preStart, end: preEnd }),
    populationTotal({ baseTable, filters, measure: m, start: periodStart, end: periodEnd }),
    complementTotal({ baseTable, filters, measure: m, start: preStart, end: preEnd }),
    complementTotal({ baseTable, filters, measure: m, start: periodStart, end: periodEnd }),
    populationByGeo({ baseTable, filters, measure: m, level: 'sales_area', start: periodStart, end: periodEnd }),
  ]);

  const warnings = [];
  if (tPost === 0) warnings.push('Filter ini tidak menangkap satu baris pun di periode program. Periksa ejaan nama paket atau channel.');
  if (tPre === 0 && tPost > 0) warnings.push('Periode sebelum program kosong. Uplift tidak bisa dihitung — kalau produknya memang baru diluncurkan, before-after tidak berlaku.');
  if (cPre === 0) warnings.push('Tidak ada populasi pembanding. Filter mungkin terlalu luas sehingga mencakup seluruh tabel.');

  return {
    measure: m,
    pre_period: { start: preStart, end: preEnd },
    post_period: { start: periodStart, end: periodEnd },
    treated_pre: tPre, treated_post: tPost,
    control_pre: cPre, control_post: cPost,
    treated_growth_pct: tPre > 0 ? (tPost / tPre - 1) * 100 : null,
    control_growth_pct: cPre > 0 ? (cPost / cPre - 1) * 100 : null,
    top_geo: byGeo.slice(0, 8),
    warnings,
  };
}

export async function createPopulationProgram({ program, filters, userId }) {
  buildPopulationWhere(program.base_table, filters);
  const id = randomUUID();
  await execute(
    `INSERT INTO program
       (id, name, division, category, brand, period_start, period_end, cost_total,
        geo_level, description, base_table, population_filter, target_value, proposal_note, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, program.name, program.division, program.category, program.brand ?? null,
      program.period_start, program.period_end, program.cost_total ?? 0,
      program.geo_level ?? 'sales_area', program.description ?? null,
      program.base_table, JSON.stringify(filters),
      program.target_value ?? null, program.proposal_note ?? null, userId ?? null,
    ],
  );
  queryCache.clear('eval:');
  return { programId: id };
}