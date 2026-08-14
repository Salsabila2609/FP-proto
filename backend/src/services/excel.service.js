import { createHash } from 'node:crypto';
import XLSX from 'xlsx';
import { badRequest } from '../lib/errors.js';

const MAX_SAMPLE_ROWS = 15;

/**
 * Baca workbook jadi matriks mentah. Header sengaja TIDAK diasumsikan ada di
 * baris pertama -- file lapangan sering punya judul, baris kosong, atau blok
 * yang berulang. Baris header ditebak, lalu dikonfirmasi manusia di UI.
 */
export function readWorkbook(pathOrBuffer) {
  const opts = { cellDates: true, cellNF: false, sheetStubs: false };
  const wb = Buffer.isBuffer(pathOrBuffer)
    ? XLSX.read(pathOrBuffer, { ...opts, type: 'buffer' })
    : XLSX.readFile(pathOrBuffer, opts);
  if (!wb.SheetNames.length) throw badRequest('File tidak punya sheet.');
  return wb;
}

export function readSheetMatrix(wb, sheetName) {
  const sheet = wb.Sheets[sheetName ?? wb.SheetNames[0]];
  if (!sheet) throw badRequest(`Sheet "${sheetName}" tidak ditemukan.`);
  return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: false });
}

/** Baris header = baris dengan sel terisi terbanyak di 10 baris pertama. */
export function guessHeaderRow(matrix) {
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(10, matrix.length); i++) {
    const filled = matrix[i].filter((c) => c !== null && String(c).trim() !== '').length;
    const textish = matrix[i].filter((c) => typeof c === 'string' && String(c).trim() !== '').length;
    const score = filled + textish;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

export function extractProfile(matrix, headerRowIndex) {
  const headers = (matrix[headerRowIndex] ?? []).map((h, i) =>
    h === null || String(h).trim() === '' ? `kolom_${i + 1}` : String(h).trim(),
  );
  const dataRows = matrix.slice(headerRowIndex + 1).filter((r) => r.some((c) => c !== null && String(c).trim() !== ''));

  const columns = headers.map((name, idx) => {
    // Dihitung dari SELURUH baris, bukan 200 pertama. File lapangan sering
    // diawali blok kosong atau baris rencana, sehingga sampel awal menyesatkan.
    const values = dataRows.map((r) => r[idx]).filter((v) => v !== null && String(v).trim() !== '');
    return {
      name,
      index: idx,
      nonEmpty: values.length,
      inferredType: inferType(values),
      distinctSample: [...new Set(values.map((v) => String(v)))].slice(0, 8),
    };
  });

  // Baris contoh dipilih yang paling banyak terisi, bukan yang paling atas.
  // Kalau sampel diambil dari baris kosong, AI akan menyimpulkan kolomnya
  // memang kosong dan pemetaannya jadi salah.
  const ranked = dataRows
    .map((r, i) => ({ r, i, filled: r.filter((c) => c !== null && String(c).trim() !== '').length }))
    .sort((a, b) => b.filled - a.filled || a.i - b.i)
    .slice(0, MAX_SAMPLE_ROWS)
    .sort((a, b) => a.i - b.i);

  return {
    headers,
    columns,
    totalRows: dataRows.length,
    sampleRows: ranked.map(({ r }) => headers.map((_, i) => normalizeCell(r[i]))),
    headerHash: hashHeaders(headers),
  };
}

/** Isi mentah beberapa baris pertama, apa adanya seperti yang dibaca parser. */
export function rawPreview(matrix, limit = 20) {
  return matrix.slice(0, limit).map((r) => r.map(normalizeCell));
}

function inferType(values) {
  if (values.length === 0) return 'empty';
  const isNum = values.every((v) => typeof v === 'number' || (typeof v === 'string' && /^-?[\d.,]+$/.test(v.trim())));
  if (isNum) return 'number';
  const isBool = values.every((v) => /^(true|false|ya|tidak|y|n|1|0)$/i.test(String(v).trim()));
  if (isBool) return 'boolean';
  const isDate = values.every((v) => v instanceof Date || /^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$/.test(String(v).trim()));
  if (isDate) return 'date';
  return 'string';
}

function normalizeCell(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return v;
}

export function hashHeaders(headers) {
  return createHash('sha256').update(headers.map((h) => h.toLowerCase().trim()).join('|')).digest('hex').slice(0, 32);
}

/**
 * Terapkan mapping yang sudah dikonfirmasi -> baris format panjang.
 * Semua logika ada di sini, deterministik, dan bisa diuji tanpa LLM.
 */
export function applyMapping(matrix, mapping) {
  const headers = (matrix[mapping.header_row_index] ?? []).map((h, i) =>
    h === null || String(h).trim() === '' ? `kolom_${i + 1}` : String(h).trim(),
  );

  // Pencocokan nama kolom dibuat toleran: beda spasi ganda, huruf besar-kecil,
  // atau spasi tak-terlihat di ujung sering terjadi pada header hasil ketik
  // manual. Tanpa ini, satu spasi berlebih membuat kolom tanggal tidak ketemu
  // dan SELURUH tanggal jadi kosong tanpa peringatan apa pun.
  const norm = (h) => String(h ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const headerIndex = new Map(headers.map((h, i) => [norm(h), i]));
  const idxOf = (name) => {
    if (!name) return -1;
    const exact = headerIndex.get(norm(name));
    if (exact !== undefined) return exact;
    // Cadangan terakhir: header yang salah satunya memuat yang lain.
    const n = norm(name);
    return headers.findIndex((h) => norm(h).includes(n) || n.includes(norm(h)));
  };
  const roleCol = (role) => mapping.columns.find((c) => c.role === role);

  // Kolom yang dirujuk mapping tapi tidak ada di berkas.
  const missingColumns = [];
  const checkColumn = (name, label) => {
    if (name && idxOf(name) < 0) missingColumns.push({ column: name, role: label });
  };
  for (const c of mapping.columns) {
    if (c.role !== 'ignore' && c.role !== 'detail') checkColumn(c.source_column, c.role);
  }
  for (const u of mapping.unpivot) checkColumn(u.source_column, 'metric_value');

  const dateIdx = idxOf(roleCol('tanggal')?.source_column ?? '');
  const geoIdx = idxOf(roleCol('geo_value')?.source_column ?? '');
  const costIdx = idxOf(roleCol('cost')?.source_column ?? '');
  const execIdx = idxOf(roleCol('is_executed')?.source_column ?? '');
  const metricNameIdx = idxOf(roleCol('metric_name')?.source_column ?? '');
  const metricValueCol = roleCol('metric_value');
  const metricValueIdx = idxOf(metricValueCol?.source_column ?? '');
  const detailIdx = mapping.columns.filter((c) => c.role === 'detail').map((c) => ({ name: c.source_column, idx: idxOf(c.source_column) }));
  const unpivot = mapping.unpivot.map((u) => ({ ...u, idx: idxOf(u.source_column) })).filter((u) => u.idx >= 0);

  const out = [];
  const issues = [];

  // Urutan hari/bulan ditentukan sekali untuk seluruh kolom, bukan per baris.
  const dateSamples = dateIdx >= 0
    ? matrix.slice(mapping.header_row_index + 1).map((r) => r[dateIdx])
    : [];
  const detected = detectDateOrder(dateSamples);
  const dateOrder = mapping.date_format === 'DMY' || mapping.date_format === 'MDY'
    ? mapping.date_format
    : detected === 'DMY' || detected === 'MDY' ? detected : 'MDY';

  matrix.slice(mapping.header_row_index + 1).forEach((row, n) => {
    const rowNo = mapping.header_row_index + n + 2;
    if (!row.some((c) => c !== null && String(c).trim() !== '')) return;
    if (!passesFilters(row, headers, mapping.row_filters)) return;

    const isExecuted = execIdx >= 0 ? parseBool(row[execIdx]) : true;
    const rawDate = dateIdx >= 0 ? row[dateIdx] : null;
    const tanggal = parseDate(rawDate, dateOrder);
    if (isExecuted && rawDate && !tanggal) {
      issues.push({ row: rowNo, field: 'tanggal', value: String(rawDate), message: 'Tanggal tidak bisa dibaca.' });
    }
    if (tanggal && (tanggal < '2015-01-01' || tanggal > '2100-01-01')) {
      issues.push({ row: rowNo, field: 'tanggal', value: tanggal, message: 'Tanggal di luar rentang wajar, kemungkinan salah ketik tahun.' });
    }

    const geo = geoIdx >= 0 ? String(row[geoIdx] ?? '').trim() : null;
    const cost = costIdx >= 0 ? parseNumber(row[costIdx]) ?? 0 : 0;
    const detail = Object.fromEntries(detailIdx.filter((d) => d.idx >= 0).map((d) => [d.name, row[d.idx] ?? null]));

    const base = { tanggal, geo_level: mapping.geo_level, geo_value: geo, cost, is_executed: isExecuted, detail };

    if (unpivot.length > 0) {
      for (const u of unpivot) {
        const value = parseNumber(row[u.idx]);
        if (value === null || value === 0) continue;
        out.push({ ...base, metric_name: u.metric_name, metric_value: value, unit: u.unit ?? 'pcs' });
      }
    } else if (metricValueIdx >= 0) {
      const value = parseNumber(row[metricValueIdx]);
      if (value !== null) {
        out.push({
          ...base,
          metric_name: metricNameIdx >= 0 ? String(row[metricNameIdx] ?? 'hasil') : metricValueCol?.metric_name ?? 'hasil',
          metric_value: value,
          unit: metricValueCol?.unit ?? 'pcs',
        });
      }
    }
  });

  // Peran wajib yang belum dipetakan sama sekali.
  const unassignedRoles = [];
  if (dateIdx < 0) unassignedRoles.push('tanggal');
  if (geoIdx < 0) unassignedRoles.push('geo_value');
  if (unpivot.length === 0 && metricValueIdx < 0) unassignedRoles.push('metric_value');

  return {
    rows: out,
    issues,
    missingColumns,
    unassignedRoles,
    dateFormat: {
      used: dateOrder,
      detected,
      // Ambigu berarti tidak ada satu pun nilai di kolom itu yang menyingkap
      // urutannya (semua hari maupun bulannya <= 12). Harus dipilih manusia.
      needsConfirmation: detected === 'ambiguous' && !mapping.date_format,
    },
  };
}

function passesFilters(row, headers, filters = []) {
  for (const f of filters) {
    const idx = headers.findIndex((h) => h === f.source_column);
    if (idx < 0) continue;
    const cell = row[idx] === null ? '' : String(row[idx]).trim();
    if (f.op === 'equals' && cell.toLowerCase() !== String(f.value ?? '').toLowerCase()) return false;
    if (f.op === 'not_equals' && cell.toLowerCase() === String(f.value ?? '').toLowerCase()) return false;
    if (f.op === 'not_empty' && cell === '') return false;
    if (f.op === 'is_empty' && cell !== '') return false;
  }
  return true;
}

export function parseBool(v) {
  if (typeof v === 'boolean') return v;
  return /^(true|ya|y|1|selesai|done)$/i.test(String(v ?? '').trim());
}

export function parseNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Menerima Date, serial Excel, YYYYMMDD, YYYY-MM-DD, dan d/m/YYYY.
 * `order` menentukan pembacaan bentuk d/m: 'MDY' (default) atau 'DMY'.
 */
export function parseDate(v, order = 'MDY') {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(+v) ? null : v.toISOString().slice(0, 10);
  // 8 digit = YYYYMMDD (dipakai di feed postpaid: 20260526). Dicek lebih dulu
  // supaya tidak salah dibaca sebagai nomor seri Excel.
  if (typeof v === 'number' && v >= 19000101 && v <= 29991231) {
    const s8 = String(Math.trunc(v));
    return `${s8.slice(0, 4)}-${s8.slice(4, 6)}-${s8.slice(6, 8)}`;
  }
  if (typeof v === 'number') {
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
    return Number.isNaN(+d) ? null : d.toISOString().slice(0, 10);
  }
  // Kolom stempel waktu ("2026-08-02 19:39:01") diperlakukan sebagai tanggal:
  // bagian jamnya dibuang. Tanpa ini seluruh baris ditolak padahal tanggalnya
  // jelas terbaca.
  const s = stripTime(String(v).trim());
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 4 ? m[3] : `20${m[3].padStart(2, '0')}`;
    const [month, day] = order === 'DMY' ? [m[2], m[1]] : [m[1], m[2]];
    if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return null;
    return `${year}-${pad(month)}-${pad(day)}`;
  }
  return null;
}

/**
 * Tebak urutan hari/bulan sebuah kolom tanggal dari SELURUH nilainya.
 *
 * '4/25/2026' pasti bulan-dulu karena 25 bukan bulan. '5/6/2026' sendirian
 * tidak bisa dipastikan -- tapi kalau di kolom yang sama ada satu saja nilai
 * yang menyingkap urutannya, seluruh kolom ikut terjawab. Ini penting karena
 * salah tebak tidak memunculkan error apa pun: tanggalnya cuma pindah bulan
 * tanpa ada yang sadar.
 *
 * Mengembalikan: 'MDY' | 'DMY' | 'ambiguous' | 'none'
 */
export function detectDateOrder(values) {
  let firstOver12 = 0;
  let secondOver12 = 0;
  let slashCount = 0;

  for (const v of values) {
    if (v instanceof Date || typeof v === 'number') continue;
    const m = stripTime(String(v ?? '').trim()).match(/^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}$/);
    if (!m) continue;
    slashCount++;
    if (Number(m[1]) > 12) firstOver12++;
    if (Number(m[2]) > 12) secondOver12++;
  }

  if (slashCount === 0) return 'none';
  if (firstOver12 && secondOver12) return 'ambiguous'; // saling bertentangan
  if (firstOver12) return 'DMY';
  if (secondOver12) return 'MDY';
  return 'ambiguous'; // semua nilai <= 12, tidak ada yang menyingkap urutan
}

const pad = (s) => String(s).padStart(2, '0');

/** Buang komponen jam dari string tanggal, termasuk bentuk ISO dan AM/PM. */
function stripTime(s) {
  return s
    .replace(/[T\s]+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(AM|PM|am|pm)?\s*(Z|[+-]\d{2}:?\d{2})?$/, '')
    .trim();
}