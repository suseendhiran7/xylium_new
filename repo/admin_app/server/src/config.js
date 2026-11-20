'use strict';

const path = require('path');
require('dotenv').config({ path: process.env.ADMIN_ENV_FILE || path.join(__dirname, '../../.env') });
const { z } = require('zod');

/**
 * "id:secret,id2:secret2" → { id: secret, id2: secret2 }
 * Used for encryption keys (base64) and HMAC keys (plain strings).
 */
function keyList(v) {
  const out = {};
  for (const part of String(v || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    if (i < 1) throw new Error(`Malformed key entry "${part.slice(0, 8)}…" — expected id:value`);
    out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

const Env = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().default(8090),
  INTERNAL_PORT: z.coerce.number().int().default(8091),
  INTERNAL_HOST: z.string().default('127.0.0.1'),
  ADMIN_DB_URL: z.string().min(1, 'ADMIN_DB_URL is required (postgres://user:pass@host:5432/xylium_admin)'),
  ADMIN_DB_SSL: z.enum(['true', 'false']).default('false'),
  CONFIG_ENCRYPTION_KEYS: z.string().min(1, 'CONFIG_ENCRYPTION_KEYS is required — run `npm run gen-keys`'),
  CONFIG_ENCRYPTION_ACTIVE_KEY: z.string().optional(),
  SDK_TO_ADMIN_KEYS: z.string().min(1, 'SDK_TO_ADMIN_KEYS is required (id:secret, used to verify SDK calls)'),
  ADMIN_TO_SDK_KEY_ID: z.string().min(1).default('admin-1'),
  ADMIN_TO_SDK_KEY: z.string().min(32, 'ADMIN_TO_SDK_KEY must be 32+ characters'),
  SDK_ALLOWED_HOSTS: z.string().default('localhost:8080,127.0.0.1:8080'),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).default(30),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().min(1).default(8),
  INSTANCE_STALE_SECONDS: z.coerce.number().int().min(30).default(90),
  OUTBOX_POLL_MS: z.coerce.number().int().min(100).default(1000),
  SDK_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(500).default(5000),
  SDK_VALIDATE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),
});

function load(env = process.env) {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const msgs = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`[admin config] invalid environment:\n${msgs}`);
  }
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';

  const encryptionKeys = {};
  for (const [id, b64] of Object.entries(keyList(e.CONFIG_ENCRYPTION_KEYS))) {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length !== 32) throw new Error(`[admin config] encryption key "${id}" must be 32 bytes, base64-encoded`);
    encryptionKeys[id] = buf;
  }
  const activeKeyId = e.CONFIG_ENCRYPTION_ACTIVE_KEY || Object.keys(encryptionKeys)[0];
  if (!encryptionKeys[activeKeyId]) throw new Error(`[admin config] CONFIG_ENCRYPTION_ACTIVE_KEY "${activeKeyId}" is not in CONFIG_ENCRYPTION_KEYS`);

  const sdkToAdminKeys = keyList(e.SDK_TO_ADMIN_KEYS);
  for (const [id, s] of Object.entries(sdkToAdminKeys)) {
    if (s.length < 32) throw new Error(`[admin config] SDK_TO_ADMIN_KEYS "${id}" must be 32+ characters`);
  }

  return Object.freeze({
    nodeEnv: e.NODE_ENV,
    production,
    port: e.PORT,
    internalPort: e.INTERNAL_PORT,
    internalHost: e.INTERNAL_HOST,
    dbUrl: e.ADMIN_DB_URL,
    dbSsl: e.ADMIN_DB_SSL === 'true',
    encryptionKeys,
    activeKeyId,
    sdkToAdminKeys,
    adminToSdk: { keyId: e.ADMIN_TO_SDK_KEY_ID, secret: e.ADMIN_TO_SDK_KEY },
    sdkAllowedHosts: list(e.SDK_ALLOWED_HOSTS).map((h) => h.toLowerCase()),
    cookieSecure: e.COOKIE_SECURE ? e.COOKIE_SECURE === 'true' : production,
    sessionIdleMs: e.SESSION_IDLE_MINUTES * 60 * 1000,
    sessionAbsoluteMs: e.SESSION_ABSOLUTE_HOURS * 60 * 60 * 1000,
    instanceStaleMs: e.INSTANCE_STALE_SECONDS * 1000,
    outboxPollMs: e.OUTBOX_POLL_MS,
    sdkRequestTimeoutMs: e.SDK_REQUEST_TIMEOUT_MS,
    sdkValidateTimeoutMs: e.SDK_VALIDATE_TIMEOUT_MS,
  });
}

let cached = null;
/** Lazily loaded so scripts and tests can set env first. */
function getConfig() {
  if (!cached) cached = load();
  return cached;
}

module.exports = { getConfig, load, keyList };
