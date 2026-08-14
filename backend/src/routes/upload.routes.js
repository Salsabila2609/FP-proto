import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { execute, query, queryOne } from '../db/duckdb.js';
import { uploadExcel, verifyFileSignature, resolveUploadPath } from '../middleware/upload.js';
import { readWorkbook, readSheetMatrix, guessHeaderRow, extractProfile, applyMapping, rawPreview } from '../services/excel.service.js';
import { proposeMapping, fallbackMapping } from '../services/mapping.service.js';
import { resolveGeo } from '../services/geo.service.js';
import { mappingSchema, DIVISIONS, CATEGORIES, GEO_LEVELS } from '../registry/canonical.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { expensiveLimiter } from '../middleware/rateLimit.js';
import { wrap } from '../lib/asyncHandler.js';
import { badRequest, notFound } from '../lib/errors.js';
import { basename } from 'node:path';

const router = Router();
router.use(authenticate);

/** Langkah 1 -- unggah dan profilkan. Belum ada yang masuk warehouse. */
router.post('/', requireRole('analyst'), (req, res, next) => {
  uploadExcel(req, res, (err) => (err ? next(err) : next()));
}, wrap(async (req, res) => {
  if (!req.file) throw badRequest('Tidak ada file yang diunggah.');
  verifyFileSignature(req.file.path, req.file.originalname);

  const wb = readWorkbook(req.file.path);
  const sheetName = wb.SheetNames[0];
  const matrix = readSheetMatrix(wb, sheetName);
  const headerRowIndex = guessHeaderRow(matrix);
  const profile = extractProfile(matrix, headerRowIndex);

  const id = randomUUID();
  await execute(
    `INSERT INTO upload_file (id, original_name, stored_path, sheet_name, header_hash, size_bytes, uploaded_by)
     VALUES (?,?,?,?,?,?,?)`,
    [id, req.file.originalname, basename(req.file.path), sheetName, profile.headerHash, req.file.size, req.user.sub],
  );

  // Kalau susunan header ini pernah dikonfirmasi, pakai templatenya langsung --
  // tidak perlu panggil LLM lagi dan hasilnya konsisten dengan upload sebelumnya.
  const template = await queryOne('SELECT mapping, label FROM mapping_template WHERE header_hash = ?', [profile.headerHash]);

  res.status(201).json({
    uploadId: id,
    sheets: wb.SheetNames,
    sheetName,
    headerRowIndex,
    profile: { headers: profile.headers, columns: profile.columns, totalRows: profile.totalRows, sampleRows: profile.sampleRows },
    reusedTemplate: template ? { label: template.label, mapping: JSON.parse(template.mapping) } : null,
  });
}));

/**
 * Profil ulang dengan sheet atau baris header yang dipilih manusia.
 *
 * Tebakan otomatis bisa meleset kalau berkasnya punya judul, baris kosong, atau
 * beberapa sheet. `rawRows` mengembalikan isi mentah apa adanya, supaya yang
 * dibaca parser bisa dibandingkan langsung dengan yang terlihat di Excel --
 * tanpa ini, "kolomnya kosong" hanya bisa ditebak-tebak.
 */
router.post('/:id/profile', requireRole('analyst'), wrap(async (req, res) => {
  const body = z.object({
    sheetName: z.string().max(200).optional(),
    headerRowIndex: z.number().int().min(0).max(50).optional(),
  }).parse(req.body ?? {});

  const upload = await queryOne('SELECT * FROM upload_file WHERE id = ?', [req.params.id]);
  if (!upload) throw notFound('Berkas unggahan tidak ditemukan.');

  const wb = readWorkbook(resolveUploadPath(upload.stored_path));
  const sheetName = body.sheetName ?? upload.sheet_name ?? wb.SheetNames[0];
  const matrix = readSheetMatrix(wb, sheetName);
  const headerRowIndex = body.headerRowIndex ?? guessHeaderRow(matrix);
  const profile = extractProfile(matrix, headerRowIndex);

  if (body.sheetName && body.sheetName !== upload.sheet_name) {
    await execute('UPDATE upload_file SET sheet_name = ?, header_hash = ? WHERE id = ?',
      [sheetName, profile.headerHash, upload.id]);
  }

  res.json({
    uploadId: upload.id,
    sheets: wb.SheetNames,
    sheetName,
    headerRowIndex,
    totalSheetRows: matrix.length,
    rawRows: rawPreview(matrix),
    profile: { headers: profile.headers, columns: profile.columns, totalRows: profile.totalRows, sampleRows: profile.sampleRows },
  });
}));

/** Langkah 2 -- minta usulan mapping ke AI. Hasilnya usulan, bukan keputusan. */
router.post('/:id/suggest-mapping', requireRole('analyst'), expensiveLimiter, wrap(async (req, res) => {
  const { upload, matrix } = await loadUpload(req.params.id);
  const body = z.object({ headerRowIndex: z.number().int().min(0).optional(), hint: z.string().max(500).optional() }).parse(req.body ?? {});
  const headerRowIndex = body.headerRowIndex ?? guessHeaderRow(matrix);
  const profile = extractProfile(matrix, headerRowIndex);

  try {
    const proposal = await proposeMapping({ profile, headerRowIndex, hint: body.hint });
    res.json({ source: 'ai', ...proposal });
  } catch (err) {
    // Gemini mati atau kuota habis bukan alasan untuk memblokir pekerjaan.
    res.json({ source: 'fallback', ok: false, issues: [err.message], draft: fallbackMapping(profile, headerRowIndex) });
  }
}));

/** Langkah 3 -- pratinjau hasil transform dengan mapping yang sedang diedit. */
router.post('/:id/preview', requireRole('analyst'), wrap(async (req, res) => {
  const { matrix } = await loadUpload(req.params.id);
  const mapping = mappingSchema.parse(req.body.mapping);
  const { rows, issues, dateFormat, missingColumns, unassignedRoles } = applyMapping(matrix, mapping);
  const geo = await resolveGeo(mapping.geo_level, rows.map((r) => r.geo_value));

  res.json({
    rowCount: rows.length,
    preview: rows.slice(0, 30),
    issues: issues.slice(0, 50),
    geo: { matchedCount: geo.matched.size, unmatched: geo.unmatched.slice(0, 30) },
    metricNames: [...new Set(rows.map((r) => r.metric_name))],
    dateFormat,
    missingColumns,
    unassignedRoles,
    headers: (matrix[mapping.header_row_index] ?? []).map((h, i) =>
      h === null || String(h).trim() === '' ? `kolom_${i + 1}` : String(h).trim()),
  });
}));

/** Langkah 4 -- konfirmasi. Baru di sini data masuk warehouse. */
router.post('/:id/commit', requireRole('analyst'), wrap(async (req, res) => {
  const { upload, matrix } = await loadUpload(req.params.id);
  const body = z.object({
    mapping: mappingSchema,
    program: z.object({
      name: z.string().min(3).max(200),
      division: z.enum(DIVISIONS),
      category: z.enum(CATEGORIES),
      brand: z.string().max(50).optional(),
      period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      cost_total: z.number().nonnegative().default(0),
      geo_level: z.enum(GEO_LEVELS),
      description: z.string().max(2000).optional(),
    }),
    saveTemplate: z.boolean().default(true),
  }).parse(req.body);

  const { rows } = applyMapping(matrix, body.mapping);
  if (rows.length === 0) throw badRequest('Mapping ini tidak menghasilkan satu baris pun. Periksa peran kolom dan filter baris.');

  const programId = randomUUID();
  const p = body.program;
  await execute(
    `INSERT INTO program (id, name, division, category, brand, period_start, period_end, cost_total, geo_level, description, source_upload_id, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [programId, p.name, p.division, p.category, p.brand ?? null, p.period_start, p.period_end, p.cost_total, p.geo_level, p.description ?? null, upload.id, req.user.sub],
  );

  for (const r of rows) {
    await execute(
      `INSERT INTO program_result (id, program_id, tanggal, geo_level, geo_value, metric_name, metric_value, unit, cost, is_executed, detail)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [randomUUID(), programId, r.tanggal, p.geo_level, r.geo_value, r.metric_name, r.metric_value, r.unit, r.cost, r.is_executed, JSON.stringify(r.detail ?? {})],
    );
  }

  if (body.saveTemplate) {
    await execute('DELETE FROM mapping_template WHERE header_hash = ?', [upload.header_hash]);
    await execute(
      `INSERT INTO mapping_template (id, header_hash, label, division, mapping, confirmed_by)
       VALUES (?,?,?,?,?,?)`,
      [randomUUID(), upload.header_hash, p.name, p.division, JSON.stringify(body.mapping), req.user.sub],
    );
  }

  await execute('UPDATE upload_file SET status = ? WHERE id = ?', ['committed', upload.id]);
  await execute('INSERT INTO audit_log (id, user_id, action, target, detail) VALUES (?,?,?,?,?)', [randomUUID(), req.user.sub, 'commit_upload', programId, JSON.stringify({ rows: rows.length })]);

  res.status(201).json({ programId, rowsInserted: rows.length });
}));

router.get('/templates', wrap(async (_req, res) => {
  res.json({ templates: await query('SELECT id, header_hash, label, division, created_at FROM mapping_template ORDER BY created_at DESC') });
}));

async function loadUpload(id) {
  const upload = await queryOne('SELECT * FROM upload_file WHERE id = ?', [id]);
  if (!upload) throw notFound('Berkas unggahan tidak ditemukan.');
  const wb = readWorkbook(resolveUploadPath(upload.stored_path));
  return { upload, matrix: readSheetMatrix(wb, upload.sheet_name) };
}

export default router;