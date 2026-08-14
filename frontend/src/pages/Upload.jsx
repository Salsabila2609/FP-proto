import { useState } from 'react';
import { api } from '../api.js';
import { Panel, Notice, Empty, fmt } from '../components/ui.jsx';

const ROLES = ['tanggal', 'geo_value', 'metric_value', 'metric_name', 'unit', 'cost', 'is_executed', 'detail', 'ignore'];
const GEO_LEVELS = ['region', 'area', 'sales_area', 'cluster', 'kabkot', 'kecamatan', 'outlet'];
const DIVISIONS = ['prepaid_snd', 'marcomm', 'postpaid'];
const CATEGORIES = ['acquisition', 'arpu', 'loyalty', 'visibility', 'partnership'];

/**
 * Alur empat langkah. Data tidak masuk warehouse sampai langkah terakhir --
 * usulan AI selalu lewat mata manusia dulu.
 */
export default function Upload({ aiEnabled, onCommitted }) {
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [upload, setUpload] = useState(null);
  const [mapping, setMapping] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [preview, setPreview] = useState(null);
  const [showRaw, setShowRaw] = useState(false);
  const [program, setProgram] = useState({
    name: '', division: 'marcomm', category: 'acquisition',
    period_start: '', period_end: '', cost_total: 0, geo_level: 'sales_area', description: '',
  });

  async function handleFile(file) {
    setBusy(true); setError(null);
    try {
      const res = await api.upload(file);
      setUpload(res);
      if (res.reusedTemplate) {
        setMapping(res.reusedTemplate.mapping);
        setWarnings([`Susunan kolom ini sudah pernah dipetakan sebagai "${res.reusedTemplate.label}". Template lama dipakai — periksa lalu lanjutkan.`]);
      } else {
        setMapping(null);
        setWarnings([]);
      }
      setStep(2);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  // Baca ulang berkas dengan sheet / baris header pilihan pengguna.
  async function reprofile(patch) {
    setBusy(true); setError(null);
    try {
      const res = await api.reprofile(upload.uploadId, patch);
      setUpload((u) => ({ ...u, ...res }));
      setMapping(null);
      setPreview(null);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function suggest() {
    setBusy(true); setError(null);
    try {
      const res = await api.suggestMapping(upload.uploadId, { headerRowIndex: upload.headerRowIndex });
      const proposed = res.ok ? res.mapping : res.draft;
      setMapping(proposed);
      setWarnings(res.ok ? proposed.warnings ?? [] : ['AI tidak bisa memetakan file ini. Isi peran tiap kolom secara manual.', ...(res.issues ?? [])]);
      setProgram((p) => ({ ...p, division: proposed.division ?? p.division, category: proposed.category ?? p.category, geo_level: proposed.geo_level ?? p.geo_level }));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function runPreview() {
    setBusy(true); setError(null);
    try {
      setPreview(await api.previewMapping(upload.uploadId, mapping));
      setStep(3);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function commit() {
    setBusy(true); setError(null);
    try {
      const res = await api.commitUpload(upload.uploadId, { mapping, program: { ...program, cost_total: Number(program.cost_total) || 0, geo_level: mapping.geo_level }, saveTemplate: true });
      onCommitted?.(res.programId);
      setStep(4);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  const setRole = (col, role) =>
    setMapping((m) => ({ ...m, columns: m.columns.map((c) => (c.source_column === col ? { ...c, role } : c)) }));

  const toggleUnpivot = (colName) =>
    setMapping((m) => {
      const exists = m.unpivot.some((u) => u.source_column === colName);
      return {
        ...m,
        unpivot: exists
          ? m.unpivot.filter((u) => u.source_column !== colName)
          : [...m.unpivot, { source_column: colName, metric_name: slug(colName), unit: 'pcs' }],
      };
    });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Unggah data program</h1>
          <p>Excel dengan kolom apa pun. AI mengusulkan pemetaan kolom ke skema kanonik; kamu yang memutuskan. Tidak ada yang masuk warehouse sebelum kamu konfirmasi di langkah terakhir.</p>
        </div>
        <div className="mono-sm">Langkah {Math.min(step, 4)} dari 4</div>
      </div>

      {error && <Notice kind="error">{error}</Notice>}

      {step === 1 && (
        <Panel title="1. Pilih berkas">
          <input type="file" accept=".xlsx,.xlsm,.csv" onChange={(e) => e.target.files[0] && handleFile(e.target.files[0])} disabled={busy} />
          <p className="stat-note" style={{ marginTop: 12 }}>Format .xlsx, .xlsm, atau .csv. Baris header tidak harus di baris pertama.</p>
        </Panel>
      )}

      {step === 2 && upload && (
        <>
          <Panel
            title="2. Petakan kolom"
            subtitle={`${upload.profile.totalRows} baris data, header terdeteksi di baris ${upload.headerRowIndex + 1}.`}
            actions={
              <div className="row">
                <button className="btn" onClick={suggest} disabled={busy || !aiEnabled}>
                  {aiEnabled ? 'Minta usulan AI' : 'AI nonaktif'}
                </button>
                <button className="btn primary" onClick={runPreview} disabled={busy || !mapping}>Pratinjau hasil</button>
              </div>
            }
          >
            <div className="row" style={{ marginBottom: 16 }}>
              <label className="field">Sheet
                <select value={upload.sheetName} onChange={(e) => reprofile({ sheetName: e.target.value })} disabled={busy}>
                  {(upload.sheets ?? []).map((sh) => <option key={sh}>{sh}</option>)}
                </select>
              </label>
              <label className="field">Baris header
                <input
                  type="number" min="1" style={{ width: 90 }}
                  value={upload.headerRowIndex + 1}
                  onChange={(e) => reprofile({ headerRowIndex: Math.max(0, Number(e.target.value) - 1) })}
                  disabled={busy}
                />
              </label>
              <button className="btn" onClick={() => { setShowRaw((v) => !v); if (!upload.rawRows) reprofile({}); }}>
                {showRaw ? 'Tutup isi mentah' : 'Lihat isi mentah berkas'}
              </button>
            </div>

            {showRaw && upload.rawRows && (
              <div style={{ overflowX: 'auto', marginBottom: 16, border: '1px solid var(--hairline)', borderRadius: 8 }}>
                <table style={{ fontSize: 12 }}>
                  <tbody>
                    {upload.rawRows.map((r, ri) => (
                      <tr key={ri} style={ri === upload.headerRowIndex ? { background: 'var(--lift-bg)' } : undefined}>
                        <td className="mono-sm" style={{ position: 'sticky', left: 0, background: 'var(--surface)' }}>{ri + 1}</td>
                        {r.map((c, ci) => (
                          <td key={ci} className="mono-sm" style={{ whiteSpace: 'nowrap', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {c === null ? '' : String(c)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {showRaw && (
              <p className="stat-note" style={{ marginTop: -8, marginBottom: 16 }}>
                Ini isi berkas persis seperti yang dibaca sistem. Baris berlatar hijau dianggap header. Kalau yang kamu lihat di sini berbeda dari Excel, ganti sheet atau baris headernya di atas.
              </p>
            )}

            {upload.profile.columns.filter((c) => c.nonEmpty === 0).length > 0 && (
              <Notice>
                Kolom ini kosong di seluruh {upload.profile.totalRows} baris: {upload.profile.columns.filter((c) => c.nonEmpty === 0).map((c) => c.name).join(', ')}.
                Kalau di Excel isinya ada, kemungkinan baris header atau sheet-nya salah — cek lewat "Lihat isi mentah berkas".
              </Notice>
            )}

            {warnings.map((w, i) => <Notice key={i}>{w}</Notice>)}
            {!mapping && <Empty title="Belum ada pemetaan">Minta usulan AI, atau isi peran kolom secara manual setelah usulan muncul.</Empty>}

            {mapping && (
              <>
                <div className="row" style={{ marginBottom: 16 }}>
                  <label className="field">Level wilayah
                    <select value={mapping.geo_level} onChange={(e) => setMapping({ ...mapping, geo_level: e.target.value })}>
                      {GEO_LEVELS.map((g) => <option key={g}>{g}</option>)}
                    </select>
                  </label>
                  <label className="field">Divisi
                    <select value={mapping.division} onChange={(e) => setMapping({ ...mapping, division: e.target.value })}>
                      {DIVISIONS.map((d) => <option key={d}>{d}</option>)}
                    </select>
                  </label>
                  <label className="field">Kategori
                    <select value={mapping.category} onChange={(e) => setMapping({ ...mapping, category: e.target.value })}>
                      {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </label>
                </div>

                <table>
                  <thead><tr><th>Kolom asal</th><th>Contoh isi</th><th>Peran</th><th>Jadikan baris</th><th>Nama metrik</th></tr></thead>
                  <tbody>
                    {upload.profile.columns.map((col) => {
                      const role = mapping.columns.find((c) => c.source_column === col.name)?.role ?? 'detail';
                      const unpivot = mapping.unpivot.find((u) => u.source_column === col.name);
                      return (
                        <tr key={col.name}>
                          <td>
                            <div style={{ fontWeight: 500 }}>{col.name}</div>
                            <div className="mono-sm">{col.inferredType} · terisi {col.nonEmpty}</div>
                          </td>
                          <td className="mono-sm">{col.distinctSample.slice(0, 3).join(' · ') || '—'}</td>
                          <td>
                            <select value={unpivot ? 'metric_value' : role} disabled={!!unpivot} onChange={(e) => setRole(col.name, e.target.value)}>
                              {ROLES.map((r) => <option key={r}>{r}</option>)}
                            </select>
                          </td>
                          <td>
                            <input type="checkbox" checked={!!unpivot} onChange={() => toggleUnpivot(col.name)} aria-label={`Jadikan ${col.name} sebagai baris metrik`} />
                          </td>
                          <td>
                            {unpivot && (
                              <input value={unpivot.metric_name} onChange={(e) =>
                                setMapping((m) => ({ ...m, unpivot: m.unpivot.map((u) => u.source_column === col.name ? { ...u, metric_name: e.target.value } : u) }))
                              } />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="stat-note" style={{ marginTop: 12 }}>
                  Centang "jadikan baris" untuk kolom yang sebenarnya varian dari hasil yang sama — misalnya SP 3GB, SP 5GB, dan SP 7GB. Tiga kolom itu jadi tiga baris, bukan tiga metrik terpisah.
                </p>
              </>
            )}
          </Panel>
        </>
      )}

      {step === 3 && preview && (
        <>
          <Panel title="3. Periksa hasil transform" actions={<button className="btn" onClick={() => setStep(2)}>Kembali ke pemetaan</button>}>
            <div className="row" style={{ marginBottom: 16 }}>
              <span className="badge ok">{fmt.int(preview.rowCount)} baris siap</span>
              {preview.issues.length > 0 && <span className="badge warn">{preview.issues.length} baris bermasalah</span>}
              {preview.geo.unmatched.length > 0 && <span className="badge bad">{preview.geo.unmatched.length} wilayah tidak dikenali</span>}
              <span className="badge">metrik: {preview.metricNames.join(', ') || '—'}</span>
            </div>

            {preview.issues.length > 0 && (
              <Notice>
                Baris bermasalah (diperiksa sebelum masuk):
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {preview.issues.slice(0, 5).map((i, n) => <li key={n}>Baris {i.row}, {i.field} = "{i.value}" — {i.message}</li>)}
                </ul>
              </Notice>
            )}
            {preview.unassignedRoles?.length > 0 && (
              <Notice kind="error">
                Peran ini belum dipetakan ke kolom mana pun: <strong>{preview.unassignedRoles.join(', ')}</strong>.
                {preview.unassignedRoles.includes('tanggal') && ' Itulah kenapa kolom tanggal di bawah kosong semua.'}
                {' '}Kembali ke pemetaan dan beri peran yang sesuai.
              </Notice>
            )}
            {preview.missingColumns?.length > 0 && (
              <Notice kind="error">
                Kolom ini disebut di pemetaan tapi tidak ada di berkas: {preview.missingColumns.map((m) => `"${m.column}" (${m.role})`).join(', ')}.
                Nama kolom yang tersedia: {(preview.headers ?? []).join(' · ')}
              </Notice>
            )}
            {preview.dateFormat && preview.dateFormat.needsConfirmation && (
              <Notice kind="error">
                Urutan hari dan bulan di kolom tanggal tidak bisa dipastikan — semua nilainya di bawah 13, jadi "5/6/2026" bisa berarti 5 Juni atau 6 Mei. Pilih yang benar; salah pilih tidak akan memunculkan error, tanggalnya hanya akan bergeser diam-diam.
                <div className="row" style={{ marginTop: 10 }}>
                  <label className="field">
                    Urutan tanggal
                    <select
                      value={mapping.date_format ?? 'MDY'}
                      onChange={async (e) => {
                        const next = { ...mapping, date_format: e.target.value };
                        setMapping(next);
                        try { setPreview(await api.previewMapping(upload.uploadId, next)); }
                        catch (err) { setError(err.message); }
                      }}
                    >
                      <option value="MDY">bulan/hari/tahun — 4/25/2026 = 25 April</option>
                      <option value="DMY">hari/bulan/tahun — 25/4/2026 = 25 April</option>
                    </select>
                  </label>
                </div>
              </Notice>
            )}
            {preview.dateFormat && !preview.dateFormat.needsConfirmation && preview.dateFormat.detected !== 'none' && (
              <p className="stat-note" style={{ marginBottom: 12 }}>
                Urutan tanggal terdeteksi otomatis: {preview.dateFormat.used === 'MDY' ? 'bulan/hari/tahun' : 'hari/bulan/tahun'}
                {preview.dateFormat.detected === 'ambiguous' ? ' (dipilih manual)' : ' — ada nilai di kolom itu yang memastikannya'}.
              </p>
            )}
            {preview.geo.unmatched.length > 0 && (
              <Notice kind="error">
                Wilayah ini tidak ketemu di warehouse: {preview.geo.unmatched.slice(0, 10).join(', ')}. Barisnya tetap tersimpan, tapi tidak ikut dihitung dan akan menurunkan tingkat keyakinan evaluasi.
              </Notice>
            )}

            <table>
              <thead><tr><th>Tanggal</th><th>Wilayah</th><th>Metrik</th><th className="num">Nilai</th><th className="num">Biaya</th><th>Terlaksana</th></tr></thead>
              <tbody>
                {preview.preview.map((r, i) => (
                  <tr key={i}>
                    <td className="mono-sm">{fmt.date(r.tanggal)}</td>
                    <td>{r.geo_value}</td>
                    <td>{r.metric_name}</td>
                    <td className="num">{fmt.int(r.metric_value)}</td>
                    <td className="num">{fmt.rp(r.cost)}</td>
                    <td>{r.is_executed ? 'ya' : 'belum'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <Panel title="4. Lengkapi identitas program" actions={<button className="btn primary" onClick={commit} disabled={busy || !program.name || !program.period_start || !program.period_end}>Simpan program</button>}>
            <div className="row">
              <label className="field" style={{ flex: '1 1 260px' }}>Nama program
                <input value={program.name} onChange={(e) => setProgram({ ...program, name: e.target.value })} placeholder="School Attack Q2 Jember" />
              </label>
              <label className="field">Mulai<input type="date" value={program.period_start} onChange={(e) => setProgram({ ...program, period_start: e.target.value })} /></label>
              <label className="field">Selesai<input type="date" value={program.period_end} onChange={(e) => setProgram({ ...program, period_end: e.target.value })} /></label>
              <label className="field">Biaya total (Rp)<input type="number" min="0" value={program.cost_total} onChange={(e) => setProgram({ ...program, cost_total: e.target.value })} /></label>
            </div>
            <p className="stat-note" style={{ marginTop: 12 }}>
              Biaya total dipakai untuk menghitung biaya per hasil inkremental. Kalau dikosongkan, resep efisiensi biaya tetap jalan tapi hasilnya nol dan tidak bisa dipakai membandingkan program.
            </p>
          </Panel>
        </>
      )}

      {step === 4 && (
        <Panel title="Selesai">
          <Notice kind="ok">Program tersimpan. Buka tab Evaluasi untuk menjalankan resep dan melihat hasilnya.</Notice>
          <button className="btn" onClick={() => { setStep(1); setUpload(null); setMapping(null); setPreview(null); }}>Unggah berkas lain</button>
        </Panel>
      )}
    </>
  );
}

const slug = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');