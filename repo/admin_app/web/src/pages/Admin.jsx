import { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi } from '../hooks.js';
import { ErrorBox, Loading, PageHeader, TYPE_LABELS } from '../components/ui.jsx';
import { AuditTable, InstancesTable } from './Overview.jsx';

export function Instances() {
  const { can } = useAuth();
  const state = useApi('/api/instances', { pollMs: 5000 });
  const [error, setError] = useState(null);
  const remove = async (id) => {
    try {
      await api.del(`/api/instances/${encodeURIComponent(id)}`);
      state.reload();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div>
      <PageHeader title="SDK instances" />
      <p className="muted">Instances check in every 30 seconds. One that has not checked in for 90 seconds is shown as stale and is not notified.</p>
      <ErrorBox error={error} />
      <section className="card">
        <InstancesTable state={state} onRemove={can('admin') ? remove : null} />
      </section>
    </div>
  );
}

export function Audit() {
  const [filters, setFilters] = useState({ configType: '', action: '', actor: '' });
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const state = useApi(`/api/audit?limit=200${qs ? `&${qs}` : ''}`);
  const set = (k) => (e) => setFilters({ ...filters, [k]: e.target.value });
  return (
    <div>
      <PageHeader title="Audit log">
        <a className="button secondary" href={`/api/audit?format=csv&limit=1000${qs ? `&${qs}` : ''}`}>
          Export CSV
        </a>
      </PageHeader>
      <div className="filters card">
        <select value={filters.configType} onChange={set('configType')} aria-label="Setting">
          <option value="">All settings</option>
          {Object.entries(TYPE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select value={filters.action} onChange={set('action')} aria-label="Action">
          <option value="">All actions</option>
          {['config.update', 'config.rollback', 'config.import', 'db.validate', 'login', 'login.failed', 'logout', 'user.create', 'user.update', 'rollout.retry', 'instance.remove'].map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <input placeholder="Who (email contains)" value={filters.actor} onChange={set('actor')} />
      </div>
      <section className="card">{state.error ? <ErrorBox error={state.error} /> : state.data ? <AuditTable entries={state.data.entries} /> : <Loading />}</section>
    </div>
  );
}

const ROLES = ['viewer', 'operator', 'admin', 'superadmin'];
const ROLE_HELP = {
  viewer: 'read only',
  operator: 'ingestion, IP intel, custom patterns',
  admin: '+ database, tenants, HTTP security, rollbacks, audit',
  superadmin: '+ user management',
};

export function Users() {
  const { user: me } = useAuth();
  const state = useApi('/api/users');
  const [form, setForm] = useState({ email: '', role: 'viewer', password: '' });
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const create = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post('/api/users', form);
      setNotice(`Created ${form.email}. Share the password with them through a secure channel.`);
      setForm({ email: '', role: 'viewer', password: '' });
      state.reload();
    } catch (e2) {
      setError(e2);
    }
  };

  const patch = async (id, body, msg) => {
    setError(null);
    try {
      await api.patch(`/api/users/${id}`, body);
      setNotice(msg);
      state.reload();
    } catch (e) {
      setError(e);
    }
  };

  const resetPassword = (u) => {
    const pw = window.prompt(`New password for ${u.email} (12+ characters):`);
    if (pw) patch(u.id, { password: pw }, `Password reset for ${u.email}; their sessions were signed out.`);
  };

  return (
    <div>
      <PageHeader title="Users" />
      <ErrorBox error={error} />
      {notice && <div className="alert ok">{notice}</div>}
      <section className="card">
        {!state.data ? (
          <Loading />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last sign-in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {state.data.users.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>
                    <select value={u.role} disabled={u.id === me.id} onChange={(e) => patch(u.id, { role: e.target.value }, `${u.email} is now ${e.target.value}.`)}>
                      {ROLES.map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                  </td>
                  <td>{u.disabled ? <span className="badge bad">disabled</span> : u.locked_until && new Date(u.locked_until) > new Date() ? <span className="badge warn">locked</span> : <span className="badge ok">active</span>}</td>
                  <td>{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : '—'}</td>
                  <td className="row-actions">
                    <button className="link" onClick={() => resetPassword(u)}>
                      Reset password
                    </button>
                    {u.id !== me.id && (
                      <button className="link danger" onClick={() => patch(u.id, { disabled: !u.disabled }, `${u.email} ${u.disabled ? 'enabled' : 'disabled'}.`)}>
                        {u.disabled ? 'Enable' : 'Disable'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <form className="card" onSubmit={create}>
        <h3>Add user</h3>
        <div className="row">
          <div className="field grow">
            <label htmlFor="u-email">Email</label>
            <input id="u-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          </div>
          <div className="field">
            <label htmlFor="u-role">Role</label>
            <select id="u-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r} — {ROLE_HELP[r]}
                </option>
              ))}
            </select>
          </div>
          <div className="field grow">
            <label htmlFor="u-pw">Initial password (12+ characters)</label>
            <input id="u-pw" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required minLength={12} />
          </div>
        </div>
        <button type="submit">Add user</button>
      </form>
    </div>
  );
}
