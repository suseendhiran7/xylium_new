'use strict';

const { query } = require('../../db/pool');
const { safeAudit } = require('../audit/audit.service');
const { liveInstances } = require('../instances/instances.service');
const svc = require('./dbops.service');

/**
 * Daily backup. Every minute: if the schedule is enabled, the configured
 * time (admin server's local time) has passed today and today's run has not
 * been claimed, claim it with one conditional UPDATE (so two admin replicas
 * never both run it) and ask a live SDK instance to write the backup.
 * A missed time (admin was down) is caught up as soon as it is running again.
 */

const TICK_MS = 60 * 1000;
const POLL_MS = 10 * 1000;
const MAX_WAIT_MS = 12 * 60 * 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const setStatus = (fields) => {
  const keys = Object.keys(fields);
  return query(
    `UPDATE db_backup_schedule SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = 1`,
    keys.map((k) => fields[k])
  );
};

async function waitForJob(inst, jobId) {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let job;
    try {
      job = await svc.sdk(inst, 'GET', `jobs/${encodeURIComponent(jobId)}`);
    } catch (err) {
      if (err.status === 404) return { status: 'failed', error: 'job disappeared (SDK restarted?)' };
      continue; // transient: keep waiting
    }
    if (job.status !== 'running') return job;
  }
  return { status: 'failed', error: 'timed out waiting for the backup to finish' };
}

let busy = false;

async function tick(now = new Date()) {
  if (busy) return;
  busy = true;
  try {
    const { rows } = await query('SELECT * FROM db_backup_schedule WHERE id = 1');
    const s = rows[0];
    if (!s || !s.enabled || localTime(now) < s.time_of_day) return;
    const today = localDate(now);

    const claimedBefore = await query('SELECT 1 FROM db_backup_schedule WHERE id = 1 AND last_run_date >= $1::date', [today]);
    if (claimedBefore.rows[0]) return;

    if (!(await liveInstances()).length) {
      if (s.last_message !== 'Waiting: no live SDK instance') await setStatus({ last_status: 'waiting', last_message: 'Waiting: no live SDK instance' });
      return;
    }

    const claim = await query(
      `UPDATE db_backup_schedule SET last_run_date = $1::date, last_run_at = NOW(), last_status = 'running', last_message = NULL, last_backup_name = NULL
        WHERE id = 1 AND enabled AND (last_run_date IS NULL OR last_run_date < $1::date) RETURNING last_run_date`,
      [today]
    );
    if (!claim.rows[0]) return; // another admin replica took it

    let inst;
    let job;
    try {
      inst = await svc.pickInstance(s.instance_id || null).catch(() => svc.pickInstance(null));
      job = await svc.sdk(inst, 'POST', 'backups', await svc.jobBody(null, { trigger: 'scheduled', retentionDays: s.retention_days }));
    } catch (err) {
      // e.g. another job is running: un-claim so the next tick retries
      await setStatus({ last_run_date: s.last_run_date, last_status: 'waiting', last_message: `Will retry: ${err.message}` });
      return;
    }
    await setStatus({ last_job_id: job.id, last_instance_id: inst.instance_id });
    console.log(`[backup] daily backup started on ${inst.instance_id} (${job.id})`);

    const done = await waitForJob(inst, job.id);
    const ok = done.status === 'succeeded';
    await setStatus({
      last_status: ok ? 'succeeded' : 'failed',
      last_message: ok ? `${done.result.rows} row(s), ${(done.result.sizeBytes / 1048576).toFixed(2)} MB` : done.error || done.status,
      last_backup_name: ok ? done.result.name : null,
    });
    await safeAudit({
      actor: null,
      action: 'db.backup.scheduled',
      outcome: ok ? 'success' : 'failure',
      detail: { instanceId: inst.instance_id, jobId: job.id, backup: ok ? done.result.name : null, error: ok ? null : done.error },
    });
    console.log(`[backup] daily backup ${ok ? `written: ${done.result.name}` : `failed: ${done.error}`}`);
  } catch (err) {
    console.error('[backup] scheduler error:', err.message);
  } finally {
    busy = false;
  }
}

function startBackupScheduler() {
  const first = setTimeout(tick, 15 * 1000);
  const timer = setInterval(tick, TICK_MS);
  first.unref();
  timer.unref();
  return { stop: () => { clearTimeout(first); clearInterval(timer); } };
}

module.exports = { startBackupScheduler, tick };
