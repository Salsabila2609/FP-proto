import { TABLES } from '../registry/tables.js';
import { query } from '../db/duckdb.js';
import { queryCache } from '../lib/cache.js';
import { partitionsBetween } from './sync.service.js';
import { getFileSourceInventory } from './fileSource.service.js';

/**
 * Isi tab "Data Health": berapa baris per tabel, rentang tanggalnya, dan --
 * yang paling menyelamatkan -- partisi mana yang bolong. Kesimpulan dari data
 * yang diam-diam kehilangan tiga hari itu salah tanpa ada yang sadar.
 */
export async function getTableInventory() {
  return queryCache.wrap('health:inventory', async () => {
    const out = [];
    for (const table of Object.values(TABLES)) {
      const col = table.grain === 'monthly' ? 'month_id' : table.partitionColumn;
      const stats = table.grain === 'snapshot'
        ? (await query(`SELECT count(*) AS row_count, max(snapshot_date) AS max_partition FROM "${table.target}"`))[0]
        : (await query(
            `SELECT count(*) AS row_count,
                    count(DISTINCT "${col}") AS partition_count,
                    min(CAST("${col}" AS VARCHAR)) AS min_partition,
                    max(CAST("${col}" AS VARCHAR)) AS max_partition
             FROM "${table.target}"`,
          ))[0];

      const lastRun = (await query(
        `SELECT status, row_count, error, created_at FROM sync_run
         WHERE table_key = ? ORDER BY created_at DESC LIMIT 1`,
        [table.key],
      ))[0] ?? null;

      out.push({
        key: table.key,
        label: table.label,
        target: table.target,
        grain: table.grain,
        description: table.description ?? null,
        rowCount: stats?.row_count ?? 0,
        partitionCount: stats?.partition_count ?? null,
        minPartition: stats?.min_partition ?? null,
        maxPartition: stats?.max_partition ?? null,
        lastRun,
      });
    }
    // Sumber berkas (OneDrive) tampil di daftar yang sama dengan tabel
    // BigQuery, supaya satu tab menjawab "data apa saja yang sudah ada".
    out.push(...(await getFileSourceInventory()));
    return out;
  }, 60_000);
}

/** Daftar partisi yang hilang di antara tanggal awal dan akhir. */
export async function getGaps(tableKey, startDate, endDate) {
  const table = TABLES[tableKey];
  if (!table || table.grain === 'snapshot') return { missing: [], expected: 0 };
  const col = table.grain === 'monthly' ? 'month_id' : table.partitionColumn;
  const rows = await query(
    `SELECT DISTINCT CAST("${col}" AS VARCHAR) AS p FROM "${table.target}"
     WHERE CAST("${col}" AS VARCHAR) BETWEEN ? AND ?`,
    [startDate, endDate],
  );
  const present = new Set(rows.map((r) => (table.grain === 'monthly' ? r.p.slice(0, 7) : r.p)));
  const expected = partitionsBetween(table.grain, startDate, endDate);
  return { expected: expected.length, missing: expected.filter((p) => !present.has(p)) };
}

export async function getRecentRuns(limit = 50) {
  return query(
    `SELECT table_key, partition_value, status, row_count, bytes_billed, duration_ms, error, triggered_by, created_at
     FROM sync_run ORDER BY created_at DESC LIMIT ?`,
    [Math.min(limit, 200)],
  );
}