import { useApi, timeAgo } from '../hooks.js';
import { StateBadge } from './ui.jsx';
import { api } from '../api.js';
import { useState } from 'react';

/** Live per-instance status of one version; polls until every live instance has answered. */
export function RolloutPanel({ type, version, canRetry }) {
  const { data, reload } = useApi(`/api/configs/${type}/versions/${version}/rollout`, { pollMs: 1500 });
  const [retrying, setRetrying] = useState(false);
  if (!data) return <p className="muted">Waiting for SDK instances…</p>;
  const s = data.summary;
  const done = s.complete;
  return (
    <section className="card rollout">
      <div className="rollout-head">
        <h3>Rollout of version {version}</h3>
        <span className={`badge ${done ? 'ok' : s.failed ? 'bad' : 'muted'}`}>
          {s.live === 0 ? 'No live SDK instances' : done ? 'Complete' : s.failed ? `${s.failed} failed` : `${s.pending} pending`}
        </span>
      </div>
      {s.live === 0 && <p className="muted">No SDK instance has checked in during the last 90 seconds. Instances apply this version when they next start or check in.</p>}
      {data.instances.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Instance</th>
              <th>Notified</th>
              <th>Result</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {data.instances.map((i) => (
              <tr key={i.instance_id}>
                <td>
                  <code>{i.instance_id}</code>
                  {!i.live && <span className="badge warn">stale</span>}
                </td>
                <td>
                  <StateBadge state={i.notify_status || 'not_notified'} />
                </td>
                <td>
                  <StateBadge state={i.state} />
                </td>
                <td className="small">
                  {i.ack_error && <span className="bad-text">{i.ack_error}</span>}
                  {!i.ack_error && i.last_error && <span className="bad-text">{i.last_error}</span>}
                  {i.state === 'restart_required' && 'Takes effect at the next restart of this instance.'}
                  {i.acked_at && <span className="muted"> {timeAgo(i.acked_at)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canRetry && (s.failed > 0 || data.instances.some((i) => i.state === 'unreachable')) && (
        <button
          className="secondary small"
          disabled={retrying}
          onClick={async () => {
            setRetrying(true);
            try {
              await api.post('/api/rollouts/retry', { configType: type, version });
              await reload();
            } finally {
              setRetrying(false);
            }
          }}
        >
          Notify again
        </button>
      )}
    </section>
  );
}
