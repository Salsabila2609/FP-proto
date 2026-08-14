export const fmt = {
  int: (v) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Math.round(v).toLocaleString('id-ID')),
  num: (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d })),
  pct: (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(d)}%`),
  rp: (v) => (v === null || v === undefined || Number.isNaN(v) ? '—' : 'Rp ' + Math.round(v).toLocaleString('id-ID')),
  date: (v) => (v ? String(v).slice(0, 10) : '—'),
};

const CONF_LABEL = { high: 'keyakinan tinggi', medium: 'keyakinan sedang', low: 'keyakinan rendah' };

/**
 * Elemen tanda tangan aplikasi ini. Tidak ada angka hasil yang boleh muncul
 * tanpa pita ini di sebelahnya, supaya tidak ada yang membaca "uplift 12%"
 * tanpa tahu apakah angka itu punya pembanding yang layak.
 */
export function Confidence({ level }) {
  if (!level) return null;
  return (
    <span className={`conf ${level}`} title={CONF_LABEL[level]}>
      <span className="bars" aria-hidden="true"><i /><i /><i /></span>
      {CONF_LABEL[level]}
    </span>
  );
}

export function Stat({ label, value, note, tone, dim }) {
  return (
    <div className={`stat ${tone ?? ''} ${dim ? 'dim' : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

export function Panel({ title, actions, children, subtitle }) {
  return (
    <section className="panel">
      {(title || actions) && (
        <header>
          <div>
            <h2>{title}</h2>
            {subtitle && <div className="stat-note">{subtitle}</div>}
          </div>
          {actions}
        </header>
      )}
      <div className="body">{children}</div>
    </section>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function Notice({ kind = 'warn', children }) {
  return <div className={`notice ${kind === 'error' ? 'bad' : kind === 'ok' ? 'ok' : ''}`}>{children}</div>;
}
