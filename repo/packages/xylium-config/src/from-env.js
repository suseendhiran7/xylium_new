'use strict';

/**
 * Map the SDK's environment variables (node_app/.env) to admin config types.
 * Mirrors how node_app/src/config/index.js and database.config.js read env,
 * so "import from env" and "shadow mode compare" agree with the running SDK.
 *
 * Returns raw objects; validate each with parseConfig(type, data).
 */

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const int = (v, d) => {
  const n = parseInt(v === undefined || v === '' ? d : v, 10);
  return Number.isNaN(n) ? parseInt(d, 10) : n;
};

function jsonMap(v) {
  if (!v) return {};
  try {
    const o = JSON.parse(v);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

function trustProxy(v) {
  if (v === undefined || v === '') return 'loopback, linklocal, uniquelocal';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  return v;
}

function normalizeDb(v) {
  const t = String(v || '').toLowerCase().trim();
  if (t === 'postgres' || t === 'postgresql') return 'postgresql';
  return 'mongodb';
}

function mongoDbName(uri) {
  try {
    const p = new URL(uri.replace(/^mongodb(\+srv)?:\/\//, 'http://')).pathname.replace(/^\//, '');
    return p || 'xylium';
  } catch {
    return 'xylium';
  }
}

function configsFromEnv(env) {
  const mongoUri = env.MONGO_URI || 'mongodb://localhost:27017/xylium';
  return {
    database: {
      activeDatabase: normalizeDb(env.ACTIVE_DATABASE),
      mongodb: {
        uri: mongoUri,
        database: env.MONGODB_DATABASE || mongoDbName(mongoUri),
        maxPoolSize: int(env.MONGO_MAX_POOL, '20'),
        minPoolSize: int(env.MONGO_MIN_POOL, '2'),
        serverSelectionTimeoutMS: int(env.MONGO_TIMEOUT_MS, '5000'),
        socketTimeoutMS: int(env.MONGO_SOCKET_TIMEOUT_MS, '30000'),
      },
      postgresql: {
        host: env.POSTGRES_HOST || 'localhost',
        port: int(env.POSTGRES_PORT, '5432'),
        database: env.POSTGRES_DATABASE || 'behavioral_events',
        user: env.POSTGRES_USER || 'postgres',
        password: env.POSTGRES_PASSWORD || '',
        ssl: env.POSTGRES_SSL === 'true',
        maxPoolSize: int(env.POSTGRES_MAX_POOL, '20'),
        idleTimeoutMillis: int(env.POSTGRES_IDLE_TIMEOUT_MS, '30000'),
        connectionTimeoutMillis: int(env.POSTGRES_CONNECTION_TIMEOUT_MS, '5000'),
      },
    },
    ingestion: {
      maxBatchEvents: int(env.MAX_BATCH_EVENTS, '500'),
      rawTtlDays: int(env.RAW_TTL_DAYS, '0'),
    },
    tenants: {
      allowedTenants: list(env.ALLOWED_TENANTS),
      tenantApiKeys: jsonMap(env.TENANT_API_KEYS),
      // {"tenant_a":["203.0.113.0/24"]} — a comma-separated string per tenant works too.
      ipWhitelist: Object.fromEntries(
        Object.entries(jsonMap(env.TENANT_IP_WHITELIST)).map(([t, v]) => [t, Array.isArray(v) ? v : list(v)])
      ),
    },
    'ip-intel': {
      provider: (env.IP_INTEL_PROVIDER || 'none').toLowerCase(),
      apiKey: env.IPQS_API_KEY || '',
      strictness: int(env.IPQS_STRICTNESS, '1'),
      timeoutMs: int(env.IP_INTEL_TIMEOUT_MS, '3000'),
      cacheTtlMs: int(env.IP_INTEL_CACHE_TTL_MS, String(6 * 60 * 60 * 1000)),
      cacheMax: int(env.IP_INTEL_CACHE_MAX, '10000'),
      devIp: env.IP_INTEL_DEV_IP || '',
    },
    'http-security': {
      corsOrigins: list(env.CORS_ORIGINS),
      trustProxy: trustProxy(env.TRUST_PROXY),
      maxPayloadBytes: int(env.MAX_PAYLOAD_BYTES, '262144'),
      rateLimitWindowMs: int(env.RATE_LIMIT_WINDOW_MS, '60000'),
      rateLimitMax: int(env.RATE_LIMIT_MAX, '3000'),
      ipIntelRateLimitWindowMs: int(env.IP_INTEL_RATE_LIMIT_WINDOW_MS, '60000'),
      ipIntelRateLimitMax: int(env.IP_INTEL_RATE_LIMIT_MAX, '30'),
    },
  };
}

module.exports = { configsFromEnv };
