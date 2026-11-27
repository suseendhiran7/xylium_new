'use strict';

/**
 * SDK side of the Admin Application link: pull → check → apply → ack,
 * heartbeat drift recovery, stale / duplicate notices, failures keeping the
 * previous settings, last-known-good boot, and signed internal routes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const { checksum, signRequest } = require('@xylium/config');
const { RuntimeConfig } = require('../src/runtime-config/runtime-config');
const { createInternalRouter } = require('../src/runtime-config/internal.routes');
const { loadSettings } = require('../src/runtime-config/settings');
const lkg = require('../src/runtime-config/last-known-good');

const quiet = { log() {}, warn() {}, error() {} };

const ingestion = (n) => ({ maxBatchEvents: n, rawTtlDays: 0 });

/** In-memory admin: versions per type, records acks and heartbeats. */
function fakeAdmin() {
  const store = {};
  const admin = {
    acks: [],
    heartbeats: [],
    snapshotCalls: 0,
    set(type, version, data, { badChecksum = false } = {}) {
      store[type] = { version, data, checksum: badChecksum ? `sha256:${'0'.repeat(64)}` : checksum(data) };
    },
    async snapshot(types) {
      admin.snapshotCalls++;
      const keys = types && types.length ? types : Object.keys(store);
      return { revision: 1, configs: Object.fromEntries(keys.filter((k) => store[k]).map((k) => [k, store[k]])) };
    },
    async ack(a) {
      admin.acks.push(a);
      return { ok: true };
    },
    async heartbeat(hb) {
      admin.heartbeats.push(hb);
      return { revision: 1, latestVersions: Object.fromEntries(Object.entries(store).map(([k, v]) => [k, v.version])) };
    },
  };
  return admin;
}

function fakeAppliers() {
  const calls = [];
  const make = (type) => ({
    boot: (d) => calls.push(['boot', type, d]),
    apply: async (d) => {
      calls.push(['apply', type, d]);
      if (d && d.__fail) throw new Error('boom');
      return { status: type === 'http-security' ? 'restart_required' : 'applied', details: {} };
    },
  });
  const appliers = Object.fromEntries(['database', 'ingestion', 'tenants', 'ip-intel', 'http-security', 'custom-patterns'].map((t) => [t, make(t)]));
  return { appliers, calls };
}

function settings(over = {}) {
  return {
    mode: 'admin', enabled: true, adminUrl: 'http://admin', instanceId: 'sdk-t', baseUrl: 'http://127.0.0.1:1',
    sdkToAdmin: { keyId: 'sdk-1', secret: 's'.repeat(64) }, adminToSdkKeys: { 'admin-1': 'a'.repeat(64) },
    cacheFile: path.join(os.tmpdir(), `xylium-lkg-${process.pid}-${Math.random()}`), cacheKey: crypto.randomBytes(32),
    heartbeatMs: 30000, requestTimeoutMs: 1000, ...over,
  };
}

function setup(over) {
  const admin = fakeAdmin();
  const { appliers, calls } = fakeAppliers();
  const rc = new RuntimeConfig({ settings: settings(over), appliers, client: admin, log: quiet });
  return { admin, appliers, calls, rc };
}

describe('settings', () => {
  test('CONFIG_SOURCE defaults to env (inert)', () => {
    expect(loadSettings({}).enabled).toBe(false);
  });
  test('admin mode requires the admin URL and keys', () => {
    expect(() => loadSettings({ CONFIG_SOURCE: 'admin' })).toThrow(/ADMIN_INTERNAL_URL/);
    expect(() => loadSettings({ CONFIG_SOURCE: 'nope' })).toThrow(/env, shadow or admin/);
  });
});

describe('notice → pull → apply → ack', () => {
  test('applies a newer version and acknowledges it', async () => {
    const { admin, calls, rc } = setup();
    admin.set('ingestion', 2, ingestion(100));
    await rc.onNotice({ changeId: 'chg_aaaaaaaaaa', configType: 'ingestion', version: 2 });
    expect(calls).toEqual([['apply', 'ingestion', ingestion(100)]]);
    expect(rc.appliedVersions().ingestion).toBe(2);
    expect(admin.acks[0]).toMatchObject({ configType: 'ingestion', version: 2, status: 'applied', changeId: 'chg_aaaaaaaaaa', instanceId: 'sdk-t' });
  });

  test('duplicate / older notice → skipped_stale, nothing re-applied', async () => {
    const { admin, calls, rc } = setup();
    admin.set('ingestion', 2, ingestion(100));
    await rc.onNotice({ changeId: 'chg_aaaaaaaaaa', configType: 'ingestion', version: 2 });
    await rc.onNotice({ changeId: 'chg_aaaaaaaaaa', configType: 'ingestion', version: 2 });
    await rc.onNotice({ changeId: 'chg_bbbbbbbbbb', configType: 'ingestion', version: 1 });
    expect(calls).toHaveLength(1);
    expect(admin.acks.map((a) => a.status)).toEqual(['applied', 'skipped_stale', 'skipped_stale']);
  });

  test('notices for one type are applied in order, one at a time', async () => {
    const { admin, calls, rc } = setup();
    admin.set('ingestion', 3, ingestion(300));
    await Promise.all([
      rc.onNotice({ changeId: 'chg_aaaaaaaaaa', configType: 'ingestion', version: 2 }),
      rc.onNotice({ changeId: 'chg_bbbbbbbbbb', configType: 'ingestion', version: 3 }),
    ]);
    // the first pull already got v3, so the second notice is stale
    expect(calls).toHaveLength(1);
    expect(rc.appliedVersions().ingestion).toBe(3);
  });

  test('checksum mismatch → failed, previous settings kept', async () => {
    const { admin, calls, rc } = setup();
    admin.set('ingestion', 1, ingestion(100), { badChecksum: true });
    await rc.onNotice({ changeId: 'chg_aaaaaaaaaa', configType: 'ingestion', version: 1 });
    expect(calls).toHaveLength(0);
    expect(admin.acks[0]).toMatchObject({ status: 'failed' });
    expect(admin.acks[0].error).toMatch(/checksum/);
    expect(rc.appliedVersions().ingestion).toBe(0);
  });

  test('schema-invalid data → failed', async () => {
    const { admin, calls, rc } = setup();
    admin.set('ingestion', 1, { maxBatchEvents: -5 });
    await rc.onNotice({ changeId: 'chg_aaaaaaaaaa', configType: 'ingestion', version: 1 });
    expect(calls).toHaveLength(0);
    expect(admin.acks[0].status).toBe('failed');
  });

  test('applier throws → failed ack, version not recorded, retried on next heartbeat', async () => {
    const { admin, appliers, rc } = setup();
    let fail = true;
    appliers.ingestion.apply = async () => {
      if (fail) throw new Error('connection refused');
      return { status: 'applied' };
    };
    admin.set('ingestion', 1, ingestion(100));
    await rc.onNotice({ changeId: 'chg_aaaaaaaaaa', configType: 'ingestion', version: 1 });
    expect(admin.acks[0]).toMatchObject({ status: 'failed', error: 'connection refused' });
    expect(rc.status().lastError).toMatch(/connection refused/);

    fail = false;
    await rc.heartbeat();
    await rc.queues.ingestion;
    expect(rc.appliedVersions().ingestion).toBe(1);
  });

  test('restart-only type → restart_required, not re-pulled every heartbeat', async () => {
    const { admin, calls, rc } = setup();
    admin.set('http-security', 1, { corsOrigins: ['https://a.example'] });
    await rc.onNotice({ changeId: 'chg_aaaaaaaaaa', configType: 'http-security', version: 1 });
    expect(admin.acks[0].status).toBe('restart_required');
    expect(rc.status().pendingRestart).toEqual({ 'http-security': 1 });
    await rc.heartbeat();
    await rc.queues['http-security'];
    expect(calls).toHaveLength(1);
    expect(admin.heartbeats[0].pendingRestart).toEqual(['http-security']);
  });

  test('shadow mode never applies', async () => {
    const { admin, calls, rc } = setup({ mode: 'shadow' });
    admin.set('ingestion', 1, ingestion(100));
    await rc.onNotice({ changeId: 'chg_aaaaaaaaaa', configType: 'ingestion', version: 1 });
    await rc.heartbeat();
    expect(calls).toHaveLength(0);
  });
});

describe('heartbeat drift recovery (lost notice)', () => {
  test('a version the instance never heard about is pulled on the next heartbeat', async () => {
    const { admin, rc } = setup();
    admin.set('tenants', 4, { allowedTenants: ['t1'], tenantApiKeys: { t1: 'key-key-key-key' } });
    const hb = await rc.heartbeat();
    expect(hb.latestVersions.tenants).toBe(4);
    await rc.queues.tenants;
    expect(rc.appliedVersions().tenants).toBe(4);
    expect(admin.acks[0]).toMatchObject({ configType: 'tenants', version: 4, status: 'applied', changeId: null });
  });
});

describe('bootstrap', () => {
  test('admin reachable → boot every type, then write last-known-good', async () => {
    const { admin, calls, rc } = setup();
    admin.set('ingestion', 2, ingestion(100));
    admin.set('http-security', 1, { corsOrigins: [] });
    const r = await rc.bootstrap();
    expect(r.source).toBe('admin');
    expect(calls.map((c) => c.slice(0, 2))).toEqual([['boot', 'ingestion'], ['boot', 'http-security']]);
    expect(fs.existsSync(rc.s.cacheFile)).toBe(true);
    expect(fs.readFileSync(rc.s.cacheFile, 'utf8')).not.toMatch(/checkout/); // encrypted
  });

  test('admin down → boot from last-known-good', async () => {
    const first = setup();
    first.admin.set('ingestion', 2, ingestion(100));
    await first.rc.bootstrap();

    const { appliers, calls } = fakeAppliers();
    const down = { snapshot: async () => { throw new Error('ECONNREFUSED'); } };
    const rc2 = new RuntimeConfig({ settings: { ...first.rc.s }, appliers, client: down, log: quiet });
    const r = await rc2.bootstrap();
    expect(r.source).toBe('last-known-good');
    expect(calls).toEqual([['boot', 'ingestion', ingestion(100)]]);
    expect(rc2.appliedVersions().ingestion).toBe(2);
  });

  test('admin down and no cache → env', async () => {
    const { appliers, calls } = fakeAppliers();
    const down = { snapshot: async () => { throw new Error('ECONNREFUSED'); } };
    const rc = new RuntimeConfig({ settings: settings(), appliers, client: down, log: quiet });
    expect((await rc.bootstrap()).source).toBe('env');
    expect(calls).toHaveLength(0);
  });

  test('cache file encrypted with another key is not used', async () => {
    const s = settings();
    lkg.save(s.cacheFile, crypto.randomBytes(32), { configs: {} });
    const { appliers } = fakeAppliers();
    const rc = new RuntimeConfig({ settings: s, appliers, client: { snapshot: async () => { throw new Error('down'); } }, log: quiet });
    expect((await rc.bootstrap()).source).toBe('env');
  });
});

describe('internal routes (admin → SDK)', () => {
  const secret = 'a'.repeat(64);
  function app(rc, appliers) {
    const a = express();
    a.use('/internal', createInternalRouter(rc, { appliers }));
    return a;
  }
  const signed = (a, method, p, body) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    let r = request(a)[method.toLowerCase()](p).set(signRequest({ keyId: 'admin-1', secret, method, path: p, body: raw }));
    if (raw) r = r.set('content-type', 'application/json').send(raw);
    return r;
  };

  test('unsigned → 401; signed notice → 202 and applied', async () => {
    const { admin, appliers, rc } = setup();
    const a = app(rc, appliers);
    expect((await request(a).post('/internal/config/changed').send({})).status).toBe(401);
    admin.set('ingestion', 1, ingestion(42));
    const notice = { changeId: 'chg_aaaaaaaaaa', configType: 'ingestion', action: 'updated', version: 1, revision: 1, applyMode: 'hot', changedAt: new Date().toISOString() };
    const res = await signed(a, 'POST', '/internal/config/changed', notice);
    expect(res.status).toBe(202);
    await rc.queues.ingestion;
    expect(rc.appliedVersions().ingestion).toBe(1);
  });

  test('replayed request → 401', async () => {
    const { appliers, rc } = setup();
    const a = app(rc, appliers);
    const p = '/internal/config/applied';
    const h = signRequest({ keyId: 'admin-1', secret, method: 'GET', path: p });
    expect((await request(a).get(p).set(h)).status).toBe(200);
    expect((await request(a).get(p).set(h)).status).toBe(401);
  });

  test('validate runs the database dry run and reports the result', async () => {
    const { appliers, rc } = setup();
    appliers.database.validate = async (d) => ({ ok: d.postgresql.password === 'right', error: 'password authentication failed' });
    const a = app(rc, appliers);
    const data = { activeDatabase: 'postgresql', postgresql: { password: 'wrong' }, mongodb: {} };
    const bad = await signed(a, 'POST', '/internal/config/validate', { configType: 'database', data });
    expect(bad.body.ok).toBe(false);
    data.postgresql.password = 'right';
    const good = await signed(a, 'POST', '/internal/config/validate', { configType: 'database', data });
    expect(good.body.ok).toBe(true);
  });
});

describe('real appliers (config singleton)', () => {
  const { APPLIERS } = require('../src/runtime-config/appliers');
  const config = require('../src/config');

  test('ingestion and tenants take effect on the next read', async () => {
    const before = { m: config.maxBatchEvents, t: config.allowedTenants, k: config.tenantApiKeys, w: config.tenantIpWhitelist };
    try {
      await APPLIERS.ingestion.apply(ingestion(77));
      expect(config.maxBatchEvents).toBe(77);
      expect(config).not.toHaveProperty('paymentPagePattern');
      const r = await APPLIERS.tenants.apply({ allowedTenants: ['tx'], tenantApiKeys: { tx: 'k-k-k-k-k-k-k' }, ipWhitelist: { tx: ['10.0.0.0/8'] } });
      expect(config.allowedTenants).toEqual(['tx']);
      expect(config.tenantIpWhitelist).toEqual({ tx: ['10.0.0.0/8'] });
      expect(r.details.ipWhitelistedTenants).toBe(1);
    } finally {
      Object.assign(config, { maxBatchEvents: before.m, allowedTenants: before.t, tenantApiKeys: before.k, tenantIpWhitelist: before.w });
    }
  });

  test('http-security: identical → applied, different → restart_required', async () => {
    const same = APPLIERS['http-security'].effective();
    expect((await APPLIERS['http-security'].apply(same)).status).toBe('applied');
    expect((await APPLIERS['http-security'].apply({ ...same, rateLimitMax: same.rateLimitMax + 1 })).status).toBe('restart_required');
  });
});
