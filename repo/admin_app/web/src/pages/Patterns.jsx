import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';
import { useApi } from '../hooks.js';
import { RolloutPanel } from '../components/Rollout.jsx';
import { ApplyModeBadge, DiffTable, ErrorBox, Loading, PageHeader } from '../components/ui.jsx';

/**
 * Custom SDK pattern files. Saving runs the same privacy validator the SDK
 * uses (no raw keystrokes, field values, clipboard content, own network calls);
 * published files are written into the SDK folder by every instance.
 */
export default function Patterns() {
  const { can } = useAuth();
  const current = useApi('/api/configs/custom-patterns');
  const [patterns, setPatterns] = useState(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    if (current.data) setPatterns((current.data.data.patterns || []).map((p) => ({ filename: p.filename, description: p.description, code: p.code, version: p.version })));
  }, [current.data]);

  if (current.error) return <ErrorBox error={current.error} />;
  if (!patterns) return <Loading />;
  const canWrite = can('operator');

  const update = (i, patch) => setPatterns(patterns.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  const loadFile = (i, file) => {
    const r = new FileReader();
    r.onload = () => update(i, { code: String(r.result), filename: patterns[i].filename || file.name });
    r.readAsText(file);
  };

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.put('/api/configs/custom-patterns', {
        data: { patterns: patterns.map(({ filename, description, code }) => ({ filename, description, code })) },
        expectedVersion: current.data.version,
        reason,
      });
      setSaved(r);
      setReason('');
      await current.reload();
    } catch (e2) {
      setError(e2);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title="Custom patterns">
        <ApplyModeBadge mode="hot" />
        <Link className="button secondary" to="/configs/custom-patterns/history">
          History
        </Link>
      </PageHeader>
      <p className="muted">
        Extra event-catcher modules served from the SDK folder (load them on a page with a <code>&lt;script&gt;</code> tag). Every file is checked by the privacy
        validator before it can be saved. Current version: <strong>{current.data.version || 'none'}</strong>
      </p>

      <form onSubmit={save}>
        <fieldset disabled={!canWrite || busy} className="plain">
          {patterns.length === 0 && <p className="card muted">No custom patterns published.</p>}
          {patterns.map((p, i) => (
            <section className="card" key={i}>
              <div className="pattern-head">
                <div className="field grow">
                  <label>File name</label>
                  <input value={p.filename} onChange={(e) => update(i, { filename: e.target.value })} placeholder="xylium-custom-example.js" pattern="[\w.\-]+\.js" required />
                </div>
                <div className="field grow">
                  <label>Description</label>
                  <input value={p.description} onChange={(e) => update(i, { description: e.target.value })} required />
                </div>
                {p.version && <span className="badge muted">file v{p.version}</span>}
              </div>
              <div className="pattern-actions">
                <button type="button" className="link" onClick={() => setOpen(open === i ? null : i)}>
                  {open === i ? 'Hide code' : 'Show code'}
                </button>
                <label className="link">
                  Upload .js
                  <input type="file" accept=".js,text/javascript" hidden onChange={(e) => e.target.files[0] && loadFile(i, e.target.files[0])} />
                </label>
                <button type="button" className="link danger" onClick={() => setPatterns(patterns.filter((_, j) => j !== i))}>
                  Unpublish
                </button>
              </div>
              {open === i && <textarea className="code" rows={16} value={p.code || ''} onChange={(e) => update(i, { code: e.target.value })} spellCheck={false} />}
            </section>
          ))}
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setPatterns([...patterns, { filename: '', description: '', code: "(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {\n  // core.pushEvent({ type: 'my_event' });\n});\n" }]);
              setOpen(patterns.length);
            }}
          >
            Add pattern
          </button>

          <div className="card">
            <div className="field">
              <label htmlFor="reason">Reason for this change</label>
              <input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={3} />
            </div>
            <button type="submit" disabled={!canWrite || busy || reason.trim().length < 3}>
              {busy ? 'Saving…' : 'Validate and publish'}
            </button>
          </div>
        </fieldset>
      </form>

      <ErrorBox error={error} />
      {saved && (
        <>
          <div className="alert ok">Published version {saved.version}.</div>
          <section className="card">
            <h3>What changed</h3>
            <DiffTable changes={saved.diff.map((d) => ({ ...d, from: d.path.endsWith('.code') && d.from ? '(previous code)' : d.from, to: d.path.endsWith('.code') && d.to ? '(new code)' : d.to }))} />
          </section>
          <RolloutPanel type="custom-patterns" version={saved.version} canRetry={can('operator')} />
        </>
      )}
    </div>
  );
}
