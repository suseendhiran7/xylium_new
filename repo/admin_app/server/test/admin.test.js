'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const request = require('supertest');
const { SKIP, setupEnv, teardown, createUser, login, signedInternal, ADMIN_TO_SDK_SECRET } = require('./helpers');

describe('Admin Application backend', { skip: SKIP }, () => {
  let dbName;
  let pub;
  let internal;
  let owner;
  let fakeSdk;
  const fakeSdkState = { notices: [], validateOk: true, validateCalls: 0 };

  before(async () => {
    // A fake SDK instance that checks the admin's signature like the real one.
    const { verifyRequest } = require('@xylium/config');
    const sdkApp = express();
    sdkApp.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString(); } }));
    sdkApp.use((req, res, next) => {
      const r = verifyRequest({ getSecret: (id) => (id === 'admin-1' ? ADMIN_TO_SDK_SECRET : undefined), headers: req.headers, method: req.method, path: req.originalUrl, rawBody: req.rawBody || '' });
      if (!r.ok) return res.status(401).json({ error: r.reason });
      next();
    });
    sdkApp.post('/internal/config/changed', (req, res) => {
      fakeSdkState.notices.push(req.body);
      res.status(202).json({ accepted: true });
    });
    sdkApp.post('/internal/config/validate', (req, res) => {
      fakeSdkState.validateCalls++;
      res.json(fakeSdkState.validateOk ? { ok: true, result: { ok: true } } : { ok: false, result: { ok: false, error: 'password authentication failed' } });
    });
    fakeSdk = http.createServer(sdkApp);
    await new Promise((r) => fakeSdk.listen(0, '127.0.0.1', r));

    dbName = await setupEnv({ sdkHosts: `127.0.0.1:${fakeSdk.address().port}` });
    const { createPublicApp, createInternalApp } = require('../src/app');
    pub = createPublicApp();
    internal = createInternalApp();
    await createUser('owner@example.com', 'superadmin');
    await createUser('ops@example.com', 'operator');
    await createUser('viewer@example.com', 'viewer');
    owner = await login(pub, 'owner@example.com');
  });

  after(async () => {
    await new Promise((r) => fakeSdk.close(r));
    await teardown(dbName);
  });

  describe('authentication', () => {
    test('API requires a session', async () => {
      assert.strictEqual((await request(pub).get('/api/configs')).status, 401);
    });

    test('wrong password → 401 with a generic message', async () => {
      const res = await request(pub).post('/api/auth/login').send({ email: 'owner@example.com', password: 'nope-nope-nope' });
      assert.strictEqual(res.status, 401);
      assert.match(res.body.message, /incorrect/);
    });

    test('unknown email → same 401', async () => {
      const res = await request(pub).post('/api/auth/login').send({ email: 'ghost@example.com', password: 'whatever-123' });
      assert.strictEqual(res.status, 401);
    });

    test('5 failures lock the account', async () => {
      await createUser('lock@example.com', 'viewer');
      for (let i = 0; i < 5; i++) await request(pub).post('/api/auth/login').send({ email: 'lock@example.com', password: 'bad-password-x' });
      const res = await request(pub).post('/api/auth/login').send({ email: 'lock@example.com', password: 'test-password-123' });
      assert.strictEqual(res.status, 423);
    });

    test('session cookie is HttpOnly + SameSite=Strict', async () => {
      const res = await request(pub).post('/api/auth/login').send({ email: 'viewer@example.com', password: 'test-password-123' });
      const cookie = res.headers['set-cookie'].join(';');
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Strict/);
    });

    test('state-changing request without CSRF token → 403', async () => {
      const res = await owner.agent.put('/api/configs/ingestion').send({ data: {}, expectedVersion: 0, reason: 'x' });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(res.body.error, 'csrf_failed');
    });

    test('logout revokes the session', async () => {
      const s = await login(pub, 'viewer@example.com');
      assert.strictEqual((await s.get('/api/auth/me')).status, 200);
      assert.strictEqual((await s.post('/api/auth/logout')).status, 204);
      assert.strictEqual((await s.get('/api/auth/me')).status, 401);
    });
  });

  describe('roles', () => {
    test('viewer can read but not change', async () => {
      const v = await login(pub, 'viewer@example.com');
      assert.strictEqual((await v.get('/api/configs')).status, 200);
      const res = await v.put('/api/configs/ingestion', { data: { maxBatchEvents: 10 }, expectedVersion: 0, reason: 'try' });
      assert.strictEqual(res.status, 403);
    });

    test('operator can change ingestion but not tenants or database', async () => {
      const o = await login(pub, 'ops@example.com');
      assert.strictEqual((await o.put('/api/configs/tenants', { data: {}, expectedVersion: 0, reason: 'try it' })).status, 403);
      assert.strictEqual((await o.put('/api/configs/database', { data: {}, expectedVersion: 0, reason: 'try it' })).status, 403);
    });

    test('only superadmin manages users', async () => {
      const o = await login(pub, 'ops@example.com');
      assert.strictEqual((await o.get('/api/users')).status, 403);
      assert.strictEqual((await owner.get('/api/users')).status, 200);
    });

    test('weak passwords are refused', async () => {
      const res = await owner.post('/api/users', { email: 'new@example.com', role: 'viewer', password: 'short' });
      assert.strictEqual(res.status, 400);
    });
  });

  describe('versioned configuration', () => {
    test('save → version 1, with audit row and outbox notice', async () => {
      const res = await owner.put('/api/configs/ingestion', { data: { maxBatchEvents: 250, paymentPagePattern: '(checkout)', rawTtlDays: 0 }, expectedVersion: 0, reason: 'first' });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.strictEqual(res.body.version, 1);
      const { query } = require('../src/db/pool');
      const audit = await query("SELECT * FROM config_audit_log WHERE action = 'config.update' AND config_type = 'ingestion' AND outcome = 'success'");
      assert.strictEqual(audit.rows.length, 1);
      assert.strictEqual(audit.rows[0].actor_email, 'owner@example.com');
      const out = await query("SELECT payload FROM notification_outbox WHERE config_type = 'ingestion'");
      assert.strictEqual(out.rows[0].payload.version, 1);
      assert.strictEqual(out.rows[0].payload.data, undefined, 'notice carries no data');
    });

    test('stale expectedVersion → 409', async () => {
      const res = await owner.put('/api/configs/ingestion', { data: { maxBatchEvents: 300 }, expectedVersion: 0, reason: 'stale' });
      assert.strictEqual(res.status, 409);
      assert.strictEqual(res.body.details.currentVersion, 1);
    });

    test('invalid data → 400 with field issues; dangerous regex refused', async () => {
      const res = await owner.put('/api/configs/ingestion', { data: { maxBatchEvents: 300, paymentPagePattern: '(a+)+$' }, expectedVersion: 1, reason: 'bad' });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.details.issues[0].path, 'paymentPagePattern');
    });

    test('identical data → 400 no_change', async () => {
      const res = await owner.put('/api/configs/ingestion', { data: { maxBatchEvents: 250, paymentPagePattern: '(checkout)', rawTtlDays: 0 }, expectedVersion: 1, reason: 'same' });
      assert.strictEqual(res.body.error, 'no_change');
    });

    test('secrets: encrypted at rest, masked in API, kept when sent blank', async () => {
      let res = await owner.put('/api/configs/tenants', { data: { allowedTenants: ['t1'], tenantApiKeys: { t1: 'very-secret-key-1' } }, expectedVersion: 0, reason: 'keys' });
      assert.strictEqual(res.status, 201);
      const { query } = require('../src/db/pool');
      const row = (await query("SELECT data, secrets_enc FROM config_versions WHERE config_type = 'tenants'")).rows[0];
      assert.ok(!JSON.stringify(row.data).includes('very-secret'));
      assert.ok(!row.secrets_enc.toString('latin1').includes('very-secret'));

      res = await owner.get('/api/configs/tenants');
      assert.deepStrictEqual(res.body.data.tenantApiKeys, { t1: { set: true } });

      res = await owner.put('/api/configs/tenants', { data: { allowedTenants: ['t1', 't2'], tenantApiKeys: '__UNCHANGED__' }, expectedVersion: 1, reason: 'add t2' });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const snap = await signedInternal(internal, 'GET', '/internal/config/snapshot?types=tenants');
      assert.deepStrictEqual(snap.body.configs.tenants.data.tenantApiKeys, { t1: 'very-secret-key-1' });

      const audit = await query("SELECT diff FROM config_audit_log WHERE config_type = 'tenants'");
      assert.ok(!JSON.stringify(audit.rows).includes('very-secret'));
    });

    test('history, diff and rollback (rollback = new version)', async () => {
      await owner.put('/api/configs/ingestion', { data: { maxBatchEvents: 100, paymentPagePattern: '(checkout)', rawTtlDays: 0 }, expectedVersion: 1, reason: 'lower' });
      const diff = await owner.get('/api/configs/ingestion/diff?from=1&to=2');
      assert.deepStrictEqual(diff.body.changes, [{ path: 'maxBatchEvents', from: 250, to: 100 }]);
      const rb = await owner.post('/api/configs/ingestion/rollback', { toVersion: 1, reason: 'undo' });
      assert.strictEqual(rb.status, 201);
      assert.strictEqual(rb.body.version, 3);
      const cur = await owner.get('/api/configs/ingestion');
      assert.strictEqual(cur.body.data.maxBatchEvents, 250);
      const hist = await owner.get('/api/configs/ingestion/versions');
      assert.deepStrictEqual(hist.body.versions.map((v) => v.source), ['rollback', 'admin', 'admin']);
    });

    test('custom patterns: server computes sha256 and refuses unsafe code', async () => {
      const code = "(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {\n  core.pushEvent({ type: 'x' });\n});\n";
      let res = await owner.put('/api/configs/custom-patterns', { data: { patterns: [{ filename: 'xylium-custom-a.js', description: 'a', code }] }, expectedVersion: 0, reason: 'publish' });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      res = await owner.put('/api/configs/custom-patterns', { data: { patterns: [{ filename: 'xylium-custom-b.js', description: 'b', code: 'fetch("https://evil")' }] }, expectedVersion: 1, reason: 'bad' });
      assert.strictEqual(res.status, 400);
    });
  });

  describe('internal API (SDK-facing)', () => {
    test('unsigned or tampered requests → 401', async () => {
      assert.strictEqual((await request(internal).get('/internal/config/snapshot')).status, 401);
      const { signRequest } = require('@xylium/config');
      const h = signRequest({ keyId: 'sdk-1', secret: 'x'.repeat(64), method: 'GET', path: '/internal/config/snapshot' });
      assert.strictEqual((await request(internal).get('/internal/config/snapshot').set(h)).status, 401);
    });

    test('heartbeat registers the instance and returns latest versions', async () => {
      const res = await signedInternal(internal, 'POST', '/internal/sdk-instances/heartbeat', {
        instanceId: 'sdk-a', baseUrl: `http://127.0.0.1:${fakeSdk.address().port}`, activeDatabase: 'postgresql',
        appliedVersions: { ingestion: 1 }, pendingRestart: [], uptimeSec: 5,
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.latestVersions.ingestion, 3);
      const list = await owner.get('/api/instances');
      assert.strictEqual(list.body.instances[0].status, 'live');
      assert.deepStrictEqual(list.body.instances[0].drift.map((d) => d.configType).sort(), ['custom-patterns', 'ingestion', 'tenants']);
    });

    test('heartbeat from a host outside SDK_ALLOWED_HOSTS → 403', async () => {
      const res = await signedInternal(internal, 'POST', '/internal/sdk-instances/heartbeat', {
        instanceId: 'sdk-evil', baseUrl: 'http://10.9.9.9:8080', activeDatabase: null, appliedVersions: {}, pendingRestart: [], uptimeSec: 1,
      });
      assert.strictEqual(res.status, 403);
    });

    test('outbox delivers a signed notice to live instances; ack completes the rollout', async () => {
      fakeSdkState.notices = [];
      const res = await owner.put('/api/configs/ip-intel', { data: { provider: 'ipapi' }, expectedVersion: 0, reason: 'enable ipapi' });
      assert.strictEqual(res.status, 201);
      const { processOnce } = require('../src/modules/notifier/outbox.worker');
      await processOnce();
      const notice = fakeSdkState.notices.find((n) => n.configType === 'ip-intel');
      assert.ok(notice, 'notice delivered');
      assert.strictEqual(notice.version, 1);

      let ro = await owner.get('/api/configs/ip-intel/versions/1/rollout');
      assert.strictEqual(ro.body.summary.complete, false);

      const ack = await signedInternal(internal, 'POST', '/internal/config/ack', {
        instanceId: 'sdk-a', changeId: notice.changeId, configType: 'ip-intel', version: 1, status: 'applied', durationMs: 4, error: null,
      });
      assert.strictEqual(ack.status, 200);
      ro = await owner.get('/api/configs/ip-intel/versions/1/rollout');
      assert.strictEqual(ro.body.summary.complete, true);
      assert.strictEqual(ro.body.instances[0].state, 'applied');
    });
  });

  describe('database changes: prepare on SDK instances before saving', () => {
    const data = { activeDatabase: 'postgresql', postgresql: { host: 'db.internal', password: 'pw' }, mongodb: {} };

    test('an instance that cannot connect → 422, nothing saved', async () => {
      fakeSdkState.validateOk = false;
      const res = await owner.put('/api/configs/database', { data, expectedVersion: 0, reason: 'move db' });
      assert.strictEqual(res.status, 422);
      assert.strictEqual(res.body.error, 'prepare_failed');
      assert.strictEqual((await owner.get('/api/configs/database')).body.version, 0);
    });

    test('all instances pass → saved', async () => {
      fakeSdkState.validateOk = true;
      const before = fakeSdkState.validateCalls;
      const res = await owner.put('/api/configs/database', { data, expectedVersion: 0, reason: 'move db' });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      assert.ok(fakeSdkState.validateCalls > before);
      assert.strictEqual(res.body.validation.allPassed, true);
    });
  });

  describe('audit', () => {
    test('admin can read and export the audit log; operator cannot', async () => {
      const res = await owner.get('/api/audit?configType=ingestion');
      assert.ok(res.body.entries.length >= 3);
      const csv = await owner.get('/api/audit?format=csv');
      assert.match(csv.headers['content-type'], /text\/csv/);
      const o = await login(pub, 'ops@example.com');
      assert.strictEqual((await o.get('/api/audit')).status, 403);
    });
  });
});
