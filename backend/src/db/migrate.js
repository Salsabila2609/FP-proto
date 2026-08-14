import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { initDb, execute, query, queryOne, closeDb } from './duckdb.js';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function runMigrations() {
  await initDb();
  await execute(`CREATE TABLE IF NOT EXISTS schema_migration (
    name VARCHAR PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT now())`);

  const applied = new Set((await query('SELECT name FROM schema_migration')).map((r) => r.name));
  const files = readdirSync(join(here, 'migrations')).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(here, 'migrations', file), 'utf8');
    // DuckDB menjalankan satu statement per run(), jadi file dipecah per ';'.
    const statements = sql
      .split(/;\s*$/m)
      .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean);
    for (const stmt of statements) await execute(stmt);
    await execute('INSERT INTO schema_migration (name) VALUES (?)', [file]);
    logger.info({ file }, 'Migrasi diterapkan');
  }

  await bootstrapAdmin();
}

async function bootstrapAdmin() {
  const { BOOTSTRAP_ADMIN_EMAIL: email, BOOTSTRAP_ADMIN_PASSWORD: password } = config;
  if (!email || !password) return;
  const existing = await queryOne('SELECT id FROM app_user WHERE email = ?', [email]);
  if (existing) return;
  await execute(
    `INSERT INTO app_user (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, 'admin')`,
    [randomUUID(), email, 'Admin', await bcrypt.hash(password, 12)],
  );
  logger.info({ email }, 'Admin awal dibuat');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => closeDb())
    .then(() => logger.info('Migrasi selesai'))
    .catch((err) => {
      logger.error({ err }, 'Migrasi gagal');
      process.exit(1);
    });
}
