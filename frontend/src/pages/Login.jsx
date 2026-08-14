import { useState } from 'react';
import { api } from '../api.js';

export default function Login({ onSignedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.login(email, password);
      onSignedIn(user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 24 }}>
      <form className="panel" style={{ width: 360, marginBottom: 0 }} onSubmit={submit}>
        <header><h2>Masuk</h2></header>
        <div className="body" style={{ display: 'grid', gap: 14 }}>
          {error && <div className="notice bad">{error}</div>}
          <label className="field">
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
          </label>
          <label className="field">
            Kata sandi
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
          </label>
          <button className="btn primary" disabled={busy}>{busy ? 'Memeriksa…' : 'Masuk'}</button>
        </div>
      </form>
    </div>
  );
}
