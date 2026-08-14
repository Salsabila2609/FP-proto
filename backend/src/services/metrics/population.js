import { query } from '../../db/duckdb.js';
import { BASE_TABLES } from '../../registry/fileSources.js';
import { assertIdentifier } from '../../lib/sql.js';
import { badRequest } from '../../lib/errors.js';

/**
 * Bangun klausa WHERE dari filter populasi sebuah program.
 *
 * Nama kolom divalidasi terhadap allowlist `filterable` di registry, dan
 * SETIAP nilai lewat parameter binding. Filter ini datang dari input pengguna
 * (atau hasil ekstraksi proposal), jadi tidak boleh ada satu pun potongan
 * string yang disambung langsung ke SQL.
 *
 * Bentuk filter:
 *   [{ column: 'package_name', op: 'contains', value: 'Platinum 50' },
 *    { column: 'channel', op: 'in', value: ['FRANCHISE'] }]
 */
export function buildPopulationWhere(baseTable, filters = []) {
  const spec = BASE_TABLES[baseTable];
  if (!spec) throw badRequest(`Tabel dasar "${baseTable}" tidak dikenal.`);

  const clauses = [];
  const params = [];

  for (const f of filters) {
    if (!spec.filterable.includes(f.column)) {
      throw badRequest(`Kolom "${f.column}" tidak boleh difilter pada ${baseTable}.`);
    }
    assertIdentifier(f.column);
    const col = `"${f.column}"`;

    switch (f.op) {
      case 'equals':
        clauses.push(`UPPER(${col}) = UPPER(?)`);
        params.push(String(f.value));
        break;
      case 'contains':
        clauses.push(`UPPER(${col}) LIKE UPPER(?)`);
        params.push(`%${String(f.value)}%`);
        break;
      case 'starts_with':
        clauses.push(`UPPER(${col}) LIKE UPPER(?)`);
        params.push(`${String(f.value)}%`);
        break;
      case 'in': {
        const list = Array.isArray(f.value) ? f.value : [f.value];
        if (!list.length) break;
        clauses.push(`UPPER(${col}) IN (${list.map(() => 'UPPER(?)').join(',')})`);
        params.push(...list.map(String));
        break;
      }
      case 'gte':
      case 'lte': {
        clauses.push(`${col} ${f.op === 'gte' ? '>=' : '<='} ?`);
        params.push(Number(f.value));
        break;
      }
      default:
        throw badRequest(`Operator filter "${f.op}" tidak dikenal.`);
    }
  }

  return { sql: clauses.length ? clauses.join(' AND ') : '1=1', params, spec };
}

/** Total satu ukuran untuk populasi program dalam rentang tanggal tertentu. */
export async function populationTotal({ baseTable, filters, measure, start, end, extraGeo }) {
  const { sql, params, spec } = buildPopulationWhere(baseTable, filters);
  const expr = spec.measures[measure];
  if (!expr) throw badRequest(`Ukuran "${measure}" tidak tersedia di ${baseTable}.`);

  let geoSql = '';
  const geoParams = [];
  if (extraGeo?.values?.length) {
    const col = spec.geoColumns[extraGeo.level];
    if (col) {
      assertIdentifier(col);
      geoSql = ` AND "${col}" IN (${extraGeo.values.map(() => '?').join(',')})`;
      geoParams.push(...extraGeo.values);
    }
  }

  const rows = await query(
    `SELECT ${expr} AS v FROM "${assertIdentifier(baseTable)}"
     WHERE ${sql}${geoSql} AND "${spec.dateColumn}" BETWEEN ? AND ?`,
    [...params, ...geoParams, start, end],
  );
  return Number(rows[0]?.v ?? 0);
}

/** Pecahan populasi per wilayah, untuk melihat daerah mana yang paling responsif. */
export async function populationByGeo({ baseTable, filters, measure, level, start, end }) {
  const { sql, params, spec } = buildPopulationWhere(baseTable, filters);
  const col = spec.geoColumns[level] ?? spec.geoColumns.sales_area;
  assertIdentifier(col);
  return query(
    `SELECT "${col}" AS geo, ${spec.measures[measure]} AS v
     FROM "${assertIdentifier(baseTable)}"
     WHERE ${sql} AND "${spec.dateColumn}" BETWEEN ? AND ?
     GROUP BY 1 HAVING ${spec.measures[measure]} > 0 ORDER BY 2 DESC`,
    [...params, start, end],
  );
}

/**
 * Populasi pembanding: baris di tabel dasar yang sama, periode sama, TIDAK
 * kena filter program. Ini yang memungkinkan before-after dikoreksi terhadap
 * tren umum -- tanpa ini, program yang cuma ikut naik akan terlihat berhasil.
 */
export async function complementTotal({ baseTable, filters, measure, start, end }) {
  const { sql, params, spec } = buildPopulationWhere(baseTable, filters);
  const rows = await query(
    `SELECT ${spec.measures[measure]} AS v FROM "${assertIdentifier(baseTable)}"
     WHERE NOT (${sql}) AND "${spec.dateColumn}" BETWEEN ? AND ?`,
    [...params, start, end],
  );
  return Number(rows[0]?.v ?? 0);
}