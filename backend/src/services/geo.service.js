import { randomUUID } from 'node:crypto';
import { query, execute } from '../db/duckdb.js';
import { assertIdentifier } from '../lib/sql.js';
import { queryCache } from '../lib/cache.js';

const LEVEL_COLUMN = {
  region: 'region_name',
  area: 'area_name',
  sales_area: 'sales_area_name',
  cluster: 'cluster_name',
  kabkot: 'kabkot_nm',
  kecamatan: 'kecamatan_nm',
  outlet: 'outlet',
};

export const geoColumn = (level) => assertIdentifier(LEVEL_COLUMN[level] ?? 'sales_area_name');

const norm = (s) => {
  const base = String(s ?? '')
    .toUpperCase()
    .replace(/^(SA|MC|KEC|KAB|KOTA)[\s.-]+/g, '')
    .replace(/[^A-Z0-9]/g, '');
  // Kode outlet sering ditulis dengan nol di depan di satu tabel dan tanpa nol
  // di tabel lain ('00158627' vs '158627'). Untuk yang murni angka, nol depan
  // dibuang supaya keduanya bertemu.
  return /^\d+$/.test(base) ? base.replace(/^0+/, '') || '0' : base;
};

export async function listGeoValues(level) {
  const col = geoColumn(level);
  return queryCache.wrap(`geo:${level}`, async () => {
    const rows = await query(`SELECT DISTINCT "${col}" AS v FROM v_trx_prepaid WHERE "${col}" IS NOT NULL`);
    return rows.map((r) => r.v);
  }, 30 * 60_000);
}

/**
 * Cocokkan nilai wilayah dari Excel ke nilai kanonik di warehouse.
 * Yang tidak ketemu dikembalikan sebagai unmatched -- bukan dibuang diam-diam,
 * karena jumlah unmatched langsung menurunkan tingkat keyakinan evaluasi.
 */
export async function resolveGeo(level, values) {
  const canonical = await listGeoValues(level);
  const byNorm = new Map(canonical.map((v) => [norm(v), v]));
  const aliases = await query('SELECT alias, geo_value FROM geo_alias WHERE geo_level = ?', [level]);
  const aliasMap = new Map(aliases.map((a) => [norm(a.alias), a.geo_value]));

  const matched = new Map();
  const unmatched = [];

  for (const raw of new Set(values.filter(Boolean))) {
    const n = norm(raw);
    const hit =
      aliasMap.get(n) ??
      byNorm.get(n) ??
      canonical.find((c) => norm(c).includes(n) && n.length >= 4) ??
      canonical.find((c) => n.includes(norm(c)) && norm(c).length >= 4);
    if (hit) matched.set(raw, hit);
    else unmatched.push(raw);
  }

  return { matched, unmatched, canonicalValues: [...new Set(matched.values())] };
}

export async function saveAlias({ alias, level, geoValue, userId }) {
  await execute(
    'INSERT INTO geo_alias (id, alias, geo_level, geo_value, confirmed_by) VALUES (?,?,?,?,?)',
    [randomUUID(), alias, level, geoValue, userId ?? null],
  );
  queryCache.clear('geo:');
}