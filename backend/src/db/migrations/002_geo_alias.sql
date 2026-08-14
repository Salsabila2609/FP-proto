-- Nama wilayah di Excel lapangan ("JEMBER") jarang persis sama dengan nilai di
-- dim_territory ("SA-Jember"). Padanan yang sudah dikonfirmasi disimpan di sini
-- supaya tidak perlu ditebak ulang tiap upload.
CREATE TABLE IF NOT EXISTS geo_alias (
  id           VARCHAR PRIMARY KEY,
  alias        VARCHAR NOT NULL,
  geo_level    VARCHAR NOT NULL,
  geo_value    VARCHAR NOT NULL,
  confirmed_by VARCHAR,
  created_at   TIMESTAMP NOT NULL DEFAULT now()
);

CREATE OR REPLACE VIEW v_trx_prepaid AS
SELECT
  f.tanggal,
  f.trx_category,
  f.transaction_type,
  COALESCE(t.region_name, f.region_name)         AS region_name,
  COALESCE(t.area_name, f.area_name)             AS area_name,
  COALESCE(t.sales_area_name, f.sales_area_name) AS sales_area_name,
  COALESCE(t.cluster_name, f.cluster_name)       AS cluster_name,
  t.kabkot_nm,
  t.kecamatan_nm,
  f.organization_id AS outlet,
  f.brand,
  f.channel,
  f.jumlah_transaksi,
  f.total_revenue
FROM fact_trx_prepaid f
LEFT JOIN dim_territory t ON f.organization_id = t.outlet_code;
