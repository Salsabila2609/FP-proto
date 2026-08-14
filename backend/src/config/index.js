import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// .env di root project; kalau ada .env di dalam backend/, itu yang menang.
loadEnv({ path: resolve(root, '.env') });
loadEnv({ path: resolve(root, 'backend/.env'), override: true });
import { z } from 'zod';

const bool = (d) => z.string().optional().transform((v) => (v === undefined ? d : v === 'true'));
const int = (d) => z.coerce.number().int().default(d);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(8080),
  LOG_LEVEL: z.string().default('info'),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET minimal 32 karakter'),
  JWT_TTL_HOURS: int(12),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional().or(z.literal('')),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(10).optional().or(z.literal('')),

  DUCKDB_PATH: z.string().default('./data/warehouse.duckdb'),
  DUCKDB_MEMORY_LIMIT: z.string().default('4GB'),
  DUCKDB_THREADS: int(4),
  DUCKDB_READ_POOL: int(4),
  UPLOAD_DIR: z.string().default('./uploads'),
  UPLOAD_MAX_MB: int(25),
  RETENTION_DAYS: int(540),

  GCP_PROJECT_ID: z.string().default(''),
  BQ_JOB_PROJECT: z.string().default(''),
  BQ_LOCATION: z.string().default('asia-southeast2'),
  BQ_MAX_BYTES_BILLED: z.string().default('53687091200'),
  BQ_TIMEOUT_MS: int(600000),

  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-3.6-flash'),
  GEMINI_RPM: int(10),
  GEMINI_TIMEOUT_MS: int(60000),

  CRON_ENABLED: bool(true),
  CRON_DAILY_SYNC: z.string().default('15 4 * * *'),
  TZ: z.string().default('Asia/Jakarta'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  console.error('Konfigurasi env tidak valid:\n' + lines.join('\n'));
  process.exit(1);
}

const env = parsed.data;

export const config = {
  ...env,
  isProd: env.NODE_ENV === 'production',
  corsOrigins: env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  // Mode mock dipakai kalau kredensial GCP belum ada, supaya UI tetap bisa
  // dikembangkan tanpa akses produksi.
  mockBigQuery: !env.GCP_PROJECT_ID,
  bqJobProject: env.BQ_JOB_PROJECT || env.GCP_PROJECT_ID,
  geminiEnabled: Boolean(env.GEMINI_API_KEY),
};

if (config.isProd && config.JWT_SECRET.includes('ganti-dengan')) {
  console.error('JWT_SECRET masih nilai contoh. Ganti sebelum deploy.');
  process.exit(1);
}
