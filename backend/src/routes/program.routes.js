import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, execute } from '../db/duckdb.js';
import { evaluateProgram, getStoredEvaluation, rankPrograms } from '../services/evaluation.service.js';
import { narrateProgram, narrateComparison } from '../services/narrator.service.js';
import { RECIPES } from '../services/metrics/recipes.js';
import { discoverPrograms, importProgram } from '../services/prepaidProgram.service.js';
import { listBaseTables, distinctValues, previewPopulation, createPopulationProgram } from '../services/populationDef.service.js';
import { DIVISIONS, GEO_LEVELS } from '../registry/canonical.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { expensiveLimiter } from '../middleware/rateLimit.js';
import { wrap } from '../lib/asyncHandler.js';
import { notFound } from '../lib/errors.js';
import { CATEGORIES } from '../registry/canonical.js';


const filterSchema = z.array(z.object({
  column: z.string().max(64),
  op: z.enum(['equals', 'contains', 'starts_with', 'in', 'gte', 'lte']),
  value: z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]),
})).max(12);

const router = Router();
router.use(authenticate);

router.get('/', wrap(async (req, res) => {
  const q = z.object({ division: z.string().optional(), category: z.string().optional() }).parse(req.query);
  const where = [];
  const params = [];
  if (q.division) { where.push('division = ?'); params.push(q.division); }
  if (q.category) { where.push('category = ?'); params.push(q.category); }
  const rows = await query(
    `SELECT p.*, (SELECT count(*) FROM program_result r WHERE r.program_id = p.id) AS result_rows
     FROM program p ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY period_start DESC`,
    params,
  );
  res.json({ programs: rows });
}));

router.get('/recipes', (_req, res) => {
  res.json({ recipes: Object.values(RECIPES).map((r) => ({ key: r.key, label: r.label, explain: r.explain })) });
});

/**
 * Program prepaid yang terdeteksi otomatis dari data cashback. Tidak perlu
 * diunggah -- namanya sudah ada di dalam data.
 */
router.get('/discover', wrap(async (req, res) => {
  const q = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(req.query);
  res.json({ discovered: await discoverPrograms(q) });
}));

router.post('/discover/import', requireRole('analyst'), wrap(async (req, res) => {
  const body = z.object({
    programName: z.string().min(1).max(200),
    category: z.enum(CATEGORIES).default('acquisition'),
    geoLevel: z.enum(['area', 'sales_area', 'cluster', 'kecamatan', 'outlet']).optional(),
  }).parse(req.body);
  res.status(201).json(await importProgram({ ...body, userId: req.user.sub }));
}));

/**
 * Definisi program berbasis FILTER -- dipakai postpaid, yang datanya satu file
 * penjualan harian dan programnya dikenali dari paket, channel, dan periodenya.
 */
router.get('/base-tables', (_req, res) => res.json({ baseTables: listBaseTables() }));

router.get('/base-tables/:table/values', wrap(async (req, res) => {
  const q = z.object({ column: z.string().max(64), search: z.string().max(100).optional() }).parse(req.query);
  res.json({ values: await distinctValues(req.params.table, q.column, q.search) });
}));

router.post('/population/preview', wrap(async (req, res) => {
  const body = z.object({
    baseTable: z.string().max(64),
    filters: filterSchema,
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    measure: z.string().max(32).optional(),
  }).parse(req.body);
  res.json(await previewPopulation(body));
}));

router.post('/population', requireRole('analyst'), wrap(async (req, res) => {
  const body = z.object({
    program: z.object({
      name: z.string().min(3).max(200),
      division: z.enum(DIVISIONS),
      category: z.enum(CATEGORIES),
      brand: z.string().max(50).optional(),
      period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      cost_total: z.number().nonnegative().default(0),
      target_value: z.number().nonnegative().optional(),
      geo_level: z.enum(GEO_LEVELS).optional(),
      base_table: z.string().max(64),
      description: z.string().max(2000).optional(),
      proposal_note: z.string().max(4000).optional(),
    }),
    filters: filterSchema,
  }).parse(req.body);
  res.status(201).json(await createPopulationProgram({ ...body, userId: req.user.sub }));
}));

router.get('/ranking', wrap(async (req, res) => {
  const q = z.object({ category: z.enum(CATEGORIES).optional(), from: z.string().optional(), to: z.string().optional() }).parse(req.query);
  res.json({ ranking: await rankPrograms(q) });
}));

router.get('/:id', wrap(async (req, res) => {
  const program = await queryOne('SELECT * FROM program WHERE id = ?', [req.params.id]);
  if (!program) throw notFound('Program tidak ditemukan.');
  const results = await query(
    `SELECT metric_name, count(*) AS baris, sum(metric_value) AS total, sum(cost) AS biaya,
            min(tanggal) AS mulai, max(tanggal) AS selesai
     FROM program_result WHERE program_id = ? AND is_executed GROUP BY 1 ORDER BY 3 DESC`,
    [req.params.id],
  );
  res.json({ program, summary: results, evaluation: await getStoredEvaluation(req.params.id) });
}));

router.post('/:id/evaluate', requireRole('analyst'), expensiveLimiter, wrap(async (req, res) => {
  res.json(await evaluateProgram(req.params.id));
}));

router.post('/:id/narrate', requireRole('analyst'), expensiveLimiter, wrap(async (req, res) => {
  res.json(await narrateProgram(req.params.id, { force: req.body?.force === true }));
}));

router.post('/compare/narrate', requireRole('analyst'), expensiveLimiter, wrap(async (req, res) => {
  const body = z.object({ category: z.enum(CATEGORIES).optional(), from: z.string().optional(), to: z.string().optional() }).parse(req.body ?? {});
  res.json(await narrateComparison(body));
}));

router.delete('/:id', requireRole('admin'), wrap(async (req, res) => {
  await execute('DELETE FROM program_result WHERE program_id = ?', [req.params.id]);
  await execute('DELETE FROM evaluation WHERE program_id = ?', [req.params.id]);
  await execute('DELETE FROM program WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

export default router;