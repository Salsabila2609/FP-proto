import { Router } from 'express';
import { z } from 'zod';
import { getTableInventory, getGaps, getRecentRuns } from '../services/health.service.js';
import { TABLES } from '../registry/tables.js';
import { FILE_SOURCE_KEYS } from '../registry/fileSources.js';
import { enqueue, getJob, listJobs, cancelJob } from '../jobs/queue.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { expensiveLimiter } from '../middleware/rateLimit.js';
import { wrap } from '../lib/asyncHandler.js';

const router = Router();
router.use(authenticate);

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Format tanggal harus YYYY-MM-DD');

/** Tab Data Health: isi tiap tabel, rentangnya, dan status sync terakhir. */
router.get('/tables', wrap(async (_req, res) => {
  res.json({ tables: await getTableInventory() });
}));

router.get('/tables/:key/gaps', wrap(async (req, res) => {
  const q = z.object({ from: dateStr, to: dateStr }).parse(req.query);
  res.json(await getGaps(req.params.key, q.from, q.to));
}));

router.get('/runs', wrap(async (req, res) => {
  res.json({ runs: await getRecentRuns(Number(req.query.limit ?? 50)) });
}));

router.post('/sync', requireRole('analyst'), expensiveLimiter, wrap(async (req, res) => {
  res.status(202).json(await enqueue({ kind: 'daily_sync', userId: req.user.sub }));
}));

router.post('/backfill', requireRole('analyst'), expensiveLimiter, wrap(async (req, res) => {
  const body = z.object({
    tableKeys: z.array(z.enum(Object.keys(TABLES))).default([]),
    startDate: dateStr,
    endDate: dateStr,
  }).parse(req.body);
  res.status(202).json(await enqueue({ kind: 'backfill', payload: body, userId: req.user.sub }));
}));

// Tarik ulang berkas dari OneDrive tanpa menunggu jadwal harian.
router.post('/files/refresh', requireRole('analyst'), expensiveLimiter, wrap(async (req, res) => {
  const body = z.object({ key: z.enum(FILE_SOURCE_KEYS).optional() }).parse(req.body ?? {});
  res.status(202).json(await enqueue({ kind: 'refresh_files', payload: body, userId: req.user.sub }));
}));

router.get('/jobs', wrap(async (req, res) => res.json({ jobs: await listJobs(Number(req.query.limit ?? 25)) })));
router.get('/jobs/:id', wrap(async (req, res) => res.json(await getJob(req.params.id))));
router.post('/jobs/:id/cancel', requireRole('analyst'), wrap(async (req, res) => {
  res.json({ cancelled: cancelJob(req.params.id) });
}));

export default router;