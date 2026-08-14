import { registerHandler } from './queue.js';
import { backfill, runDailySync, applyRetention } from '../services/sync.service.js';
import { evaluateProgram } from '../services/evaluation.service.js';
import { refreshAllFileSources, refreshFileSource } from '../services/fileSource.service.js';

registerHandler('daily_sync', async () => {
  const bq = await runDailySync({ triggeredBy: 'job' });
  const files = await refreshAllFileSources({ triggeredBy: 'job' });
  return [...bq, ...files];
});

registerHandler('backfill', ({ payload, signal, onProgress }) =>
  backfill({ ...payload, signal, onProgress }),
);

registerHandler('retention', () => applyRetention());

registerHandler('refresh_files', ({ payload }) =>
  payload?.key
    ? refreshFileSource(payload.key, { triggeredBy: 'job' })
    : refreshAllFileSources({ triggeredBy: 'job' }),
);

registerHandler('evaluate_all', async ({ payload, onProgress }) => {
  const ids = payload.programIds ?? [];
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    try {
      await evaluateProgram(ids[i]);
      out.push({ id: ids[i], status: 'ok' });
    } catch (err) {
      out.push({ id: ids[i], status: 'error', error: err.message });
    }
    onProgress({ done: i + 1, total: ids.length });
  }
  return out;
});