-- Tabel sumber `stg.cashback` menyediakan brand dan kecamatan. Keduanya ikut
-- ditarik karena market share berlevel kecamatan, sedangkan cashback adalah
-- sisi biayanya -- tanpa kolom ini keduanya tidak bisa dipertemukan.
ALTER TABLE fact_cashback ADD COLUMN IF NOT EXISTS brand VARCHAR;
ALTER TABLE fact_cashback ADD COLUMN IF NOT EXISTS kecamatan_nm VARCHAR;
ALTER TABLE fact_cashback ADD COLUMN IF NOT EXISTS kabkot_nm VARCHAR;