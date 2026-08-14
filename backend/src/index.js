import { createApp } from './app.js';
import { config } from './config/index.js';
import { logger } from './lib/logger.js';
import { initDb, closeDb } from './db/duckdb.js';
import { runMigrations } from './db/migrate.js';
import { startScheduler } from './jobs/scheduler.js';
import './jobs/handlers.js';

const app = createApp();

await initDb();
await runMigrations();
const stopScheduler = startScheduler();

const server = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, env: config.NODE_ENV, mockBigQuery: config.mockBigQuery, ai: config.geminiEnabled },
    'API siap',
  );
});

// Matikan dengan rapi: berhenti menerima koneksi baru, tunggu job yang jalan,
// baru tutup DuckDB. Kalau tidak, file warehouse bisa ditinggal dalam keadaan
// setengah tertulis.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Mematikan server');
    stopScheduler();
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 20_000).unref();
  });
}

process.on('unhandledRejection', (err) => logger.error({ err }, 'Promise rejection tanpa handler'));
