import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { normalizeRows } from './normalize.js';

// DuckDB melayani banyak reader paralel dalam satu proses, tapi hanya satu
// writer pada satu waktu. Jadi:
//   - reads  -> pool koneksi, dipinjam-kembalikan per query
//   - writes -> satu koneksi khusus, diserialkan lewat antrean promise
// Dengan begitu 20 user yang membuka dashboard tidak saling blokir, dan sync
// harian yang menulis jutaan baris tidak pernah bentrok dengan dirinya sendiri.

let instance = null;
const readPool = [];
const waiters = [];
let writeConn = null;
let writeChain = Promise.resolve();

export async function initDb() {
  if (instance) return;
  mkdirSync(dirname(config.DUCKDB_PATH), { recursive: true });

  instance = await DuckDBInstance.create(config.DUCKDB_PATH, {
    memory_limit: config.DUCKDB_MEMORY_LIMIT,
    threads: String(config.DUCKDB_THREADS),
  });

  writeConn = await instance.connect();
  for (let i = 0; i < config.DUCKDB_READ_POOL; i++) readPool.push(await instance.connect());

  logger.info(
    { path: config.DUCKDB_PATH, readers: config.DUCKDB_READ_POOL },
    'DuckDB siap',
  );
}

function acquireReader() {
  const conn = readPool.pop();
  if (conn) return Promise.resolve(conn);
  return new Promise((resolve) => waiters.push(resolve));
}

function releaseReader(conn) {
  const next = waiters.shift();
  if (next) next(conn);
  else readPool.push(conn);
}

/** SELECT. Aman dipanggil paralel dari banyak request. */
export async function query(sql, params = []) {
  const conn = await acquireReader();
  try {
    const reader = await conn.runAndReadAll(sql, params);
    return normalizeRows(reader.getRowObjects());
  } finally {
    releaseReader(conn);
  }
}

export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

/** INSERT/UPDATE/DDL. Diserialkan otomatis. */
export function execute(sql, params = []) {
  return enqueueWrite(async (conn) => {
    await conn.run(sql, params);
  });
}

/**
 * Beberapa statement dalam satu transaksi. Callback menerima objek dengan
 * .run() dan .all(); jangan simpan referensinya keluar dari callback.
 */
export function transaction(fn) {
  return enqueueWrite(async (conn) => {
    const ctx = {
      run: (sql, params = []) => conn.run(sql, params),
      all: async (sql, params = []) =>
        normalizeRows((await conn.runAndReadAll(sql, params)).getRowObjects()),
    };
    await conn.run('BEGIN TRANSACTION');
    try {
      const result = await fn(ctx);
      await conn.run('COMMIT');
      return result;
    } catch (err) {
      await conn.run('ROLLBACK').catch(() => {});
      throw err;
    }
  });
}

function enqueueWrite(fn) {
  const run = writeChain.then(() => fn(writeConn));
  // Rantai tetap hidup walau satu job gagal, tapi errornya tetap dilempar ke pemanggil.
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function closeDb() {
  await writeChain.catch(() => {});
  for (const c of readPool.splice(0)) c.closeSync?.();
  writeConn?.closeSync?.();
  instance?.closeSync?.();
  instance = null;
}
