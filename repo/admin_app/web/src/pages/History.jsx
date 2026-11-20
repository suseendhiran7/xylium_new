import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi, fmtTime } from '../hooks.js';
import { RolloutPanel } from '../components/Rollout.jsx';
import { DiffTable, ErrorBox, Loading, PageHeader, TYPE_LABELS } from '../components/ui.jsx';

export default function History() {
  const { type } = useParams();
  const { can } = useAuth();
  const versions = useApi(`/api/configs/${type}/versions`);
  const [selected, setSelected] = useState(null);
  const [diff, setDiff] = useState(null);
  const [rollbackTo, setRollbackTo] = useState(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  if (versions.error) return <ErrorBox error={versions.error} />;
  if (!versions.data) return <Loading />;
  const list = versions.data.versions;
  const latest = list[0] ? list[0].version : 0;

  const showDiff = async (v) => {
    setSelected(v);
    setDiff(null);
    try {
      const r = await api.get(`/api/configs/${type}/diff?from=${v - 1}&to=${v}`);
      setDiff(r.changes);
    } catch (e) {
      setError(e);
    }
  };

  const doRollback = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.post(`/api/configs/${type}/rollback`, { toVersion: rollbackTo, reason });
      setResult(r);
      setRollbackTo(null);
      setReason('');
      versions.reload();
    } catch (e2) {
      setError(e2);
    }
  };

  return (
    <div>
      <PageHeader title={`${TYPE_LABELS[type] || type} — history`} back={{ to: type === 'custom-patterns' ? '/configs/custom-patterns' : `/configs/${type}`, label: TYPE_LABELS[type] || type }} />
      {list.length === 0 && <p className="muted">No versions yet.</p>}
      {list.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Version</th>
              <th>When</th>
              <th>Who</th>
              <th>Reason</th>
              <th>Source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((v) => (
              <tr key={v.version} className={selected === v.version ? 'selected' : ''}>
                <td>
                  <strong>v{v.version}</strong>
                  {v.version === latest && <span className="badge ok">current</span>}
                </td>
                <td>{fmtTime(v.created_at)}</td>
                <td>{v.created_by || <span className="muted">system</span>}</td>
                <td>{v.change_reason}</td>
                <td>
                  {v.source}
                  {v.based_on_version ? ` of v${v.based_on_version}` : ''}
                </td>
                <td className="row-actions">
                  <button className="link" onClick={() => showDiff(v.version)}>
                    Changes
                  </button>
                  {can('admin') && v.version !== latest && (
                    <button className="link" onClick={() => setRollbackTo(v.version)}>
                      Roll back to this
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {selected && (
        <section className="card">
          <h3>
            Changes in v{selected} (compared with v{selected - 1 || 'nothing'})
          </h3>
          {diff ? <DiffTable changes={diff} /> : <Loading />}
        </section>
      )}

      {rollbackTo && (
        <form className="card" onSubmit={doRollback}>
          <h3>Roll back to v{rollbackTo}</h3>
          <p className="muted">This saves the settings of v{rollbackTo} as a new version (v{latest + 1}); history is never rewritten.</p>
          <div className="field">
            <label htmlFor="rb-reason">Reason</label>
            <input id="rb-reason" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} />
          </div>
          <div className="form-actions">
            <button type="submit" disabled={reason.trim().length < 3}>
              Roll back
            </button>
            <button type="button" className="secondary" onClick={() => setRollbackTo(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <ErrorBox error={error} />
      {result && <RolloutPanel type={type} version={result.version} canRetry={can('operator')} />}
    </div>
  );
}
