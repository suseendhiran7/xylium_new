'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const c = require('../src');

describe('registry', () => {
  test('every type has a schema, an apply mode and secret paths', () => {
    for (const [key, t] of Object.entries(c.CONFIG_TYPES)) {
      assert.strictEqual(t.key, key);
      assert.ok(c.APPLY_MODES.includes(t.applyMode), key);
      assert.ok(Array.isArray(t.secretPaths), key);
      assert.strictEqual(typeof t.schema.safeParse, 'function', key);
    }
  });

  test('unknown type → 400 error', () => {
    assert.throws(() => c.getConfigType('nope'), (e) => e.status === 400 && /Known types/.test(e.message));
  });

  test('values equivalent to today\'s .env.example all validate', () => {
    const samples = {
      database: {
        activeDatabase: 'postgresql',
        mongodb: { uri: 'mongodb://localhost:27017/xylium', database: 'xylium', maxPoolSize: 20, minPoolSize: 2, serverSelectionTimeoutMS: 5000, socketTimeoutMS: 30000 },
        postgresql: { host: 'localhost', port: 5432, database: 'postgres', user: 'postgres', password: 'postgres', ssl: false, maxPoolSize: 20, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000 },
      },
      ingestion: { maxBatchEvents: 500, paymentPagePattern: '(payment|checkout|pay|billing)', rawTtlDays: 30 },
      tenants: { allowedTenants: ['tenant_test001', 'tenant_abc123'], tenantApiKeys: { tenant_test001: 'changeme-secret' } },
      'ip-intel': { provider: 'ipapi', apiKey: '', strictness: 1, timeoutMs: 3000, cacheTtlMs: 21600000, cacheMax: 10000, devIp: '' },
      'http-security': { corsOrigins: ['*'], trustProxy: 'loopback, linklocal, uniquelocal', maxPayloadBytes: 262144, rateLimitWindowMs: 60000, rateLimitMax: 3000, ipIntelRateLimitWindowMs: 60000, ipIntelRateLimitMax: 30 },
      'custom-patterns': { patterns: [] },
    };
    for (const [key, data] of Object.entries(samples)) {
      const r = c.parseConfig(key, data);
      assert.ok(r.success, `${key}: ${r.success ? '' : JSON.stringify(r.error.flatten())}`);
    }
  });

  test('type rules: ipqs needs a key, trustProxy=true refused, short API keys refused', () => {
    assert.strictEqual(c.parseConfig('ip-intel', { provider: 'ipqs' }).success, false);
    assert.strictEqual(c.parseConfig('http-security', { trustProxy: true }).success, false);
    assert.strictEqual(c.parseConfig('tenants', { tenantApiKeys: { t1: 'short' } }).success, false);
    assert.strictEqual(c.parseConfig('tenants', { allowedTenants: ['bad tenant!'] }).success, false);
  });

  test('checksum ignores key order', () => {
    assert.strictEqual(c.checksum({ a: 1, b: { c: 2, d: 3 } }), c.checksum({ b: { d: 3, c: 2 }, a: 1 }));
    assert.notStrictEqual(c.checksum({ a: 1 }), c.checksum({ a: 2 }));
    assert.match(c.checksum({}), /^sha256:[a-f0-9]{64}$/);
  });
});

describe('regex safety (paymentPagePattern runs on every event)', () => {
  test('accepts the default and ordinary alternations', () => {
    assert.strictEqual(c.safeRegexSource('(payment|checkout|pay|billing)'), null);
    assert.strictEqual(c.safeRegexSource('^/(checkout|cart)/'), null);
  });
  test('rejects invalid and catastrophic patterns', () => {
    assert.match(c.safeRegexSource('(unclosed'), /Not a valid/);
    assert.match(c.safeRegexSource('(a+)+$'), /Nested quantifier/);
    assert.match(c.safeRegexSource('(.*)*x'), /Nested quantifier/);
    assert.match(c.safeRegexSource('(a|aa)+$'), /overlapping/);
    assert.strictEqual(c.parseConfig('ingestion', { paymentPagePattern: '(a+)+$' }).success, false);
  });
});

describe('secrets', () => {
  const data = { postgresql: { host: 'h', password: 'pw' }, mongodb: { uri: 'mongodb://u:p@h/x' } };
  const paths = c.getConfigType('database').secretPaths;

  test('mask shows set/not set only', () => {
    const m = c.maskSecrets(data, paths);
    assert.deepStrictEqual(m.postgresql.password, { set: true });
    assert.deepStrictEqual(m.mongodb.uri, { set: true });
    assert.strictEqual(m.postgresql.host, 'h');
    assert.ok(!JSON.stringify(m).includes('pw'));
    assert.strictEqual(data.postgresql.password, 'pw', 'input not mutated');
  });

  test('split + merge round-trips', () => {
    const { publicData, secrets } = c.splitSecrets(data, paths);
    assert.ok(!JSON.stringify(publicData).includes('pw'));
    assert.deepStrictEqual(c.mergeSecrets(publicData, secrets), data);
  });

  test('blank or UNCHANGED secrets keep the previous value', () => {
    const input = { postgresql: { host: 'h2', password: c.UNCHANGED }, mongodb: { uri: '' } };
    const out = c.keepUnchangedSecrets(input, data, paths);
    assert.strictEqual(out.postgresql.password, 'pw');
    assert.strictEqual(out.mongodb.uri, 'mongodb://u:p@h/x');
    assert.strictEqual(out.postgresql.host, 'h2');
    const changed = c.keepUnchangedSecrets({ postgresql: { password: 'new' } }, data, paths);
    assert.strictEqual(changed.postgresql.password, 'new');
  });

  test('map secrets are masked and merged per entry', () => {
    const tp = c.getConfigType('tenants').secretPaths;
    const prev = { allowedTenants: [], tenantApiKeys: { t1: 'key-one-111111', t2: 'key-two-222222' } };
    assert.deepStrictEqual(c.maskSecrets(prev, tp).tenantApiKeys, { t1: { set: true }, t2: { set: true } });
    const next = c.keepUnchangedSecrets({ tenantApiKeys: { t1: c.UNCHANGED, t3: 'key-three-3333' } }, prev, tp);
    assert.deepStrictEqual(next.tenantApiKeys, { t1: 'key-one-111111', t3: 'key-three-3333' });
    assert.deepStrictEqual(c.keepUnchangedSecrets({ tenantApiKeys: c.UNCHANGED }, prev, tp).tenantApiKeys, prev.tenantApiKeys);
  });
});

describe('request signing', () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const getSecret = (id) => (id === 'k1' ? secret : undefined);
  const body = JSON.stringify({ configType: 'database', version: 12 });
  const sign = (over = {}) => c.signRequest({ keyId: 'k1', secret, method: 'POST', path: '/internal/config/changed', body, ...over });
  const verify = (headers, over = {}) =>
    c.verifyRequest({ getSecret, headers, method: 'POST', path: '/internal/config/changed', rawBody: body, ...over });

  test('valid request verifies', () => {
    assert.deepStrictEqual(verify(sign()), { ok: true, keyId: 'k1' });
  });

  test('tampered body, path or method fails', () => {
    const h = sign();
    assert.strictEqual(verify(h, { rawBody: body.replace('12', '13') }).reason, 'signature mismatch');
    assert.strictEqual(verify(h, { path: '/internal/config/validate' }).reason, 'signature mismatch');
    assert.strictEqual(verify(h, { method: 'GET' }).reason, 'signature mismatch');
  });

  test('stale timestamp, unknown key, missing headers fail', () => {
    assert.strictEqual(verify(sign({ now: Date.now() - 10 * 60 * 1000 })).reason, 'timestamp outside allowed window');
    assert.strictEqual(verify(sign({ keyId: 'k2' })).reason, 'unknown key id');
    assert.strictEqual(verify({}).reason, 'missing signature headers');
  });

  test('replay is rejected when a nonce cache is used', () => {
    const cache = new c.NonceCache();
    const h = sign();
    assert.strictEqual(verify(h, { nonceCache: cache }).ok, true);
    assert.strictEqual(verify(h, { nonceCache: cache }).reason, 'replayed nonce');
  });

  test('short secrets are refused when signing', () => {
    assert.throws(() => c.signRequest({ keyId: 'k', secret: 'short', method: 'GET', path: '/' }), /at least 32/);
  });
});

describe('messages', () => {
  test('the notification from the design doc parses', () => {
    const r = c.messages.ConfigChangedNotice.safeParse({
      changeId: 'chg_01JD8XQ7R4',
      configType: 'database',
      action: 'updated',
      version: 12,
      revision: 341,
      applyMode: 'reconnect',
      changedAt: '2026-11-19T10:00:00Z',
      changedBy: 'usr_7f3c',
    });
    assert.ok(r.success, r.success ? '' : JSON.stringify(r.error.flatten()));
  });

  test('a notification cannot smuggle config data', () => {
    const r = c.messages.ConfigChangedNotice.strict().safeParse({
      changeId: 'chg_01JD8XQ7R4', configType: 'database', action: 'updated', version: 1, revision: 1,
      applyMode: 'reconnect', changedAt: '2026-11-19T10:00:00Z', data: { postgresql: { password: 'x' } },
    });
    assert.strictEqual(r.success, false);
  });
});

describe('custom patterns', () => {
  const code = `(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {
  document.addEventListener('click', function (e) { core.pushEvent({ type: 'rage_click' }); }, { passive: true });
});
`;
  const sha = crypto.createHash('sha256').update(code).digest('hex');

  test('a clean, hashed pattern is accepted', () => {
    const r = c.parseConfig('custom-patterns', { patterns: [{ filename: 'xylium-rage.js', description: 'rage clicks', version: 1, sha256: sha, code }] });
    assert.ok(r.success, r.success ? '' : JSON.stringify(r.error.flatten()));
  });

  test('hash mismatch, unsafe code and path filenames are refused', () => {
    const base = { filename: 'xylium-rage.js', description: 'd', version: 1, sha256: sha, code };
    assert.strictEqual(c.parseConfig('custom-patterns', { patterns: [{ ...base, sha256: 'a'.repeat(64) }] }).success, false);
    const bad = code.replace("{ type: 'rage_click' }", "{ type: 'x', v: e.target.value }");
    const badSha = crypto.createHash('sha256').update(bad).digest('hex');
    assert.strictEqual(c.parseConfig('custom-patterns', { patterns: [{ ...base, code: bad, sha256: badSha }] }).success, false);
    assert.strictEqual(c.parseConfig('custom-patterns', { patterns: [{ ...base, filename: '../evil.js' }] }).success, false);
  });
});
