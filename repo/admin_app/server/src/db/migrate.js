'use strict';

const fs = require('fs');
const path = require('path');
const { getPool } = require('./pool');

const DIR = path.join(__dirname, 'migrations');

/**
 * Apply migrations/*.sql in name order, each in its own transaction,
 * recording them in schema_migrations. Safe to run on every start.
 * An advisory lock stops two admin instances migrating at once.
 */
async function migrate({ log = console.log } = {}) {
  const client = await getPool().connect();
  try {
    await client.query('SELECT pg_advisory_lock(74261001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    const applied = [];
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`migration ${f} failed: ${err.message}`);
      }
      applied.push(f);
      log(`[admin db] applied migration ${f}`);
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(74261001)').catch(() => {});
    client.release();
  }
}

module.exports = { migrate };
