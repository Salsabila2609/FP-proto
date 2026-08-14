import { BigQuery } from '@google-cloud/bigquery';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { upstream } from '../lib/errors.js';

let client = null;

function getClient() {
  if (!client) {
    client = new BigQuery({ projectId: config.bqJobProject, location: config.BQ_LOCATION });
  }
  return client;
}

/**
 * Jalankan query BigQuery.
 *
 * maximumBytesBilled adalah rem biaya: query yang akan memindai lebih dari
 * batas ini ditolak sebelum jalan, bukan dijalankan lalu ditagih. Ini yang
 * menyelamatkan kamu dari satu typo di klausa WHERE.
 *
 * Kredensial diambil dari ADC (gcloud auth application-default login) atau
 * GOOGLE_APPLICATION_CREDENTIALS. Service account-nya cukup diberi peran
 * BigQuery Job User + Data Viewer -- tidak ada operasi tulis di sini.
 */
export async function runQuery({ query, params = {}, label }) {
  const started = Date.now();
  try {
    const [job] = await getClient().createQueryJob({
      query,
      params,
      location: config.BQ_LOCATION,
      maximumBytesBilled: config.BQ_MAX_BYTES_BILLED,
      useLegacySql: false,
      labels: label ? { pipeline: 'program_eval', step: label } : undefined,
    });

    const [rows] = await job.getQueryResults({ timeoutMs: config.BQ_TIMEOUT_MS });
    const [meta] = await job.getMetadata();
    const bytesBilled = Number(meta?.statistics?.query?.totalBytesBilled ?? 0);

    logger.info(
      { label, rows: rows.length, bytesBilled, ms: Date.now() - started },
      'Query BigQuery selesai',
    );
    return { rows, bytesBilled };
  } catch (err) {
    logger.error({ err, label }, 'Query BigQuery gagal');
    throw upstream(`BigQuery gagal: ${err.message}`, { label });
  }
}

/** BigQuery mengembalikan DATE/TIMESTAMP sebagai objek { value }. */
export function unwrapBqValue(v) {
  if (v && typeof v === 'object' && 'value' in v) return v.value;
  if (typeof v === 'bigint') return Number(v);
  return v;
}

export function unwrapBqRow(row) {
  const out = {};
  for (const k of Object.keys(row)) out[k] = unwrapBqValue(row[k]);
  return out;
}
