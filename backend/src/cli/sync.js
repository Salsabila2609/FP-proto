#!/usr/bin/env node
// Sync manual dari terminal:
//   node src/cli/sync.js daily
//   node src/cli/sync.js backfill 2026-06-01 2026-08-11
//   node src/cli/sync.js backfill 2026-06-01 2026-08-11 trx_prepaid,cashback
import { initDb, closeDb } from '../db/duckdb.js';
import { runMigrations } from '../db/migrate.js';
import { runDailySync, backfill } from '../services/sync.service.js';
import { logger } from '../lib/logger.js';

const [mode, start, end, tables] = process.argv.slice(2);

await initDb();
await runMigrations();

try {
  if (mode === 'daily') {
    console.table(await runDailySync({ triggeredBy: 'cli' }));
  } else if (mode === 'backfill') {
    if (!start || !end) throw new Error('Pakai: backfill <YYYY-MM-DD> <YYYY-MM-DD> [tabel1,tabel2]');
    const results = await backfill({
      tableKeys: tables ? tables.split(',') : [],
      startDate: start,
      endDate: end,
      onProgress: (p) => process.stdout.write(`\r${p.done}/${p.total} ${p.current}          `),
      triggeredBy: 'cli',
    });
    process.stdout.write('\n');
    console.table(results.map((r) => ({ tabel: r.tableKey, partisi: r.partitionValue, status: r.status, baris: r.rowCount ?? 0 })));
  } else {
    console.log('Mode: daily | backfill');
  }
} catch (err) {
  logger.error({ err }, 'Sync CLI gagal');
  process.exitCode = 1;
} finally {
  await closeDb();
}
