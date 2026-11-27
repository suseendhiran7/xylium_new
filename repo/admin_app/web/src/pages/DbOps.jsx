import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { fmtTime, timeAgo, useApi } from '../hooks.js';
import { ErrorBox, Loading, PageHeader } from '../components/ui.jsx';

const DB_LABEL = { postgresql: 'PostgreSQL', mongodb: 'MongoDB' };
const JOB_LABEL = { migration: 'Migration', backup: 'Backup', restore: 'Restore' };

const fmtBytes = (n) => {
  if (n === undefined || n === null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
};
const fmtNum = (n) => (n === undefined || n === null ? '—' : Number(n).toLocaleString());
const duration = (a, b) => {
  if (!a) return '—';
  const s = Math.round(((b ? new Date(b) : new Date()) - new Date(a)) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

function JobStatus({ status }) {
  const cls = { running: 'warn', succeeded: 'ok', failed: 'bad', cancelled: 'muted' }[status] || 'muted';
  return <span className={`badge ${cls}`}>{status}</span>;
}

/** Live log of one job; polls while it runs. */
function JobPanel({ jobId, instance, onFinished }) {
  const { can } = useAuth();
  const [pollMs, setPollMs] = useState(1500);
  const state = useApi(`/api/db-ops/jobs/${encodeURIComponent(jobId)}${instance ? `?instance=${encodeURIComponent(instance)}` : ''}`, { pollMs });
  const job = state.data;
  const logRef = useRef(null);
  const wasRunning = useRef(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!job) return;
    if (job.status === 'running') wasRunning.current = true;
    else {
      setPollMs(0);
      if (wasRunning.current) {
        wasRunning.current = false;
        onFinished && onFinished(job);
      }
    }
  }, [job, onFinished]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job && job.log && job.log.length]);

  const cancel = async () => {
    try {
      await api.post(`/api/db-ops/jobs/${encodeURIComponent(jobId)}/cancel`, { instanceId: instance });
      state.reload();
    } catch (e) {
      setError(e);
    }
  };

  if (state.error) return <ErrorBox error={state.error} />;
  if (!job) return <Loading what="Loading job" />;
  return (
    <div>
      <div className="job-head">
        <div>
          <strong>{JOB_LABEL[job.kind] || job.kind}</strong> <JobStatus status={job.status} />
          <div className="muted small">
            {job.params && job.params.target} · started {fmtTime(job.startedAt)} · {duration(job.startedAt, job.finishedAt)}
            {job.params && job.params.configSource === 'instance' && ' · using the instance\'s own settings'}
          </div>
        </div>
        {job.cancellable && can('admin') && (
          <button className="secondary small" onClick={cancel}>
            Stop
          </button>
        )}
      </div>
      <ErrorBox error={error} />
      {job.error && <div className="alert bad">{job.error}</div>}
      <pre className="job-log" ref={logRef}>
        {(job.log || []).join('\n') || 'Starting…'}
      </pre>
    </div>
  );
}

function MigrationCard({ database, instance, busy, onStarted }) {
  const [target, setTarget] = useState('');
  const [steps, setSteps] = useState({ schema: true, data: false, verify: false });
  const [opts, setOpts] = useState({ dryRun: false, reset: false, mode: 'skip' });
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  const effective = target || database.activeDatabase || '';
  const isPg = effective === 'postgresql';

  const run = async () => {
    setError(null);
    setSending(true);
    try {
      const job = await api.post('/api/db-ops/migrate', {
        instanceId: instance,
        targetType: target || null,
        steps: { schema: steps.schema, data: isPg && steps.data, verify: isPg && steps.verify },
        options: opts,
      });
      onStarted(job);
    } catch (e) {
      setError(e);
    } finally {
      setSending(false);
    }
  };

  const toggle = (k) => (e) => setSteps({ ...steps, [k]: e.target.checked });
  return (
    <section className="card">
      <h3>Run migration</h3>
      <p className="muted small">
        Creates or upgrades every table, column, index and unique key the SDK needs in the selected database. Safe to run any time: existing data is
        never dropped. With PostgreSQL selected it can also copy existing data from MongoDB (no duplicates; re-run to resume).
      </p>
      <div className="row">
        <div className="field">
          <label htmlFor="mig-target">Database</label>
          <select id="mig-target" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Active database{database.activeDatabase ? ` (${DB_LABEL[database.activeDatabase]})` : ''}</option>
            <option value="postgresql">PostgreSQL{database.postgresql ? ` — ${database.postgresql}` : ''}</option>
            <option value="mongodb">MongoDB{database.mongodb ? ` — ${database.mongodb}` : ''}</option>
          </select>
        </div>
      </div>
      <div className="check-list">
        <label>
          <input type="checkbox" checked={steps.schema} onChange={toggle('schema')} /> Create / upgrade tables and indexes
        </label>
        <label className={isPg ? '' : 'disabled'} title={isPg ? '' : 'Data copy goes into PostgreSQL only'}>
          <input type="checkbox" checked={isPg && steps.data} disabled={!isPg} onChange={toggle('data')} /> Copy data from MongoDB into PostgreSQL
        </label>
        <label className={isPg ? '' : 'disabled'}>
          <input type="checkbox" checked={isPg && steps.verify} disabled={!isPg} onChange={toggle('verify')} /> Verify the copy (counts, spot checks, duplicates)
        </label>
      </div>
      {isPg && steps.data && (
        <div className="check-list nested">
          <label>
            <input type="checkbox" checked={opts.dryRun} onChange={(e) => setOpts({ ...opts, dryRun: e.target.checked })} /> Dry run (everything is
            rolled back)
          </label>
          <label>
            <input type="checkbox" checked={opts.reset} onChange={(e) => setOpts({ ...opts, reset: e.target.checked })} /> Re-read from the start
            (still no duplicates)
          </label>
          <label>
            <input type="checkbox" checked={opts.mode === 'newer'} onChange={(e) => setOpts({ ...opts, mode: e.target.checked ? 'newer' : 'skip' })} />{' '}
            Update rows whose MongoDB copy is newer
          </label>
        </div>
      )}
      <ErrorBox error={error} />
      <button onClick={run} disabled={busy || sending || (!steps.schema && !(isPg && (steps.data || steps.verify)))}>
        {sending ? 'Starting…' : 'Run migration'}
      </button>
      {busy && <span className="muted small inline-note">A job is running; wait for it to finish.</span>}
    </section>
  );
}

function RestorePanel({ backup, database, instance, busy, onStarted, onClose }) {
  const [mode, setMode] = useState('merge');
  const [safety, setSafety] = useState(true);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);
  const mismatch = backup.databaseType && database.activeDatabase && backup.databaseType !== database.activeDatabase;

  const run = async () => {
    setError(null);
    setSending(true);
    try {
      const job = await api.post('/api/db-ops/restore', {
        instanceId: instance,
        targetType: backup.databaseType || null,
        name: backup.name,
        mode,
        safetyBackup: safety,
        confirm,
      });
      onStarted(job);
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="card restore">
      <div className="job-head">
        <h3>Restore {backup.name}</h3>
        <button className="link" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="muted small">
        {DB_LABEL[backup.databaseType] || backup.databaseType} backup of <code>{backup.database}</code> taken {fmtTime(backup.createdAt)} ·{' '}
        {fmtNum(backup.rows)} rows in {backup.tables ? Object.keys(backup.tables).length : '?'} tables. It is restored into the{' '}
        {DB_LABEL[backup.databaseType]} database of the saved configuration
        {backup.databaseType === 'postgresql' && database.postgresql ? ` (${database.postgresql})` : ''}
        {backup.databaseType === 'mongodb' && database.mongodb ? ` (${database.mongodb})` : ''}.
      </p>
      {mismatch && (
        <div className="alert warn">
          The active database is {DB_LABEL[database.activeDatabase]}, so restored {DB_LABEL[backup.databaseType]} data will not show in the app until
          you switch the active database (or run a migration into it).
        </div>
      )}
      <div className="choice">
        <label className={mode === 'merge' ? 'on' : ''}>
          <input type="radio" name="mode" checked={mode === 'merge'} onChange={() => setMode('merge')} />
          <span>
            <strong>Merge (recommended)</strong>
            <span className="muted small">Adds the backup's rows back. Rows that already exist are kept as they are; nothing is deleted.</span>
          </span>
        </label>
        <label className={mode === 'replace' ? 'on' : ''}>
          <input type="radio" name="mode" checked={mode === 'replace'} onChange={() => setMode('replace')} />
          <span>
            <strong>Replace</strong>
            <span className="muted small">Empties every table in the backup first, so they hold exactly the backed-up data. Newer rows in them are lost.</span>
          </span>
        </label>
      </div>
      {mode === 'replace' && (
        <>
          <div className="check-list">
            <label>
              <input type="checkbox" checked={safety} onChange={(e) => setSafety(e.target.checked)} /> Take a safety backup of the current data first
            </label>
          </div>
          <div className="field">
            <label htmlFor="confirm-replace">
              Type <code>REPLACE</code> to confirm
            </label>
            <input id="confirm-replace" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
          </div>
        </>
      )}
      <ErrorBox error={error} />
      <button className={mode === 'replace' ? 'danger' : ''} onClick={run} disabled={busy || sending || (mode === 'replace' && confirm !== 'REPLACE')}>
        {sending ? 'Starting…' : mode === 'replace' ? 'Replace with this backup' : 'Restore (merge)'}
      </button>
    </section>
  );
}

function BackupsCard({ backups, database, instance, busy, onStarted, onChanged }) {
  const { can } = useAuth();
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [restoring, setRestoring] = useState(null);
  const q = instance ? `?instance=${encodeURIComponent(instance)}` : '';

  const backupNow = async () => {
    setError(null);
    try {
      onStarted(await api.post('/api/db-ops/backups', { instanceId: instance }));
    } catch (e) {
      setError(e);
    }
  };

  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setNotice(null);
    setUploading(true);
    try {
      const meta = await api.upload(`/api/db-ops/backups/upload?name=${encodeURIComponent(file.name)}${instance ? `&instance=${encodeURIComponent(instance)}` : ''}`, file);
      setNotice(`Uploaded ${meta.name}: ${fmtNum(meta.rows)} rows, checked and complete. Use Restore to load it.`);
      onChanged();
      setRestoring(meta);
    } catch (err) {
      setError(err);
    } finally {
      setUploading(false);
    }
  };

  const remove = async (b) => {
    if (!window.confirm(`Delete backup ${b.name}? This cannot be undone.`)) return;
    try {
      await api.del(`/api/db-ops/backups/${encodeURIComponent(b.name)}${q}`);
      onChanged();
    } catch (e) {
      setError(e);
    }
  };

  const list = backups && backups.backups;
  return (
    <>
      <section className="card">
        <div className="job-head">
          <h3>Backups</h3>
          <div className="actions">
            {can('admin') && (
              <label className={`button secondary small ${uploading ? 'disabled' : ''}`}>
                {uploading ? 'Uploading…' : 'Upload backup'}
                <input type="file" accept=".gz,application/gzip" hidden onChange={onFile} disabled={uploading} />
              </label>
            )}
            {can('operator') && (
              <button className="small" onClick={backupNow} disabled={busy}>
                Back up now
              </button>
            )}
          </div>
        </div>
        <p className="muted small">
          Full dump of the active database ({DB_LABEL[database.activeDatabase] || 'per instance settings'}), compressed. Stored on the SDK instance
          {backups && backups.directory ? (
            <>
              {' '}
              in <code>{backups.directory}</code>
            </>
          ) : null}
          . Download one to keep it elsewhere; upload it later to bring the old data back.
        </p>
        <ErrorBox error={error} />
        {notice && <div className="alert ok">{notice}</div>}
        {backups && backups.error ? (
          <ErrorBox error={backups.error} />
        ) : !list ? (
          <Loading />
        ) : list.length === 0 ? (
          <p className="muted">No backups yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Backup</th>
                  <th>Database</th>
                  <th>Taken</th>
                  <th>Rows</th>
                  <th>Size</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((b) => (
                  <tr key={b.name}>
                    <td>
                      <code className="wrap">{b.name}</code>
                      <span className={`badge ${b.trigger === 'scheduled' ? 'ok' : b.trigger === 'pre-restore' ? 'warn' : ''}`}>{b.uploaded ? 'uploaded' : b.trigger || 'unknown'}</span>
                    </td>
                    <td>
                      {DB_LABEL[b.databaseType] || '—'}
                      <div className="muted small">{b.database}</div>
                    </td>
                    <td title={fmtTime(b.createdAt)}>{timeAgo(b.createdAt)}</td>
                    <td>{fmtNum(b.rows)}</td>
                    <td>{fmtBytes(b.sizeBytes)}</td>
                    <td className="row-actions">
                      {can('operator') && (
                        <a className="link" href={`/api/db-ops/backups/${encodeURIComponent(b.name)}/download${q}`}>
                          Download
                        </a>
                      )}
                      {can('admin') && (
                        <>
                          <button className="link" onClick={() => setRestoring(b)} disabled={busy}>
                            Restore
                          </button>
                          <button className="link danger" onClick={() => remove(b)}>
                            Delete
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {restoring && (
        <RestorePanel backup={restoring} database={database} instance={instance} busy={busy} onStarted={onStarted} onClose={() => setRestoring(null)} />
      )}
    </>
  );
}

function ScheduleCard({ schedule, instances, onSaved }) {
  const { can } = useAuth();
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (schedule && !form) setForm({ enabled: schedule.enabled, timeOfDay: schedule.timeOfDay, retentionDays: schedule.retentionDays, instanceId: schedule.instanceId || '' });
  }, [schedule, form]);
  if (!form) return null;
  const edit = can('admin');
  const save = async (e) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await api.put('/api/db-ops/schedule', { ...form, retentionDays: Number(form.retentionDays), instanceId: form.instanceId || null });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err);
    }
  };
  const status = schedule.lastStatus;
  return (
    <form className="card" onSubmit={save}>
      <h3>Daily backup</h3>
      <div className="check-list">
        <label>
          <input type="checkbox" checked={form.enabled} disabled={!edit} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Back up the
          active database every day
        </label>
      </div>
      <div className="row">
        <div className="field">
          <label htmlFor="sch-time">Time ({schedule.timezone})</label>
          <input id="sch-time" type="time" value={form.timeOfDay} disabled={!edit} onChange={(e) => setForm({ ...form, timeOfDay: e.target.value })} required />
        </div>
        <div className="field">
          <label htmlFor="sch-keep">Keep for (days, 0 = forever)</label>
          <input id="sch-keep" type="number" min="0" max="3650" value={form.retentionDays} disabled={!edit} onChange={(e) => setForm({ ...form, retentionDays: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="sch-inst">Run on</label>
          <select id="sch-inst" value={form.instanceId} disabled={!edit} onChange={(e) => setForm({ ...form, instanceId: e.target.value })}>
            <option value="">Any live SDK instance</option>
            {[...new Set([...(instances || []), ...(form.instanceId ? [form.instanceId] : [])])].map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="muted small">
        Last run:{' '}
        {schedule.lastRunAt ? (
          <>
            {fmtTime(schedule.lastRunAt)} <JobStatus status={status || 'unknown'} /> {schedule.lastMessage}
            {schedule.lastBackupName && (
              <>
                {' '}
                → <code>{schedule.lastBackupName}</code>
              </>
            )}
          </>
        ) : status === 'waiting' ? (
          schedule.lastMessage
        ) : (
          'never'
        )}
        . Uploaded backups and safety backups are never deleted by the retention rule.
      </p>
      <ErrorBox error={error} />
      {saved && <div className="alert ok">Schedule saved.</div>}
      {edit && <button type="submit">Save schedule</button>}
    </form>
  );
}

function JobsCard({ jobs, selected, onSelect }) {
  if (!jobs || jobs.error || !jobs.jobs || !jobs.jobs.length) return null;
  return (
    <section className="card">
      <h3>Recent jobs</h3>
      <p className="muted small">Kept in the SDK instance's memory until it restarts.</p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Job</th>
              <th>Status</th>
              <th>Target</th>
              <th>Started</th>
              <th>Took</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {jobs.jobs.map((j) => (
              <tr key={j.id} className={j.id === selected ? 'selected' : ''}>
                <td>
                  {JOB_LABEL[j.kind] || j.kind}
                  {j.params && j.params.mode && <span className="muted small"> · {j.params.mode}</span>}
                  {j.params && j.params.trigger === 'scheduled' && <span className="muted small"> · daily</span>}
                </td>
                <td>
                  <JobStatus status={j.status} />
                </td>
                <td className="small">{j.params && j.params.target}</td>
                <td title={fmtTime(j.startedAt)}>{timeAgo(j.startedAt)}</td>
                <td>{duration(j.startedAt, j.finishedAt)}</td>
                <td className="row-actions">
                  <button className="link" onClick={() => onSelect(j.id)}>
                    Show log
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function DbOps() {
  const [instance, setInstance] = useState(null);
  const [jobId, setJobId] = useState(null);
  const status = useApi(`/api/db-ops/status${instance ? `?instance=${encodeURIComponent(instance)}` : ''}`, { pollMs: 5000 });
  const s = status.data;
  const running = s && s.jobs && s.jobs.running;
  const shownJob = jobId || (running && running.id) || null;

  const started = (job) => {
    setJobId(job.id);
    status.reload();
  };

  return (
    <div>
      <PageHeader title="Migration & backups">
        {s && s.instances.length > 1 && (
          <select value={instance || s.instance || ''} onChange={(e) => setInstance(e.target.value)} aria-label="SDK instance">
            {s.instances.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        )}
      </PageHeader>
      <p className="muted">
        Jobs run on an SDK instance against the database selected on the <Link to="/configs/database">Database</Link> page.
      </p>
      {status.error && <ErrorBox error={status.error} />}
      {!s ? (
        !status.error && <Loading />
      ) : (
        <>
          <section className="card db-summary">
            <div>
              <div className="muted small">Active database</div>
              <strong>{DB_LABEL[s.database.activeDatabase] || 'Per instance settings'}</strong>
            </div>
            <div>
              <div className="muted small">PostgreSQL</div>
              <code>{s.database.postgresql || '—'}</code>
            </div>
            <div>
              <div className="muted small">MongoDB</div>
              <code>{s.database.mongodb || '—'}</code>
            </div>
            <div>
              <div className="muted small">Runs on</div>
              {s.instance ? <code>{s.instance}</code> : <span className="badge bad">no live SDK instance</span>}
            </div>
          </section>
          {s.database.note && <div className="alert info">{s.database.note}</div>}
          {!s.instance && (
            <div className="alert warn">
              No SDK instance is connected to this admin app, so jobs cannot run. Start the SDK with <code>CONFIG_SOURCE=shadow</code> (or{' '}
              <code>admin</code>) and <code>ADMIN_INTERNAL_URL</code> set; see <Link to="/instances">SDK instances</Link>.
            </div>
          )}
          {s.jobs && s.jobs.error && <ErrorBox error={s.jobs.error} />}

          {shownJob && s.instance && (
            <section className="card">
              <JobPanel key={shownJob} jobId={shownJob} instance={s.instance} onFinished={() => status.reload()} />
            </section>
          )}

          {s.instance && (
            <>
              <MigrationCard database={s.database} instance={s.instance} busy={!!running} onStarted={started} />
              <BackupsCard backups={s.backups} database={s.database} instance={s.instance} busy={!!running} onStarted={started} onChanged={status.reload} />
            </>
          )}
          <ScheduleCard schedule={s.schedule} instances={s.instances} onSaved={status.reload} />
          <JobsCard jobs={s.jobs} selected={shownJob} onSelect={setJobId} />
        </>
      )}
    </div>
  );
}
