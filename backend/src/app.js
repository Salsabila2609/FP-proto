import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { ZodError } from 'zod';
import routes from './routes/index.js';
import { config } from './config/index.js';
import { logger } from './lib/logger.js';
import { generalLimiter } from './middleware/rateLimit.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { badRequest } from './lib/errors.js';

export function createApp() {
  const app = express();

  // Di belakang reverse proxy, supaya rate limit membaca IP asli.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(compression());
  app.use(
    cors({
      origin: (origin, cb) =>
        !origin || config.corsOrigins.includes(origin)
          ? cb(null, true)
          : cb(new Error('Asal permintaan tidak diizinkan.')),
      credentials: true,
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: '2mb' }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/healthz' } }));
  app.use('/api', generalLimiter);

  app.use('/api', routes);

  // Error validasi zod diterjemahkan jadi 400 dengan daftar field yang salah.
  app.use((err, _req, _res, next) => {
    if (err instanceof ZodError) {
      return next(badRequest('Input tidak valid.', err.issues.map((i) => ({ field: i.path.join('.'), message: i.message }))));
    }
    if (err?.code === 'LIMIT_FILE_SIZE') return next(badRequest(`Ukuran file melebihi ${config.UPLOAD_MAX_MB} MB.`));
    next(err);
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
