'use strict';

const { getConfig } = require('../../config');
const { liveInstances } = require('../instances/instances.service');
const { callSdk } = require('../notifier/sdk.client');

/**
 * PREPARE step of a database change: ask every live SDK instance to test the
 * candidate settings from its own network (POST /internal/config/validate).
 * Nothing is applied. `allPassed` gates the save.
 *
 * @param {object} data  full, validated database config (with real secrets)
 */
async function validateOnInstances(data) {
  const instances = await liveInstances();
  const results = await Promise.all(
    instances.map(async (inst) => {
      try {
        const r = await callSdk(inst.base_url, 'POST', 'internal/config/validate', { configType: 'database', data }, { timeoutMs: getConfig().sdkValidateTimeoutMs });
        if (r.status !== 200) {
          return { instanceId: inst.instance_id, ok: false, error: (r.body && (r.body.message || r.body.error)) || `HTTP ${r.status}` };
        }
        return { instanceId: inst.instance_id, ok: !!r.body.ok, result: r.body.result, error: r.body.ok ? null : (r.body.result && r.body.result.error) || r.body.error || 'validation failed' };
      } catch (err) {
        return { instanceId: inst.instance_id, ok: false, error: err.name === 'TimeoutError' ? 'timed out' : err.message };
      }
    })
  );
  return {
    instances: results,
    liveCount: instances.length,
    allPassed: results.length > 0 && results.every((r) => r.ok),
    warning: instances.length === 0 ? 'No live SDK instances: the settings could not be tested. Instances will apply them when they next start or check in.' : null,
  };
}

module.exports = { validateOnInstances };
