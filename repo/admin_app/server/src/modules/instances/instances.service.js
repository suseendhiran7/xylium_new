'use strict';

const { query } = require('../../db/pool');
const { getConfig } = require('../../config');
const { assertAllowed, callSdk } = require('../notifier/sdk.client');

/** Upsert from a (signature-verified, schema-validated) heartbeat. */
async function recordHeartbeat(hb) {
  assertAllowed(hb.baseUrl);
  await query(
    `INSERT INTO sdk_instances (instance_id, base_url, hostname, app_version, active_database, applied_versions, pending_restart, uptime_sec, last_heartbeat_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
     ON CONFLICT (instance_id) DO UPDATE SET base_url = EXCLUDED.base_url, hostname = EXCLUDED.hostname, app_version = EXCLUDED.app_version,
       active_database = EXCLUDED.active_database, applied_versions = EXCLUDED.applied_versions,
       pending_restart = EXCLUDED.pending_restart, uptime_sec = EXCLUDED.uptime_sec, last_heartbeat_at = NOW()`,
    [hb.instanceId, hb.baseUrl, hb.hostname || null, hb.appVersion || null, hb.activeDatabase, JSON.stringify(hb.appliedVersions), JSON.stringify(hb.pendingRestart || []), hb.uptimeSec]
  );
}

async function listInstances() {
  const staleMs = getConfig().instanceStaleMs;
  const { rows } = await query('SELECT * FROM sdk_instances ORDER BY last_heartbeat_at DESC');
  const latest = await query('SELECT config_type, version FROM config_current');
  const latestBy = Object.fromEntries(latest.rows.map((r) => [r.config_type, r.version]));
  return rows.map((r) => {
    const live = Date.now() - new Date(r.last_heartbeat_at).getTime() < staleMs;
    const pending = new Set(r.pending_restart || []);
    const behind = Object.entries(latestBy).filter(([k, v]) => (r.applied_versions[k] || 0) < v);
    // Waiting for a restart is expected, not drift.
    const drift = behind.filter(([k]) => !pending.has(k)).map(([k, v]) => ({ configType: k, applied: r.applied_versions[k] || 0, latest: v }));
    const restartPending = behind.filter(([k]) => pending.has(k)).map(([k, v]) => ({ configType: k, applied: r.applied_versions[k] || 0, latest: v }));
    return { ...r, status: live ? 'live' : 'stale', drift, restartPending };
  });
}

async function liveInstances() {
  const { rows } = await query(
    "SELECT instance_id, base_url FROM sdk_instances WHERE last_heartbeat_at > NOW() - ($1 || ' milliseconds')::interval",
    [String(getConfig().instanceStaleMs)]
  );
  return rows;
}

async function liveStatus(instanceId) {
  const { rows } = await query('SELECT base_url FROM sdk_instances WHERE instance_id = $1', [instanceId]);
  if (!rows[0]) return null;
  try {
    const r = await callSdk(rows[0].base_url, 'GET', 'internal/status');
    return { reachable: r.status === 200, status: r.status, body: r.body };
  } catch (err) {
    return { reachable: false, error: err.message };
  }
}

async function removeInstance(instanceId) {
  const { rowCount } = await query('DELETE FROM sdk_instances WHERE instance_id = $1', [instanceId]);
  return rowCount > 0;
}

module.exports = { recordHeartbeat, listInstances, liveInstances, liveStatus, removeInstance };
