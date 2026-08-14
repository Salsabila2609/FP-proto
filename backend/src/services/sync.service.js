import { randomUUID } from 'node:crypto';
import { TABLES, getTable } from '../registry/tables.js';
import { runQuery, unwrapBqRow } from './bigquery.client.js';
import { mockRows } from './mock.service.js';
import { bulkLoad } from '../db/bulk.js';
import { execute, query } from '../db/duckdb.js';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { queryCache } from '../lib/cache.js';
import { badRequest, notFound } from '../lib/errors.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

export function assertPartition(table, value) {
  const ok = table.grain === 'monthly' ? MONTH_RE.test(value) : DATE_RE.test(value);
  if (!ok) throw badRequest(`Format partisi salah untuk ${table.key}: "${value}"`);
  return value;
}

/** Tarik satu partisi (satu hari / satu bulan / satu snapshot) dari BigQuery ke DuckDB. */
export async function syncPartition(tableKey, partitionValue, { triggeredBy = 'manual' } = {}) {
  const table = getTable(tableKey);
  if (!table) throw notFound(`Tabel "${tableKey}" tidak ada di registry.`);
  assertPartition(table, partitionValue);

  const started = Date.now();
  try {
    let rows;
    let bytesBilled = 0;

    if (config.mockBigQuery) {
      rows = mockRows(tableKey, partitionValue);
    } else {
      const spec = table.buildQuery(partitionValue);
      const res = await runQuery({ ...spec, label: tableKey });
      bytesBilled = res.bytesBilled;
      rows = res.rows.map(unwrapBqRow);
    }

    if (table.transform) rows = rows.map((r) => table.transform(r, partitionValue));

    if (table.replaceAll) {
      await execute(`DELETE FROM "${table.target}"`);
      await bulkLoad({ table: table.target, columns: table.columns, rows });
    } else {
      await bulkLoad({
        table: table.target,
        columns: table.columns,
        rows,
        partition: { column: table.partitionColumn, value: partitionValue },
      });
    }

    const durationMs = Date.now() - started;
    await recordRun({ tableKey, partitionValue, status: 'sukses', rowCount: rows.length, bytesBilled, durationMs, triggeredBy });
    queryCache.clear();
    logger.info({ tableKey, partitionValue, rows: rows.length, durationMs }, 'Partisi tersinkron');
    return { tableKey, partitionValue, rowCount: rows.length, bytesBilled, durationMs, status: 'sukses' };
  } catch (err) {
    await recordRun({ tableKey, partitionValue, status: 'gagal', rowCount: 0, bytesBilled: 0, durationMs: Date.now() - started, triggeredBy, error: err.message });
    throw err;
  }
}

async function recordRun(r) {
  await execute(
    `INSERT INTO sync_run (id, table_key, partition_value, status, row_count, bytes_billed, duration_ms, error, triggered_by)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [randomUUID(), r.tableKey, r.partitionValue, r.status, r.rowCount, r.bytesBilled, r.durationMs, r.error ?? null, r.triggeredBy],
  );
}

export function partitionsBetween(grain, startDate, endDate) {
  const out = [];
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  if (Number.isNaN(+start) || Number.isNaN(+end) || start > end) throw badRequest('Rentang tanggal tidak valid.');
  if (grain === 'monthly') {
    const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    while (cur <= end) {
      out.push(cur.toISOString().slice(0, 7));
      cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
  } else {
    const cur = new Date(start);
    while (cur <= end) {
      out.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }
  return out;
}

/**
 * Backfill. Partisi dijalankan berurutan dengan jeda kecil supaya tidak
 * menghabiskan slot BigQuery dan tetap responsif dibatalkan.
 */
export async function backfill({ tableKeys, startDate, endDate, onProgress, signal, triggeredBy = 'backfill' }) {
  const keys = tableKeys?.length ? tableKeys : Object.keys(TABLES).filter((k) => !TABLES[k].replaceAll);
  const tasks = [];
  for (const key of keys) {
    const table = getTable(key);
    if (!table) throw notFound(`Tabel "${key}" tidak ada.`);
    if (table.grain === 'snapshot') tasks.push({ key, partition: endDate });
    else for (const p of partitionsBetween(table.grain, startDate, endDate)) tasks.push({ key, partition: p });
  }

  const results = [];
  for (let i = 0; i < tasks.length; i++) {
    if (signal?.aborted) break;
    const { key, partition } = tasks[i];
    try {
      results.push(await syncPartition(key, partition, { triggeredBy }));
    } catch (err) {
      results.push({ tableKey: key, partitionValue: partition, status: 'gagal', error: err.message });
    }
    onProgress?.({ done: i + 1, total: tasks.length, current: `${key} ${partition}` });
  }
  return results;
}

/** Sync harian: kemarin untuk tabel daily, bulan berjalan untuk monthly, snapshot dimensi. */
export async function runDailySync({ triggeredBy = 'cron' } = {}) {
  const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const month = y.slice(0, 7);
  const results = [];
  for (const table of Object.values(TABLES)) {
    const partition = table.grain === 'monthly' ? month : y;
    try {
      results.push(await syncPartition(table.key, partition, { triggeredBy }));
    } catch (err) {
      results.push({ tableKey: table.key, partitionValue: partition, status: 'gagal', error: err.message });
    }
  }
  await applyRetention();
  return results;
}

export async function applyRetention() {
  if (!config.RETENTION_DAYS || config.RETENTION_DAYS <= 0) return { deleted: 0 };
  const cutoff = new Date(Date.now() - config.RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
  let deleted = 0;
  for (const table of Object.values(TABLES)) {
    if (table.grain === 'snapshot') continue;
    const before = await query(`SELECT count(*) AS n FROM "${table.target}" WHERE tanggal < ?`, [cutoff]);
    await execute(`DELETE FROM "${table.target}" WHERE tanggal < ?`, [cutoff]);
    deleted += before[0]?.n ?? 0;
  }
  if (deleted > 0) {
    logger.info({ cutoff, deleted }, 'Retensi diterapkan');
    queryCache.clear();
  }
  return { deleted, cutoff };
}
