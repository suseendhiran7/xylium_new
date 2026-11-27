'use strict';

const { query } = require('../../db/pool');
const { HttpError } = require('../../lib/util');
const { liveInstances } = require('../instances/instances.service');
const { getCurrentFull } = require('../configs/configs.service');
const { callSdk } = require('../notifier/sdk.client');

/**
 * Database operations (migration, backup, restore) are executed by an SDK
 * instance: it owns the event-store schema and has network access to the
 * event database. The admin app picks a live instance, sends it the saved
 * database configuration (so the job targets exactly what is selected on the
 * Database page) and relays job status.
 */

const BACKUP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.xbk\.gz$/;
const JOB_TIMEOUT_MS = 20000;

/** A live SDK instance: the requested one, else the first live one. */
async function pickInstance(instanceId) {
  const live = (await liveInstances()).sort((a, b) => a.instance_id.localeCompare(b.instance_id));
  if (!live.length) {
    throw new HttpError(409, 'no_live_instance', 'No live SDK instance. Database jobs run on an SDK instance: start one connected to this admin app (CONFIG_SOURCE=shadow or admin).');
  }
  if (!instanceId) return live[0];
  const inst = live.find((i) => i.instance_id === instanceId);
  if (!inst) throw new HttpError(409, 'instance_not_live', `SDK instance ${instanceId} is not live`);
  return inst;
}

/** Saved database configuration (full, with secrets) or null when none was saved yet. */
async function savedDatabaseConfig() {
  const cur = await getCurrentFull('database');
  return cur ? { version: cur.version, data: cur.data } : null;
}

/** What the browser may see about the selected database: no credentials. */
function describeDatabase(saved) {
  if (!saved) return { version: 0, source: 'instance', note: 'No database configuration saved yet: jobs use each SDK instance\'s own settings.' };
  const d = saved.data || {};
  return {
    version: saved.version,
    source: 'admin',
    activeDatabase: d.activeDatabase,
    postgresql: d.postgresql ? `${d.postgresql.host}:${d.postgresql.port}/${d.postgresql.database}` : null,
    mongodb: d.mongodb ? d.mongodb.database : null,
  };
}

/** Signed call to an instance's /internal/db-ops API; non-2xx becomes an HttpError. */
async function sdk(inst, method, path, body, { timeoutMs = JOB_TIMEOUT_MS } = {}) {
  let r;
  try {
    r = await callSdk(inst.base_url, method, `internal/db-ops/${path}`, body, { timeoutMs });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, 'sdk_unreachable', `SDK instance ${inst.instance_id} did not answer: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
  }
  if (r.status === 401) throw new HttpError(502, 'sdk_rejected', `SDK instance ${inst.instance_id} rejected the signed request (check ADMIN_TO_SDK keys)`);
  if (r.status === 404 && r.body && r.body.error === 'not found') {
    throw new HttpError(502, 'sdk_outdated', `SDK instance ${inst.instance_id} has no database-operations API (update and restart it)`);
  }
  if (r.status < 200 || r.status >= 300) {
    throw new HttpError(r.status >= 500 ? 502 : r.status, (r.body && r.body.error) || 'sdk_error', (r.body && r.body.message) || `SDK answered HTTP ${r.status}`);
  }
  return r.body;
}

/** Body common to every job: the saved database config + an optional explicit target type. */
async function jobBody(targetType, extra = {}) {
  const saved = await savedDatabaseConfig();
  const body = { ...extra };
  if (saved) body.database = saved.data;
  if (targetType) body.targetType = targetType;
  return body;
}

function assertBackupName(name) {
  if (typeof name !== 'string' || !BACKUP_NAME_RE.test(name) || name.includes('..')) {
    throw new HttpError(400, 'bad_name', 'Invalid backup name (must end in .xbk.gz)');
  }
  return name;
}

// ---------------------------------------------------------------- schedule

function scheduleView(row) {
  return {
    enabled: row.enabled,
    timeOfDay: row.time_of_day,
    retentionDays: row.retention_days,
    instanceId: row.instance_id,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastMessage: row.last_message,
    lastJobId: row.last_job_id,
    lastInstanceId: row.last_instance_id,
    lastBackupName: row.last_backup_name,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

async function getSchedule() {
  const { rows } = await query('SELECT * FROM db_backup_schedule WHERE id = 1');
  return scheduleView(rows[0]);
}

async function updateSchedule({ enabled, timeOfDay, retentionDays, instanceId }, actor) {
  const { rows } = await query(
    `UPDATE db_backup_schedule SET enabled = $1, time_of_day = $2, retention_days = $3, instance_id = $4,
            updated_at = NOW(), updated_by = $5 WHERE id = 1 RETURNING *`,
    [enabled, timeOfDay, retentionDays, instanceId || null, actor ? actor.email : null]
  );
  return scheduleView(rows[0]);
}

module.exports = {
  pickInstance, savedDatabaseConfig, describeDatabase, sdk, jobBody, assertBackupName, getSchedule, updateSchedule,
  scheduleView, BACKUP_NAME_RE,
};
