import pino from 'pino';
import { config } from '../config/index.js';

// Field yang tidak boleh pernah muncul di log.
const redact = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  'apiKey',
  '*.apiKey',
];

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: { paths: redact, censor: '[redacted]' },
  transport: config.isProd ? undefined : { target: 'pino/file', options: { destination: 1 } },
});
