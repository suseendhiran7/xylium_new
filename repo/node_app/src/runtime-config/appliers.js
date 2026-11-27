'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const databaseRegistry = require('../config/database-registry');
const databaseSwitchService = require('../services/database-switch.service');
const { setRuntimeDatabaseConfig } = require('../config/database.config');
const ipIntelService = require('../ipIntelService');

/**
 * One applier per config type.
 *
 *   boot(data)   at startup, before the app is built: copy into the config
 *                singleton / runtime override. Every type, restart ones included.
 *   apply(data)  while running. Returns { status: 'applied' | 'restart_required', details }
 *                or throws — and on throw the previous settings stay in force.
 *
 * Most readers use `config.x` at call time, so assigning to the singleton is
 * enough for the next request to see the change.
 */

const ACTOR = { username: 'admin-app' };

const ingestion = {
  boot(d) {
    config.maxBatchEvents = d.maxBatchEvents;
    config.rawTtlDays = d.rawTtlDays;
  },
  async apply(d) {
    this.boot(d);
    return { status: 'applied', details: { maxBatchEvents: d.maxBatchEvents } };
  },
};

const tenants = {
  boot(d) {
    config.allowedTenants = [...d.allowedTenants];
    config.tenantApiKeys = { ...d.tenantApiKeys };
    // New object every time: the IP whitelist middleware recompiles on change.
    config.tenantIpWhitelist = Object.fromEntries(Object.entries(d.ipWhitelist || {}).map(([t, ips]) => [t, [...ips]]));
  },
  async apply(d) {
    this.boot(d);
    const ipWhitelisted = Object.values(d.ipWhitelist || {}).filter((ips) => ips.length > 0).length;
    return { status: 'applied', details: { tenants: d.allowedTenants.length, apiKeys: Object.keys(d.tenantApiKeys).length, ipWhitelistedTenants: ipWhitelisted } };
  },
};

const ipIntel = {
  boot(d) {
    Object.assign(config.ipIntel, {
      provider: d.provider, apiKey: d.apiKey, strictness: d.strictness, timeoutMs: d.timeoutMs,
      cacheTtlMs: d.cacheTtlMs, cacheMax: d.cacheMax, devIp: d.devIp,
    });
  },
  async apply(d) {
    const changedSource = config.ipIntel.provider !== d.provider || config.ipIntel.apiKey !== d.apiKey || config.ipIntel.strictness !== d.strictness;
    this.boot(d);
    if (changedSource) ipIntelService.clearCache();
    return { status: 'applied', details: { provider: d.provider, cacheCleared: changedSource } };
  },
};

// Read once in createApp() / at module load → takes effect at the next restart.
const httpSecurity = {
  effective() {
    return {
      corsOrigins: config.corsOrigins, trustProxy: config.trustProxy, maxPayloadBytes: config.maxPayloadBytes,
      rateLimitWindowMs: config.rateLimitWindowMs, rateLimitMax: config.rateLimitMax,
      ipIntelRateLimitWindowMs: config.ipIntel.rateLimitWindowMs, ipIntelRateLimitMax: config.ipIntel.rateLimitMax,
    };
  },
  boot(d) {
    config.corsOrigins = [...d.corsOrigins];
    config.trustProxy = d.trustProxy;
    config.maxPayloadBytes = d.maxPayloadBytes;
    config.rateLimitWindowMs = d.rateLimitWindowMs;
    config.rateLimitMax = d.rateLimitMax;
    config.ipIntel.rateLimitWindowMs = d.ipIntelRateLimitWindowMs;
    config.ipIntel.rateLimitMax = d.ipIntelRateLimitMax;
  },
  async apply(d) {
    if (JSON.stringify(this.effective()) === JSON.stringify(d)) return { status: 'applied', details: { unchanged: true } };
    return { status: 'restart_required', details: { reason: 'CORS, proxy trust, body size and rate limits are built at startup' } };
  },
};

const SDK_DIR = path.join(__dirname, '../../sdk');
const MANIFEST = path.join(SDK_DIR, '.xylium-published.json');

const customPatterns = {
  readManifest() {
    try {
      return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).files || [];
    } catch {
      return [];
    }
  },
  boot(d) {
    return this.write(d);
  },
  write(d) {
    // The shared schema already checked sha256 and ran the privacy validator.
    const written = [];
    for (const p of d.patterns) {
      const target = path.join(SDK_DIR, p.filename);
      if (path.dirname(target) !== SDK_DIR) throw new Error(`refusing path outside the SDK folder: ${p.filename}`);
      const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
      if (current === p.code) continue;
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, p.code, 'utf8');
      const check = crypto.createHash('sha256').update(fs.readFileSync(tmp, 'utf8'), 'utf8').digest('hex');
      if (check !== p.sha256) {
        fs.unlinkSync(tmp);
        throw new Error(`checksum mismatch writing ${p.filename}`);
      }
      fs.renameSync(tmp, target);
      written.push(p.filename);
    }
    // Remove files this mechanism published earlier that are no longer listed.
    const keep = new Set(d.patterns.map((p) => p.filename));
    const removed = [];
    for (const f of this.readManifest()) {
      if (!keep.has(f) && /^[\w.-]+\.js$/.test(f) && fs.existsSync(path.join(SDK_DIR, f))) {
        fs.unlinkSync(path.join(SDK_DIR, f));
        removed.push(f);
      }
    }
    fs.writeFileSync(MANIFEST, JSON.stringify({ files: [...keep] }, null, 2));
    return { written, removed };
  },
  async apply(d) {
    return { status: 'applied', details: this.write(d) };
  },
};

const database = {
  boot(d) {
    // server.js initializes the registry from this right after bootstrap.
    setRuntimeDatabaseConfig(d);
  },
  async apply(d) {
    let result;
    try {
      result = await databaseSwitchService.switchDatabase(d.activeDatabase, ACTOR, { config: d });
    } catch (err) {
      if (err.code === 'restart_required') {
        setRuntimeDatabaseConfig(d); // used at next start
        return { status: 'restart_required', details: { reason: err.message } };
      }
      throw err;
    }
    setRuntimeDatabaseConfig(d);
    return {
      status: 'applied',
      details: {
        activeDatabase: databaseRegistry.getActiveType(),
        switched: !!result.previousDatabase,
        reconfigured: !!result.reconfigured,
        alreadyActive: !!result.alreadyActive,
      },
    };
  },
  /** Dry run for /internal/config/validate: test the target engine, change nothing. */
  async validate(d) {
    return databaseSwitchService.testConnection(d.activeDatabase, d);
  },
};

const APPLIERS = {
  database,
  ingestion,
  tenants,
  'ip-intel': ipIntel,
  'http-security': httpSecurity,
  'custom-patterns': customPatterns,
};

module.exports = { APPLIERS, SDK_DIR };
