'use strict';

const fs = require('fs');
const express = require('express');
const jobs = require('./jobs');
const backup = require('./backup');
const { runMigration } = require('./migration');
const { resolveDatabaseConfig, resolveTargetType, describeTarget } = require('./connections');

/**
 * Database operations for the Admin Application, mounted under the
 * HMAC-signed /internal router (signature already checked when these run).
 *
 * Every job body may carry `database`: the admin app's saved database
 * configuration (full, with secrets). Without it the instance's own current
 * configuration is used. `targetType` picks postgresql / mongodb; default is
 * that configuration's activeDatabase.
 */
function createDbOpsRouter() {
  const router = express.Router();

  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
    res.status(err.status || 500).json({ error: err.code || 'db_ops_error', message: err.message });
  });

  const target = (body = {}) => {
    const { config, source } = resolveDatabaseConfig(body.database);
    const type = resolveTargetType(config, body.targetType);
    return { config, type, configSource: source, label: describeTarget(type, config) };
  };

  router.get('/jobs', (req, res) => res.json({ running: jobs.runningJob(), jobs: jobs.listJobs() }));

  router.get('/jobs/:id', (req, res) => {
    const job = jobs.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'not_found', message: 'Unknown job (jobs are kept in memory and reset when the SDK restarts)' });
    res.json(job);
  });

  router.post('/jobs/:id/cancel', (req, res) => {
    const job = jobs.cancelJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'not_found', message: 'Unknown job' });
    res.json(job);
  });

  router.post('/migrate', wrap(async (req, res) => {
    const t = target(req.body);
    const steps = {
      schema: req.body.steps?.schema !== false,
      data: !!req.body.steps?.data,
      verify: !!req.body.steps?.verify,
    };
    if (steps.data && t.type !== 'postgresql') {
      return res.status(400).json({ error: 'unsupported', message: 'Copying data is only supported into PostgreSQL (from MongoDB).' });
    }
    const o = req.body.options || {};
    const options = {
      dryRun: !!o.dryRun,
      reset: !!o.reset,
      mode: o.mode === 'newer' ? 'newer' : 'skip',
      only: Array.isArray(o.only) ? o.only.map(String).slice(0, 50) : [],
      batch: Math.min(Math.max(parseInt(o.batch, 10) || 2000, 100), 20000),
      sample: Math.min(Math.max(parseInt(o.sample, 10) || 200, 10), 5000),
    };
    const job = jobs.startJob('migration', { target: t.label, targetType: t.type, configSource: t.configSource, steps, options },
      (ctx) => runMigration({ type: t.type, config: t.config, steps, options }, ctx));
    res.status(202).json(job);
  }));

  router.get('/backups', wrap(async (req, res) => {
    res.json({ directory: backup.backupDir(), backups: backup.listBackups() });
  }));

  router.post('/backups', wrap(async (req, res) => {
    const t = target(req.body);
    const trigger = req.body.trigger === 'scheduled' ? 'scheduled' : 'manual';
    const retentionDays = Math.max(0, Math.min(parseInt(req.body.retentionDays, 10) || 0, 3650));
    const job = jobs.startJob('backup', { target: t.label, targetType: t.type, configSource: t.configSource, trigger, retentionDays },
      (ctx) => {
        ctx.setCancel(() => {}); // createBackup polls ctx.isCancelled()
        return backup.createBackup({ type: t.type, config: t.config, trigger, retentionDays }, ctx);
      });
    res.status(202).json(job);
  }));

  router.get('/backups/:name/download', wrap(async (req, res) => {
    const meta = backup.getBackupMeta(req.params.name);
    if (!meta) return res.status(404).json({ error: 'not_found', message: 'Backup not found' });
    const file = backup.filePath(meta.name);
    res.set({
      'content-type': 'application/gzip',
      'content-length': String(fs.statSync(file).size),
      'content-disposition': `attachment; filename="${meta.name}"`,
    });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }));

  router.delete('/backups/:name', wrap(async (req, res) => {
    if (!backup.getBackupMeta(req.params.name)) return res.status(404).json({ error: 'not_found', message: 'Backup not found' });
    backup.deleteBackupFiles(req.params.name);
    res.json({ deleted: req.params.name });
  }));

  // Raw body (application/octet-stream). The request signature covers the
  // query string, which carries the file's sha256; the file is checked
  // against it while it is written, then fully inspected before it is kept.
  router.put('/backups/upload', wrap(async (req, res) => {
    const name = String(req.query.name || '');
    const sha256 = String(req.query.sha256 || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) return res.status(400).json({ error: 'bad_request', message: 'sha256 query parameter required' });
    const maxBytes = Math.max(1, parseInt(process.env.BACKUP_MAX_UPLOAD_MB || '2048', 10)) * 1048576;
    const meta = await backup.saveUpload(name, req, { expectedSha256: sha256, maxBytes });
    res.status(201).json(meta);
  }));

  router.post('/restore', wrap(async (req, res) => {
    const t = target(req.body);
    const name = backup.assertName(req.body.name);
    if (!backup.getBackupMeta(name)) return res.status(404).json({ error: 'not_found', message: 'Backup not found' });
    const mode = req.body.mode === 'replace' ? 'replace' : 'merge';
    const safetyBackup = req.body.safetyBackup !== false;
    const job = jobs.startJob('restore', { target: t.label, targetType: t.type, configSource: t.configSource, name, mode, safetyBackup },
      (ctx) => {
        ctx.setCancel(() => {}); // restoreBackup polls ctx.isCancelled()
        return backup.restoreBackup({ name, type: t.type, config: t.config, mode, safetyBackup }, ctx);
      });
    res.status(202).json(job);
  }));

  return router;
}

module.exports = { createDbOpsRouter };
