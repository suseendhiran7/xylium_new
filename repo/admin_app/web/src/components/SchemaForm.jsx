import { useState } from 'react';
import { UNCHANGED } from '../api.js';

/**
 * Renders a JSON Schema (generated from the shared zod schemas) as a form.
 * Secret fields are write-only: the API sends `{ set: boolean }`; the form
 * keeps them blank, and blank is sent as "keep the stored value".
 */

const HELP = {
  activeDatabase: 'Where NEW events are written. Existing history stays in the previous database.',
  maxBatchEvents: 'Maximum events accepted in one /collect request.',
  rawTtlDays: 'Delete raw events older than this many days. 0 keeps them forever.',
  allowedTenants: 'One tenant id per line. Empty allows every tenant (development only).',
  tenantApiKeys: 'Server-to-server keys per tenant (used by /identify and payment verification).',
  ipWhitelist:
    'Each tenant has its own list. When a tenant has entries, its requests (/collect, /ip-intel, /identify) are accepted only from those IPs; others get 403. A tenant with no entries accepts any IP.',
  provider: 'none disables lookups; ipapi is free; ipqs needs an API key.',
  corsOrigins: 'One origin per line, e.g. https://shop.example.com. Empty allows any origin.',
  trustProxy: 'Hop count (e.g. 1) or subnet list. Never "true" behind a public load balancer.',
  uri: 'Full MongoDB connection string, including credentials.',
  ssl: 'Use TLS for the PostgreSQL connection.',
};

const LABELS = {
  mongodb: 'MongoDB', postgresql: 'PostgreSQL', uri: 'Connection URI', ssl: 'Use SSL/TLS', devIp: 'Development IP override',
  serverSelectionTimeoutMS: 'Server selection timeout (ms)', socketTimeoutMS: 'Socket timeout (ms)',
  idleTimeoutMillis: 'Idle timeout (ms)', connectionTimeoutMillis: 'Connection timeout (ms)',
  tenantApiKeys: 'Tenant API keys', ipWhitelist: 'IP whitelist (per tenant)', ipIntelRateLimitWindowMs: 'IP intel rate-limit window (ms)', ipIntelRateLimitMax: 'IP intel rate-limit max requests',
  rawTtlDays: 'Raw event retention (days)', corsOrigins: 'CORS origins', maxPayloadBytes: 'Max payload (bytes)',
};
// camelCase → sentence case, with known acronyms kept.
const label = (key) =>
  LABELS[key] ||
  key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/ ms$/, ' (ms)')
    .replace(/\bip\b/gi, 'IP')
    .replace(/\bapi\b/gi, 'API');

const isMasked = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && 'set' in v;

/** Turn API data (secrets masked) into form state. */
export function toFormState(data, secretPaths) {
  const state = JSON.parse(JSON.stringify(data || {}));
  for (const p of secretPaths) {
    const keys = p.split('.');
    let o = state;
    for (let i = 0; i < keys.length - 1 && o; i++) o = o[keys[i]];
    const v = o ? o[keys.at(-1)] : undefined;
    if (isMasked(v)) o[keys.at(-1)] = { __secret: true, set: v.set, value: '' };
    else if (v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(isMasked)) {
      // map secret (e.g. tenantApiKeys): names visible, values write-only
      o[keys.at(-1)] = { __secretMap: true, rows: Object.keys(v).map((k) => ({ key: k, value: '', stored: true })) };
    }
  }
  return state;
}

/** Turn form state back into an API payload: untouched secrets → UNCHANGED. */
export function fromFormState(state) {
  const walk = (v) => {
    if (v && typeof v === 'object' && v.__secret) return v.value === '' ? UNCHANGED : v.value;
    if (v && typeof v === 'object' && v.__secretMap) {
      return Object.fromEntries(v.rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value === '' && r.stored ? UNCHANGED : r.value]));
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(state);
}

function Field({ name, schema, value, onChange, path, root }) {
  const id = `f-${path.join('-')}`;
  const help = HELP[name];
  const common = { id, name: path.join('.') };

  // tenant id -> list of strings (the per-tenant IP whitelist)
  if (schema.type === 'object' && schema.additionalProperties && schema.additionalProperties.type === 'array') {
    return (
      <div className="field">
        <label htmlFor={id}>{label(name)}</label>
        {help && <p className="help">{help}</p>}
        <TenantListEditor id={id} value={value || {}} onChange={onChange} tenants={(root && root.allowedTenants) || []} />
      </div>
    );
  }

  if (value && typeof value === 'object' && value.__secretMap) {
    return (
      <div className="field">
        <label htmlFor={id}>{label(name)}</label>
        <SecretMapEditor id={id} value={value} onChange={onChange} />
        {help && <p className="help">{help} Stored keys are never shown; leave one blank to keep it.</p>}
      </div>
    );
  }

  // Secret string
  if (value && typeof value === 'object' && value.__secret) {
    return (
      <div className="field">
        <label htmlFor={id}>{label(name)}</label>
        <input
          {...common}
          type="password"
          autoComplete="new-password"
          value={value.value}
          placeholder={value.set ? 'Stored — leave blank to keep' : 'Not set'}
          onChange={(e) => onChange({ ...value, value: e.target.value })}
        />
        {help && <p className="help">{help}</p>}
      </div>
    );
  }

  if (schema.type === 'object' && schema.properties) {
    return (
      <fieldset className="group">
        <legend>{label(name)}</legend>
        {Object.entries(schema.properties).map(([k, s]) => (
          <Field key={k} name={k} schema={s} value={value ? value[k] : undefined} path={[...path, k]} root={root} onChange={(v) => onChange({ ...(value || {}), [k]: v })} />
        ))}
      </fieldset>
    );
  }

  if (schema.type === 'object' && schema.additionalProperties) {
    return (
      <div className="field">
        <label htmlFor={id}>{label(name)}</label>
        <KeyValueEditor id={id} value={value || {}} onChange={onChange} />
        {help && <p className="help">{help}</p>}
      </div>
    );
  }

  let input;
  if (schema.enum) {
    input = (
      <select {...common} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {schema.enum.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  } else if (schema.type === 'boolean') {
    return (
      <div className="field checkbox">
        <label>
          <input {...common} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> {label(name)}
        </label>
        {help && <p className="help">{help}</p>}
      </div>
    );
  } else if (schema.type === 'integer' || schema.type === 'number') {
    input = (
      <input
        {...common}
        type="number"
        value={value ?? ''}
        min={schema.minimum}
        max={schema.maximum}
        step={schema.type === 'integer' ? 1 : 'any'}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    );
  } else if (schema.type === 'array') {
    input = (
      <textarea
        {...common}
        rows={Math.min(8, Math.max(3, (value || []).length + 1))}
        value={(value || []).join('\n')}
        onChange={(e) => onChange(e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))}
      />
    );
  } else if (schema.anyOf) {
    // e.g. trustProxy: boolean | integer | string
    input = (
      <input
        {...common}
        type="text"
        value={value === undefined ? '' : String(value)}
        onChange={(e) => {
          const t = e.target.value;
          onChange(t === 'true' ? true : t === 'false' ? false : /^\d+$/.test(t) ? Number(t) : t);
        }}
      />
    );
  } else {
    input = <input {...common} type="text" value={value ?? ''} onChange={(e) => onChange(e.target.value)} spellCheck={false} />;
  }

  return (
    <div className="field">
      <label htmlFor={id}>{label(name)}</label>
      {input}
      {help && <p className="help">{help}</p>}
    </div>
  );
}

function SecretMapEditor({ id, value, onChange }) {
  const rows = value.rows;
  const set = (next) => onChange({ ...value, rows: next });
  return (
    <div className="kv" id={id}>
      {rows.length === 0 && <p className="muted small">None stored.</p>}
      {rows.map((r, i) => (
        <div className="kv-row" key={i}>
          <input placeholder="tenant id" value={r.key} readOnly={r.stored} onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
          <input
            type="password"
            autoComplete="new-password"
            placeholder={r.stored ? 'Stored — leave blank to keep' : 'New key (12+ characters)'}
            value={r.value}
            onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
          />
          <button type="button" className="link danger" onClick={() => set(rows.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="secondary small" onClick={() => set([...rows, { key: '', value: '', stored: false }])}>
        Add key
      </button>
    </div>
  );
}

function KeyValueEditor({ id, value, onChange, secret }) {
  const [rows, setRows] = useState(() => Object.entries(value || {}));
  const push = (next) => {
    setRows(next);
    onChange(Object.fromEntries(next.filter(([k]) => k.trim() !== '')));
  };
  return (
    <div className="kv" id={id}>
      {rows.map(([k, v], i) => (
        <div className="kv-row" key={i}>
          <input placeholder="tenant id" value={k} onChange={(e) => push(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))} />
          <input
            placeholder="key"
            type={secret ? 'password' : 'text'}
            autoComplete="new-password"
            value={v}
            onChange={(e) => push(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))}
          />
          <button type="button" className="link" onClick={() => push(rows.filter((_, j) => j !== i))} aria-label="Remove">
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="secondary small" onClick={() => push([...rows, ['', '']])}>
        Add
      </button>
    </div>
  );
}

// Loose browser-side check so typos are flagged while typing; the server
// validates every entry exactly before anything is saved.
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/(3[0-2]|[12]?\d))?$/;
const IPV6 = /^[0-9a-f:.]*:[0-9a-f:.]*(\/(12[0-8]|1[01]\d|[1-9]?\d))?$/i;
const looksLikeIp = (s) => IPV4.test(s) || IPV6.test(s);
const splitLines = (text) => text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

/** Per-tenant lists: one row per tenant, entries one per line. */
function TenantListEditor({ id, value, onChange, tenants }) {
  const [rows, setRows] = useState(() => Object.entries(value || {}).map(([tenant, list]) => ({ tenant, text: (list || []).join('\n') })));
  const push = (next) => {
    setRows(next);
    onChange(Object.fromEntries(next.filter((r) => r.tenant.trim()).map((r) => [r.tenant.trim(), splitLines(r.text)])));
  };
  const used = new Set(rows.map((r) => r.tenant.trim()));
  const unused = tenants.filter((t) => !used.has(t));
  const listId = `${id}-tenants`;
  return (
    <div className="tenant-lists" id={id}>
      <datalist id={listId}>
        {unused.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      {rows.length === 0 && <p className="muted small">No tenant has an IP whitelist; every tenant accepts any IP.</p>}
      {rows.map((r, i) => {
        const entries = splitLines(r.text);
        const bad = entries.filter((e) => !looksLikeIp(e));
        const dup = r.tenant.trim() && rows.some((x, j) => j !== i && x.tenant.trim() === r.tenant.trim());
        const unknown = r.tenant.trim() && tenants.length > 0 && !tenants.includes(r.tenant.trim());
        return (
          <div className="tenant-list" key={i}>
            <div className="tenant-list-head">
              <input
                placeholder="tenant id"
                list={listId}
                value={r.tenant}
                aria-label="Tenant id"
                onChange={(e) => push(rows.map((x, j) => (j === i ? { ...x, tenant: e.target.value } : x)))}
              />
              <span className="muted small">
                {entries.length === 0 ? 'no entries: any IP allowed' : `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}: only these IPs allowed`}
              </span>
              <button type="button" className="link danger" onClick={() => push(rows.filter((_, j) => j !== i))}>
                Remove tenant
              </button>
            </div>
            <textarea
              rows={Math.min(10, Math.max(3, entries.length + 1))}
              placeholder={'203.0.113.7\n203.0.113.0/24\n2001:db8::/32'}
              aria-label={`IP whitelist for ${r.tenant || 'tenant'}`}
              spellCheck={false}
              value={r.text}
              onChange={(e) => push(rows.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))}
            />
            {bad.length > 0 && <p className="field-error small">Not an IP address or CIDR range: {bad.join(', ')}</p>}
            {dup && <p className="field-error small">This tenant is listed twice; only one list is kept.</p>}
            {unknown && <p className="muted small">Note: {r.tenant.trim()} is not in the allowed tenants list above.</p>}
          </div>
        );
      })}
      <button type="button" className="secondary small" onClick={() => push([...rows, { tenant: unused[0] || '', text: '' }])}>
        Add tenant IP whitelist
      </button>
    </div>
  );
}

export function SchemaForm({ schema, value, onChange }) {
  if (!schema || !schema.properties) return null;
  return (
    <div className="schema-form">
      {Object.entries(schema.properties).map(([k, s]) => (
        <Field key={k} name={k} schema={s} value={value ? value[k] : undefined} path={[k]} root={value} onChange={(v) => onChange({ ...value, [k]: v })} />
      ))}
    </div>
  );
}
