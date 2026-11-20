import { Link } from 'react-router-dom';

export const TYPE_LABELS = {
  database: 'Database',
  ingestion: 'Ingestion',
  tenants: 'Tenants & API keys',
  'ip-intel': 'IP intelligence',
  'http-security': 'HTTP security',
  'custom-patterns': 'Custom patterns',
};

export function ApplyModeBadge({ mode }) {
  const text = { hot: 'Applies live', reconnect: 'Reconnects live', restart: 'Needs restart' }[mode] || mode;
  return <span className={`badge mode-${mode}`} title={mode}>{text}</span>;
}

export function StateBadge({ state }) {
  const cls = {
    applied: 'ok', live: 'ok', success: 'ok', delivered: 'ok',
    failed: 'bad', unreachable: 'bad', stale: 'warn', failure: 'bad', denied: 'bad',
    restart_required: 'warn', pending: 'muted', skipped_stale: 'muted', not_notified: 'muted',
  }[state] || 'muted';
  return <span className={`badge ${cls}`}>{String(state || '—').replace(/_/g, ' ')}</span>;
}

export function ErrorBox({ error }) {
  if (!error) return null;
  const issues = error.details && error.details.issues;
  const fieldErrors = error.details && error.details.fieldErrors;
  return (
    <div className="alert bad" role="alert">
      <strong>{error.message}</strong>
      {issues && (
        <ul>
          {issues.map((i, n) => (
            <li key={n}>
              <code>{i.path || '(root)'}</code>: {i.message}
            </li>
          ))}
        </ul>
      )}
      {fieldErrors && (
        <ul>
          {Object.entries(fieldErrors).map(([k, v]) => (
            <li key={k}>
              <code>{k}</code>: {v.join(', ')}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Loading({ what = 'Loading' }) {
  return <p className="muted">{what}…</p>;
}

export function PageHeader({ title, children, back }) {
  return (
    <header className="page-header">
      <div>
        {back && (
          <Link className="back" to={back.to}>
            ← {back.label}
          </Link>
        )}
        <h1>{title}</h1>
      </div>
      <div className="actions">{children}</div>
    </header>
  );
}

export function DiffTable({ changes }) {
  if (!changes || changes.length === 0) return <p className="muted">No differences.</p>;
  const show = (v) => (v === null || v === undefined ? <span className="muted">—</span> : <code>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</code>);
  return (
    <table className="table diff">
      <thead>
        <tr>
          <th>Field</th>
          <th>Before</th>
          <th>After</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((c) => (
          <tr key={c.path}>
            <td>
              <code>{c.path}</code>
            </td>
            <td className="del">{show(c.from)}</td>
            <td className="add">{show(c.to)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
