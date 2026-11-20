import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi } from '../hooks.js';
import { SchemaForm, toFormState, fromFormState } from '../components/SchemaForm.jsx';
import { RolloutPanel } from '../components/Rollout.jsx';
import { ApplyModeBadge, DiffTable, ErrorBox, Loading, PageHeader, StateBadge, TYPE_LABELS } from '../components/ui.jsx';

const ROLE_RANK = ['viewer', 'operator', 'admin', 'superadmin'];

export default function ConfigEdit({ typeOverride }) {
  const params = useParams();
  const type = typeOverride || params.type;
  const { can } = useAuth();
  const types = useApi('/api/configs/types');
  const current = useApi(`/api/configs/${type}`);
  const [form, setForm] = useState(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [check, setCheck] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);
  const [confirmText, setConfirmText] = useState('');

  const meta = useMemo(() => types.data && types.data.types.find((t) => t.key === type), [types.data, type]);
  const canWrite = meta && can(meta.writeRole);
  const isDb = type === 'database';

  useEffect(() => {
    if (current.data && meta) setForm(toFormState(current.data.data, meta.secretPaths));
  }, [current.data, meta]);

  useEffect(() => {
    setCheck(null);
  }, [form]);

  if (types.error || current.error) return <ErrorBox error={types.error || current.error} />;
  if (!meta || !form || !current.data) return <Loading />;

  const payload = () => fromFormState(form);
  const dbTargetChanged = isDb && current.data.version > 0 && form.activeDatabase !== current.data.data.activeDatabase;

  const runCheck = async () => {
    setBusy(true);
    setError(null);
    try {
      setCheck(await api.post(`/api/configs/${type}/validate`, { data: payload() }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.put(`/api/configs/${type}`, { data: payload(), expectedVersion: current.data.version, reason });
      setSaved(r);
      setReason('');
      setConfirmText('');
      await current.reload();
    } catch (e2) {
      setError(e2);
      if (e2.code === 'prepare_failed') setCheck({ ok: false, instances: e2.details });
    } finally {
      setBusy(false);
    }
  };

  const dbCheckPassed = !isDb || (check && check.ok);
  const confirmOk = !isDb || confirmText === form.activeDatabase;
  const canSave = canWrite && reason.trim().length >= 3 && dbCheckPassed && confirmOk && !busy;

  return (
    <div>
      <PageHeader title={TYPE_LABELS[type] || type} back={{ to: '/configs', label: 'Configuration' }}>
        <ApplyModeBadge mode={meta.applyMode} />
        <Link className="button secondary" to={`/configs/${type}/history`}>
          History
        </Link>
      </PageHeader>
      <p className="muted">
        {meta.description}. Current version: <strong>{current.data.version || 'none (defaults shown)'}</strong>
        {current.data.reason && <> — “{current.data.reason}”</>}
      </p>
      {!canWrite && <div className="alert info">You can view this configuration. Changing it requires the {meta.writeRole} role.</div>}

      <form onSubmit={save} className="card">
        <fieldset disabled={!canWrite || busy} className="plain">
          <SchemaForm schema={meta.jsonSchema} value={form} onChange={setForm} />

          {dbTargetChanged && (
            <div className="alert warn">
              Switching from <strong>{current.data.data.activeDatabase}</strong> to <strong>{form.activeDatabase}</strong> changes where new events are written.
              Historical events stay in {current.data.data.activeDatabase}, so user history and risk baselines start fresh until the data is migrated
              (MongoDB → PostgreSQL: <code>npm run migrate</code> in node_app).
            </div>
          )}

          <div className="field">
            <label htmlFor="reason">Reason for this change</label>
            <input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this changing? (kept in the audit log)" required minLength={3} />
          </div>

          {isDb && (
            <div className="field">
              <label htmlFor="confirm">
                Type <code>{form.activeDatabase}</code> to confirm
              </label>
              <input id="confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
            </div>
          )}

          <div className="form-actions">
            <button type="button" className="secondary" onClick={runCheck} disabled={busy || !canWrite}>
              {isDb ? 'Test on SDK instances' : 'Check'}
            </button>
            <button type="submit" disabled={!canSave}>
              {busy ? 'Working…' : 'Save new version'}
            </button>
            {isDb && !dbCheckPassed && <span className="muted small">Test the settings on the SDK instances first.</span>}
          </div>
        </fieldset>
      </form>

      <ErrorBox error={error} />

      {check && (
        <section className={`card ${check.ok ? '' : 'bad-border'}`}>
          <h3>{check.ok ? 'Check passed' : 'Check failed'}</h3>
          {check.instances && (
            <>
              {check.instances.warning && <p className="alert warn">{check.instances.warning}</p>}
              {check.instances.instances && check.instances.instances.length > 0 && (
                <table className="table">
                  <thead>
                    <tr>
                      <th>SDK instance</th>
                      <th>Result</th>
                      <th>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {check.instances.instances.map((i) => (
                      <tr key={i.instanceId}>
                        <td>
                          <code>{i.instanceId}</code>
                        </td>
                        <td>
                          <StateBadge state={i.ok ? 'success' : 'failure'} />
                        </td>
                        <td className="small">{i.ok ? `${(i.result && i.result.latencyMs) ?? '?'} ms` : i.error}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </section>
      )}

      {saved && (
        <>
          <div className="alert ok">
            Saved version {saved.version}. {meta.applyMode === 'restart' ? 'It takes effect when each SDK instance restarts.' : 'SDK instances are applying it now.'}
          </div>
          <section className="card">
            <h3>What changed</h3>
            <DiffTable changes={saved.diff} />
          </section>
          <RolloutPanel type={type} version={saved.version} canRetry={can('operator')} />
        </>
      )}
    </div>
  );
}

export { ROLE_RANK };
