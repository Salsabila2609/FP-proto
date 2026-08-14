import { query } from '../../db/duckdb.js';
import { geoColumn } from '../geo.service.js';
import { queryCache } from '../../lib/cache.js';

const MEASURE_SQL = {
  sp: "SUM(CASE WHEN trx_category = 'SP' THEN jumlah_transaksi ELSE 0 END)",
  rebuy_revenue: "SUM(CASE WHEN trx_category = 'Rebuy' THEN total_revenue ELSE 0 END)",
  vou_revenue: "SUM(CASE WHEN trx_category = 'Vou' THEN total_revenue ELSE 0 END)",
  revenue: 'SUM(total_revenue)',
  trx: 'SUM(jumlah_transaksi)',
};

export const MEASURES = Object.keys(MEASURE_SQL);

/** Total satu ukuran untuk sekumpulan wilayah dalam satu rentang tanggal. */
export async function measureTotal({ measure, level, geoValues, start, end }) {
  const expr = MEASURE_SQL[measure] ?? MEASURE_SQL.revenue;
  const col = geoColumn(level);
  if (!geoValues.length) return 0;

  const key = `m:${measure}:${level}:${start}:${end}:${geoValues.slice().sort().join(',')}`;
  return queryCache.wrap(key, async () => {
    const rows = await query(
      `SELECT ${expr} AS v FROM v_trx_prepaid
       WHERE tanggal BETWEEN ? AND ? AND "${col}" IN (${geoValues.map(() => '?').join(',')})`,
      [start, end, ...geoValues],
    );
    return Number(rows[0]?.v ?? 0);
  });
}

/** Ukuran per wilayah, dipakai untuk ranking antar area dalam satu program. */
export async function measureByGeo({ measure, level, geoValues, start, end }) {
  const expr = MEASURE_SQL[measure] ?? MEASURE_SQL.revenue;
  const col = geoColumn(level);
  if (!geoValues.length) return [];
  return query(
    `SELECT "${col}" AS geo, ${expr} AS v FROM v_trx_prepaid
     WHERE tanggal BETWEEN ? AND ? AND "${col}" IN (${geoValues.map(() => '?').join(',')})
     GROUP BY 1 ORDER BY 2 DESC`,
    [start, end, ...geoValues],
  );
}

/** Wilayah pembanding: level yang sama, region yang sama, tapi tidak kena program. */
export async function findControlGeos({ level, treated, limit = 200 }) {
  const col = geoColumn(level);
  if (!treated.length) return [];
  const rows = await query(
    `WITH treated_regions AS (
       SELECT DISTINCT region_name FROM v_trx_prepaid
       WHERE "${col}" IN (${treated.map(() => '?').join(',')})
     )
     SELECT DISTINCT "${col}" AS geo FROM v_trx_prepaid
     WHERE region_name IN (SELECT region_name FROM treated_regions)
       AND "${col}" IS NOT NULL
       AND "${col}" NOT IN (${treated.map(() => '?').join(',')})
     LIMIT ?`,
    [...treated, ...treated, limit],
  );
  return rows.map((r) => r.geo);
}

export function shiftDate(dateStr, days) {
  return new Date(new Date(`${dateStr}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000) + 1;
}

export const growth = (post, pre) => (pre > 0 ? post / pre - 1 : null);
