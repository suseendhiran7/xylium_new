'use strict';

/**
 * Test harness: a throw-away PostgreSQL database per test file.
 * Needs a reachable PostgreSQL; set ADMIN_TEST_PG_URL to a server URL WITHOUT
 * a database name, e.g. postgres://postgres:pass@127.0.0.1:5432
 * Tests are skipped when it is not set.
 */
const crypto = require('crypto');
const { Client } = require('pg');

const BASE = process.env.ADMIN_TEST_PG_URL;
const SKIP = !BASE && 'ADMIN_TEST_PG_URL not set (needs a PostgreSQL server)';

const SDK_TO_ADMIN_SECRET = crypto.randomBytes(32).toString('hex');
const ADMIN_TO_SDK_SECRET = crypto.randomBytes(32).toString('hex');

async function setupEnv({ sdkHosts = '127.0.0.1:1' } = {}) {
  const dbName = `xa_test_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
  const admin = new Client({ connectionString: `${BASE}/postgres` });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    ADMIN_ENV_FILE: '/nonexistent',
    ADMIN_DB_URL: `${BASE}/${dbName}`,
    CONFIG_ENCRYPTION_KEYS: `k1:${crypto.randomBytes(32).toString('base64')}`,
    SDK_TO_ADMIN_KEYS: `sdk-1:${SDK_TO_ADMIN_SECRET}`,
    ADMIN_TO_SDK_KEY_ID: 'admin-1',
    ADMIN_TO_SDK_KEY: ADMIN_TO_SDK_SECRET,
    SDK_ALLOWED_HOSTS: sdkHosts,
    COOKIE_SECURE: 'false',
  });
  const { migrate } = require('../src/db/migrate');
  await migrate({ log: () => {} });
  return dbName;
}

async function teardown(dbName) {
  const { closePool } = require('../src/db/pool');
  await closePool();
  const admin = new Client({ connectionString: `${BASE}/postgres` });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
}

async function createUser(email, role, password = 'test-password-123') {
  const { query } = require('../src/db/pool');
  const { hashPassword } = require('../src/auth/passwords');
  const { rows } = await query('INSERT INTO admin_users (email, role, password_hash) VALUES ($1,$2,$3) RETURNING id', [email, role, await hashPassword(password)]);
  return rows[0].id;
}

/** Log in through the API; returns a supertest agent wrapper that sends the CSRF header. */
async function login(app, email, password = 'test-password-123') {
  const request = require('supertest');
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  const csrf = res.body.csrfToken;
  return {
    agent,
    get: (u) => agent.get(u),
    put: (u, b) => agent.put(u).set('x-csrf-token', csrf).send(b),
    post: (u, b) => agent.post(u).set('x-csrf-token', csrf).send(b),
    patch: (u, b) => agent.patch(u).set('x-csrf-token', csrf).send(b),
    csrf,
  };
}

/** A signed request from a fake SDK instance to the internal app. */
function signedInternal(app, method, path, body) {
  const request = require('supertest');
  const { signRequest } = require('@xylium/config');
  const raw = body === undefined ? '' : JSON.stringify(body);
  const headers = signRequest({ keyId: 'sdk-1', secret: SDK_TO_ADMIN_SECRET, method, path, body: raw });
  let r = request(app)[method.toLowerCase()](path).set(headers);
  if (raw) r = r.set('content-type', 'application/json').send(raw);
  return r;
}

module.exports = { SKIP, setupEnv, teardown, createUser, login, signedInternal, SDK_TO_ADMIN_SECRET, ADMIN_TO_SDK_SECRET };
