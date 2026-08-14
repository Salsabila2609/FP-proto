import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Panel, Stat, Confidence, Notice, Empty, fmt } from '../components/ui.jsx';

export default function Evaluation({ aiEnabled, selectedId }) {
  const [programs, setPrograms] = useState([]);
  const [id, setId] = useState(selectedId ?? '');
  const [detail, setDetail] = useState(null);
  const [evaluation, setEvaluation] = useState(null);
  const [narrative, setNarrative] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const [discovered, setDiscovered] = useState([]);
  const [showDiscover, setShowDiscover] = useState(false);
  // Cashback diberikan per outlet, jadi level outlet memberi pembanding alami:
  // outlet yang tidak menerima cashback di region yang sama. Level sales_area
  // biasanya mencakup semuanya, sehingga tidak ada pembanding sama sekali.
  const [importLevel, setImportLevel] = useState('outlet');

  function loadPrograms() {
    api.programs().then((r) => setPrograms(r.programs)).catch((e) => setError(e.message));
  }
  useEffect(loadPrograms, []);
  useEffect(() => {
    api.discover().then((r) => setDiscovered(r.discovered)).catch(() => {});
  }, []);

  async function importOne(name, category) {
    setBusy('import');
    setError(null);
    try {
      const res = await api.importDiscovered({ programName: name, category, geoLevel: importLevel });
      setDiscovered((d) => d.map((x) => (x.program_name === name ? { ...x, alreadyImported: true } : x)));
      loadPrograms();
      setId(res.programId);
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }
  useEffect(() => {
    if (!id) return;
    setDetail(null); setEvaluation(null); setNarrative(null);
    api.program(id).then(setDetail).catch((e) => setError(e.message));
  }, [id]);

  async function run(action) {
    setBusy(action); setError(null);
    try {
      if (action === 'evaluate') setEvaluation(await api.evaluate(id));
      if (action === 'narrate') setNarrative((await api.narrate(id)).narrative);
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  const results = evaluation?.results ?? detail?.evaluation?.map((e) => ({ ...e, label: e.recipe })) ?? [];
  const headline = results.find((r) => r.status === 'ok' && r.metrics?.uplift_pp !== undefined);
  const cost = results.find((r) => r.recipe === 'cost_efficiency' && r.status === 'ok');
  const share = results.find((r) => r.recipe === 'marketshare_delta' && r.status === 'ok');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Evaluasi</h1>
          <p>Setiap resep menyatakan syaratnya lebih dulu. Kalau data tidak memenuhi, resep dilewati dengan alasan yang jelas — bukan dipaksa mengeluarkan angka yang menyesatkan.</p>
        </div>
      </div>

      {error && <Notice kind="error">{error}</Notice>}

      <Panel title="Pilih program">
        <div className="row">
          <label className="field" style={{ flex: '1 1 320px' }}>Program
            <select value={id} onChange={(e) => setId(e.target.value)}>
              <option value="">— pilih —</option>
              {programs.map((p) => (
                <option key={p.id} value={p.id}>{p.name} · {p.division} · {p.period_start}</option>
              ))}
            </select>
          </label>
          <button className="btn primary" onClick={() => run('evaluate')} disabled={!id || busy}>
            {busy === 'evaluate' ? 'Menghitung…' : 'Jalankan evaluasi'}
          </button>
          <button className="btn" onClick={() => run('narrate')} disabled={!id || busy || !aiEnabled || results.length === 0}>
            {busy === 'narrate' ? 'Menulis…' : aiEnabled ? 'Minta ringkasan AI' : 'AI nonaktif'}
          </button>
        </div>
      </Panel>

      {discovered.length > 0 && (
        <Panel
          title="Program prepaid terdeteksi"
          subtitle="Ditemukan otomatis dari data cashback — nama dan biayanya sudah ada di dalam data, jadi tidak perlu diunggah."
          actions={
            <button className="btn" onClick={() => setShowDiscover((v) => !v)}>
              {showDiscover ? 'Sembunyikan' : `Lihat ${discovered.filter((d) => !d.alreadyImported).length} yang belum diimpor`}
            </button>
          }
        >
          {showDiscover && (
            <div className="row" style={{ marginBottom: 14 }}>
              <label className="field">
                Level wilayah saat impor
                <select value={importLevel} onChange={(e) => setImportLevel(e.target.value)}>
                  <option value="outlet">outlet — punya pembanding alami</option>
                  <option value="cluster">cluster</option>
                  <option value="sales_area">sales area</option>
                  <option value="area">area</option>
                </select>
              </label>
              <span className="stat-note" style={{ maxWidth: '46ch' }}>
                Cashback diberikan per outlet. Kalau diimpor di level sales area dan programnya mencakup semua sales area, tidak ada wilayah pembanding dan uplift tidak bisa dihitung.
              </span>
            </div>
          )}
          {showDiscover && (
            <table>
              <thead>
                <tr>
                  <th>Program</th><th>Periode</th><th className="num">Biaya</th>
                  <th className="num">Outlet</th><th className="num">Sales area</th><th />
                </tr>
              </thead>
              <tbody>
                {discovered.map((d) => (
                  <tr key={d.program_name}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{d.program_name}</div>
                      {d.brand && <div className="mono-sm">{d.brand}</div>}
                    </td>
                    <td className="mono-sm">{fmt.date(d.period_start)} → {fmt.date(d.period_end)} ({d.durationDays}h)</td>
                    <td className="num">{fmt.rp(d.cost_total)}</td>
                    <td className="num">{fmt.int(d.outlet_count)}</td>
                    <td className="num">{fmt.int(d.sales_area_count)}</td>
                    <td className="num">
                      {d.alreadyImported ? (
                        <span className="badge ok">sudah diimpor</span>
                      ) : (
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          <button className="btn" disabled={busy} onClick={() => importOne(d.program_name, 'acquisition')}>Akuisisi</button>
                          <button className="btn" disabled={busy} onClick={() => importOne(d.program_name, 'arpu')}>ARPU</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {showDiscover && (
            <p className="stat-note" style={{ marginTop: 12 }}>
              Pilih kategori saat mengimpor: itu yang menentukan resep mana yang dipakai. Akuisisi mengukur SP baru, ARPU mengukur revenue rebuy per outlet aktif.
            </p>
          )}
        </Panel>
      )}

      {!id && <Empty title="Belum ada program dipilih">Pilih program di atas, atau impor salah satu program prepaid yang terdeteksi.</Empty>}

      {evaluation?.dataQuality && (
        <Panel title="Kualitas data masukan" subtitle="Angka di bawah ini menentukan seberapa jauh hasil evaluasi boleh dipercaya.">
          <div className="row">
            <span className="badge">{fmt.int(evaluation.dataQuality.rowsExecuted)} baris terlaksana</span>
            {evaluation.dataQuality.rowsSkippedNotExecuted > 0 && (
              <span className="badge warn">{evaluation.dataQuality.rowsSkippedNotExecuted} baris rencana dikecualikan</span>
            )}
            {evaluation.dataQuality.geoUnmatchedCount > 0
              ? <span className="badge bad">{evaluation.dataQuality.geoUnmatchedCount} wilayah tidak dikenali</span>
              : <span className="badge ok">semua wilayah cocok</span>}
          </div>
        </Panel>
      )}

      {results.length > 0 && (
        <div className="panel">
          <div className="stats">
            <Stat
              label="Uplift vs pembanding"
              value={headline ? fmt.pct(headline.metrics.uplift_pp) : '—'}
              note={headline ? `pertumbuhan wilayah program ${fmt.pct(headline.metrics.treated_growth_pct)}, pembanding ${fmt.pct(headline.metrics.control_growth_pct)}` : 'belum dihitung'}
              tone={headline?.metrics.uplift_pp > 0 ? 'lift' : headline ? 'drag' : ''}
              dim={headline?.confidence === 'low'}
            />
            <Stat
              label="Hasil inkremental"
              value={headline ? fmt.int(headline.metrics.incremental_result) : '—'}
              note={headline?.metrics.incremental_share !== null && headline ? `${Math.round((headline.metrics.incremental_share ?? 0) * 100)}% dari total, sisanya organik` : ''}
              dim={headline?.confidence === 'low'}
            />
            <Stat
              label="Biaya per hasil inkremental"
              value={cost?.metrics.cost_per_incremental ? fmt.rp(cost.metrics.cost_per_incremental) : '—'}
              note={cost?.metrics.note ?? (cost ? `total biaya ${fmt.rp(cost.metrics.cost_total)}` : '')}
              dim={cost?.confidence === 'low'}
            />
            <Stat
              label="Perubahan pangsa pasar"
              value={share?.metrics.ga_share_delta_pp !== null && share ? `${share.metrics.ga_share_delta_pp > 0 ? '+' : ''}${fmt.num(share.metrics.ga_share_delta_pp, 2)} pp` : '—'}
              note={share ? `${fmt.num(share.metrics.ga_share_pre_pct, 1)}% → ${fmt.num(share.metrics.ga_share_post_pct, 1)}%` : 'belum tersedia'}
              tone={share?.metrics.ga_share_delta_pp > 0 ? 'lift' : share ? 'drag' : ''}
              dim={share?.confidence === 'low'}
            />
          </div>
        </div>
      )}

      {headline && share && headline.metrics.uplift_pp > 0 && share.metrics.ga_share_delta_pp <= 0 && (
        <Notice>
          Uplift positif tapi pangsa pasar tidak naik. Kenaikannya kemungkinan besar mengikuti tren industri di wilayah itu, bukan hasil merebut pelanggan dari operator lain.
        </Notice>
      )}

      {results.map((r) => (
        <Panel
          key={r.recipe}
          title={r.label ?? r.recipe}
          subtitle={r.explain}
          actions={r.status === 'ok' ? <Confidence level={r.confidence} /> : <span className={`badge ${r.status === 'skipped' ? 'warn' : 'bad'}`}>{r.status}</span>}
        >
          {r.status !== 'ok' ? (
            <p className="stat-note" style={{ margin: 0 }}>{r.skipReason ?? r.skip_reason}</p>
          ) : (
            <MetricTable metrics={r.metrics} />
          )}
        </Panel>
      ))}

      {narrative && (
        <Panel title="Ringkasan AI" subtitle="Ditulis dari angka di atas. Model tidak menghitung ulang apa pun.">
          <div className="narrative">{narrative}</div>
        </Panel>
      )}
    </>
  );
}

function MetricTable({ metrics }) {
  const rows = Object.entries(metrics).filter(([, v]) => typeof v !== 'object' || v === null);
  const perEvent = metrics.per_event;
  const topGeo = metrics.top_geo;

  return (
    <>
      <table>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td style={{ width: '48%', color: 'var(--muted)' }}>{k.replace(/_/g, ' ')}</td>
              <td className="num">{format(k, v)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {topGeo?.length > 0 && (
        <>
          <h3 style={{ margin: '20px 0 8px' }}>Wilayah terbaik</h3>
          <table>
            <tbody>{topGeo.map((g, i) => <tr key={i}><td>{g.geo}</td><td className="num">{fmt.int(g.v)}</td></tr>)}</tbody>
          </table>
        </>
      )}

      {perEvent?.length > 0 && (
        <>
          <h3 style={{ margin: '20px 0 8px' }}>Per event</h3>
          <table>
            <thead><tr><th>Tanggal</th><th>Wilayah</th><th className="num">SP di jendela</th><th className="num">Perkiraan tanpa event</th><th className="num">Lift</th></tr></thead>
            <tbody>
              {perEvent.slice(0, 15).map((e, i) => (
                <tr key={i}>
                  <td className="mono-sm">{fmt.date(e.tanggal)}</td>
                  <td>{e.geo}</td>
                  <td className="num">{fmt.int(e.sp_in_window)}</td>
                  <td className="num">{fmt.int(e.sp_expected)}</td>
                  <td className="num" style={{ color: e.lift > 0 ? 'var(--lift)' : 'var(--drag)' }}>{e.lift === null ? '—' : fmt.pct(e.lift * 100)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

function format(key, value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'ya' : 'tidak';
  if (typeof value === 'string') return value.replace(/_/g, ' ');
  if (key.endsWith('_pct') || key.endsWith('_pp')) return fmt.pct(value, 2);
  if (key.startsWith('cost') || key.includes('revenue') || key.includes('biaya')) return fmt.rp(value);
  if (key.includes('share') && value <= 1) return fmt.pct(value * 100, 1);
  return fmt.int(value);
}