const {
  DatabaseConfigSchema,
  sanitizeDatabaseConfig,
  DATABASE_CONNECTION_FIELDS,
} = require('@xylium/config');
require('dotenv').config();

// The schema now lives in the shared @xylium/config package so the Admin
// Application validates database settings with exactly the same rules.
// It is re-exported below, so existing imports keep working.

function parseMongoDatabase(uri) {
  try {
    const url = new URL(uri.replace(/^mongodb(\+srv)?:\/\//, 'http://'));
    const path = url.pathname.replace(/^\//, '');
    return path || 'xylium';
  } catch {
    return 'xylium';
  }
}

function normalizeType(v) {
  const t = String(v || '').toLowerCase().trim();
  if (t === 'postgres' || t === 'postgresql') return 'postgresql';
  if (t === 'mongo' || t === 'mongodb') return 'mongodb';
  return null;
}

// Set by the runtime config layer when configuration comes from the Admin
// Application. null = use environment variables (the behaviour until now).
let runtimeOverride = null;

function invalid(parsed) {
  console.error('[database.config] Configuration validation failed:', parsed.error.format());
  const err = new Error(`Invalid database configuration: ${JSON.stringify(parsed.error.flatten())}`);
  err.status = 400;
  err.details = parsed.error.flatten();
  return err;
}

/** Database configuration from environment variables only. */
function loadDatabaseConfigFromEnv() {
  const activeDatabase = normalizeType(process.env.ACTIVE_DATABASE) || 'mongodb';
  const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017/xylium';
  const mongoDbName = process.env.MONGODB_DATABASE || parseMongoDatabase(mongoUri);

  const rawConfig = {
    activeDatabase,
    mongodb: {
      uri: mongoUri,
      database: mongoDbName,
      maxPoolSize: parseInt(process.env.MONGO_MAX_POOL || '20', 10),
      minPoolSize: parseInt(process.env.MONGO_MIN_POOL || '2', 10),
      serverSelectionTimeoutMS: parseInt(process.env.MONGO_TIMEOUT_MS || '5000', 10),
      socketTimeoutMS: parseInt(process.env.MONGO_SOCKET_TIMEOUT_MS || '30000', 10),
    },
    postgresql: {
      host: process.env.POSTGRES_HOST || 'localhost',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      database: process.env.POSTGRES_DATABASE || 'behavioral_events',
      user: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || '',
      ssl: process.env.POSTGRES_SSL === 'true',
      maxPoolSize: parseInt(process.env.POSTGRES_MAX_POOL || '20', 10),
      idleTimeoutMillis: parseInt(process.env.POSTGRES_IDLE_TIMEOUT_MS || '30000', 10),
      connectionTimeoutMillis: parseInt(process.env.POSTGRES_CONNECTION_TIMEOUT_MS || '5000', 10),
    },
  };

  const parsed = DatabaseConfigSchema.safeParse(rawConfig);
  if (!parsed.success) throw invalid(parsed);
  return parsed.data;
}

/**
 * Current database configuration: the runtime override (Admin Application)
 * when one is set, otherwise environment variables.
 * Returns a copy; callers may not mutate shared state through it.
 */
function loadDatabaseConfig() {
  if (runtimeOverride) return JSON.parse(JSON.stringify(runtimeOverride));
  return loadDatabaseConfigFromEnv();
}

/** Validate a candidate configuration without storing it. Throws (status 400) when invalid. */
function parseDatabaseConfig(candidate) {
  const parsed = DatabaseConfigSchema.safeParse(candidate);
  if (!parsed.success) throw invalid(parsed);
  return parsed.data;
}

/** Make `config` the database configuration every later loadDatabaseConfig() returns. */
function setRuntimeDatabaseConfig(config) {
  runtimeOverride = parseDatabaseConfig(config);
  return loadDatabaseConfig();
}

/** Back to environment variables. */
function clearRuntimeDatabaseConfig() {
  runtimeOverride = null;
}

function getDatabaseConfigSource() {
  return runtimeOverride ? 'runtime' : 'env';
}

/**
 * Stable identity of one engine's connection settings. Two configs with the
 * same fingerprint can share a connection; a different fingerprint needs a
 * new one. Contains a hash only, never the secrets themselves.
 */
function connectionFingerprint(type, config) {
  const t = normalizeType(type);
  const section = (config && (config[t] || config)) || {};
  const fields = DATABASE_CONNECTION_FIELDS[t] || [];
  const picked = fields.map((f) => [f, section[f] === undefined ? null : section[f]]);
  return `${t}:${require('crypto').createHash('sha256').update(JSON.stringify(picked)).digest('hex').slice(0, 16)}`;
}

/**
 * Mask sensitive credentials for API responses and logs.
 */
const sanitizeConfig = sanitizeDatabaseConfig;

module.exports = {
  loadDatabaseConfig,
  loadDatabaseConfigFromEnv,
  parseDatabaseConfig,
  setRuntimeDatabaseConfig,
  clearRuntimeDatabaseConfig,
  getDatabaseConfigSource,
  connectionFingerprint,
  normalizeType,
  sanitizeConfig,
  DatabaseConfigSchema,
};
