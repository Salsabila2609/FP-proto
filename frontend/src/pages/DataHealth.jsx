import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Panel, Stat, Notice, fmt, Empty } from '../components/ui.jsx';

export default function DataHealth() {
  const [tables, setTables] = useState([]);
  const [runs, setRuns] = useState([]);
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const [range, setRange] = useState({ from: isoDaysAgo(30), to: isoDaysAgo(1) });
  const [gaps, setGaps] = useState({});

  async function load() {
    try {
      const [t, r] = await Promise.all([api.tables(), api.runs()]);
      setTables(t.tables);
      setRuns(r.runs);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => { load(); }, []);

  // Job sync berjalan di latar; polling berhenti begitu selesai.
  useEffect(() => {
    if (!job || ['done', 'failed'].includes(job.status)) return;
    const t = setTimeout(async () => {
      try {
        const next = await api.job(job.id);
        setJob(next);
        if (['done', 'failed'].includes(next.status)) load();
      } catch { /* biarkan polling berikutnya mencoba lagi */ }
    }, 2500);
    return () => clearTimeout(t);
  }, [job]);

  // Sumber berkas (postpaid/OneDrive) ditarik terpisah dari BigQuery, supaya
  // memperbarui satu file tidak memicu backfill seluruh tabel GCP.
  async function refreshFile(key) {
    setError(null);
    try { setJob(await api.refreshFiles(key)); } catch (err) { setError(err.message); }
  }

  async function checkGaps(key) {
    const res = await api.gaps(key, range.from, range.to);
    setGaps((g) => ({ ...g, [key]: res }));
  }

  const totalRows = tables.reduce((s, t) => s + (t.rowCount ?? 0), 0);
  const failing = tables.filter((t) => t.lastRun?.status === 'gagal');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Kesehatan data</h1>
          <p>Isi tiap tabel di warehouse lokal, kapan terakhir ditarik, dan tanggal mana yang bolong. Periksa halaman ini sebelum menarik kesimpulan dari evaluasi mana pun.</p>
        </div>
        <div className="row">
          <button className="btn" onClick={load}>Muat ulang</button>
          <button className="btn primary" onClick={async () => {
            try { setJob(await api.syncNow()); } catch (err) { setError(err.message); }
          }}>Tarik data kemarin</button>
          <button className="btn" onClick={() => refreshFile()}>Tarik berkas postpaid</button>
        </div>
      </div>

      {error && <Notice kind="error">{error}</Notice>}
      {job && job.status !== 'done' && job.status !== 'failed' && (
        <Notice>Sync sedang berjalan{job.progress ? ` — ${job.progress.done}/${job.progress.total} ${job.progress.current ?? ''}` : '…'}</Notice>
      )}
      {job?.status === 'failed' && <Notice kind="error">Sync gagal: {job.error}</Notice>}
      {failing.length > 0 && (
        <Notice kind="error">{failing.length} tabel gagal pada percobaan terakhir: {failing.map((t) => t.label).join(', ')}.</Notice>
      )}

      <div className="panel">
        <div className="stats">
          <Stat label="Total baris tersimpan" value={fmt.int(totalRows)} />
          <Stat label="Tabel terdaftar" value={tables.length} />
          <Stat label="Tabel berisi" value={tables.filter((t) => t.rowCount > 0).length} note={`dari ${tables.length}`} />
        </div>
      </div>

      <Panel title="Tabel" subtitle="Satu baris per tabel di registry. Menambah sumber data baru cukup dengan menambah entri registry di backend.">
        <table>
          <thead>
            <tr>
              <th>Tabel</th><th>Granularitas</th><th className="num">Baris</th>
              <th className="num">Partisi</th><th>Rentang</th><th>Sync terakhir</th><th />
            </tr>
          </thead>
          <tbody>
            {tables.map((t) => (
              <tr key={t.key}>
                <td>
                  <div style={{ fontWeight: 500 }}>{t.label}</div>
                  <div className="mono-sm">{t.target}</div>
                  {gaps[t.key] && (
                    <div className="stat-note" style={{ marginTop: 4 }}>
                      {gaps[t.key].missing.length === 0
                        ? `Lengkap untuk ${gaps[t.key].expected} partisi.`
                        : `Bolong ${gaps[t.key].missing.length}: ${gaps[t.key].missing.slice(0, 6).join(', ')}${gaps[t.key].missing.length > 6 ? '…' : ''}`}
                    </div>
                  )}
                </td>
                <td>{t.grain}</td>
                <td className="num">{fmt.int(t.rowCount)}</td>
                <td className="num">{t.partitionCount ?? '—'}</td>
                <td className="mono-sm">
                  {t.minPartition ?? '—'} → {t.maxPartition ?? '—'}
                  {t.mode && <div className="stat-note">{t.mode}</div>}
                </td>
                <td>
                  {t.lastRun
                    ? <span className={`badge ${t.lastRun.status === 'sukses' ? 'ok' : 'bad'}`}>{t.lastRun.status}</span>
                    : <span className="badge">belum pernah</span>}
                </td>
                <td className="num">
                  {t.grain === 'berkas' ? (
                    <button className="btn" disabled={!t.configured} onClick={() => refreshFile(t.key)}>
                      {t.configured ? 'Tarik berkas' : 'Belum disetel'}
                    </button>
                  ) : t.grain !== 'snapshot' ? (
                    <button className="btn" onClick={() => checkGaps(t.key)}>Cek bolong</button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Tarik ulang rentang tanggal" subtitle="Aman diulang: partisi lama dihapus lebih dulu, jadi tidak ada data ganda.">
        <div className="row">
          <label className="field">Dari<input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
          <label className="field">Sampai<input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
          <button className="btn primary" onClick={async () => {
            try { setJob(await api.backfill({ startDate: range.from, endDate: range.to, tableKeys: [] })); }
            catch (err) { setError(err.message); }
          }}>Jalankan backfill</button>
        </div>
      </Panel>

      <Panel title="Riwayat sync">
        {runs.length === 0 ? <Empty title="Belum ada riwayat">Jalankan sync pertama untuk mengisi tabel.</Empty> : (
          <table>
            <thead><tr><th>Waktu</th><th>Tabel</th><th>Partisi</th><th>Status</th><th className="num">Baris</th><th className="num">Durasi</th><th>Catatan</th></tr></thead>
            <tbody>
              {runs.slice(0, 30).map((r, i) => (
                <tr key={i}>
                  <td className="mono-sm">{String(r.created_at).slice(0, 19).replace('T', ' ')}</td>
                  <td>{r.table_key}</td>
                  <td className="mono-sm">{r.partition_value}</td>
                  <td><span className={`badge ${r.status === 'sukses' ? 'ok' : 'bad'}`}>{r.status}</span></td>
                  <td className="num">{fmt.int(r.row_count)}</td>
                  <td className="num">{r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
                  <td className="stat-note">{r.error ?? r.triggered_by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}

function isoDaysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}