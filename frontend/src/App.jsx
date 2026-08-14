import { useEffect, useState } from 'react';
import { api } from './api.js';
import Login from './pages/Login.jsx';
import DataHealth from './pages/DataHealth.jsx';
import Upload from './pages/Upload.jsx';
import Evaluation from './pages/Evaluation.jsx';
import DefineProgram from './pages/DefineProgram.jsx';
import Ranking from './pages/Ranking.jsx';
import './styles/app.css';

const TABS = [
  { key: 'data', label: 'Kesehatan data' },
  { key: 'upload', label: 'Unggah program' },
  { key: 'define', label: 'Definisikan program' },
  { key: 'eval', label: 'Evaluasi' },
  { key: 'rank', label: 'Peringkat' },
];

export default function App() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [meta, setMeta] = useState({ aiEnabled: false, mockBigQuery: false });
  const [tab, setTab] = useState('data');
  const [openProgram, setOpenProgram] = useState(null);

  useEffect(() => {
    Promise.all([api.me().catch(() => null), api.meta().catch(() => ({}))]).then(([me, m]) => {
      setUser(me?.user ?? null);
      setMeta(m ?? {});
      setReady(true);
    });
  }, []);

  if (!ready) return null;
  if (!user) return <Login onSignedIn={setUser} />;

  const goToProgram = (id) => { setOpenProgram(id); setTab('eval'); };

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          Evaluasi Program
          <small>Prepaid · Marcomm · Postpaid</small>
        </div>
        <nav>
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)} aria-current={tab === t.key ? 'page' : undefined}>
              {t.label}
            </button>
          ))}
        </nav>
        <footer>
          <div>{user.name ?? user.email}</div>
          <div style={{ marginTop: 4 }}>{meta.mockBigQuery ? 'Sumber: data contoh' : 'Sumber: BigQuery'}</div>
          <div>{meta.aiEnabled ? `AI: ${meta.model}` : 'AI: nonaktif'}</div>
          <button className="btn" style={{ marginTop: 10 }} onClick={async () => { await api.logout(); setUser(null); }}>Keluar</button>
        </footer>
      </aside>

      <main className="main">
        {tab === 'data' && <DataHealth />}
        {tab === 'upload' && <Upload aiEnabled={meta.aiEnabled} onCommitted={goToProgram} />}
        {tab === 'define' && <DefineProgram onCreated={goToProgram} />}
        {tab === 'eval' && <Evaluation aiEnabled={meta.aiEnabled} selectedId={openProgram} />}
        {tab === 'rank' && <Ranking onOpenProgram={goToProgram} />}
      </main>
    </div>
  );
}