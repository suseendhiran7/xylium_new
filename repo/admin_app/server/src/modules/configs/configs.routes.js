'use strict';

const express = require('express');
const { z } = require('zod');
const { getConfigType, maskSecrets } = require('@xylium/config');
const svc = require('./configs.service');
const { validateOnInstances } = require('../database/database.service');
const { getRollout } = require('../rollouts/rollouts.service');
const { requireRole, hasRole } = require('../../middleware/session');
const { safeAudit } = require('../audit/audit.service');
const { HttpError, asyncRoute } = require('../../lib/util');

const router = express.Router();

function typeParam(req) {
  getConfigType(req.params.type); // 400 on unknown type
  return req.params.type;
}

function requireWrite(type, user) {
  const role = svc.writeRoleFor(type);
  if (!hasRole(user, role)) throw new HttpError(403, 'forbidden', `Changing ${type} requires role ${role} or higher`);
}

const intParam = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'bad_param', `${name} must be a non-negative integer`);
  return n;
};

router.get('/types', requireRole('viewer'), (req, res) => res.json({ types: svc.describeTypes() }));

router.get('/', requireRole('viewer'), asyncRoute(async (req, res) => res.json({ configs: await svc.listCurrent() })));

router.get('/:type', requireRole('viewer'), asyncRoute(async (req, res) => res.json(await svc.getCurrentMasked(typeParam(req)))));

/**
 * Check a candidate without saving. Always runs the schema; for `database`
 * also the PREPARE step on live SDK instances.
 */
router.post(
  '/:type/validate',
  requireRole('operator'),
  asyncRoute(async (req, res) => {
    const type = typeParam(req);
    requireWrite(type, req.user);
    const { data } = await svc.resolveCandidate(type, req.body && req.body.data);
    const out = { ok: true, configType: type, data: maskSecrets(data, getConfigType(type).secretPaths) };
    if (type === 'database') {
      out.instances = await validateOnInstances(data);
      out.ok = out.instances.allPassed || out.instances.liveCount === 0;
      await safeAudit({ req, actor: req.user, action: 'db.validate', configType: type, outcome: out.ok ? 'success' : 'failure', detail: { results: out.instances.instances } });
    }
    res.json(out);
  })
);

const UpdateBody = z.object({
  data: z.record(z.unknown()),
  expectedVersion: z.number().int().min(0),
  reason: z.string().min(3).max(1000),
});

router.put(
  '/:type',
  requireRole('operator'),
  asyncRoute(async (req, res) => {
    const type = typeParam(req);
    requireWrite(type, req.user);
    const body = UpdateBody.parse(req.body);

    // Database: commit only if every live SDK instance can reach the new settings.
    let validation = null;
    if (type === 'database') {
      const { data } = await svc.resolveCandidate(type, body.data);
      validation = await validateOnInstances(data);
      if (validation.liveCount > 0 && !validation.allPassed) {
        await safeAudit({ req, actor: req.user, action: 'config.update', configType: type, outcome: 'failure', detail: { error: 'prepare_failed', message: 'An SDK instance could not use these settings', results: validation.instances } });
        throw new HttpError(422, 'prepare_failed', 'Not saved: at least one SDK instance could not use these settings', validation);
      }
    }

    try {
      const result = await svc.updateConfig(type, body.data, { actor: req.user, req, expectedVersion: body.expectedVersion, reason: body.reason });
      res.status(201).json({ ...result, validation });
    } catch (err) {
      if (err.status === 400 || err.status === 409) {
        await safeAudit({ req, actor: req.user, action: 'config.update', configType: type, outcome: 'failure', detail: { error: err.code, message: err.message } });
      }
      throw err;
    }
  })
);

router.get(
  '/:type/versions',
  requireRole('viewer'),
  asyncRoute(async (req, res) => res.json({ versions: await svc.listVersions(typeParam(req), { limit: req.query.limit }) }))
);

router.get(
  '/:type/versions/:version',
  requireRole('viewer'),
  asyncRoute(async (req, res) => res.json(await svc.getVersionMasked(typeParam(req), intParam(req.params.version, 'version'))))
);

router.get(
  '/:type/diff',
  requireRole('viewer'),
  asyncRoute(async (req, res) => {
    const type = typeParam(req);
    res.json({ changes: await svc.diffVersions(type, intParam(req.query.from, 'from'), intParam(req.query.to, 'to')) });
  })
);

router.get(
  '/:type/versions/:version/rollout',
  requireRole('viewer'),
  asyncRoute(async (req, res) => res.json(await getRollout(typeParam(req), intParam(req.params.version, 'version'))))
);

const RollbackBody = z.object({ toVersion: z.number().int().min(1), reason: z.string().min(3).max(1000) });

router.post(
  '/:type/rollback',
  requireRole('admin'),
  asyncRoute(async (req, res) => {
    const type = typeParam(req);
    const body = RollbackBody.parse(req.body);
    const result = await svc.rollback(type, body.toVersion, { actor: req.user, req, reason: body.reason });
    res.status(201).json(result);
  })
);

module.exports = router;
