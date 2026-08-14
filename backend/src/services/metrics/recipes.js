import { query } from '../../db/duckdb.js';
import { geoColumn } from '../geo.service.js';
import { OWN_OPERATORS } from '../../registry/regions.js';
import { populationTotal, populationByGeo, complementTotal } from './population.js';
import { BASE_TABLES } from '../../registry/fileSources.js';
import { measureTotal, measureByGeo, findControlGeos, shiftDate, daysBetween, growth } from './baseline.js';

/**
 * Pustaka resep evaluasi.
 *
 * Setiap resep mendeklarasikan syaratnya lebih dulu. Kalau data program tidak
 * memenuhi syarat, resep di-SKIP dengan alasan yang bisa dibaca -- bukan
 * dipaksa jalan dan mengeluarkan angka yang menyesatkan. LLM tidak pernah
 * memilih rumus di sini; dia hanya menarasikan hasilnya.
 */

export const RECIPES = {
  did_acquisition: {
    key: 'did_acquisition',
    label: 'Uplift akuisisi (difference-in-differences)',
    appliesTo: (p) => ['acquisition', 'partnership'].includes(p.category),
    explain:
      'Membandingkan pertumbuhan penjualan SP di wilayah program terhadap wilayah pembanding di region yang sama pada periode yang sama. Yang dilaporkan adalah selisihnya, bukan pertumbuhan mentah.',
    run: (ctx) => didRecipe(ctx, 'sp', 'SP terjual'),
  },

  did_revenue: {
    key: 'did_revenue',
    label: 'Uplift revenue rebuy (difference-in-differences)',
    appliesTo: (p) => ['arpu', 'loyalty'].includes(p.category),
    explain:
      'Sama seperti uplift akuisisi, tapi ukurannya revenue rebuy. Dipakai untuk program peningkatan ARPU.',
    run: (ctx) => didRecipe(ctx, 'rebuy_revenue', 'Revenue rebuy'),
  },

  arpu_health: {
    key: 'arpu_health',
    label: 'Kesehatan ARPU',
    appliesTo: (p) => ['arpu', 'loyalty'].includes(p.category),
    explain:
      'Revenue rebuy naik sementara basis pelanggan menyusut adalah sinyal bahaya: pendapatan datang dari memeras pelanggan lama, bukan dari pertumbuhan.',
    run: async ({ program, treated, level }) => {
      const pre = { start: shiftDate(program.period_start, -daysBetween(program.period_start, program.period_end)), end: shiftDate(program.period_start, -1) };
      const post = { start: program.period_start, end: program.period_end };

      const [revPre, revPost, basePre, basePost] = await Promise.all([
        measureTotal({ measure: 'rebuy_revenue', level, geoValues: treated, ...pre }),
        measureTotal({ measure: 'rebuy_revenue', level, geoValues: treated, ...post }),
        activeBase({ level, geoValues: treated, ...pre }),
        activeBase({ level, geoValues: treated, ...post }),
      ]);

      const arpuPre = basePre > 0 ? revPre / basePre : null;
      const arpuPost = basePost > 0 ? revPost / basePost : null;
      const baseGrowth = growth(basePost, basePre);
      const arpuGrowth = arpuPre ? arpuPost / arpuPre - 1 : null;

      return {
        metrics: {
          arpu_pre: arpuPre, arpu_post: arpuPost, arpu_growth: arpuGrowth,
          active_outlet_pre: basePre, active_outlet_post: basePost, base_growth: baseGrowth,
          verdict: arpuGrowth === null ? 'tidak_cukup_data'
            : arpuGrowth > 0 && (baseGrowth ?? 0) >= -0.02 ? 'sehat'
            : arpuGrowth > 0 ? 'arpu_naik_basis_turun'
            : 'arpu_turun',
        },
        confidence: basePre > 20 && basePost > 20 ? 'high' : basePre > 0 ? 'medium' : 'low',
      };
    },
  },

  marketshare_delta: {
    key: 'marketshare_delta',
    label: 'Perubahan pangsa pasar',
    appliesTo: () => true,
    explain:
      'Validasi silang. Kalau revenue naik tapi pangsa pasar diam atau turun, kenaikan itu tren industri, bukan hasil program. Sumbernya mingguan, jadi program yang berjalan beberapa minggu pun tetap bisa dinilai.',
    run: async ({ program, treated, level }) => {
      const msCol = {
        region: 'region_name', area: 'area_name', sales_area: 'sales_area_name',
        kabkot: 'kabkot_nm', kecamatan: 'kecamatan_nm',
      }[level];
      if (!msCol) return { skip: 'Market share hanya tersedia sampai level kecamatan/sales area.' };

      // Ambil juga beberapa minggu sebelum program mulai, supaya ada titik
      // pembanding walau program hanya berjalan singkat.
      const lookback = shiftDate(program.period_start, -35);
      const rows = await query(
        `SELECT tanggal,
                SUM(CASE WHEN UPPER(operator) IN (${OWN_OPERATORS.map(() => '?').join(',')}) THEN total_ga_ori ELSE 0 END) AS own_ga,
                SUM(total_ga_ori) AS all_ga,
                SUM(CASE WHEN UPPER(operator) IN (${OWN_OPERATORS.map(() => '?').join(',')}) THEN total_base_ori ELSE 0 END) AS own_base,
                SUM(total_base_ori) AS all_base
         FROM fact_marketshare
         WHERE "${msCol}" IN (${treated.map(() => '?').join(',')})
           AND tanggal BETWEEN ? AND ?
         GROUP BY 1 ORDER BY 1`,
        [...OWN_OPERATORS, ...OWN_OPERATORS, ...treated, lookback, program.period_end],
      );

      if (rows.length < 2) {
        return { skip: `Butuh minimal dua snapshot mingguan pangsa pasar di wilayah ini; yang tersedia ${rows.length}.` };
      }

      // Titik "sebelum" = snapshot terakhir sebelum program mulai, kalau ada.
      const preIdx = Math.max(0, rows.findIndex((r) => r.tanggal >= program.period_start) - 1);
      const pre = rows[preIdx];
      const post = rows[rows.length - 1];
      if (pre === post) return { skip: 'Semua snapshot pangsa pasar jatuh di sisi yang sama dari tanggal mulai program.' };

      const gaShare = (r) => (r.all_ga > 0 ? (r.own_ga / r.all_ga) * 100 : null);
      const baseShare = (r) => (r.all_base > 0 ? (r.own_base / r.all_base) * 100 : null);
      const delta = (a, b) => (a === null || b === null ? null : b - a);

      return {
        metrics: {
          snapshot_pre: pre.tanggal,
          snapshot_post: post.tanggal,
          snapshots_observed: rows.length,
          snapshots_after_start: rows.filter((r) => r.tanggal >= program.period_start).length,
          ga_share_pre_pct: gaShare(pre),
          ga_share_post_pct: gaShare(post),
          ga_share_delta_pp: delta(gaShare(pre), gaShare(post)),
          base_share_pre_pct: baseShare(pre),
          base_share_post_pct: baseShare(post),
          base_share_delta_pp: delta(baseShare(pre), baseShare(post)),
        },
        confidence: rows.length >= 6 ? 'high' : rows.length >= 4 ? 'medium' : 'low',
      };
    },
  },

  event_window: {
    key: 'event_window',
    label: 'Lonjakan di sekitar tanggal event',
    appliesTo: (p) => p.division === 'marcomm',
    explain:
      'Untuk aktivitas yang tidak bisa diatribusikan ke transaksi individual (school attack, event booth): bandingkan penjualan SP di wilayah itu pada H-3 sampai H+7 terhadap rata-rata harian wilayah yang sama di luar jendela event.',
    run: async ({ program, level, resultRows }) => {
      const events = resultRows.filter((r) => r.is_executed && r.tanggal && r.geo_canonical);
      if (events.length < 3) return { skip: 'Butuh minimal 3 event yang sudah terlaksana dengan tanggal dan wilayah yang jelas.' };

      const perEvent = [];
      for (const ev of events) {
        const inWindow = await measureTotal({ measure: 'sp', level, geoValues: [ev.geo_canonical], start: shiftDate(ev.tanggal, -3), end: shiftDate(ev.tanggal, 7) });
        const baselineTotal = await measureTotal({ measure: 'sp', level, geoValues: [ev.geo_canonical], start: shiftDate(ev.tanggal, -45), end: shiftDate(ev.tanggal, -4) });
        const baselineDaily = baselineTotal / 42;
        const expected = baselineDaily * 11;
        perEvent.push({
          tanggal: ev.tanggal, geo: ev.geo_canonical,
          sp_in_window: inWindow, sp_expected: expected,
          lift: expected > 0 ? inWindow / expected - 1 : null,
          reported: ev.metric_value,
        });
      }

      const valid = perEvent.filter((e) => e.lift !== null);
      const avgLift = valid.length ? valid.reduce((s, e) => s + e.lift, 0) / valid.length : null;
      const positive = valid.filter((e) => e.lift > 0).length;

      return {
        metrics: {
          events_evaluated: valid.length,
          avg_lift_pct: avgLift === null ? null : avgLift * 100,
          events_with_positive_lift: positive,
          hit_rate: valid.length ? positive / valid.length : null,
          total_reported: perEvent.reduce((s, e) => s + (e.reported ?? 0), 0),
          total_incremental_sp: valid.reduce((s, e) => s + (e.sp_in_window - e.sp_expected), 0),
          per_event: perEvent.slice(0, 50),
        },
        confidence: valid.length >= 10 ? 'high' : valid.length >= 5 ? 'medium' : 'low',
      };
    },
  },

  did_population: {
    key: 'did_population',
    label: 'Uplift populasi program (before-after terkoreksi)',
    // Berlaku untuk program yang didefinisikan sebagai FILTER, bukan sebagai
    // hasil yang diunggah -- misalnya postpaid, yang datanya satu file harian
    // dan programnya dikenali dari nama paket, channel, dan periodenya.
    // Hanya berlaku kalau tabel dasarnya benar-benar punya ukuran yang dibutuhkan.
    // Program prepaid memakai fact_cashback sebagai tabel dasar, tapi di situ
    // yang tersimpan biaya -- penjualannya diukur resep did_acquisition dari
    // fact_trx_prepaid. Tanpa cek ini, resep berjalan lalu gagal di tengah.
    appliesTo: (p) => {
      if (!p.base_table || !p.population_filter) return false;
      const spec = BASE_TABLES[p.base_table];
      return Boolean(spec?.measures?.[p.category === 'arpu' ? 'revenue' : 'ga']);
    },
    explain:
      'Membandingkan pertumbuhan populasi yang kena program terhadap sisa populasi di tabel yang sama pada periode yang sama. Kalau paket lain juga naik sebanyak itu, uplift program dilaporkan nol -- bukan angka pertumbuhan mentahnya.',
    run: async ({ program }) => {
      const filters = typeof program.population_filter === 'string'
        ? JSON.parse(program.population_filter)
        : program.population_filter;
      if (!Array.isArray(filters) || filters.length === 0) {
        return { skip: 'Filter populasi program kosong.' };
      }

      const baseTable = program.base_table;
      const measure = program.category === 'arpu' ? 'revenue' : 'ga';
      const windowDays = daysBetween(program.period_start, program.period_end);
      const pre = { start: shiftDate(program.period_start, -windowDays), end: shiftDate(program.period_start, -1) };
      const post = { start: program.period_start, end: program.period_end };

      const [tPre, tPost, cPre, cPost] = await Promise.all([
        populationTotal({ baseTable, filters, measure, ...pre }),
        populationTotal({ baseTable, filters, measure, ...post }),
        complementTotal({ baseTable, filters, measure, ...pre }),
        complementTotal({ baseTable, filters, measure, ...post }),
      ]);

      if (tPre <= 0) {
        return { skip: 'Periode sebelum program tidak punya data untuk populasi ini. Kalau produknya memang baru diluncurkan, before-after tidak bisa dipakai.' };
      }
      if (cPre <= 0) {
        return { skip: 'Tidak ada populasi pembanding di tabel dasar. Pertumbuhan tidak bisa dipisahkan dari tren umum.' };
      }

      const treatedGrowth = growth(tPost, tPre);
      const controlGrowth = growth(cPost, cPre);
      const expected = tPre * (1 + controlGrowth);
      const incremental = tPost - expected;
      const perGeo = await populationByGeo({ baseTable, filters, measure, level: 'sales_area', ...post });

      return {
        metrics: {
          measure,
          base_table: baseTable,
          pre_period: pre, post_period: post,
          treated_pre: tPre, treated_post: tPost,
          control_pre: cPre, control_post: cPost,
          treated_growth_pct: treatedGrowth * 100,
          control_growth_pct: controlGrowth * 100,
          uplift_pp: (treatedGrowth - controlGrowth) * 100,
          expected_without_program: expected,
          incremental_result: incremental,
          incremental_share: tPost > 0 ? incremental / tPost : null,
          target_value: program.target_value ?? null,
          target_achievement_pct: program.target_value ? (tPost / program.target_value) * 100 : null,
          top_geo: perGeo.slice(0, 5),
          bottom_geo: perGeo.slice(-5).reverse(),
        },
        confidence: tPre >= 100 && cPre >= 100 ? 'high' : tPre >= 20 ? 'medium' : 'low',
      };
    },
  },

  cost_efficiency: {
    key: 'cost_efficiency',
    label: 'Efisiensi biaya per hasil inkremental',
    appliesTo: () => true,
    dependsOn: ['did_acquisition', 'did_revenue', 'event_window', 'did_population'],
    explain:
      'Biaya dibagi hasil INKREMENTAL, bukan hasil total. Program mahal yang sebagian besar hasilnya organik akan terlihat buruk di sini, dan memang seharusnya begitu.',
    run: async ({ program, priorResults }) => {
      const source = ['did_acquisition', 'did_revenue', 'did_population', 'event_window']
        .map((k) => priorResults[k])
        .find((r) => r && r.status === 'ok');
      if (!source) return { skip: 'Belum ada hasil inkremental dari resep lain untuk dibagi.' };

      const incremental =
        source.metrics.incremental_result ?? source.metrics.total_incremental_sp ?? null;
      const total = source.metrics.treated_post ?? source.metrics.total_reported ?? null;
      if (!incremental || incremental <= 0) {
        return {
          metrics: { cost_total: program.cost_total, incremental_result: incremental, cost_per_incremental: null, note: 'Hasil inkremental nol atau negatif, biaya per hasil tidak bermakna.' },
          confidence: 'low',
        };
      }

      return {
        metrics: {
          cost_total: program.cost_total,
          incremental_result: incremental,
          total_result: total,
          organic_share: total ? 1 - incremental / total : null,
          cost_per_incremental: program.cost_total / incremental,
          cost_per_total: total ? program.cost_total / total : null,
        },
        confidence: source.confidence,
      };
    },
  },
};

async function didRecipe({ program, treated, level }, measure, measureLabel) {
  if (treated.length === 0) return { skip: 'Tidak ada wilayah program yang cocok dengan data warehouse.' };

  const windowDays = daysBetween(program.period_start, program.period_end);
  const pre = { start: shiftDate(program.period_start, -windowDays), end: shiftDate(program.period_start, -1) };
  const post = { start: program.period_start, end: program.period_end };

  const control = await findControlGeos({ level, treated });
  if (control.length === 0) {
    return {
      skip:
        `Program ini mencakup SEMUA ${level} di region-nya, jadi tidak ada wilayah pembanding ` +
        'dan uplift tidak bisa dipisahkan dari tren umum. Impor ulang program di level "outlet": ' +
        'cashback diberikan per outlet, jadi outlet yang tidak menerimanya menjadi pembanding alami.',
    };
  }

  const [tPre, tPost, cPre, cPost] = await Promise.all([
    measureTotal({ measure, level, geoValues: treated, ...pre }),
    measureTotal({ measure, level, geoValues: treated, ...post }),
    measureTotal({ measure, level, geoValues: control, ...pre }),
    measureTotal({ measure, level, geoValues: control, ...post }),
  ]);

  if (tPre <= 0 || cPre <= 0) return { skip: 'Data periode sebelum program kosong, tidak ada dasar pembanding.' };

  const treatedGrowth = growth(tPost, tPre);
  const controlGrowth = growth(cPost, cPre);
  const did = treatedGrowth - controlGrowth;
  const expected = tPre * (1 + controlGrowth);
  const incremental = tPost - expected;

  const perGeo = await measureByGeo({ measure, level, geoValues: treated, ...post });

  return {
    metrics: {
      measure, measure_label: measureLabel,
      pre_period: pre, post_period: post,
      treated_geo_count: treated.length, control_geo_count: control.length,
      treated_pre: tPre, treated_post: tPost,
      control_pre: cPre, control_post: cPost,
      treated_growth_pct: treatedGrowth * 100,
      control_growth_pct: controlGrowth * 100,
      uplift_pp: did * 100,
      expected_without_program: expected,
      incremental_result: incremental,
      incremental_share: tPost > 0 ? incremental / tPost : null,
      top_geo: perGeo.slice(0, 5),
      bottom_geo: perGeo.slice(-5).reverse(),
    },
    confidence: treated.length >= 8 && control.length >= 8 ? 'high' : treated.length >= 3 ? 'medium' : 'low',
  };
}

async function activeBase({ level, geoValues, start, end }) {
  const col = geoColumn(level);
  if (!geoValues.length) return 0;
  const rows = await query(
    `SELECT count(DISTINCT outlet) AS n FROM v_trx_prepaid
     WHERE tanggal BETWEEN ? AND ? AND "${col}" IN (${geoValues.map(() => '?').join(',')})`,
    [start, end, ...geoValues],
  );
  return Number(rows[0]?.n ?? 0);
}

export const RECIPE_KEYS = Object.keys(RECIPES);