import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Panel, Notice, Empty, fmt } from '../components/ui.jsx';

const OPS = [
  { op: 'contains', label: 'mengandung' },
  { op: 'equals', label: 'sama dengan' },
  { op: 'starts_with', label: 'diawali' },
  { op: 'in', label: 'salah satu dari' },
  { op: 'gte', label: '≥' },
  { op: 'lte', label: '≤' },
];

/**
 * Untuk program yang tidak punya file hasil sendiri -- postpaid. Datanya satu
 * tabel penjualan harian; programnya didefinisikan sebagai filter di atasnya.
 * Pratinjau dijalankan sebelum menyimpan supaya filter yang tidak menangkap
 * apa-apa ketahuan di sini, bukan setelah dievaluasi.
 */
export default function DefineProgram({ onCreated }) {
  const [baseTables, setBaseTables] = useState([]);
  const [baseTable, setBaseTable] = useState('fact_postpaid_sales');
  const [filters, setFilters] = useState([{ column: 'package_name', op: 'contains', value: '' }]);
  const [values, setValues] = useState({});
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [program, setProgram] = useState({
    name: '', division: 'postpaid', category: 'acquisition',
    period_start: '', period_end: '', cost_total: 0, target_value: '', proposal_note: '',
  });

  useEffect(() => {
    api.baseTables().then((r) => setBaseTables(r.baseTables)).catch((e) => setError(e.message));
  }, []);

  const spec = baseTables.find((b) => b.key === baseTable);

  async function loadValues(column) {
    if (values[column]) return;
    try {
      const r = await api.baseTableValues(baseTable, column);
      setValues((v) => ({ ...v, [column]: r.values }));
    } catch { /* dropdown tetap bisa diketik manual */ }
  }

  async function runPreview() {
    setBusy('preview'); setError(null);
    try {
      setPreview(await api.previewPopulation({
        baseTable,
        filters: cleanFilters(filters),
        periodStart: program.period_start,
        periodEnd: program.period_end,
      }));
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  async function save() {
    setBusy('save'); setError(null);
    try {
      const res = await api.createPopulationProgram({
        program: {
          ...program,
          cost_total: Number(program.cost_total) || 0,
          target_value: program.target_value === '' ? undefined : Number(program.target_value),
          base_table: baseTable,
        },
        filters: cleanFilters(filters),
      });
      onCreated?.(res.programId);
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  const setFilter = (i, patch) => setFilters((f) => f.map((x, n) => (n === i ? { ...x, ...patch } : x)));
  const canPreview = program.period_start && program.period_end && cleanFilters(filters).length > 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Definisikan program</h1>
          <p>Untuk program yang tidak punya file hasil sendiri. Datanya sudah ada di satu tabel penjualan; program dikenali dari paket, channel, dan periodenya. Cocok untuk postpaid.</p>
        </div>
      </div>

      {error && <Notice kind="error">{error}</Notice>}

      <Panel title="1. Sumber dan kondisi" subtitle="Baris yang memenuhi SEMUA kondisi di bawah dianggap terkena program.">
        <div className="row" style={{ marginBottom: 16 }}>
          <label className="field">Tabel dasar
            <select value={baseTable} onChange={(e) => { setBaseTable(e.target.value); setPreview(null); }}>
              {baseTables.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
            </select>
          </label>
        </div>

        <table>
          <thead><tr><th>Kolom</th><th>Operator</th><th>Nilai</th><th /></tr></thead>
          <tbody>
            {filters.map((f, i) => (
              <tr key={i}>
                <td>
                  <select value={f.column} onChange={(e) => { setFilter(i, { column: e.target.value, value: '' }); loadValues(e.target.value); }}>
                    {(spec?.filterable ?? []).map((c) => <option key={c}>{c}</option>)}
                  </select>
                </td>
                <td>
                  <select value={f.op} onChange={(e) => setFilter(i, { op: e.target.value })}>
                    {OPS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
                  </select>
                </td>
                <td>
                  <input
                    list={`vals-${f.column}`}
                    value={Array.isArray(f.value) ? f.value.join(', ') : f.value}
                    onFocus={() => loadValues(f.column)}
                    onChange={(e) => setFilter(i, { value: f.op === 'in' ? e.target.value.split(',').map((s) => s.trim()).filter(Boolean) : e.target.value })}
                    placeholder={f.op === 'in' ? 'pisahkan dengan koma' : 'ketik atau pilih'}
                    style={{ minWidth: 260 }}
                  />
                  <datalist id={`vals-${f.column}`}>
                    {(values[f.column] ?? []).map((v) => <option key={v.value} value={v.value}>{`${v.value} (${v.rows_count})`}</option>)}
                  </datalist>
                </td>
                <td className="num">
                  {filters.length > 1 && <button className="btn" onClick={() => setFilters((x) => x.filter((_, n) => n !== i))}>Hapus</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <button className="btn" style={{ marginTop: 12 }} onClick={() => setFilters((f) => [...f, { column: spec?.filterable[0] ?? 'package_name', op: 'contains', value: '' }])}>
          Tambah kondisi
        </button>
      </Panel>

      <Panel
        title="2. Periode dan biaya"
        actions={<button className="btn primary" onClick={runPreview} disabled={!canPreview || busy}>{busy === 'preview' ? 'Menghitung…' : 'Pratinjau populasi'}</button>}
      >
        <div className="row">
          <label className="field" style={{ flex: '1 1 240px' }}>Nama program
            <input value={program.name} onChange={(e) => setProgram({ ...program, name: e.target.value })} placeholder="Booster Platinum 50-3 Franchise" />
          </label>
          <label className="field">Mulai<input type="date" value={program.period_start} onChange={(e) => setProgram({ ...program, period_start: e.target.value })} /></label>
          <label className="field">Selesai<input type="date" value={program.period_end} onChange={(e) => setProgram({ ...program, period_end: e.target.value })} /></label>
          <label className="field">Budget (Rp)<input type="number" min="0" value={program.cost_total} onChange={(e) => setProgram({ ...program, cost_total: e.target.value })} /></label>
          <label className="field">Target hasil<input type="number" min="0" value={program.target_value} onChange={(e) => setProgram({ ...program, target_value: e.target.value })} placeholder="2021" /></label>
          <label className="field">Kategori
            <select value={program.category} onChange={(e) => setProgram({ ...program, category: e.target.value })}>
              <option value="acquisition">acquisition</option>
              <option value="arpu">arpu</option>
              <option value="loyalty">loyalty</option>
              <option value="partnership">partnership</option>
            </select>
          </label>
        </div>
      </Panel>

      {preview && (
        <Panel
          title="3. Pratinjau"
          subtitle="Angka ini datang dari data sungguhan, bukan perkiraan. Kalau ada peringatan di bawah, perbaiki filternya dulu."
          actions={<button className="btn primary" onClick={save} disabled={busy || !program.name || preview.treated_post === 0}>{busy === 'save' ? 'Menyimpan…' : 'Simpan program'}</button>}
        >
          {preview.warnings.map((w, i) => <Notice key={i} kind={preview.treated_post === 0 ? 'error' : 'warn'}>{w}</Notice>)}

          <table>
            <thead><tr><th>Populasi</th><th className="num">Sebelum</th><th className="num">Selama program</th><th className="num">Pertumbuhan</th></tr></thead>
            <tbody>
              <tr>
                <td style={{ fontWeight: 500 }}>Kena program</td>
                <td className="num">{fmt.int(preview.treated_pre)}</td>
                <td className="num">{fmt.int(preview.treated_post)}</td>
                <td className="num">{preview.treated_growth_pct === null ? '—' : fmt.pct(preview.treated_growth_pct)}</td>
              </tr>
              <tr>
                <td>Pembanding (sisa tabel)</td>
                <td className="num">{fmt.int(preview.control_pre)}</td>
                <td className="num">{fmt.int(preview.control_post)}</td>
                <td className="num">{preview.control_growth_pct === null ? '—' : fmt.pct(preview.control_growth_pct)}</td>
              </tr>
            </tbody>
          </table>

          <p className="stat-note" style={{ marginTop: 12 }}>
            Periode sebelum otomatis diambil sepanjang durasi program, tepat sebelum tanggal mulai ({preview.pre_period.start} → {preview.pre_period.end}). Selisih dua baris di atas itulah yang nanti dilaporkan sebagai uplift.
          </p>

          {preview.top_geo.length > 0 && (
            <>
              <h3 style={{ margin: '20px 0 8px' }}>Sebaran wilayah</h3>
              <table>
                <tbody>{preview.top_geo.map((g, i) => <tr key={i}><td>{g.geo ?? '(kosong)'}</td><td className="num">{fmt.int(g.v)}</td></tr>)}</tbody>
              </table>
            </>
          )}
        </Panel>
      )}

      {!preview && <Empty title="Belum ada pratinjau">Isi kondisi dan periode, lalu klik Pratinjau populasi untuk melihat berapa baris yang tertangkap.</Empty>}
    </>
  );
}

const cleanFilters = (filters) =>
  filters.filter((f) => (Array.isArray(f.value) ? f.value.length > 0 : String(f.value ?? '').trim() !== ''));