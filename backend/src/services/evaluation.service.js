import { randomUUID, createHash } from 'node:crypto';
import { query, execute, queryOne } from '../db/duckdb.js';
import { RECIPES, RECIPE_KEYS } from './metrics/recipes.js';
import { resolveGeo } from './geo.service.js';
import { notFound } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { queryCache } from '../lib/cache.js';

/**
 * Jalankan seluruh resep yang berlaku untuk satu program.
 * Urutannya penting: cost_efficiency membaca hasil resep lain, jadi dia terakhir.
 */
export async function evaluateProgram(programId) {
  const program = await queryOne('SELECT * FROM program WHERE id = ?', [programId]);
  if (!program) throw notFound('Program tidak ditemukan.');

  const resultRows = await query(
    `SELECT tanggal, geo_value, metric_name, metric_value, unit, cost, is_executed
     FROM program_result WHERE program_id = ?`,
    [programId],
  );

  const executed = resultRows.filter((r) => r.is_executed);
  const { matched, unmatched, canonicalValues } = await resolveGeo(
    program.geo_level,
    executed.map((r) => r.geo_value),
  );
  const enriched = executed.map((r) => ({ ...r, geo_canonical: matched.get(r.geo_value) ?? null }));

  const ctx = {
    program,
    level: program.geo_level,
    treated: canonicalValues,
    resultRows: enriched,
    priorResults: {},
  };

  const ordered = RECIPE_KEYS.filter((k) => !RECIPES[k].dependsOn).concat(RECIPE_KEYS.filter((k) => RECIPES[k].dependsOn));
  const outputs = [];

  for (const key of ordered) {
    const recipe = RECIPES[key];
    if (!recipe.appliesTo(program)) continue;
    let record;
    try {
      const res = await recipe.run(ctx);
      record = res.skip
        ? { recipe: key, status: 'skipped', skipReason: res.skip, metrics: null, confidence: null }
        : { recipe: key, status: 'ok', skipReason: null, metrics: res.metrics, confidence: downgrade(res.confidence, unmatched.length, executed.length) };
    } catch (err) {
      logger.error({ err, recipe: key, programId }, 'Resep evaluasi gagal');
      record = { recipe: key, status: 'error', skipReason: err.message, metrics: null, confidence: null };
    }
    ctx.priorResults[key] = record;
    outputs.push({ ...record, label: recipe.label, explain: recipe.explain });
  }

  await persist(programId, outputs);

  return {
    program,
    geo: { matched: matched.size, unmatched, canonicalValues },
    dataQuality: {
      rowsTotal: resultRows.length,
      rowsExecuted: executed.length,
      rowsSkippedNotExecuted: resultRows.length - executed.length,
      geoUnmatchedCount: unmatched.length,
    },
    results: outputs,
  };
}

// Wilayah yang tidak cocok berarti sebagian program tidak terhitung.
// Itu menurunkan keyakinan apa pun kata rumusnya.
function downgrade(level, unmatchedCount, totalRows) {
  if (!level) return level;
  const ratio = totalRows > 0 ? unmatchedCount / totalRows : 0;
  if (ratio > 0.3) return 'low';
  if (ratio > 0.1 && level === 'high') return 'medium';
  return level;
}

async function persist(programId, outputs) {
  await execute('DELETE FROM evaluation WHERE program_id = ?', [programId]);
  for (const o of outputs) {
    await execute(
      `INSERT INTO evaluation (id, program_id, recipe, status, skip_reason, metrics, confidence)
       VALUES (?,?,?,?,?,?,?)`,
      [randomUUID(), programId, o.recipe, o.status, o.skipReason, o.metrics ? JSON.stringify(o.metrics) : null, o.confidence],
    );
  }
  queryCache.clear('eval:');
}

export async function getStoredEvaluation(programId) {
  const rows = await query('SELECT * FROM evaluation WHERE program_id = ? ORDER BY recipe', [programId]);
  return rows.map((r) => ({ ...r, metrics: r.metrics ? JSON.parse(r.metrics) : null }));
}

/**
 * Peringkat lintas program. Skor komposit dinormalisasi DALAM kategori yang
 * sama -- membandingkan program akuisisi dengan program loyalty pakai angka
 * mentah tidak bermakna karena satuan KPI-nya beda.
 */
export async function rankPrograms({ category, from, to } = {}) {
  const key = `eval:rank:${category ?? '*'}:${from ?? ''}:${to ?? ''}`;
  return queryCache.wrap(key, async () => {
    const params = [];
    let where = 'WHERE 1=1';
    if (category) { where += ' AND p.category = ?'; params.push(category); }
    if (from) { where += ' AND p.period_end >= ?'; params.push(from); }
    if (to) { where += ' AND p.period_start <= ?'; params.push(to); }

    const rows = await query(
      `SELECT p.id, p.name, p.division, p.category, p.cost_total, p.period_start, p.period_end,
              e.recipe, e.status, e.confidence, e.metrics
       FROM program p LEFT JOIN evaluation e ON e.program_id = p.id
       ${where}`,
      params,
    );

    const byProgram = new Map();
    for (const r of rows) {
      if (!byProgram.has(r.id)) {
        byProgram.set(r.id, { id: r.id, name: r.name, division: r.division, category: r.category, cost_total: r.cost_total, period_start: r.period_start, period_end: r.period_end, uplift_pp: null, cost_per_incremental: null, ga_share_delta_pp: null, confidence: 'low' });
      }
      const p = byProgram.get(r.id);
      if (r.status !== 'ok' || !r.metrics) continue;
      const m = JSON.parse(r.metrics);
      if (m.uplift_pp !== undefined) p.uplift_pp = m.uplift_pp;
      if (m.avg_lift_pct !== undefined && p.uplift_pp === null) p.uplift_pp = m.avg_lift_pct;
      if (m.cost_per_incremental !== undefined) p.cost_per_incremental = m.cost_per_incremental;
      if (m.ga_share_delta_pp !== undefined) p.ga_share_delta_pp = m.ga_share_delta_pp;
      p.confidence = strongest(p.confidence, r.confidence);
    }

    const list = [...byProgram.values()];
    const byCategory = new Map();
    for (const p of list) {
      if (!byCategory.has(p.category)) byCategory.set(p.category, []);
      byCategory.get(p.category).push(p);
    }

    for (const group of byCategory.values()) {
      const upliftScore = normalize(group.map((p) => p.uplift_pp), 'higher');
      const costScore = normalize(group.map((p) => p.cost_per_incremental), 'lower');
      const shareScore = normalize(group.map((p) => p.ga_share_delta_pp), 'higher');
      group.forEach((p, i) => {
        const parts = [upliftScore[i], costScore[i], shareScore[i]].filter((v) => v !== null);
        p.score = parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : null;
      });
      group.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    }

    return [...byCategory.entries()].map(([cat, programs]) => ({ category: cat, programs }));
  }, 5 * 60_000);
}

function normalize(values, direction) {
  const valid = values.filter((v) => v !== null && Number.isFinite(v));
  if (valid.length < 2) return values.map(() => null);
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  if (max === min) return values.map((v) => (v === null ? null : 50));
  return values.map((v) => {
    if (v === null || !Number.isFinite(v)) return null;
    const t = (v - min) / (max - min);
    return Math.round((direction === 'lower' ? 1 - t : t) * 100);
  });
}

const RANK = { low: 0, medium: 1, high: 2 };
const strongest = (a, b) => ((RANK[b] ?? 0) > (RANK[a] ?? 0) ? b : a);

export const hashInput = (obj) => createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 32);
