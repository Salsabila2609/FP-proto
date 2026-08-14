import { mkdtempSync, rmSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { transaction } from './duckdb.js';
import { assertIdentifier } from '../lib/sql.js';

/**
 * Muat banyak baris ke DuckDB lewat NDJSON + read_json.
 *
 * Kenapa bukan INSERT baris per baris: untuk 200 ribu baris per hari,
 * INSERT satu-satu lewat driver JS makan menit; parser JSON milik DuckDB
 * berjalan di C++ dan multi-thread, jadi bedanya orde besaran.
 *
 * Idempoten per partisi: baris lama pada partisi yang sama dihapus lebih dulu
 * di dalam transaksi yang sama, jadi backfill boleh diulang berapa kali pun
 * tanpa menggandakan data.
 */
export async function bulkLoad({ table, columns, rows, partition }) {
  assertIdentifier(table);
  const colNames = columns.map((c) => c.name);
  colNames.forEach(assertIdentifier);
  if (partition) assertIdentifier(partition.column);

  const dir = mkdtempSync(join(tmpdir(), 'peval-'));
  const file = join(dir, 'batch.ndjson');

  try {
    if (rows.length > 0) {
      const out = createWriteStream(file, { encoding: 'utf8' });
      for (const row of rows) {
        const rec = {};
        for (const c of colNames) rec[c] = row[c] === undefined ? null : row[c];
        if (!out.write(JSON.stringify(rec) + '\n')) await once(out, 'drain');
      }
      out.end();
      await once(out, 'finish');
    }

    const colSpec = columns.map((c) => `"${c.name}": '${c.type}'`).join(', ');
    const colList = colNames.map((c) => `"${c}"`).join(', ');

    return await transaction(async (tx) => {
      if (partition) {
        await tx.run(`DELETE FROM "${table}" WHERE "${partition.column}" = ?`, [partition.value]);
      }
      if (rows.length === 0) return { inserted: 0 };
      await tx.run(
        `INSERT INTO "${table}" (${colList})
         SELECT ${colList}
         FROM read_json(?, format='newline_delimited', columns={${colSpec}})`,
        [file],
      );
      return { inserted: rows.length };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
