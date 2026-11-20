'use strict';

const { loadSettings } = require('./settings');
const { RuntimeConfig } = require('./runtime-config');
const { APPLIERS } = require('./appliers');
const { createInternalRouter } = require('./internal.routes');

/**
 * Process-wide runtime configuration. With CONFIG_SOURCE unset (= env) this
 * is inert: no routes, no timers, no admin calls.
 */
let instance = null;

function getRuntimeConfig() {
  if (!instance) instance = new RuntimeConfig({ settings: loadSettings(), appliers: APPLIERS });
  return instance;
}

function internalRouter() {
  return createInternalRouter(getRuntimeConfig(), { appliers: APPLIERS });
}

module.exports = { getRuntimeConfig, internalRouter };
