import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { FILE_SOURCES, getFileSource } from '../registry/fileSources.js';
import { readWorkbook, readSheetMatrix, guessHeaderRow, parseNumber, parseDate } from './excel.service.js';
import { bulkLoad } from '../db/bulk.js';
import { execute, query } from '../db/duckdb.js';
import { logger } from '../lib/logger.js';
import { queryCache } from '../lib/cache.js';
import { badRequest, notFound, upstream } from '../lib/errors.js';

const MAX_BYTES = 200 * 1024 * 1024;

/**
 * Ambil berkas dari OneDrive/SharePoint atau dari folder tersinkron lokal,
 * agregasi, lalu muat ke warehouse.
 *
 * Tautan berbagi OneDrive tidak langsung mengembalikan berkas -- perlu
 * ditambahi parameter download. Ini bekerja hanya kalau tautannya disetel
 * "anyone with the link". Konsekuensinya nyata: siapa pun yang punya URL itu
 * bisa mengunduh datanya. Untuk berkas berisi data pribadi, folder OneDrive
 * yang tersinkron di server (opsi `path`) jauh lebih aman.
 */
export async function refreshFileSource(key, { triggeredBy = 'manual' } = {}) {
  const source = getFileSource(key);
  if (!source) throw notFound(`Sumber berkas "${key}" tidak ada di registry.`);
  assertNoPii(source);

  const started = Date.now();
  try {
    const buffer = await fetchSource(source);
    const fileHash = createHash('sha256').update(buffer).digest('hex').slice(0, 32);

    // Kalau isi berkasnya sama persis dengan pemuatan terakhir yang sukses,
    // tidak ada gunanya memproses ulang.
    const last = (await query(
      `SELECT file_hash FROM file_source_run WHERE source_key = ? AND status = 'sukses'
       ORDER BY created_at DESC LIMIT 1`, [key],
    ))[0];
    if (last?.file_hash === fileHash) {
      await recordRun({ key, status: 'sukses', rowCount: 0, fileHash, durationMs: Date.now() - started, triggeredBy, error: 'tidak berubah, dilewati' });
      return { sourceKey: key, status: 'sukses', rowCount: 0, unchanged: true };
    }

    const rows = aggregate(parseRows(buffer, source), source);

    if (source.replaceAll) await execute(`DELETE FROM "${source.target}"`);
    await bulkLoad({ table: source.target, columns: source.columns, rows });

    const durationMs = Date.now() - started;
    await recordRun({ key, status: 'sukses', rowCount: rows.length, fileHash, durationMs, triggeredBy });
    queryCache.clear();
    logger.info({ key, rows: rows.length, durationMs }, 'Sumber berkas dimuat');
    return { sourceKey: key, status: 'sukses', rowCount: rows.length, durationMs };
  } catch (err) {
    await recordRun({ key, status: 'gagal', rowCount: 0, durationMs: Date.now() - started, triggeredBy, error: err.message });
    throw err;
  }
}

/** Allowlist `keep` tidak boleh memuat kolom yang terdaftar sebagai PII. */
function assertNoPii(source) {
  const kept = new Set(Object.keys(source.keep).map((k) => k.toLowerCase()));
  const leaked = (source.pii ?? []).filter((p) => kept.has(p.toLowerCase()));
  if (leaked.length) {
    throw badRequest(
      `Sumber "${source.key}" mencoba menyimpan kolom data pribadi: ${leaked.join(', ')}. ` +
      'Hapus dari daftar keep sebelum melanjutkan.',
    );
  }
}

async function fetchSource(source) {
  if (source.path) {
    if (!existsSync(source.path)) throw badRequest(`Berkas tidak ditemukan di ${source.path}`);
    return readFileSync(source.path);
  }
  if (!source.url) throw badRequest(`Sumber "${source.key}" belum punya url maupun path. Isi lewat env.`);

  const url = toDirectDownload(source.url);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw upstream(`Gagal mengunduh berkas (${res.status}). Pastikan tautan berbagi disetel "anyone with the link".`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw badRequest('Berkas melebihi 200 MB.');
  // Tautan yang salah izin mengembalikan halaman login HTML, bukan xlsx.
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw upstream('Yang terunduh bukan berkas Excel -- kemungkinan tautan mengarah ke halaman login.');
  }
  return buf;
}

function toDirectDownload(url) {
  if (url.includes('download=1') || url.includes('/download')) return url;
  return url + (url.includes('?') ? '&' : '?') + 'download=1';
}

function parseRows(buffer, source) {
  const wb = readWorkbook(buffer);
  const matrix = readSheetMatrix(wb, source.sheet ?? wb.SheetNames[0]);
  const headerRow = guessHeaderRow(matrix);
  const headers = (matrix[headerRow] ?? []).map((h) => String(h ?? '').trim());

  const indexOf = (name) => headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const dims = Object.entries(source.keep).map(([src, dst]) => ({ dst, idx: indexOf(src), src }));
  const measures = Object.entries(source.measures).map(([src, dst]) => ({ dst, idx: indexOf(src), src }));

  const missing = [...dims, ...measures].filter((c) => c.idx < 0).map((c) => c.src);
  if (missing.length) {
    throw badRequest(
      `Kolom ini tidak ada di berkas: ${missing.join(', ')}. ` +
      'Kemungkinan template dari HQ berubah -- sesuaikan registry/fileSources.js.',
    );
  }

  return matrix.slice(headerRow + 1).flatMap((r) => {
    if (!r.some((c) => c !== null && String(c).trim() !== '')) return [];
    const out = {};
    for (const d of dims) out[d.dst] = d.dst === 'tanggal' ? parseDate(r[d.idx]) : cleanCell(r[d.idx]);
    for (const m of measures) out[m.dst] = parseNumber(r[m.idx]) ?? 0;
    if (!out.tanggal) return [];
    if (source.rowFilter && !source.rowFilter(out)) return [];
    return [out];
  });
}

const cleanCell = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());

/**
 * Agregasi terjadi SEBELUM data menyentuh warehouse. Ini yang membuat baris
 * per pelanggan tidak pernah tersimpan, sekaligus memangkas ukuran data
 * secara drastis.
 */
function aggregate(rows, source) {
  const dimKeys = Object.values(source.keep);
  const measureKeys = Object.values(source.measures);
  const bucket = new Map();

  for (const row of rows) {
    const key = dimKeys.map((k) => row[k] ?? '').join('\u0001');
    let acc = bucket.get(key);
    if (!acc) {
      acc = {};
      for (const k of dimKeys) acc[k] = row[k] ?? null;
      for (const k of measureKeys) acc[k] = 0;
      acc[source.countAs] = 0;
      bucket.set(key, acc);
    }
    for (const k of measureKeys) acc[k] += row[k] ?? 0;
    acc[source.countAs] += 1;
  }

  return [...bucket.values()].map((r) => ({ ...r, tenure: r.tenure === null ? null : Number(r.tenure) || null }));
}

async function recordRun(r) {
  await execute(
    `INSERT INTO file_source_run (id, source_key, status, row_count, file_hash, duration_ms, error, triggered_by)
     VALUES (?,?,?,?,?,?,?,?)`,
    [randomUUID(), r.key, r.status, r.rowCount, r.fileHash ?? null, r.durationMs, r.error ?? null, r.triggeredBy],
  );
}

export async function refreshAllFileSources({ triggeredBy = 'cron' } = {}) {
  const out = [];
  for (const key of Object.keys(FILE_SOURCES)) {
    try {
      out.push(await refreshFileSource(key, { triggeredBy }));
    } catch (err) {
      out.push({ sourceKey: key, status: 'gagal', error: err.message });
    }
  }
  return out;
}

export async function getFileSourceInventory() {
  const out = [];
  for (const s of Object.values(FILE_SOURCES)) {
    const stats = (await query(
      `SELECT count(*) AS row_count, min(CAST(tanggal AS VARCHAR)) AS min_p, max(CAST(tanggal AS VARCHAR)) AS max_p
       FROM "${s.target}"`,
    ))[0];
    const lastRun = (await query(
      `SELECT status, row_count, error, created_at FROM file_source_run
       WHERE source_key = ? ORDER BY created_at DESC LIMIT 1`, [s.key],
    ))[0] ?? null;
    out.push({
      key: s.key, label: s.label, target: s.target, grain: 'berkas',
      configured: Boolean(s.url || s.path),
      mode: s.path ? 'folder tersinkron' : s.url ? 'tautan berbagi' : 'belum disetel',
      rowCount: stats?.row_count ?? 0, minPartition: stats?.min_p ?? null, maxPartition: stats?.max_p ?? null,
      lastRun,
    });
  }
  return out;
}