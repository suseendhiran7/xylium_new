'use strict';

const { query, tx } = require('../../db/pool');
const { getConfig } = require('../../config');
const { liveInstances } = require('../instances/instances.service');
const { callSdk } = require('./sdk.client');

const MAX_ATTEMPTS = 6; // ~1s, 2s, 4s, 8s, 16s, 32s — then the heartbeat takes over

/**
 * Deliver one outbox notice to every live SDK instance it has not reached yet.
 * The notice says only "type T is at version V"; instances pull the data.
 * Instances that are down now catch up through heartbeat drift detection.
 */
async function deliver(row) {
  const notice = row.payload;
  const instances = await liveInstances();
  let allDelivered = true;
  for (const inst of instances) {
    await query(
      `INSERT INTO config_rollouts (config_type, version, instance_id, change_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (config_type, version, instance_id) DO NOTHING`,
      [row.config_type, row.version, inst.instance_id, row.change_id]
    );
    const { rows: [ro] } = await query(
      'SELECT notify_status, ack_status FROM config_rollouts WHERE config_type = $1 AND version = $2 AND instance_id = $3',
      [row.config_type, row.version, inst.instance_id]
    );
    if (ro.notify_status === 'delivered' || ro.ack_status) continue;
    let error = null;
    try {
      const r = await callSdk(inst.base_url, 'POST', 'internal/config/changed', notice);
      if (r.status !== 202 && r.status !== 200) error = `HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`;
    } catch (err) {
      error = err.name === 'TimeoutError' ? 'timeout' : err.message;
    }
    if (error) allDelivered = false;
    await query(
      `UPDATE config_rollouts SET notify_status = $4, notify_attempts = notify_attempts + 1, last_error = $5, updated_at = NOW()
        WHERE config_type = $1 AND version = $2 AND instance_id = $3`,
      [row.config_type, row.version, inst.instance_id, error ? 'unreachable' : 'delivered', error]
    );
  }
  return allDelivered;
}

async function processOnce() {
  // Single admin instance assumed (decision: ~1 replica); the row lock still
  // keeps two workers from sending the same notice at the same moment.
  const rows = await tx(async (client) => {
    const r = await client.query(
      `SELECT * FROM notification_outbox WHERE processed_at IS NULL AND next_attempt_at <= NOW()
        ORDER BY id LIMIT 20 FOR UPDATE SKIP LOCKED`
    );
    for (const row of r.rows) {
      await client.query("UPDATE notification_outbox SET next_attempt_at = NOW() + interval '60 seconds' WHERE id = $1", [row.id]);
    }
    return r.rows;
  });
  for (const row of rows) {
    let ok = false;
    try {
      ok = await deliver(row);
    } catch (err) {
      console.error('[outbox] delivery error', row.change_id, err.message);
    }
    const attempts = row.attempts + 1;
    if (ok || attempts >= MAX_ATTEMPTS) {
      await query('UPDATE notification_outbox SET processed_at = NOW(), attempts = $2 WHERE id = $1', [row.id, attempts]);
    } else {
      const backoffMs = Math.min(1000 * 2 ** row.attempts, 60000);
      await query(
        "UPDATE notification_outbox SET attempts = $2, next_attempt_at = NOW() + ($3 || ' milliseconds')::interval WHERE id = $1",
        [row.id, attempts, String(backoffMs)]
      );
    }
  }
  return rows.length;
}

function startOutboxWorker() {
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await processOnce();
    } catch (err) {
      console.error('[outbox] poll failed:', err.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, getConfig().outboxPollMs);
  timer.unref();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    tick,
  };
}

module.exports = { startOutboxWorker, processOnce };
