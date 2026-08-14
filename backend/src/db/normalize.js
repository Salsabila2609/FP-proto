// DuckDB mengembalikan tipe khusus (BigInt, DuckDBDateValue, DuckDBDecimalValue).
// Semua hasil query dilewatkan sini supaya sisa aplikasi dan JSON.stringify
// cuma pernah melihat tipe JS biasa.
const EPOCH_DAY_MS = 86400000;

export function normalizeValue(v) {
  if (v === null || v === undefined) return null;

  if (typeof v === 'bigint') {
    return v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v.toString();
  }
  if (typeof v !== 'object') return v;

  if (v instanceof Date) return v.toISOString();

  // DATE -> 'YYYY-MM-DD'
  if ('days' in v && Object.keys(v).length === 1) {
    return new Date(Number(v.days) * EPOCH_DAY_MS).toISOString().slice(0, 10);
  }
  // TIMESTAMP -> ISO string
  if ('micros' in v) {
    return new Date(Number(BigInt(v.micros) / 1000n)).toISOString();
  }
  // DECIMAL -> number
  if ('value' in v && 'scale' in v) {
    return Number(BigInt(v.value)) / 10 ** Number(v.scale);
  }
  if (Array.isArray(v.items)) return v.items.map(normalizeValue);
  if (v.entries && typeof v.entries === 'object') return normalizeRow(v.entries);
  if (Array.isArray(v)) return v.map(normalizeValue);

  return v;
}

export function normalizeRow(row) {
  const out = {};
  for (const k of Object.keys(row)) out[k] = normalizeValue(row[k]);
  return out;
}

export const normalizeRows = (rows) => rows.map(normalizeRow);
