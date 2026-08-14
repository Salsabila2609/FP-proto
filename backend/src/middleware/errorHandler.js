import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { config } from '../config/index.js';

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: { code: 'not_found', message: 'Endpoint tidak ada.' } });
}

export function errorHandler(err, req, res, _next) {
  const status = err instanceof AppError ? err.status : 500;
  if (status >= 500) logger.error({ err, path: req.path }, 'Permintaan gagal');
  else logger.warn({ code: err.code, path: req.path, msg: err.message }, 'Permintaan ditolak');

  res.status(status).json({
    error: {
      code: err.code ?? 'internal_error',
      // Pesan error internal tidak pernah bocor ke klien di produksi.
      message: status >= 500 && config.isProd ? 'Terjadi kesalahan di server.' : err.message,
      details: err.details,
    },
  });
}
