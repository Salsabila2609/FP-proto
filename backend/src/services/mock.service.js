import { REGIONS, TRANSACTION_TYPES, TRANSACTION_CATEGORY } from '../registry/regions.js';

// Dipakai saat GCP_PROJECT_ID kosong, supaya UI dan resep evaluasi bisa
// dikembangkan tanpa akses produksi. Datanya sengaja punya tren berbeda per
// sales area, jadi perhitungan uplift menghasilkan angka yang tidak seragam.
const SALES_AREAS = {
  'EAST JAVA': ['SA-Surabaya', 'SA-Malang', 'SA-Jember'],
  'CENTRAL JAVA': ['SA-Semarang', 'SA-Solo'],
  'BALI NUSRA': ['SA-Denpasar', 'SA-Mataram'],
};
const BIAS = { 'SA-Surabaya': 1.18, 'SA-Malang': 0.9, 'SA-Jember': 1.05, 'SA-Semarang': 1.0, 'SA-Solo': 0.95, 'SA-Denpasar': 1.12, 'SA-Mataram': 0.88 };

function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507)) >>> 0) / 4294967296;
}

export function mockRows(tableKey, partitionValue) {
  const rnd = seeded(tableKey + partitionValue);
  const rows = [];
  const dayIndex = Math.floor(new Date(partitionValue + (partitionValue.length === 7 ? '-01' : '')).getTime() / 86400000);

  for (const region of REGIONS) {
    for (const sa of SALES_AREAS[region]) {
      for (let outlet = 1; outlet <= 6; outlet++) {
        const code = `${sa.slice(3, 6).toUpperCase()}${1000 + outlet}`;
        const trend = Math.pow(BIAS[sa], (dayIndex % 90) / 30);
        if (tableKey === 'trx_prepaid') {
          for (const type of TRANSACTION_TYPES.slice(0, 5)) {
            rows.push({
              tanggal: partitionValue, transaction_type: type,
              trx_category: TRANSACTION_CATEGORY[type],
              region_name: region, area_name: `${region} AREA`, sales_area_name: sa,
              cluster_name: `${sa}-C${outlet % 3}`, organization_id: code,
              organization_name: `Outlet ${code}`, product_name: `P-${500 + (outlet % 6)}`,
              channel: 'Traditional', brand: outlet % 2 ? 'IM3' : '3ID',
              jumlah_transaksi: Math.round(5 + rnd() * 40),
              total_revenue: Math.round((50000 + rnd() * 900000) * trend),
            });
          }
        } else if (tableKey === 'cashback') {
          rows.push({
            tanggal: partitionValue, area_name: `${region} AREA`, sales_area_name: sa,
            cluster_name: `${sa}-C${outlet % 3}`, outlet_code: code, outlet_name: `Outlet ${code}`,
            cashback_type: rnd() > 0.5 ? 'PROGRAM SP BOOSTER' : 'PROGRAM REBUY GOLD',
            cashback: Math.round(20000 + rnd() * 300000),
          });
        } else if (tableKey === 'stock_balance') {
          rows.push({ tanggal: partitionValue, outlet_code: code, outlet_name: `Outlet ${code}`, region_name: region, sub_area_name: `${region} SUB`, sales_area_name: sa, brand: '3ID', amount: Math.round(1e6 + rnd() * 9e6) });
        } else if (tableKey === 'allocation') {
          rows.push({ tanggal: partitionValue, brand: '3ID', outlet_code: code, region_name: region, sub_area_name: `${region} SUB`, sales_area_name: sa, daily_amount: Math.round(5e5 + rnd() * 5e6) });
        } else if (tableKey === 'territory') {
          rows.push({ outlet_code: code, region_name: region, area_name: `${region} AREA`, sub_area_name: `${region} SUB`, sales_area_name: sa, cluster_name: `${sa}-C${outlet % 3}`, kabkot_nm: `KAB ${sa.slice(3)}`, kecamatan_nm: `KEC ${sa.slice(3)} ${outlet}`, channel: 'Traditional', brand: 'IM3' });
        }
      }
      if (tableKey === 'marketshare') {
        for (const op of ['IOH', 'TSEL', 'XL', 'SF']) {
          const share = op === 'IOH' ? 28 + rnd() * 8 : 15 + rnd() * 15;
          rows.push({ tanggal: `${partitionValue}-01`, month_id: partitionValue.replace('-', ''), region_name: region, area_name: `${region} AREA`, sales_area_name: sa, kabkot_nm: `KAB ${sa.slice(3)}`, kecamatan_nm: `KEC ${sa.slice(3)} 1`, operator: op, total_base_ori: Math.round(1e4 + rnd() * 5e4), base_share_pct: Number(share.toFixed(2)), total_ga_ori: Math.round(500 + rnd() * 3000), ga_share_pct: Number((share + (rnd() - 0.5) * 4).toFixed(2)) });
        }
      }
    }
  }
  return rows;
}
