'use strict';

const { query } = require('../../db/pool');

/**
 * Append one audit row. Never throws into the caller's flow for a failed
 * audit write of a *read-only* action; for changes, the write happens inside
 * the change's own transaction (pass `client`) so both commit or neither.
 */
async function writeAudit(entry, client = null) {
  const q = client ? client.query.bind(client) : query;
  const { actor, req, action, configType = null, fromVersion = null, toVersion = null, diff = null, outcome = 'success', detail = null } = entry;
  await q(
    `INSERT INTO config_audit_log (actor_id, actor_email, actor_ip, request_id, action, config_type, from_version, to_version, diff, outcome, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      actor ? actor.id : null,
      actor ? actor.email : null,
      req ? req.ip : null,
      req ? req.requestId : null,
      action,
      configType,
      fromVersion,
      toVersion,
      diff ? JSON.stringify(diff) : null,
      outcome,
      detail ? JSON.stringify(detail) : null,
    ]
  );
}

async function safeAudit(entry) {
  try {
    await writeAudit(entry);
  } catch (err) {
    console.error('[audit] write failed:', err.message, entry.action);
  }
}

async function listAudit({ configType, actor, action, from, to, limit = 100, before } = {}) {
  const where = [];
  const params = [];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (configType) add('config_type = ?', configType);
  if (actor) add('lower(actor_email) LIKE ?', `%${String(actor).toLowerCase()}%`);
  if (action) add('action = ?', action);
  if (from) add('at >= ?', from);
  if (to) add('at <= ?', to);
  if (before) add('id < ?', before);
  params.push(Math.min(Math.max(parseInt(limit, 10) || 100, 1), 1000));
  const { rows } = await query(
    `SELECT id, at, actor_email, actor_ip, request_id, action, config_type, from_version, to_version, diff, outcome, detail
       FROM config_audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY id DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}

module.exports = { writeAudit, safeAudit, listAudit };
