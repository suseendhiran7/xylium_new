'use strict';

const { query } = require('../../db/pool');
const { getConfig } = require('../../config');

/** Record an SDK instance's outcome for one version (from /internal/config/ack). */
async function recordAck(ack) {
  // The instance may ack a version it pulled via heartbeat drift (no notice);
  // make sure the instance row exists so the FK holds.
  const exists = await query('SELECT 1 FROM sdk_instances WHERE instance_id = $1', [ack.instanceId]);
  if (!exists.rows[0]) return false;
  await query(
    `INSERT INTO config_rollouts (config_type, version, instance_id, change_id, notify_status, ack_status, ack_error, ack_detail, acked_at, updated_at)
     VALUES ($1,$2,$3,$4,'not_notified',$5,$6,$7,NOW(),NOW())
     ON CONFLICT (config_type, version, instance_id) DO UPDATE SET
       change_id = COALESCE(config_rollouts.change_id, EXCLUDED.change_id),
       ack_status = EXCLUDED.ack_status, ack_error = EXCLUDED.ack_error, ack_detail = EXCLUDED.ack_detail,
       acked_at = NOW(), updated_at = NOW()`,
    [ack.configType, ack.version, ack.instanceId, ack.changeId, ack.status, ack.error, JSON.stringify({ durationMs: ack.durationMs, ...(ack.details || {}) })]
  );
  return true;
}

/**
 * Rollout of one version: every instance that is live now or was notified,
 * with its delivery and outcome. `complete` = every live instance acked.
 */
async function getRollout(type, version) {
  const staleMs = getConfig().instanceStaleMs;
  const { rows } = await query(
    `SELECT i.instance_id, i.base_url, i.last_heartbeat_at,
            (i.last_heartbeat_at > NOW() - ($3 || ' milliseconds')::interval) AS live,
            (i.applied_versions ->> $1)::int AS applied_version,
            r.notify_status, r.notify_attempts, r.last_error, r.ack_status, r.ack_error, r.ack_detail, r.acked_at
       FROM sdk_instances i
       LEFT JOIN config_rollouts r ON r.instance_id = i.instance_id AND r.config_type = $1 AND r.version = $2
      WHERE r.id IS NOT NULL OR i.last_heartbeat_at > NOW() - ($3 || ' milliseconds')::interval
      ORDER BY i.instance_id`,
    [type, version, String(staleMs)]
  );
  const instances = rows.map((r) => {
    let state = 'pending';
    if (r.ack_status) state = r.ack_status;
    else if ((r.applied_version || 0) >= version) state = 'applied';
    else if (r.notify_status === 'unreachable') state = 'unreachable';
    return { ...r, state };
  });
  const live = instances.filter((i) => i.live);
  const done = (i) => ['applied', 'restart_required', 'skipped_stale'].includes(i.state);
  return {
    configType: type,
    version,
    instances,
    summary: {
      live: live.length,
      applied: instances.filter((i) => i.state === 'applied').length,
      failed: instances.filter((i) => i.state === 'failed').length,
      restartRequired: instances.filter((i) => i.state === 'restart_required').length,
      pending: live.filter((i) => !done(i) && i.state !== 'failed').length,
      complete: live.length > 0 && live.every(done),
    },
  };
}

module.exports = { recordAck, getRollout };
