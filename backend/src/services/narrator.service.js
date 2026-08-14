import { randomUUID } from 'node:crypto';
import { generateText } from './gemini.client.js';
import { execute, queryOne } from '../db/duckdb.js';
import { getStoredEvaluation, rankPrograms, hashInput } from './evaluation.service.js';
import { RECIPES } from './metrics/recipes.js';
import { config } from '../config/index.js';
import { notFound } from '../lib/errors.js';

const SYSTEM = `Kamu analis evaluasi program di operator telekomunikasi Indonesia.

Kamu menerima ANGKA YANG SUDAH DIHITUNG. Tugasmu menjelaskannya dalam bahasa Indonesia yang
lugas untuk manajer sales, bukan menghitung ulang.

Aturan yang tidak boleh dilanggar:
- Jangan menyebut angka yang tidak ada di input. Jangan menghitung, menjumlah, atau memperkirakan sendiri.
- Kalau confidence "low", katakan terus terang bahwa kesimpulannya lemah dan sebutkan penyebabnya.
- Resep yang statusnya "skipped" harus disebut sebagai keterbatasan, bukan diabaikan.
- Bedakan dengan jelas pertumbuhan mentah dan uplift. Kenaikan yang setara wilayah pembanding
  bukan keberhasilan program.
- Kalau pangsa pasar tidak naik sementara revenue naik, sebut itu sebagai tanda ikut tren industri.
- Maksimal 250 kata. Tanpa basa-basi pembuka. Tanpa bullet berlebihan.

Format: 3 paragraf pendek -- apa yang terjadi, apa artinya, apa yang perlu dicek atau dilakukan.`;

export async function narrateProgram(programId, { force = false } = {}) {
  const program = await queryOne('SELECT * FROM program WHERE id = ?', [programId]);
  if (!program) throw notFound('Program tidak ditemukan.');

  const evaluations = await getStoredEvaluation(programId);
  if (evaluations.length === 0) throw notFound('Program ini belum dievaluasi.');

  const payload = {
    program: { name: program.name, division: program.division, category: program.category, periode: [program.period_start, program.period_end], biaya_total: program.cost_total, level_wilayah: program.geo_level },
    hasil: evaluations.map((e) => ({ resep: e.recipe, penjelasan_resep: RECIPES[e.recipe]?.explain, status: e.status, alasan_dilewati: e.skip_reason, confidence: e.confidence, angka: e.metrics })),
  };

  const inputHash = hashInput(payload);
  if (!force) {
    const cached = await queryOne(
      'SELECT narrative FROM insight WHERE program_id = ? AND input_hash = ? ORDER BY created_at DESC LIMIT 1',
      [programId, inputHash],
    );
    if (cached) return { narrative: cached.narrative, cached: true };
  }

  const narrative = await generateText({
    system: SYSTEM,
    user: `Data evaluasi:\n${JSON.stringify(payload, null, 2)}`,
    cacheKey: `narr:${inputHash}`,
  });

  await execute(
    'INSERT INTO insight (id, program_id, scope, input_hash, narrative, model) VALUES (?,?,?,?,?,?)',
    [randomUUID(), programId, 'program', inputHash, narrative, config.GEMINI_MODEL],
  );

  return { narrative, cached: false };
}

export async function narrateComparison({ category, from, to }) {
  const ranking = await rankPrograms({ category, from, to });
  const payload = { periode: [from ?? null, to ?? null], peringkat: ranking };
  const inputHash = hashInput(payload);

  const narrative = await generateText({
    system: `${SYSTEM}\n\nKali ini kamu membandingkan beberapa program. Sebutkan mana yang paling efektif dan kenapa, lalu mana yang biayanya tidak sebanding hasilnya. Skor sudah dinormalisasi di dalam kategori yang sama; jangan bandingkan lintas kategori.`,
    user: `Data peringkat:\n${JSON.stringify(payload, null, 2)}`,
    cacheKey: `cmp:${inputHash}`,
  });

  await execute(
    'INSERT INTO insight (id, program_id, scope, input_hash, narrative, model) VALUES (?,?,?,?,?,?)',
    [randomUUID(), null, 'comparison', inputHash, narrative, config.GEMINI_MODEL],
  );

  return { narrative, ranking };
}
