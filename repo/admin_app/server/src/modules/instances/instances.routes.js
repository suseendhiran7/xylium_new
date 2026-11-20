'use strict';

const express = require('express');
const { requireRole } = require('../../middleware/session');
const svc = require('./instances.service');
const { listAudit } = require('../audit/audit.service');
const { safeAudit } = require('../audit/audit.service');
const { processOnce } = require('../notifier/outbox.worker');
const { query } = require('../../db/pool');
const { HttpError, asyncRoute } = require('../../lib/util');

const instances = express.Router();

instances.get('/', requireRole('viewer'), asyncRoute(async (req, res) => res.json({ instances: await svc.listInstances() })));

instances.get(
  '/:id/status',
  requireRole('viewer'),
  asyncRoute(async (req, res) => {
    const s = await svc.liveStatus(req.params.id);
    if (!s) throw new HttpError(404, 'not_found', 'Unknown instance');
    res.json(s);
  })
);

instances.delete(
  '/:id',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    if (!(await svc.removeInstance(req.params.id))) throw new HttpError(404, 'not_found', 'Unknown instance');
    await safeAudit({ req, actor: req.user, action: 'instance.remove', detail: { instanceId: req.params.id } });
    res.status(204).end();
  })
);

/** Re-send notices that have not reached every live instance. */
const rollouts = express.Router();
rollouts.post(
  '/retry',
  requireRole('operator'),
  asyncRoute(async (req, res) => {
    const { configType, version } = req.body || {};
    const r = await query(
      `UPDATE notification_outbox SET processed_at = NULL, attempts = 0, next_attempt_at = NOW()
        WHERE config_type = $1 AND version = $2 RETURNING change_id`,
      [String(configType || ''), Number(version) || 0]
    );
    if (!r.rows[0]) throw new HttpError(404, 'not_found', 'No notice for that version');
    await query(
      "UPDATE config_rollouts SET notify_status = 'pending' WHERE config_type = $1 AND version = $2 AND ack_status IS DISTINCT FROM 'applied'",
      [configType, Number(version)]
    );
    await processOnce();
    await safeAudit({ req, actor: req.user, action: 'rollout.retry', configType, toVersion: Number(version) });
    res.json({ ok: true });
  })
);

const audit = express.Router();
audit.get(
  '/',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const rows = await listAudit(req.query);
    if (req.query.format === 'csv') {
      const esc = (v) => `"${String(v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : v).replace(/"/g, '""')}"`;
      const cols = ['id', 'at', 'actor_email', 'actor_ip', 'action', 'config_type', 'from_version', 'to_version', 'outcome', 'diff', 'detail', 'request_id'];
      res.type('text/csv').set('Content-Disposition', 'attachment; filename="xylium-audit.csv"');
      return res.send([cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c] instanceof Date ? r[c].toISOString() : r[c])).join(','))].join('\n'));
    }
    res.json({ entries: rows });
  })
);

module.exports = { instances, rollouts, audit };
