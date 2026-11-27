'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const express = require('express');
const { z } = require('zod');
const { requireRole } = require('../../middleware/session');
const { safeAudit } = require('../audit/audit.service');
const { liveInstances } = require('../instances/instances.service');
const { callSdkStream } = require('../notifier/sdk.client');
const { HttpError, asyncRoute } = require('../../lib/util');
const svc = require('./dbops.service');

/**
 * /api/db-ops: run migrations, take / download / upload / restore backups,
 * daily backup schedule. Viewer: read. Operator: take and download backups.
 * Admin: migrate, restore, upload, delete, schedule, cancel jobs.
 */
const router = express.Router();

const MAX_UPLOAD_BYTES = Math.max(1, parseInt(process.env.BACKUP_MAX_UPLOAD_MB || '2048', 10)) * 1048576;
const TargetType = z.enum(['postgresql', 'mongodb']).optional().nullable();
const instanceOf = (req) => (req.query.instance ? String(req.query.instance) : (req.body && req.body.instanceId) || null);

const settle = (p) => p.then((value) => ({ value }), (err) => ({ error: { status: err.status || 500, code: err.code, message: err.message } }));

router.get('/status', requireRole('viewer'), asyncRoute(async (req, res) => {
  const [instances, saved, schedule] = await Promise.all([liveInstances(), svc.savedDatabaseConfig(), svc.getSchedule()]);
  const out = {
    instances: instances.map((i) => i.instance_id).sort(),
    database: svc.describeDatabase(saved),
    schedule,
    instance: null,
    jobs: null,
    backups: null,
  };
  if (instances.length) {
    const inst = await svc.pickInstance(instanceOf(req)).catch(() => svc.pickInstance(null));
    out.instance = inst.instance_id;
    const [jobs, backups] = await Promise.all([settle(svc.sdk(inst, 'GET', 'jobs')), settle(svc.sdk(inst, 'GET', 'backups'))]);
    out.jobs = jobs.value || { error: jobs.error };
    out.backups = backups.value || { error: backups.error };
  }
  res.json(out);
}));

router.get('/jobs/:id', requireRole('viewer'), asyncRoute(async (req, res) => {
  const inst = await svc.pickInstance(instanceOf(req));
  res.json(await svc.sdk(inst, 'GET', `jobs/${encodeURIComponent(req.params.id)}`));
}));

router.post('/jobs/:id/cancel', requireRole('admin'), asyncRoute(async (req, res) => {
  const inst = await svc.pickInstance(instanceOf(req));
  const job = await svc.sdk(inst, 'POST', `jobs/${encodeURIComponent(req.params.id)}/cancel`, {});
  await safeAudit({ req, actor: req.user, action: 'db.job.cancel', detail: { instanceId: inst.instance_id, jobId: req.params.id, kind: job.kind } });
  res.json(job);
}));

const MigrateBody = z.object({
  instanceId: z.string().max(128).optional().nullable(),
  targetType: TargetType,
  steps: z.object({ schema: z.boolean().default(true), data: z.boolean().default(false), verify: z.boolean().default(false) }).default({}),
  options: z.object({
    dryRun: z.boolean().default(false),
    reset: z.boolean().default(false),
    mode: z.enum(['skip', 'newer']).default('skip'),
    only: z.array(z.string().max(64)).max(50).default([]),
    batch: z.number().int().min(100).max(20000).optional(),
  }).default({}),
});

router.post('/migrate', requireRole('admin'), asyncRoute(async (req, res) => {
  const p = MigrateBody.safeParse(req.body || {});
  if (!p.success) throw new HttpError(400, 'invalid_request', 'Invalid migration request', p.error.flatten());
  const b = p.data;
  if (!b.steps.schema && !b.steps.data && !b.steps.verify) throw new HttpError(400, 'invalid_request', 'Choose at least one step');
  const inst = await svc.pickInstance(b.instanceId);
  const job = await svc.sdk(inst, 'POST', 'migrate', await svc.jobBody(b.targetType, { steps: b.steps, options: b.options }));
  await safeAudit({ req, actor: req.user, action: 'db.migrate', detail: { instanceId: inst.instance_id, jobId: job.id, target: job.params.target, steps: b.steps, options: b.options } });
  res.status(202).json({ ...job, instanceId: inst.instance_id });
}));

router.post('/backups', requireRole('operator'), asyncRoute(async (req, res) => {
  const p = z.object({ instanceId: z.string().max(128).optional().nullable(), targetType: TargetType }).safeParse(req.body || {});
  if (!p.success) throw new HttpError(400, 'invalid_request', 'Invalid backup request', p.error.flatten());
  const inst = await svc.pickInstance(p.data.instanceId);
  const job = await svc.sdk(inst, 'POST', 'backups', await svc.jobBody(p.data.targetType, { trigger: 'manual' }));
  await safeAudit({ req, actor: req.user, action: 'db.backup', detail: { instanceId: inst.instance_id, jobId: job.id, target: job.params.target } });
  res.status(202).json({ ...job, instanceId: inst.instance_id });
}));

router.delete('/backups/:name', requireRole('admin'), asyncRoute(async (req, res) => {
  const name = svc.assertBackupName(req.params.name);
  const inst = await svc.pickInstance(instanceOf(req));
  await svc.sdk(inst, 'DELETE', `backups/${encodeURIComponent(name)}`);
  await safeAudit({ req, actor: req.user, action: 'db.backup.delete', detail: { instanceId: inst.instance_id, backup: name } });
  res.status(204).end();
}));

router.get('/backups/:name/download', requireRole('operator'), asyncRoute(async (req, res) => {
  const name = svc.assertBackupName(req.params.name);
  const inst = await svc.pickInstance(instanceOf(req));
  const r = await callSdkStream(inst.base_url, 'GET', `internal/db-ops/backups/${encodeURIComponent(name)}/download`);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new HttpError(r.status === 404 ? 404 : 502, body.error || 'sdk_error', body.message || `SDK answered HTTP ${r.status}`);
  }
  await safeAudit({ req, actor: req.user, action: 'db.backup.download', detail: { instanceId: inst.instance_id, backup: name } });
  res.set({
    'content-type': 'application/gzip',
    'content-disposition': `attachment; filename="${name}"`,
    ...(r.headers.get('content-length') ? { 'content-length': r.headers.get('content-length') } : {}),
  });
  await pipeline(Readable.fromWeb(r.body), res);
}));

/**
 * Upload a backup file (raw request body, application/octet-stream).
 * Buffered to a temp file first so its sha256 can be signed, then streamed
 * to the SDK instance, which verifies and inspects it before keeping it.
 */
router.put('/backups/upload', requireRole('admin'), asyncRoute(async (req, res) => {
  const raw = path.basename(String(req.query.name || ''));
  const name = raw.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[^A-Za-z0-9]+/, '');
  if (!svc.BACKUP_NAME_RE.test(name)) throw new HttpError(400, 'bad_name', 'Upload a Xylium backup file (*.xbk.gz) as downloaded from this page');
  const inst = await svc.pickInstance(instanceOf(req));

  const tmp = path.join(os.tmpdir(), `xylium-upload-${crypto.randomBytes(8).toString('hex')}.tmp`);
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    await pipeline(req, async function* (src) {
      for await (const chunk of src) {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'too_large', `Backup is larger than the upload limit (${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB)`);
        hash.update(chunk);
        yield chunk;
      }
    }, fs.createWriteStream(tmp));
    if (!size) throw new HttpError(400, 'empty', 'The uploaded file is empty');
    const sha256 = hash.digest('hex');
    const r = await callSdkStream(inst.base_url, 'PUT',
      `internal/db-ops/backups/upload?name=${encodeURIComponent(name)}&sha256=${sha256}`,
      { body: fs.createReadStream(tmp), contentLength: size });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new HttpError(r.status >= 500 ? 502 : r.status, body.error || 'upload_failed', body.message || `SDK answered HTTP ${r.status}`);
    await safeAudit({ req, actor: req.user, action: 'db.backup.upload', detail: { instanceId: inst.instance_id, backup: name, sizeBytes: size, sha256 } });
    res.status(201).json(body);
  } finally {
    fs.rm(tmp, { force: true }, () => {});
  }
}));

const RestoreBody = z.object({
  instanceId: z.string().max(128).optional().nullable(),
  targetType: TargetType,
  name: z.string().max(200),
  mode: z.enum(['merge', 'replace']).default('merge'),
  safetyBackup: z.boolean().default(true),
  confirm: z.string().max(200).optional(),
});

router.post('/restore', requireRole('admin'), asyncRoute(async (req, res) => {
  const p = RestoreBody.safeParse(req.body || {});
  if (!p.success) throw new HttpError(400, 'invalid_request', 'Invalid restore request', p.error.flatten());
  const b = p.data;
  svc.assertBackupName(b.name);
  if (b.mode === 'replace' && b.confirm !== 'REPLACE') {
    throw new HttpError(400, 'confirm_required', 'Replace deletes the current rows of every table in the backup. Type REPLACE to confirm.');
  }
  const inst = await svc.pickInstance(b.instanceId);
  const job = await svc.sdk(inst, 'POST', 'restore', await svc.jobBody(b.targetType, { name: b.name, mode: b.mode, safetyBackup: b.safetyBackup }));
  await safeAudit({ req, actor: req.user, action: 'db.restore', detail: { instanceId: inst.instance_id, jobId: job.id, backup: b.name, mode: b.mode, target: job.params.target } });
  res.status(202).json({ ...job, instanceId: inst.instance_id });
}));

router.get('/schedule', requireRole('viewer'), asyncRoute(async (req, res) => res.json(await svc.getSchedule())));

const ScheduleBody = z.object({
  enabled: z.boolean(),
  timeOfDay: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Use HH:MM (24-hour)'),
  retentionDays: z.number().int().min(0).max(3650),
  instanceId: z.string().max(128).optional().nullable(),
});

router.put('/schedule', requireRole('admin'), asyncRoute(async (req, res) => {
  const p = ScheduleBody.safeParse(req.body || {});
  if (!p.success) throw new HttpError(400, 'invalid_request', 'Invalid schedule', p.error.flatten());
  const before = await svc.getSchedule();
  const after = await svc.updateSchedule(p.data, req.user);
  await safeAudit({
    req, actor: req.user, action: 'db.schedule.update',
    detail: { from: { enabled: before.enabled, timeOfDay: before.timeOfDay, retentionDays: before.retentionDays, instanceId: before.instanceId }, to: p.data },
  });
  res.json(after);
}));

module.exports = router;
