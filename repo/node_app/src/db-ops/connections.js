'use strict';

/**
 * Dedicated, short-lived connections for database jobs. Jobs never borrow
 * the live adapters: a job may target settings that differ from what this
 * instance currently serves (the Admin Application sends its saved database
 * configuration), and closing a job's connection must never affect traffic.
 */

const { Pool } = require('pg');
const mongoose = require('mongoose');
const { loadDatabaseConfig, parseDatabaseConfig, normalizeType } = require('../config/database.config');

/**
 * The database configuration a job runs against: the admin-supplied one when
 * given (validated with the shared schema), otherwise this instance's current one.
 * @returns {{ config: object, source: 'admin'|'instance' }}
 */
function resolveDatabaseConfig(candidate) {
  if (candidate && typeof candidate === 'object') return { config: parseDatabaseConfig(candidate), source: 'admin' };
  return { config: loadDatabaseConfig(), source: 'instance' };
}

/** 'postgresql' | 'mongodb': the explicitly requested type, else the config's active one. */
function resolveTargetType(config, requested) {
  if (requested) {
    const t = normalizeType(requested);
    if (!t) {
      const err = new Error(`Unknown database type "${requested}" (postgresql or mongodb)`);
      err.status = 400;
      throw err;
    }
    return t;
  }
  return config.activeDatabase;
}

/** Human-readable target, never with credentials. */
function describeTarget(type, config) {
  if (type === 'postgresql') {
    const c = config.postgresql;
    return `postgresql ${c.host}:${c.port}/${c.database}`;
  }
  return `mongodb ${config.mongodb.database}`;
}

/** A pg Pool for the REAL server (no embedded fallback); throws if unreachable. */
async function openPostgres(pgConfig, { max = 4 } = {}) {
  const pool = new Pool({
    host: pgConfig.host,
    port: pgConfig.port,
    database: pgConfig.database,
    user: pgConfig.user,
    password: pgConfig.password,
    ssl: pgConfig.ssl ? { rejectUnauthorized: false } : false,
    max,
    connectionTimeoutMillis: Math.max(pgConfig.connectionTimeoutMillis || 5000, 5000),
  });
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    await pool.end().catch(() => {});
    throw new Error(`Cannot connect to PostgreSQL ${pgConfig.host}:${pgConfig.port}/${pgConfig.database}: ${err.message}`);
  }
  return pool;
}

/** A separate mongoose connection (never the global one the models use). */
async function openMongo(mongoConfig) {
  try {
    return await mongoose.createConnection(mongoConfig.uri, {
      dbName: mongoConfig.database,
      serverSelectionTimeoutMS: Math.max(mongoConfig.serverSelectionTimeoutMS || 5000, 5000),
    }).asPromise();
  } catch (err) {
    throw new Error(`Cannot connect to MongoDB ${mongoConfig.database}: ${err.message}`);
  }
}

module.exports = { resolveDatabaseConfig, resolveTargetType, describeTarget, openPostgres, openMongo };
