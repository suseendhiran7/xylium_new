'use strict';

const os = require('os');
const path = require('path');

/**
 * Where this SDK instance gets its configuration.
 *
 *   CONFIG_SOURCE=env     (default) environment variables only — exactly the
 *                         behaviour before the Admin Application existed.
 *   CONFIG_SOURCE=shadow  talk to the admin app, log differences vs env, apply nothing.
 *   CONFIG_SOURCE=admin   admin app is the source of truth; env is the last fallback.
 */
function keyList(v) {
  const out = {};
  for (const part of String(v || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

function loadSettings(env = process.env) {
  const mode = String(env.CONFIG_SOURCE || 'env').toLowerCase();
  if (!['env', 'shadow', 'admin'].includes(mode)) {
    throw new Error(`[runtime-config] CONFIG_SOURCE must be env, shadow or admin (got "${env.CONFIG_SOURCE}")`);
  }
  const port = parseInt(env.PORT || '8080', 10);
  const s = {
    mode,
    enabled: mode !== 'env',
    adminUrl: (env.ADMIN_INTERNAL_URL || '').replace(/\/+$/, ''),
    instanceId: env.SDK_INSTANCE_ID || `${os.hostname()}-${port}`.replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 128),
    baseUrl: (env.SDK_INTERNAL_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, ''),
    sdkToAdmin: { keyId: env.SDK_TO_ADMIN_KEY_ID || 'sdk-1', secret: env.SDK_TO_ADMIN_KEY || '' },
    adminToSdkKeys: keyList(env.ADMIN_TO_SDK_KEYS),
    cacheFile: env.CONFIG_CACHE_FILE || path.join(process.cwd(), '.xylium-config-cache'),
    cacheKey: env.CONFIG_CACHE_KEY ? Buffer.from(env.CONFIG_CACHE_KEY, 'base64') : null,
    heartbeatMs: Math.max(5000, parseInt(env.HEARTBEAT_INTERVAL_MS || '30000', 10)),
    requestTimeoutMs: Math.max(500, parseInt(env.ADMIN_REQUEST_TIMEOUT_MS || '3000', 10)),
  };
  if (s.enabled) {
    const missing = [];
    if (!s.adminUrl) missing.push('ADMIN_INTERNAL_URL');
    if (s.sdkToAdmin.secret.length < 32) missing.push('SDK_TO_ADMIN_KEY (32+ chars)');
    if (mode === 'admin' && Object.keys(s.adminToSdkKeys).length === 0) missing.push('ADMIN_TO_SDK_KEYS');
    if (missing.length) throw new Error(`[runtime-config] CONFIG_SOURCE=${mode} needs ${missing.join(', ')}`);
    if (s.cacheKey && s.cacheKey.length !== 32) throw new Error('[runtime-config] CONFIG_CACHE_KEY must be 32 bytes, base64-encoded');
  }
  return s;
}

module.exports = { loadSettings };
