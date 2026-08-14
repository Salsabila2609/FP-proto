-- ============================================================
-- 004 -- sumber berkas (OneDrive) + program sebagai filter populasi
-- ============================================================

-- Penjualan postpaid harian, SUDAH TERAGREGASI dan TANPA DATA PRIBADI.
-- File sumbernya berisi msisdn, nama pelanggan, NIK, NPWP, dan alamat. Kolom
-- itu tidak pernah masuk ke sini: agregasi dilakukan saat muat, jadi salinan
-- data pribadi tidak pernah tersimpan di luar sumber aslinya. Lihat
-- registry/fileSources.js -- daftar kolom yang boleh disimpan bersifat
-- allowlist, dan proses muat menolak jalan kalau ada kolom PII di dalamnya.
CREATE TABLE IF NOT EXISTS fact_postpaid_sales (
  tanggal        DATE NOT NULL,
  package_name   VARCHAR,
  package_group  VARCHAR,
  package_type   VARCHAR,      -- Contract | Non Contract
  order_type     VARCHAR,      -- New Registration | Change Postpaid Plan
  tenure         INTEGER,
  region_name    VARCHAR,
  area_name      VARCHAR,
  sales_area_name VARCHAR,
  branch_name    VARCHAR,
  channel        VARCHAR,
  store_name     VARCHAR,
  agent_type     VARCHAR,
  ga_count       BIGINT,
  acq_revenue    DOUBLE,
  guaranteed_revenue DOUBLE
);

-- Catatan pemuatan berkas, sejajar dengan sync_run untuk BigQuery.
CREATE TABLE IF NOT EXISTS file_source_run (
  id          VARCHAR PRIMARY KEY,
  source_key  VARCHAR NOT NULL,
  status      VARCHAR NOT NULL,
  row_count   BIGINT DEFAULT 0,
  file_hash   VARCHAR,
  duration_ms BIGINT,
  error       VARCHAR,
  triggered_by VARCHAR,
  created_at  TIMESTAMP NOT NULL DEFAULT now()
);

-- Sebuah program bisa didefinisikan dengan dua cara:
--   1. hasilnya diunggah  -> baris di program_result (marcomm)
--   2. sebagai FILTER      -> population_filter di sini (postpaid, prepaid)
-- Cara kedua tidak butuh unggahan hasil sama sekali: populasinya dipilih dari
-- tabel dasar, dan periode sebelum/sesudah dibandingkan pada populasi itu.
ALTER TABLE program ADD COLUMN IF NOT EXISTS base_table VARCHAR;
ALTER TABLE program ADD COLUMN IF NOT EXISTS population_filter JSON;
ALTER TABLE program ADD COLUMN IF NOT EXISTS target_value DOUBLE;
ALTER TABLE program ADD COLUMN IF NOT EXISTS proposal_note VARCHAR;