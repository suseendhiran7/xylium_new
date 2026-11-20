'use strict';

const { Pool } = require('pg');
const { getConfig } = require('../config');

let pool = null;

function getPool() {
  if (!pool) {
    const cfg = getConfig();
    pool = new Pool({
      connectionString: cfg.dbUrl,
      ssl: cfg.dbSsl ? { rejectUnauthorized: true } : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err) => console.error('[admin db] idle client error:', err.message));
  }
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

/** Run `fn(client)` in a transaction; rolls back on any throw. */
async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function closePool() {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

module.exports = { getPool, query, tx, closePool };
