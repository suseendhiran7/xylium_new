'use strict';

const crypto = require('crypto');

/**
 * Long-running database jobs (migration, backup, restore) started by the
 * Admin Application. One job at a time per SDK process: two jobs writing to
 * the same database at once (e.g. a restore during a migration) is never
 * what anyone wants. Jobs and their logs live in memory; the last few are
 * kept so the admin UI can show what happened.
 */

const MAX_JOBS = 25;
const MAX_LOG_LINES = 3000;

const jobs = new Map(); // id -> job (insertion order = age)
let running = null;

function publicView(job, { withLog = false } = {}) {
  const view = {
    id: job.id,
    kind: job.kind,
    status: job.status, // running | succeeded | failed | cancelled
    params: job.params,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: job.progress,
    result: job.result,
    error: job.error,
    cancellable: job.status === 'running' && typeof job.onCancel === 'function',
  };
  if (withLog) view.log = job.log;
  return view;
}

/**
 * Start `fn` as a background job. Throws (status 409) if another job runs.
 * fn receives { log, progress, setCancel, isCancelled } and returns the result.
 */
function startJob(kind, params, fn) {
  if (running) {
    const err = new Error(`Another database job is running (${running.kind} ${running.id}). Wait for it to finish.`);
    err.status = 409;
    err.code = 'job_running';
    throw err;
  }
  const job = {
    id: `job_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
    kind,
    params,
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    progress: null,
    result: null,
    error: null,
    log: [],
    cancelled: false,
    onCancel: null,
  };
  const log = (line) => {
    const text = `${new Date().toISOString().slice(11, 19)} ${String(line)}`;
    job.log.push(text);
    if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
    console.log(`[db-ops ${job.id}] ${line}`);
  };
  const ctx = {
    log,
    progress: (p) => { job.progress = p; },
    setCancel: (cb) => { job.onCancel = cb; },
    isCancelled: () => job.cancelled,
  };

  jobs.set(job.id, job);
  while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);
  running = job;

  Promise.resolve()
    .then(() => fn(ctx))
    .then((result) => {
      job.result = result === undefined ? null : result;
      job.status = job.cancelled ? 'cancelled' : 'succeeded';
      log(job.cancelled ? 'Stopped on request.' : 'Finished.');
    })
    .catch((err) => {
      job.status = 'failed';
      job.error = err.message;
      log(`FAILED: ${err.message}`);
      if (process.env.DEBUG && err.stack) console.error(err.stack);
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      job.onCancel = null;
      if (running === job) running = null;
    });

  return publicView(job);
}

function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (job.status === 'running' && typeof job.onCancel === 'function') {
    job.cancelled = true;
    job.onCancel();
  }
  return publicView(job);
}

const getJob = (id) => (jobs.has(id) ? publicView(jobs.get(id), { withLog: true }) : null);
const listJobs = () => [...jobs.values()].reverse().map((j) => publicView(j));
const runningJob = () => (running ? publicView(running) : null);

module.exports = { startJob, cancelJob, getJob, listJobs, runningJob };
