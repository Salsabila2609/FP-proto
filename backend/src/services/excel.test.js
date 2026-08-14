import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, parseNumber, parseBool, applyMapping, detectDateOrder } from './excel.service.js';

test('parseDate menerima serial Excel, M/D/YYYY, dan ISO', () => {
  assert.equal(parseDate('4/25/2026'), '2026-04-25');
  assert.equal(parseDate('2026-06-17'), '2026-06-17');
  assert.equal(parseDate(45000), '2023-03-15');
  assert.equal(parseDate(''), null);
  // Format feed postpaid: 8 digit, bukan nomor seri Excel.
  assert.equal(parseDate('20260526'), '2026-05-26');
  assert.equal(parseDate(20260526), '2026-05-26');
});

test('parseNumber membersihkan pemisah ribuan gaya Indonesia', () => {
  assert.equal(parseNumber('1.250'), 1250);
  assert.equal(parseNumber('12,5'), 12.5);
  assert.equal(parseNumber('Rp 300.000'), 300000);
  // Feed postpaid memakai koma desimal untuk nilai revenue.
  assert.equal(parseNumber('0,101351351'), 0.101351351);
  assert.equal(parseNumber('16.555.000'), 16555000);
});

test('parseBool memperlakukan TRUE/ya/1 sebagai terlaksana', () => {
  assert.equal(parseBool('TRUE'), true);
  assert.equal(parseBool('FALSE'), false);
  assert.equal(parseBool(''), false);
});

test('applyMapping meng-unpivot kolom SP dan membuang baris belum terlaksana', () => {
  const matrix = [
    ['NO', 'BRANCH', 'TANGGAL', 'STATUS', 'SP 3GB', 'SP 5GB'],
    [1, 'JEMBER', '4/25/2026', 'TRUE', 600, null],
    [2, 'JEMBER', '5/5/2026', 'TRUE', 150, 20],
    [3, 'JEMBER', null, 'FALSE', null, null],
  ];
  const mapping = {
    header_row_index: 0,
    geo_level: 'sales_area',
    division: 'marcomm',
    category: 'acquisition',
    columns: [
      { source_column: 'TANGGAL', role: 'tanggal' },
      { source_column: 'BRANCH', role: 'geo_value' },
      { source_column: 'STATUS', role: 'is_executed' },
      { source_column: 'NO', role: 'detail' },
    ],
    unpivot: [
      { source_column: 'SP 3GB', metric_name: 'sp_3gb', unit: 'pcs' },
      { source_column: 'SP 5GB', metric_name: 'sp_5gb', unit: 'pcs' },
    ],
    row_filters: [],
    warnings: [],
  };

  const { rows } = applyMapping(matrix, mapping);
  assert.equal(rows.length, 3);
  assert.equal(rows.filter((r) => r.is_executed).length, 3);
  assert.equal(rows[0].metric_name, 'sp_3gb');
  assert.equal(rows[0].metric_value, 600);
});

test('applyMapping menandai tahun yang tidak masuk akal', () => {
  const matrix = [
    ['TANGGAL', 'BRANCH', 'STATUS', 'SP 3GB'],
    ['9/2/0206', 'JEMBER', 'TRUE', 10],
  ];
  const { issues } = applyMapping(matrix, {
    header_row_index: 0, geo_level: 'sales_area', division: 'marcomm', category: 'acquisition',
    columns: [
      { source_column: 'TANGGAL', role: 'tanggal' },
      { source_column: 'BRANCH', role: 'geo_value' },
      { source_column: 'STATUS', role: 'is_executed' },
    ],
    unpivot: [{ source_column: 'SP 3GB', metric_name: 'sp_3gb' }],
    row_filters: [], warnings: [],
  });
  assert.ok(issues.length >= 1);
});

test('detectDateOrder memakai satu nilai penyingkap untuk seluruh kolom', () => {
  // 25 tidak mungkin bulan -> kolomnya pasti bulan-dulu
  assert.equal(detectDateOrder(['4/25/2026', '5/6/2026']), 'MDY');
  // 25 di posisi pertama -> hari-dulu
  assert.equal(detectDateOrder(['25/4/2026', '5/6/2026']), 'DMY');
  // tidak ada yang menyingkap urutan -> harus dikonfirmasi manusia
  assert.equal(detectDateOrder(['5/6/2026', '7/8/2026']), 'ambiguous');
  // saling bertentangan, campur dua format dalam satu kolom
  assert.equal(detectDateOrder(['25/4/2026', '4/25/2026']), 'ambiguous');
  assert.equal(detectDateOrder(['2026-04-25']), 'none');
});

test('parseDate menghormati urutan yang diminta', () => {
  assert.equal(parseDate('5/6/2026', 'MDY'), '2026-05-06');
  assert.equal(parseDate('5/6/2026', 'DMY'), '2026-06-05');
  // bulan 25 tidak valid, jadi ditolak alih-alih menghasilkan tanggal ngawur
  assert.equal(parseDate('4/25/2026', 'DMY'), null);
});

test('applyMapping melaporkan format tanggal yang dipakai', () => {
  const matrix = [
    ['TANGGAL', 'BRANCH', 'STATUS', 'SP 3GB'],
    ['4/25/2026', 'JEMBER', 'TRUE', 600],
    ['5/6/2026', 'JEMBER', 'TRUE', 100],
  ];
  const { rows, dateFormat } = applyMapping(matrix, {
    header_row_index: 0, geo_level: 'sales_area', division: 'marcomm', category: 'acquisition',
    columns: [
      { source_column: 'TANGGAL', role: 'tanggal' },
      { source_column: 'BRANCH', role: 'geo_value' },
      { source_column: 'STATUS', role: 'is_executed' },
    ],
    unpivot: [{ source_column: 'SP 3GB', metric_name: 'sp_3gb' }],
    row_filters: [], warnings: [],
  });
  assert.equal(dateFormat.detected, 'MDY');
  assert.equal(dateFormat.needsConfirmation, false);
  assert.equal(rows[1].tanggal, '2026-05-06');
});

test('applyMapping melaporkan kolom yang tidak ketemu, bukan diam-diam mengosongkan tanggal', () => {
  const matrix = [
    ['TANGGAL  PELAKSANAAN MM/DD/YYYY', 'BRANCH', 'STATUS', 'SP 3GB'],
    ['4/25/2026', 'JEMBER', 'TRUE', 600],
  ];
  const base = {
    header_row_index: 0, geo_level: 'sales_area', division: 'marcomm', category: 'acquisition',
    columns: [
      { source_column: 'BRANCH', role: 'geo_value' },
      { source_column: 'STATUS', role: 'is_executed' },
    ],
    unpivot: [{ source_column: 'SP 3GB', metric_name: 'sp_3gb' }],
    row_filters: [], warnings: [],
  };

  // Peran tanggal belum dipetakan sama sekali
  const a = applyMapping(matrix, base);
  assert.ok(a.unassignedRoles.includes('tanggal'));
  assert.equal(a.rows[0].tanggal, null);

  // Nama kolom beda spasi ganda -> tetap harus ketemu
  const b = applyMapping(matrix, {
    ...base,
    columns: [...base.columns, { source_column: 'TANGGAL PELAKSANAAN MM/DD/YYYY', role: 'tanggal' }],
  });
  assert.deepEqual(b.missingColumns, []);
  assert.equal(b.rows[0].tanggal, '2026-04-25');

  // Nama kolom yang benar-benar tidak ada -> dilaporkan
  const c = applyMapping(matrix, {
    ...base,
    columns: [...base.columns, { source_column: 'ZZZ_TIDAK_ADA', role: 'tanggal' }],
  });
  assert.equal(c.missingColumns.length, 1);
});

test('parseDate membuang komponen jam dari kolom stempel waktu', () => {
  assert.equal(parseDate('2026-08-02 19:39:01'), '2026-08-02');
  assert.equal(parseDate('2026-08-03T13:56:53'), '2026-08-03');
  assert.equal(parseDate('2026-08-03T13:56:53.000Z'), '2026-08-03');
  assert.equal(parseDate('4/25/2026 09:15'), '2026-04-25');
  assert.equal(parseDate('4/25/2026 9:15 PM'), '2026-04-25');
  // deteksi urutan tetap jalan walau ada jam
  assert.equal(detectDateOrder(['4/25/2026 09:15', '5/6/2026 10:00']), 'MDY');
});