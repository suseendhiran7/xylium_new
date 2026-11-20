'use strict';

const express = require('express');
const { verifyRequest, NonceCache, messages } = require('@xylium/config');
const { getConfig } = require('../config');
const configs = require('../modules/configs/configs.service');
const { recordHeartbeat } = require('../modules/instances/instances.service');
const { recordAck } = require('../modules/rollouts/rollouts.service');
const { HttpError, asyncRoute } = require('../lib/util');

/**
 * SDK-facing API. Every request must be HMAC-signed with an SDK_TO_ADMIN key.
 * Served on its own port (INTERNAL_PORT), which should be reachable only
 * from the private network the SDK instances run in.
 */
const nonceCache = new NonceCache();

function verifySdkSignature(req, res, next) {
  const result = verifyRequest({
    getSecret: (id) => getConfig().sdkToAdminKeys[id],
    headers: req.headers,
    method: req.method,
    path: req.originalUrl,
    rawBody: req.rawBody || '',
    nonceCache,
  });
  if (!result.ok) {
    console.warn(`[internal] rejected ${req.method} ${req.originalUrl} from ${req.ip}: ${result.reason}`);
    return next(new HttpError(401, 'bad_signature', 'Request signature rejected'));
  }
  req.sdkKeyId = result.keyId;
  next();
}

const router = express.Router();
router.use(verifySdkSignature);

router.get(
  '/config/snapshot',
  asyncRoute(async (req, res) => {
    const types = String(req.query.types || '').split(',').map((s) => s.trim()).filter(Boolean);
    res.set('Cache-Control', 'no-store');
    res.json(await configs.snapshot(types));
  })
);

router.post(
  '/config/ack',
  asyncRoute(async (req, res) => {
    const ack = messages.ConfigAck.parse(req.body);
    const recorded = await recordAck(ack);
    if (ack.status === 'failed') console.warn(`[internal] ${ack.instanceId} failed to apply ${ack.configType} v${ack.version}: ${ack.error}`);
    res.json({ ok: true, recorded });
  })
);

router.post(
  '/sdk-instances/heartbeat',
  asyncRoute(async (req, res) => {
    const hb = messages.Heartbeat.parse(req.body);
    await recordHeartbeat(hb);
    res.json(await configs.latestVersions());
  })
);

module.exports = router;
