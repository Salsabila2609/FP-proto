import { Router } from 'express';
import authRoutes from './auth.routes.js';
import dataRoutes from './data.routes.js';
import uploadRoutes from './upload.routes.js';
import programRoutes from './program.routes.js';
import { config } from '../config/index.js';

const router = Router();

router.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));
router.get('/meta', (_req, res) =>
  res.json({ mockBigQuery: config.mockBigQuery, aiEnabled: config.geminiEnabled, model: config.GEMINI_MODEL }),
);

router.use('/auth', authRoutes);
router.use('/data', dataRoutes);
router.use('/uploads', uploadRoutes);
router.use('/programs', programRoutes);

export default router;
