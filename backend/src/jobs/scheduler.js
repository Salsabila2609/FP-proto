import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { enqueue } from './queue.js';

/**
 * Penjadwal minimalis: cek tiap menit, jalankan kalau menit ini cocok.
 * Cukup untuk satu jadwal harian, tanpa menambah dependensi cron.
 * Formatnya "m h * * *" (menit jam).
 */
export function startScheduler() {
  if (!config.CRON_ENABLED) {
    logger.info('Penjadwal nonaktif (CRON_ENABLED=false)');
    return () => {};
  }

  const [minute, hour] = config.CRON_DAILY_SYNC.split(' ');
  let lastRunKey = null;

  const timer = setInterval(async () => {
    const now = new Date();
    const key = now.toISOString().slice(0, 16);
    if (key === lastRunKey) return;
    if (!matches(minute, now.getMinutes()) || !matches(hour, now.getHours())) return;
    lastRunKey = key;
    try {
      const job = await enqueue({ kind: 'daily_sync', userId: 'scheduler' });
      logger.info({ jobId: job.id }, 'Sync harian terjadwal masuk antrean');
    } catch (err) {
      logger.warn({ err: err.message }, 'Sync terjadwal dilewati');
    }
  }, 60_000);

  timer.unref?.();
  logger.info({ schedule: config.CRON_DAILY_SYNC, tz: config.TZ }, 'Penjadwal aktif');
  return () => clearInterval(timer);
}

const matches = (pattern, value) => pattern === '*' || Number(pattern) === value;
