import { timeAgo, fmtTime } from '../hooks.js';
import { ErrorBox, Loading, StateBadge, TYPE_LABELS } from '../components/ui.jsx';

export function InstancesTable({ state, compact, onRemove }) {
  if (state.error) return <ErrorBox error={state.error} />;
  if (!state.data) return <Loading />;
  const list = state.data.instances;
  if (list.length === 0)
    return (
      <p className="muted">
        No SDK instance has registered yet. Start node_app with <code>CONFIG_SOURCE=admin</code> (or <code>shadow</code>) and the admin connection settings.
      </p>
    );
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Instance</th>
          <th>Status</th>
          <th>Active database</th>
          <th>Configuration</th>
          {!compact && <th>Uptime</th>}
          {onRemove && <th />}
        </tr>
      </thead>
      <tbody>
        {list.map((i) => (
          <tr key={i.instance_id}>
            <td>
              <code>{i.instance_id}</code>
              {!compact && <div className="muted small">{i.base_url}</div>}
            </td>
            <td>
              <StateBadge state={i.status} /> <span className="muted small">{timeAgo(i.last_heartbeat_at)}</span>
            </td>
            <td>{i.active_database || '—'}</td>
            <td className="small">
              {i.drift.length === 0 && i.restartPending.length === 0 && <span className="badge ok">up to date</span>}
              {i.drift.map((d) => (
                <div key={d.configType}>
                  <span className="badge warn">behind</span> {TYPE_LABELS[d.configType]}: v{d.applied} of v{d.latest}
                </div>
              ))}
              {i.restartPending.map((d) => (
                <div key={d.configType}>
                  <span className="badge warn">restart pending</span> {TYPE_LABELS[d.configType]} v{d.latest}
                </div>
              ))}
            </td>
            {!compact && <td>{i.uptime_sec != null ? `${Math.round(i.uptime_sec / 60)} min` : '—'}</td>}
            {onRemove && (
              <td>
                {i.status === 'stale' && (
                  <button className="link danger" onClick={() => onRemove(i.instance_id)}>
                    Remove
                  </button>
                )}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function AuditTable({ entries }) {
  if (!entries.length) return <p className="muted">Nothing recorded.</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>When</th>
          <th>Who</th>
          <th>Action</th>
          <th>Setting</th>
          <th>Result</th>
          <th>Details</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.id}>
            <td title={fmtTime(e.at)}>{timeAgo(e.at)}</td>
            <td>{e.actor_email || <span className="muted">system</span>}</td>
            <td>
              <code>{e.action}</code>
            </td>
            <td>
              {e.config_type ? `${TYPE_LABELS[e.config_type] || e.config_type}` : ''}
              {e.to_version ? ` → v${e.to_version}` : ''}
            </td>
            <td>
              <StateBadge state={e.outcome} />
            </td>
            <td className="small">
              {e.detail && e.detail.reason && typeof e.detail.reason === 'string' && <div>“{e.detail.reason}”</div>}
              {e.diff && e.diff.length > 0 && <div className="muted">{e.diff.map((d) => d.path).join(', ')}</div>}
              {e.detail && e.detail.message && <div className="bad-text">{e.detail.message}</div>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
