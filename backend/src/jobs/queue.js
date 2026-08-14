import { randomUUID } from 'node:crypto';
import { execute, query, queryOne } from '../db/duckdb.js';
import { logger } from '../lib/logger.js';
import { notFound, conflict } from '../lib/errors.js';

/**
 * Antrean job dalam-proses dengan konkurensi 1.
 *
 * Sync dan backfill bisa berjalan berjam-jam, jadi tidak boleh menahan koneksi
 * HTTP: route mengembalikan job id, frontend melakukan polling. Konkurensi
 * sengaja 1 supaya dua backfill tidak berebut koneksi tulis DuckDB dan tidak
 * meledakkan tagihan BigQuery secara bersamaan.
 *
 * Kalau nanti butuh banyak worker atau job yang tahan restart, ganti isi file
 * ini dengan BullMQ + Redis. Permukaan API-nya (enqueue/get/list) tetap sama.
 */
const handlers = new Map();
const pending = [];
let running = null;

export const registerHandler = (kind, fn) => handlers.set(kind, fn);

export async function enqueue({ kind, payload = {}, userId, unique = true }) {
  if (!handlers.has(kind)) throw notFound(`Jenis job "${kind}" tidak dikenal.`);
  if (unique && (running?.kind === kind || pending.some((j) => j.kind === kind))) {
    throw conflict(`Job ${kind} sedang berjalan atau menunggu. Tunggu sampai selesai.`);
  }

  const job = { id: randomUUID(), kind, payload, userId, controller: new AbortController() };
  await execute('INSERT INTO job (id, kind, status, payload, created_by) VALUES (?,?,?,?,?)', [job.id, kind, 'queued', JSON.stringify(payload), userId ?? null]);
  pending.push(job);
  setImmediate(drain);
  return { id: job.id, kind, status: 'queued' };
}

async function drain() {
  if (running || pending.length === 0) return;
  running = pending.shift();
  const job = running;

  await setStatus(job.id, 'running');
  try {
    const result = await handlers.get(job.kind)({
      payload: job.payload,
      signal: job.controller.signal,
      onProgress: (p) => execute('UPDATE job SET progress = ?, updated_at = now() WHERE id = ?', [JSON.stringify(p), job.id]).catch(() => {}),
    });
    await execute('UPDATE job SET status = ?, result = ?, updated_at = now() WHERE id = ?', ['done', JSON.stringify(result ?? null), job.id]);
  } catch (err) {
    logger.error({ err, kind: job.kind }, 'Job gagal');
    await execute('UPDATE job SET status = ?, error = ?, updated_at = now() WHERE id = ?', ['failed', err.message, job.id]);
  } finally {
    running = null;
    setImmediate(drain);
  }
}

const setStatus = (id, status) => execute('UPDATE job SET status = ?, updated_at = now() WHERE id = ?', [status, id]);

export async function getJob(id) {
  const row = await queryOne('SELECT * FROM job WHERE id = ?', [id]);
  if (!row) throw notFound('Job tidak ditemukan.');
  return {
    ...row,
    payload: row.payload ? JSON.parse(row.payload) : null,
    progress: row.progress ? JSON.parse(row.progress) : null,
    result: row.result ? JSON.parse(row.result) : null,
  };
}

export const listJobs = (limit = 25) =>
  query('SELECT id, kind, status, progress, error, created_at, updated_at FROM job ORDER BY created_at DESC LIMIT ?', [Math.min(limit, 100)]);

export function cancelJob(id) {
  if (running?.id === id) {
    running.controller.abort();
    return true;
  }
  const idx = pending.findIndex((j) => j.id === id);
  if (idx >= 0) {
    pending.splice(idx, 1);
    return true;
  }
  return false;
}
