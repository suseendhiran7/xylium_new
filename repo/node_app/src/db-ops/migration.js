'use strict';

/**
 * "Run migration" from the Admin Application.
 *
 *   schema  create / upgrade every table, column, index and unique key the
 *           SDK needs in the selected database (PostgreSQL or MongoDB).
 *           Idempotent: safe on an empty database and on one in use.
 *   data    PostgreSQL only: copy existing data from MongoDB into the
 *           PostgreSQL tables with the duplicate-safe migrator in
 *           scripts/migrate (resumable, ON CONFLICT everywhere).
 *   verify  counts, spot checks and duplicate check after a data copy.
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { Pool } = require('pg');
const appConfig = require('../config');
const { COLLECTIONS } = require('../models/EventStores');
const { PostgresTarget } = require('../../scripts/migrate/target/postgres');
const sources = require('../../scripts/migrate/sources');
const Runner = require('../../scripts/migrate/runner');
const { openMongo, describeTarget } = require('./connections');

const MODELS_DIR = path.join(__dirname, '../models');

/** Load every Mongoose model file so mongoose.modelNames() is complete. */
function loadAllModels() {
  for (const f of fs.readdirSync(MODELS_DIR)) {
    if (f.endsWith('.js')) require(path.join(MODELS_DIR, f)); // eslint-disable-line global-require
  }
}

/** PostgresTarget.connect(), creating the database first if it does not exist. */
async function connectPostgresTarget(pgConfig, log) {
  const target = new PostgresTarget(pgConfig);
  try {
    await target.connect();
    return target;
  } catch (err) {
    await target.close().catch(() => {});
    if (err.code !== '3D000') throw new Error(`Cannot connect to PostgreSQL: ${err.message}`);
  }
  log(`Database "${pgConfig.database}" does not exist; creating it`);
  const admin = new Pool({ ...pgConfig, database: 'postgres', ssl: pgConfig.ssl ? { rejectUnauthorized: false } : false, max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${String(pgConfig.database).replace(/"/g, '""')}"`);
  } finally {
    await admin.end().catch(() => {});
  }
  const created = new PostgresTarget(pgConfig);
  await created.connect();
  return created;
}

async function postgresTableSummary(pool) {
  const { rows } = await pool.query(
    `SELECT c.relname AS table, GREATEST(c.reltuples, 0)::bigint AS approx_rows,
            (SELECT COUNT(*) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped)::int AS columns
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`
  );
  return rows.map((r) => ({ name: r.table, columns: r.columns, approxRows: Number(r.approx_rows) }));
}

async function migrateSchemaPostgres(config, log) {
  log(`Schema: ${describeTarget('postgresql', config)}`);
  const target = await connectPostgresTarget(config.postgresql, log);
  try {
    log('Tables, columns and indexes are up to date');
    await target.prepareBookkeeping();
    log('Checking unique keys (duplicate protection)');
    await target.prepareConstraints(log);
    const tables = await postgresTableSummary(target.pool);
    log(`${tables.length} table(s) present`);
    return { databaseType: 'postgresql', tables };
  } finally {
    await target.close().catch(() => {});
  }
}

async function migrateSchemaMongo(config, log) {
  log(`Schema: ${describeTarget('mongodb', config)}`);
  loadAllModels();
  const conn = await openMongo(config.mongodb);
  try {
    const existing = new Set((await conn.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
    const tables = [];
    for (const name of mongoose.modelNames()) {
      const base = mongoose.model(name);
      const collection = base.collection.collectionName;
      const model = conn.models[name] || conn.model(name, base.schema, collection);
      if (!existing.has(collection)) {
        await model.createCollection();
        log(`  created collection ${collection}`);
      }
      await model.createIndexes();
      const indexes = await conn.db.collection(collection).indexes();
      tables.push({ name: collection, indexes: indexes.length });
      log(`  indexes ok: ${collection} (${indexes.length})`);
    }
    if (appConfig.rawTtlDays > 0) {
      for (const name of COLLECTIONS) {
        await conn.db.collection(name)
          .createIndex({ receivedAt: 1 }, { expireAfterSeconds: appConfig.rawTtlDays * 86400 })
          .then(() => log(`  TTL ${appConfig.rawTtlDays}d ok: ${name}`))
          .catch((e) => log(`  TTL index on ${name} not changed: ${e.message}`));
      }
    }
    return { databaseType: 'mongodb', tables: tables.sort((a, b) => a.name.localeCompare(b.name)) };
  } finally {
    await conn.close().catch(() => {});
  }
}

function migrateSchema(type, config, log) {
  return type === 'postgresql' ? migrateSchemaPostgres(config, log) : migrateSchemaMongo(config, log);
}

/** Build a scripts/migrate Runner for MongoDB -> PostgreSQL with the given options. */
async function openRunner(config, options, log) {
  const opts = {
    source: 'mongo',
    batch: options.batch || 2000,
    mode: options.mode === 'newer' ? 'newer' : 'skip',
    only: Array.isArray(options.only) ? options.only : [],
    parallel: 1,
    sample: options.sample || 200,
    reset: !!options.reset,
    dryRun: !!options.dryRun,
  };
  const target = await connectPostgresTarget(config.postgresql, log);
  const source = sources.mongo.create(config);
  try {
    await source.connect();
  } catch (err) {
    await target.close().catch(() => {});
    throw new Error(`Cannot connect to MongoDB (source of the data copy): ${err.message}`);
  }
  const runner = new Runner({ source, target, entities: sources.mongo.entities(), sourceName: 'mongo', opts, log: (l) => log(String(l).replace(/^\n+/, '')) });
  const close = async () => {
    await source.close().catch(() => {});
    await target.close().catch(() => {});
  };
  return { runner, target, opts, close };
}

async function copyDataFromMongo(config, options, ctx) {
  const { log } = ctx;
  log(`Data copy: mongodb ${config.mongodb.database} -> ${describeTarget('postgresql', config)}` +
    `${options.dryRun ? ' (DRY RUN: every transaction is rolled back)' : ''}`);
  const { runner, target, close } = await openRunner(config, options, log);
  ctx.setCancel(() => runner.requestStop());
  try {
    await target.prepareBookkeeping();
    await target.prepareConstraints(log);
    const results = await runner.migrateAll();
    const copied = results.filter((r) => !r.skipped);
    const total = (k) => copied.reduce((n, r) => n + (r[k] || 0), 0);
    log(`Data copy ${runner.stopping ? 'paused (run again to resume)' : 'done'}: read ${total('docsRead')}, ` +
      `inserted ${total('inserted')}, already present ${total('skipped')}, rejected ${total('rejected')}`);
    return { entities: results, paused: runner.stopping };
  } finally {
    await close();
  }
}

async function verifyData(config, options, ctx) {
  const { runner, target, close } = await openRunner(config, options, ctx.log);
  try {
    await target.prepareBookkeeping();
    const healthy = await runner.verify(options.sample || 200);
    ctx.log(healthy ? 'Verification passed' : 'Verification found problems (see FAIL lines above)');
    return { healthy };
  } finally {
    await close();
  }
}

/**
 * The whole "Run migration" job.
 * @param {{ type: string, config: object, steps: { schema?: boolean, data?: boolean, verify?: boolean }, options: object }} p
 */
async function runMigration({ type, config, steps, options }, ctx) {
  const result = { databaseType: type, target: describeTarget(type, config) };
  if (steps.data && type !== 'postgresql') {
    const err = new Error('Copying data is only supported into PostgreSQL (from MongoDB). Select PostgreSQL or run the schema step only.');
    err.status = 400;
    throw err;
  }
  if (steps.schema !== false) {
    ctx.progress({ step: 'schema' });
    result.schema = await migrateSchema(type, config, ctx.log);
  }
  if (steps.data && !ctx.isCancelled()) {
    ctx.progress({ step: 'data' });
    result.data = await copyDataFromMongo(config, options, ctx);
  }
  if (steps.verify && !ctx.isCancelled()) {
    ctx.progress({ step: 'verify' });
    result.verify = await verifyData(config, options, ctx);
  }
  ctx.progress({ step: 'done' });
  return result;
}

module.exports = { runMigration, migrateSchema };
