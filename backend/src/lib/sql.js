import { badRequest } from './errors.js';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * Nilai selalu lewat parameter binding. Nama tabel/kolom tidak bisa
 * diparameterkan, jadi apapun yang dipakai sebagai identifier harus lolos
 * pola ini DAN berasal dari registry, bukan langsung dari input user.
 */
export function assertIdentifier(name) {
  if (!IDENT.test(String(name ?? ''))) {
    throw badRequest(`Nama objek database tidak valid: ${name}`);
  }
  return name;
}

/** Bangun klausa WHERE dari filter yang sudah divalidasi. */
export function buildWhere(filters = {}, allowed = []) {
  const clauses = [];
  const params = [];
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    if (!allowed.includes(key)) throw badRequest(`Filter tidak dikenal: ${key}`);
    assertIdentifier(key);
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      clauses.push(`"${key}" IN (${value.map(() => '?').join(', ')})`);
      params.push(...value);
    } else {
      clauses.push(`"${key}" = ?`);
      params.push(value);
    }
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}
