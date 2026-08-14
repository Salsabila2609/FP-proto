-- ============================================================
-- 001_init -- skema dasar
-- ============================================================

-- ---------- pengguna & audit ----------
CREATE TABLE IF NOT EXISTS app_user (
  id            VARCHAR PRIMARY KEY,
  email         VARCHAR NOT NULL UNIQUE,
  name          VARCHAR,
  password_hash VARCHAR NOT NULL,
  role          VARCHAR NOT NULL DEFAULT 'viewer',   -- viewer | analyst | admin
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         VARCHAR PRIMARY KEY,
  user_id    VARCHAR,
  action     VARCHAR NOT NULL,
  target     VARCHAR,
  detail     JSON,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- ---------- dimensi wilayah (satu-satunya sumber kebenaran) ----------
CREATE TABLE IF NOT EXISTS dim_territory (
  outlet_code     VARCHAR PRIMARY KEY,
  region_name     VARCHAR,
  area_name       VARCHAR,
  sub_area_name   VARCHAR,
  sales_area_name VARCHAR,
  cluster_name    VARCHAR,
  kabkot_nm       VARCHAR,
  kecamatan_nm    VARCHAR,
  channel         VARCHAR,
  brand           VARCHAR,
  snapshot_date   DATE
);

-- ---------- fakta dari BigQuery ----------
CREATE TABLE IF NOT EXISTS fact_trx_prepaid (
  tanggal           DATE NOT NULL,
  transaction_type  VARCHAR,
  trx_category      VARCHAR,        -- SP | Rebuy | Vou, hasil mapping lokal
  region_name       VARCHAR,
  area_name         VARCHAR,
  sales_area_name   VARCHAR,
  cluster_name      VARCHAR,
  organization_id   VARCHAR,
  organization_name VARCHAR,
  product_name      VARCHAR,
  channel           VARCHAR,
  brand             VARCHAR,
  jumlah_transaksi  BIGINT,
  total_revenue     DOUBLE
);

CREATE TABLE IF NOT EXISTS fact_cashback (
  tanggal         DATE NOT NULL,
  area_name       VARCHAR,
  sales_area_name VARCHAR,
  cluster_name    VARCHAR,
  outlet_code     VARCHAR,
  outlet_name     VARCHAR,
  cashback_type   VARCHAR,
  cashback        DOUBLE
);

CREATE TABLE IF NOT EXISTS fact_stock_balance (
  tanggal         DATE NOT NULL,
  outlet_code     VARCHAR,
  outlet_name     VARCHAR,
  region_name     VARCHAR,
  sub_area_name   VARCHAR,
  sales_area_name VARCHAR,
  brand           VARCHAR,
  amount          DOUBLE
);

CREATE TABLE IF NOT EXISTS fact_allocation (
  tanggal         DATE NOT NULL,
  brand           VARCHAR,
  outlet_code     VARCHAR,
  region_name     VARCHAR,
  sub_area_name   VARCHAR,
  sales_area_name VARCHAR,
  daily_amount    DOUBLE
);

CREATE TABLE IF NOT EXISTS fact_marketshare (
  tanggal        DATE NOT NULL,
  month_id       VARCHAR,
  region_name    VARCHAR,
  area_name      VARCHAR,
  sales_area_name VARCHAR,
  kabkot_nm      VARCHAR,
  kecamatan_nm   VARCHAR,
  operator       VARCHAR,
  total_base_ori DOUBLE,
  base_share_pct DOUBLE,
  total_ga_ori   DOUBLE,
  ga_share_pct   DOUBLE
);

-- ---------- catatan sinkronisasi ----------
CREATE TABLE IF NOT EXISTS sync_run (
  id          VARCHAR PRIMARY KEY,
  table_key   VARCHAR NOT NULL,
  partition_value VARCHAR NOT NULL,
  status      VARCHAR NOT NULL,          -- sukses | gagal
  row_count   BIGINT DEFAULT 0,
  bytes_billed BIGINT DEFAULT 0,
  duration_ms BIGINT,
  error       VARCHAR,
  triggered_by VARCHAR,
  created_at  TIMESTAMP NOT NULL DEFAULT now()
);

-- ---------- program (skema kanonik) ----------
CREATE TABLE IF NOT EXISTS program (
  id            VARCHAR PRIMARY KEY,
  name          VARCHAR NOT NULL,
  division      VARCHAR NOT NULL,        -- prepaid_snd | marcomm | postpaid
  category      VARCHAR NOT NULL,        -- acquisition | arpu | loyalty | visibility | partnership
  brand         VARCHAR,
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,
  cost_total    DOUBLE DEFAULT 0,
  geo_level     VARCHAR NOT NULL,        -- region | area | sales_area | cluster | kecamatan | outlet
  description   VARCHAR,
  source_upload_id VARCHAR,
  created_by    VARCHAR,
  created_at    TIMESTAMP NOT NULL DEFAULT now()
);

-- Format panjang: apapun bentuk Excel aslinya, hasilnya selalu satu baris
-- per (program, tanggal, geo, metrik). Ini yang bikin program dari tiga divisi
-- bisa dibandingkan tanpa maksa mereka pakai kolom yang sama.
CREATE TABLE IF NOT EXISTS program_result (
  id           VARCHAR PRIMARY KEY,
  program_id   VARCHAR NOT NULL,
  tanggal      DATE,
  geo_level    VARCHAR,
  geo_value    VARCHAR,
  metric_name  VARCHAR NOT NULL,
  metric_value DOUBLE,
  unit         VARCHAR,
  cost         DOUBLE DEFAULT 0,
  is_executed  BOOLEAN NOT NULL DEFAULT TRUE,
  detail       JSON
);

-- ---------- upload & mapping ----------
CREATE TABLE IF NOT EXISTS upload_file (
  id            VARCHAR PRIMARY KEY,
  original_name VARCHAR NOT NULL,
  stored_path   VARCHAR NOT NULL,
  sheet_name    VARCHAR,
  header_hash   VARCHAR,
  size_bytes    BIGINT,
  status        VARCHAR NOT NULL DEFAULT 'pending', -- pending | mapped | committed | rejected
  uploaded_by   VARCHAR,
  created_at    TIMESTAMP NOT NULL DEFAULT now()
);

-- Mapping yang sudah dikonfirmasi manusia, dipakai ulang otomatis untuk file
-- dengan susunan header yang sama.
CREATE TABLE IF NOT EXISTS mapping_template (
  id           VARCHAR PRIMARY KEY,
  header_hash  VARCHAR NOT NULL UNIQUE,
  label        VARCHAR,
  division     VARCHAR,
  mapping      JSON NOT NULL,
  confirmed_by VARCHAR,
  created_at   TIMESTAMP NOT NULL DEFAULT now(),
  updated_at   TIMESTAMP NOT NULL DEFAULT now()
);

-- ---------- hasil evaluasi ----------
CREATE TABLE IF NOT EXISTS evaluation (
  id           VARCHAR PRIMARY KEY,
  program_id   VARCHAR NOT NULL,
  recipe       VARCHAR NOT NULL,
  status       VARCHAR NOT NULL,       -- ok | skipped | error
  skip_reason  VARCHAR,
  metrics      JSON,
  confidence   VARCHAR,                -- high | medium | low
  computed_at  TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS insight (
  id           VARCHAR PRIMARY KEY,
  program_id   VARCHAR,
  scope        VARCHAR NOT NULL,       -- program | comparison
  input_hash   VARCHAR NOT NULL,
  narrative    VARCHAR,
  model        VARCHAR,
  created_at   TIMESTAMP NOT NULL DEFAULT now()
);

-- ---------- job latar ----------
CREATE TABLE IF NOT EXISTS job (
  id          VARCHAR PRIMARY KEY,
  kind        VARCHAR NOT NULL,
  status      VARCHAR NOT NULL,        -- queued | running | done | failed
  payload     JSON,
  progress    JSON,
  result      JSON,
  error       VARCHAR,
  created_by  VARCHAR,
  created_at  TIMESTAMP NOT NULL DEFAULT now(),
  updated_at  TIMESTAMP NOT NULL DEFAULT now()
);
