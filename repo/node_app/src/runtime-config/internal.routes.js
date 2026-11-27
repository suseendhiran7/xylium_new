'use strict';

const express = require('express');
const { verifyRequest, NonceCache, messages, parseConfig } = require('@xylium/config');
const databaseSwitchService = require('../services/database-switch.service');
const { createDbOpsRouter } = require('../db-ops/routes');

/**
 * Admin-facing routes on the SDK. Mounted only when CONFIG_SOURCE is shadow
 * or admin, before CORS and the global body parser. Every request must be
 * HMAC-signed with an ADMIN_TO_SDK key.
 */
function createInternalRouter(runtime, { appliers }) {
  const router = express.Router();
  const nonceCache = new NonceCache();

  router.use(express.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }));

  router.use((req, res, next) => {
    const r = verifyRequest({
      getSecret: (id) => runtime.s.adminToSdkKeys[id],
      headers: req.headers,
      method: req.method,
      path: req.originalUrl,
      rawBody: req.rawBody || '',
      nonceCache,
    });
    if (!r.ok) {
      console.warn(`[internal] rejected ${req.method} ${req.originalUrl} from ${req.ip}: ${r.reason}`);
      return res.status(401).json({ error: 'bad_signature' });
    }
    next();
  });

  router.post('/config/changed', (req, res) => {
    const parsed = messages.ConfigChangedNotice.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_notice', details: parsed.error.flatten() });
    runtime.onNotice(parsed.data); // async; outcome is reported via ack
    res.status(202).json({ accepted: true, instanceId: runtime.s.instanceId });
  });

  router.post('/config/validate', async (req, res) => {
    const parsed = messages.ValidateRequest.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_request', details: parsed.error.flatten() });
    const { configType, data } = parsed.data;
    const schema = parseConfig(configType, data);
    if (!schema.success) {
      return res.json({ ok: false, result: { error: schema.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } });
    }
    try {
      if (configType === 'database') {
        const result = await appliers.database.validate(schema.data);
        return res.json({ ok: !!result.ok, result });
      }
      return res.json({ ok: true, result: { schema: 'valid' } });
    } catch (err) {
      return res.json({ ok: false, result: { error: err.message } });
    }
  });

  router.get('/status', async (req, res) => {
    try {
      res.json({ runtimeConfig: runtime.status(), database: await databaseSwitchService.getStatus() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/config/applied', (req, res) => res.json(runtime.status()));

  // Migration, backup and restore jobs started from the Admin Application.
  router.use('/db-ops', createDbOpsRouter());

  router.use((req, res) => res.status(404).json({ error: 'not found' }));
  return router;
}

module.exports = { createInternalRouter };
