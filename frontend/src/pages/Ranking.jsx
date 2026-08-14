import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Panel, Confidence, Notice, Empty, fmt } from '../components/ui.jsx';

export default function Ranking({ onOpenProgram }) {
  const [ranking, setRanking] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.ranking().then((r) => setRanking(r.ranking)).catch((e) => setError(e.message));
  }, []);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Peringkat program</h1>
          <p>Skor dinormalisasi di dalam kategori yang sama. Program akuisisi tidak dibandingkan dengan program loyalty karena satuan KPI-nya berbeda — angkanya akan terlihat rapi tapi tidak berarti apa-apa.</p>
        </div>
      </div>

      {error && <Notice kind="error">{error}</Notice>}
      {ranking.length === 0 && <Empty title="Belum ada program yang dievaluasi">Jalankan evaluasi di tab sebelah dulu.</Empty>}

      {ranking.map((group) => (
        <Panel key={group.category} title={group.category} subtitle={`${group.programs.length} program`}>
          <table>
            <thead>
              <tr>
                <th className="num">Skor</th><th>Program</th><th>Divisi</th><th>Periode</th>
                <th className="num">Uplift</th><th className="num">Biaya / hasil inkremental</th>
                <th className="num">Δ pangsa</th><th>Keyakinan</th>
              </tr>
            </thead>
            <tbody>
              {group.programs.map((p) => (
                <tr key={p.id} onClick={() => onOpenProgram?.(p.id)} style={{ cursor: 'pointer' }}>
                  <td className="num" style={{ fontWeight: 500, fontFamily: 'var(--mono)' }}>{p.score ?? '—'}</td>
                  <td>{p.name}</td>
                  <td className="mono-sm">{p.division}</td>
                  <td className="mono-sm">{p.period_start} → {p.period_end}</td>
                  <td className="num" style={{ color: p.uplift_pp > 0 ? 'var(--lift)' : p.uplift_pp < 0 ? 'var(--drag)' : 'inherit' }}>
                    {p.uplift_pp === null ? '—' : fmt.pct(p.uplift_pp)}
                  </td>
                  <td className="num">{p.cost_per_incremental ? fmt.rp(p.cost_per_incremental) : '—'}</td>
                  <td className="num">{p.ga_share_delta_pp === null ? '—' : `${fmt.num(p.ga_share_delta_pp, 2)} pp`}</td>
                  <td><Confidence level={p.confidence} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ))}
    </>
  );
}
