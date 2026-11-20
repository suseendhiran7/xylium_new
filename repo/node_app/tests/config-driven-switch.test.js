'use strict';

/**
 * Phase 0 + Phase 1 of the Admin Application plan:
 *   - admin routes accept an admin JWT only (tenant keys rejected)
 *   - payment verification is tenant-scoped for API keys
 *   - embedded PostgreSQL fallback is opt-in
 *   - database config can come from an explicit object (Admin App), not just env
 *   - the ACTIVE database type can be reconfigured (new host/password) live
 *   - temporary test adapters are closed
 *
 * PostgreSQL runs on pg-mem. "good-host" configs get a pg-mem pool through a
 * factory spy; "unreachable" configs use a real pg Pool pointed at a closed
 * port, so they fail exactly like a wrong host would.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const request = require('supertest');
const { newDb } = require('pg-mem');

const createApp = require('../src/app');
const { generateToken } = require('../src/utils/token');
const databaseRegistry = require('../src/config/database-registry');
const databaseSwitchService = require('../src/services/database-switch.service');
const DatabaseFactory = require('../src/database/factories/database.factory');
const PostgreSQLAdapter = require('../src/database/adapters/postgresql.adapter');
const dbConfig = require('../src/config/database.config');

const realCreateAdapter = DatabaseFactory.createAdapter.bind(DatabaseFactory);

function pgMemPool() {
  return new (newDb().adapters.createPg().Pool)();
}

/** Full database config with PostgreSQL pointed at `host` / `password`. */
function cfg({ host = 'good-host', password = 'pw-1', port = 5432 } = {}) {
  const base = dbConfig.loadDatabaseConfigFromEnv();
  return {
    ...base,
    activeDatabase: 'postgresql',
    postgresql: { ...base.postgresql, host, port, password, connectionTimeoutMillis: 1000 },
  };
}

let createdAdapters;

beforeEach(async () => {
  await databaseRegistry.shutdownAll();
  databaseRegistry.switchHistory = [];
  dbConfig.clearRuntimeDatabaseConfig();
  createdAdapters = [];
  jest.spyOn(DatabaseFactory, 'createAdapter').mockImplementation((type, config, conn, options) => {
    const t = (type || '').toLowerCase();
    const section = config && (config.postgresql || config);
    let adapter;
    if ((t === 'postgresql' || t === 'postgres') && section && section.host === 'good-host') {
      adapter = new PostgreSQLAdapter(section, pgMemPool(), options);
    } else {
      adapter = realCreateAdapter(type, config, conn, options);
    }
    createdAdapters.push(adapter);
    return adapter;
  });
  // Boot state: PostgreSQL (pg-mem) active, built from env settings.
  await databaseRegistry.initialize('postgresql', { postgresql: pgMemPool() });
});

afterEach(async () => {
  jest.restoreAllMocks();
  await databaseRegistry.shutdownAll();
  dbConfig.clearRuntimeDatabaseConfig();
});

const ADMIN = { Authorization: `Bearer ${generateToken({ userId: 'ops_1', username: 'ops_1', role: 'admin' }, 300)}` };
const TENANT_KEY = { 'x-tenant-id': 'tenant_test001', 'x-api-key': 'changeme-secret' };

// ---------------------------------------------------------------- Phase 0

describe('admin routes: admin JWT only', () => {
  let app;
  beforeAll(() => {
    app = createApp();
  });

  test('no credentials → 401', async () => {
    const res = await request(app).get('/api/admin/database/status');
    expect(res.status).toBe(401);
  });

  test('tenant API key → 401 (a tenant key is not an admin credential)', async () => {
    const res = await request(app).post('/api/admin/database/switch').set(TENANT_KEY).send({ databaseType: 'mongodb' });
    expect(res.status).toBe(401);
    expect(databaseRegistry.getActiveType()).toBe('postgresql');
  });

  test('non-admin user token → 403', async () => {
    const userToken = generateToken({ userId: 'u1', role: 'user', tenantId: 'tenant_test001' }, 300);
    const res = await request(app).get('/api/admin/database/status').set({ Authorization: `Bearer ${userToken}` });
    expect(res.status).toBe(403);
  });

  test('admin token → 200 on status, config and history', async () => {
    for (const p of ['status', 'config', 'switch-history']) {
      const res = await request(app).get(`/api/admin/database/${p}`).set(ADMIN);
      expect(res.status).toBe(200);
    }
  });

  test('legacy /admin/database mount is protected the same way', async () => {
    const res = await request(app).get('/admin/database/status').set(TENANT_KEY);
    expect(res.status).toBe(401);
  });
});

describe('payments/verify: tenant-scoped API keys', () => {
  test('a key for tenant A cannot verify a payment for tenant B', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/analytics/payments/verify')
      .set(TENANT_KEY)
      .send({
        paymentId: 'pay_123',
        orderId: 'o1',
        userId: 'u1',
        sessionId: 'sess_12345',
        tenantId: 'tenant_abc123',
        amount: 10,
        status: 'succeeded',
      });
    expect(res.status).toBe(403);
  });
});

describe('JWT_SECRET in production', () => {
  const run = (env) =>
    spawnSync(process.execPath, ['-e', "require('./src/config')"], {
      cwd: path.join(__dirname, '..'),
      env: { PATH: process.env.PATH, NODE_ENV: 'production', ...env },
      encoding: 'utf8',
    });

  test('refuses to start without JWT_SECRET', () => {
    const r = run({});
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/JWT_SECRET must be set/);
  });

  test('refuses the .env.example placeholder', () => {
    expect(run({ JWT_SECRET: 'change-me-to-a-long-random-secret-32chars' }).status).not.toBe(0);
  });

  test('starts with a real secret', () => {
    expect(run({ JWT_SECRET: 'q7v0N2rX9pL4sT8wY1zC6bF3hJ5kM0aD' }).status).toBe(0);
  });
});

describe('embedded PostgreSQL fallback is opt-in', () => {
  const unreachable = { host: '127.0.0.1', port: 1, database: 'x', user: 'x', password: 'x', connectionTimeoutMillis: 1000 };

  test('allowEmbeddedFallback:false → connect() rejects and leaves no pool', async () => {
    const a = new PostgreSQLAdapter(unreachable, null, { allowEmbeddedFallback: false });
    await expect(a.connect()).rejects.toThrow(/PostgreSQL connection failed/);
    expect(a.isConnected).toBe(false);
    expect(a.isEmbedded).toBe(false);
    expect(a.pool).toBeNull();
  });

  test('default follows PG_ALLOW_EMBEDDED (tests set it to true)', async () => {
    const a = new PostgreSQLAdapter(unreachable);
    expect(a.allowEmbeddedFallback).toBe(true);
    await a.connect();
    expect(a.isEmbedded).toBe(true);
    await a.disconnect();
  });

  test('with PG_ALLOW_EMBEDDED unset the default is off', () => {
    const prev = process.env.PG_ALLOW_EMBEDDED;
    delete process.env.PG_ALLOW_EMBEDDED;
    try {
      expect(new PostgreSQLAdapter(unreachable).allowEmbeddedFallback).toBe(false);
    } finally {
      process.env.PG_ALLOW_EMBEDDED = prev;
    }
  });
});

// ---------------------------------------------------------------- Phase 1

describe('database configuration source', () => {
  test('ACTIVE_DATABASE is honoured (was hard-coded to mongodb)', () => {
    const prev = process.env.ACTIVE_DATABASE;
    try {
      process.env.ACTIVE_DATABASE = 'postgres';
      expect(dbConfig.loadDatabaseConfig().activeDatabase).toBe('postgresql');
      process.env.ACTIVE_DATABASE = 'MongoDB';
      expect(dbConfig.loadDatabaseConfig().activeDatabase).toBe('mongodb');
      delete process.env.ACTIVE_DATABASE;
      expect(dbConfig.loadDatabaseConfig().activeDatabase).toBe('mongodb');
    } finally {
      if (prev === undefined) delete process.env.ACTIVE_DATABASE;
      else process.env.ACTIVE_DATABASE = prev;
    }
  });

  test('runtime override wins over env until cleared', () => {
    expect(dbConfig.getDatabaseConfigSource()).toBe('env');
    dbConfig.setRuntimeDatabaseConfig(cfg({ host: 'db.internal' }));
    expect(dbConfig.getDatabaseConfigSource()).toBe('runtime');
    expect(dbConfig.loadDatabaseConfig().postgresql.host).toBe('db.internal');
    // callers get a copy
    dbConfig.loadDatabaseConfig().postgresql.host = 'mutated';
    expect(dbConfig.loadDatabaseConfig().postgresql.host).toBe('db.internal');
    dbConfig.clearRuntimeDatabaseConfig();
    expect(dbConfig.loadDatabaseConfig().postgresql.host).not.toBe('db.internal');
  });

  test('invalid config is rejected with status 400 and nothing is stored', () => {
    const bad = cfg();
    bad.postgresql.port = 'not-a-port';
    let err;
    try {
      dbConfig.setRuntimeDatabaseConfig(bad);
    } catch (e) {
      err = e;
    }
    expect(err && err.status).toBe(400);
    expect(dbConfig.getDatabaseConfigSource()).toBe('env');
  });

  test('connection fingerprint tracks connection settings only, and hides secrets', () => {
    const a = dbConfig.connectionFingerprint('postgresql', cfg({ password: 'pw-1' }));
    const b = dbConfig.connectionFingerprint('postgresql', cfg({ password: 'pw-2' }));
    const c = dbConfig.connectionFingerprint('postgresql', { ...cfg({ password: 'pw-1' }), activeDatabase: 'mongodb' });
    expect(a).not.toBe(b);
    expect(a).toBe(c);
    expect(a).not.toMatch(/pw-1/);
  });

  test('schema and sanitizer are re-exported unchanged from the shared package', () => {
    const shared = require('@xylium/config');
    expect(dbConfig.DatabaseConfigSchema).toBe(shared.DatabaseConfigSchema);
    const masked = dbConfig.sanitizeConfig({ postgresql: { password: 'secret' }, mongodb: { uri: 'mongodb://u:p4ss@h/db' } });
    expect(masked.postgresql.password).toBe('******');
    expect(masked.mongodb.uri).toBe('mongodb://u:******@h/db');
  });
});

describe('testConnection with an explicit candidate config', () => {
  test('reachable candidate → ok, and the temporary connection is closed', async () => {
    const result = await databaseSwitchService.testConnection('postgresql', cfg());
    expect(result.ok).toBe(true);
    const temp = createdAdapters.at(-1);
    expect(temp.isConnected).toBe(false);
    // the active adapter is untouched
    expect(databaseRegistry.getActiveAdapter()).not.toBe(temp);
    expect(databaseRegistry.getActiveAdapter().isConnected).toBe(true);
  });

  test('unreachable candidate → ok:false (never the embedded engine), connection closed', async () => {
    const result = await databaseSwitchService.testConnection('postgresql', cfg({ host: '127.0.0.1', port: 1 }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/PostgreSQL connection failed/);
    const temp = createdAdapters.at(-1);
    expect(temp.isEmbedded).toBe(false);
    expect(temp.isConnected).toBe(false);
  });

  test('invalid candidate → 400 before any connection is attempted', async () => {
    const before = createdAdapters.length;
    await expect(databaseSwitchService.testConnection('postgresql', { postgresql: { port: -1 } })).rejects.toMatchObject({ status: 400 });
    expect(createdAdapters.length).toBe(before);
  });
});

describe('reconfigureActive: new settings for the active database, no restart', () => {
  test('swaps to a new adapter, records history, drains and closes the old one', async () => {
    const oldAdapter = databaseRegistry.getActiveAdapter();
    const result = await databaseSwitchService.reconfigureActive(cfg({ password: 'rotated' }), { username: 'ops_1' }, { retireGraceMs: 0 });

    expect(result).toMatchObject({ ok: true, reconfigured: true, activeDatabase: 'postgresql' });
    const newAdapter = databaseRegistry.getActiveAdapter();
    expect(newAdapter).not.toBe(oldAdapter);
    expect(newAdapter.config.password).toBe('rotated');
    expect(newAdapter.isEmbedded).toBe(false);
    expect(databaseRegistry.adapters.get('postgresql')).toBe(newAdapter);

    await result.retired;
    expect(oldAdapter.isConnected).toBe(false);

    const [latest] = databaseRegistry.getSwitchHistory();
    expect(latest).toMatchObject({ admin: 'ops_1', status: 'SUCCESS', toDatabase: 'postgresql' });
    expect(latest.message).toMatch(/Reconfigured postgresql/);
    expect(latest.message).not.toMatch(/rotated/);
  });

  test('requests already holding the old adapter can finish during the grace period', async () => {
    const oldAdapter = databaseRegistry.getActiveAdapter();
    const result = await databaseSwitchService.reconfigureActive(cfg({ password: 'rotated' }), {}, { retireGraceMs: 50 });
    // Still usable right after the swap...
    const health = await oldAdapter.healthCheck();
    expect(health.status).toBe('healthy');
    // ...and closed once the grace period is over.
    await result.retired;
    expect(oldAdapter.isConnected).toBe(false);
  });

  test('unreachable new settings → 502, old adapter stays active and connected', async () => {
    const oldAdapter = databaseRegistry.getActiveAdapter();
    await expect(
      databaseSwitchService.reconfigureActive(cfg({ host: '127.0.0.1', port: 1 }), { username: 'ops_1' })
    ).rejects.toMatchObject({ status: 502 });
    expect(databaseRegistry.getActiveAdapter()).toBe(oldAdapter);
    expect(oldAdapter.isConnected).toBe(true);
    expect(databaseRegistry.isSwitchInProgress()).toBe(false);
    expect(databaseRegistry.getSwitchHistory()[0]).toMatchObject({ status: 'FAILED' });
    expect(createdAdapters.at(-1).isConnected).toBe(false);
  });

  test('same settings → no-op', async () => {
    const oldAdapter = databaseRegistry.getActiveAdapter();
    const result = await databaseSwitchService.reconfigureActive(dbConfig.loadDatabaseConfig());
    expect(result).toMatchObject({ ok: true, unchanged: true });
    expect(databaseRegistry.getActiveAdapter()).toBe(oldAdapter);
  });

  test('a second change while one is in progress → 409', async () => {
    databaseRegistry.acquireSwitchLock();
    try {
      await expect(databaseSwitchService.reconfigureActive(cfg({ password: 'x' }))).rejects.toMatchObject({ status: 409 });
    } finally {
      databaseRegistry.releaseSwitchLock();
    }
  });

  test('MongoDB active with a changed connection → 409 restart_required', async () => {
    const fakeMongo = {
      connectionFingerprint: 'mongodb:old',
      isConnected: true,
      healthCheck: async () => ({ status: 'healthy' }),
      getAdapterInfo: () => ({ type: 'mongodb' }),
      disconnect: async () => {},
    };
    databaseRegistry.setActiveAdapter('mongodb', fakeMongo);
    const next = { ...cfg(), activeDatabase: 'mongodb', mongodb: { ...cfg().mongodb, uri: 'mongodb://other:27017/x' } };
    await expect(databaseSwitchService.reconfigureActive(next)).rejects.toMatchObject({ status: 409, code: 'restart_required' });
    expect(databaseRegistry.getActiveAdapter()).toBe(fakeMongo);
  });
});

describe('switchDatabase with an explicit config', () => {
  test('same type + different settings becomes a reconfigure', async () => {
    const oldAdapter = databaseRegistry.getActiveAdapter();
    const result = await databaseSwitchService.switchDatabase('postgresql', { username: 'ops_1' }, { config: cfg({ password: 'p2' }), retireGraceMs: 0 });
    expect(result.reconfigured).toBe(true);
    expect(databaseRegistry.getActiveAdapter()).not.toBe(oldAdapter);
    await result.retired;
  });

  test('same type + same settings stays alreadyActive (unchanged behaviour)', async () => {
    const result = await databaseSwitchService.switchDatabase('postgresql', {}, { config: dbConfig.loadDatabaseConfig() });
    expect(result.alreadyActive).toBe(true);
  });

  test('without options the behaviour is unchanged', async () => {
    const result = await databaseSwitchService.switchDatabase('postgresql');
    expect(result.alreadyActive).toBe(true);
  });

  test('switch to a type whose cached adapter has old settings builds a new one and retires the stale one', async () => {
    // Make MongoDB active (fake), leaving the env-built PostgreSQL adapter cached.
    const stalePg = databaseRegistry.getActiveAdapter();
    const fakeMongo = {
      connectionFingerprint: 'mongodb:x',
      isConnected: true,
      healthCheck: async () => ({ status: 'healthy' }),
      getAdapterInfo: () => ({ type: 'mongodb' }),
      disconnect: async () => {},
    };
    databaseRegistry.setActiveAdapter('mongodb', fakeMongo);
    expect(databaseRegistry.adapters.get('postgresql')).toBe(stalePg);

    const result = await databaseSwitchService.switchDatabase('postgresql', { username: 'ops_1' }, { config: cfg({ password: 'new' }), retireGraceMs: 0 });
    expect(result).toMatchObject({ ok: true, activeDatabase: 'postgresql', previousDatabase: 'mongodb' });
    const active = databaseRegistry.getActiveAdapter();
    expect(active).not.toBe(stalePg);
    expect(active.config.password).toBe('new');

    await new Promise((r) => setTimeout(r, 20));
    expect(stalePg.isConnected).toBe(false);
  });

  test('switch with unreachable explicit settings → 502, previous adapter kept, candidate closed', async () => {
    const fakeMongo = {
      connectionFingerprint: 'mongodb:x',
      isConnected: true,
      healthCheck: async () => ({ status: 'healthy' }),
      getAdapterInfo: () => ({ type: 'mongodb' }),
      disconnect: async () => {},
    };
    databaseRegistry.setActiveAdapter('mongodb', fakeMongo);
    await expect(
      databaseSwitchService.switchDatabase('postgresql', {}, { config: cfg({ host: '127.0.0.1', port: 1 }) })
    ).rejects.toMatchObject({ status: 502 });
    expect(databaseRegistry.getActiveAdapter()).toBe(fakeMongo);
    expect(createdAdapters.at(-1).isConnected).toBe(false);
    expect(databaseRegistry.isSwitchInProgress()).toBe(false);
  });
});

describe('registry.retireAdapter', () => {
  test('refuses to retire the active adapter', async () => {
    await expect(databaseRegistry.retireAdapter(databaseRegistry.getActiveAdapter())).rejects.toThrow(/active/);
  });
});
