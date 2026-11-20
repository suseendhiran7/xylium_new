'use strict';

const os = require('os');
const { CONFIG_TYPES, parseConfig, checksum, configsFromEnv, maskSecrets, getConfigType } = require('@xylium/config');
const databaseRegistry = require('../config/database-registry');
const lkg = require('./last-known-good');
const { AdminClient } = require('./admin.client');

const pkgVersion = (() => {
  try {
    return require('../../package.json').version;
  } catch {
    return undefined;
  }
})();

/**
 * Keeps this SDK instance's configuration in step with the Admin Application.
 *
 *   notice  → POST /internal/config/changed  ("type T is at version V")
 *   pull    → GET  {admin}/internal/config/snapshot?types=T
 *   check   → checksum + shared zod schema (the SDK trusts the admin's
 *             signature, not its data)
 *   apply   → per-type applier; on failure the previous settings stay
 *   ack     → POST {admin}/internal/config/ack
 *
 * Changes of one type are applied one at a time, in version order; an older
 * or duplicate version is acknowledged as `skipped_stale`. A heartbeat every
 * 30 s reports applied versions and pulls anything newer, so a lost notice
 * heals by itself.
 */
class RuntimeConfig {
  constructor({ settings, appliers, client = null, log = console }) {
    this.s = settings;
    this.appliers = appliers;
    this.client = client || (settings.enabled ? new AdminClient(settings) : null);
    this.log = log;
    this.applied = {}; // type -> { version, checksum, data, appliedAt }
    this.pendingRestart = {}; // type -> { version, checksum, data }
    this.queues = {}; // type -> promise chain
    this.lastError = null;
    this.source = 'env';
    this.startedAt = Date.now();
    this.timer = null;
  }

  get enabled() {
    return this.s.enabled;
  }

  appliedVersions() {
    return Object.fromEntries(Object.keys(CONFIG_TYPES).map((k) => [k, this.applied[k] ? this.applied[k].version : 0]));
  }

  /** Validate one snapshot entry; returns parsed data or throws. */
  check(type, entry) {
    if (!CONFIG_TYPES[type]) throw new Error(`unknown config type ${type}`);
    const sum = checksum(entry.data);
    if (sum !== entry.checksum) throw new Error(`checksum mismatch for ${type} v${entry.version}`);
    const parsed = parseConfig(type, entry.data);
    if (!parsed.success) {
      throw new Error(`invalid ${type} v${entry.version}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    return parsed.data;
  }

  // ------------------------------------------------------------------ boot

  /**
   * Called by server.js before the database and the app are set up.
   * admin mode: admin snapshot → last-known-good file → env (in that order).
   * shadow mode: compare admin with env and log; apply nothing.
   */
  async bootstrap() {
    if (!this.enabled) return { source: 'env' };
    let snap = null;
    let source = null;
    try {
      snap = await this.client.snapshot();
      source = 'admin';
    } catch (err) {
      this.log.warn(`[runtime-config] admin unreachable at startup (${err.message})`);
      if (this.s.mode === 'admin') {
        try {
          snap = lkg.load(this.s.cacheFile, this.s.cacheKey);
          if (snap) source = 'last-known-good';
        } catch (e) {
          this.log.error(`[runtime-config] last-known-good unreadable: ${e.message}`);
        }
      }
    }
    if (!snap) {
      this.log.warn('[runtime-config] starting from environment variables');
      return { source: (this.source = 'env') };
    }

    if (this.s.mode === 'shadow') {
      this.logShadowDiff(snap);
      return { source: (this.source = 'env'), shadow: true };
    }

    for (const [type, entry] of Object.entries(snap.configs || {})) {
      try {
        const data = this.check(type, entry);
        await this.appliers[type].boot(data);
        this.applied[type] = { version: entry.version, checksum: entry.checksum, data, appliedAt: new Date().toISOString() };
      } catch (err) {
        this.lastError = err.message;
        this.log.error(`[runtime-config] boot: ${type} v${entry.version} not applied (env value kept): ${err.message}`);
      }
    }
    this.source = source;
    if (source === 'admin') this.persist();
    this.log.log(`[runtime-config] configuration from ${source}: ${JSON.stringify(this.appliedVersions())}`);
    return { source };
  }

  logShadowDiff(snap) {
    const fromEnv = configsFromEnv(process.env);
    for (const [type, entry] of Object.entries(snap.configs || {})) {
      if (!fromEnv[type]) continue;
      const envParsed = parseConfig(type, fromEnv[type]);
      if (!envParsed.success) continue;
      const same = checksum(envParsed.data) === entry.checksum;
      if (same) this.log.log(`[runtime-config][shadow] ${type} v${entry.version}: matches env`);
      else {
        const secretPaths = getConfigType(type).secretPaths;
        const mask = (d) => JSON.stringify(maskSecrets(d, secretPaths, (v) => (v ? '***' : '')));
        this.log.warn(`[runtime-config][shadow] ${type} v${entry.version} DIFFERS from env\n  admin: ${mask(entry.data)}\n  env:   ${mask(envParsed.data)}`);
      }
    }
  }

  // ------------------------------------------------------------------ live sync

  /** Handle a verified notice; returns immediately, work is queued per type. */
  onNotice(notice) {
    if (this.s.mode !== 'admin') {
      this.log.log(`[runtime-config][${this.s.mode}] notice ${notice.configType} v${notice.version} (not applied in this mode)`);
      return Promise.resolve();
    }
    return this.enqueue(notice.configType, { changeId: notice.changeId, version: notice.version });
  }

  enqueue(type, hint) {
    const prev = this.queues[type] || Promise.resolve();
    const next = prev.then(() => this.syncType(type, hint)).catch((err) => {
      this.lastError = err.message;
      this.log.error(`[runtime-config] sync ${type} failed: ${err.message}`);
    });
    this.queues[type] = next;
    return next;
  }

  seenVersion(type) {
    return Math.max(this.applied[type] ? this.applied[type].version : 0, this.pendingRestart[type] ? this.pendingRestart[type].version : 0);
  }

  async syncType(type, { changeId = null, version = null } = {}) {
    const started = Date.now();
    const ack = (status, extra = {}) =>
      this.client
        .ack({ instanceId: this.s.instanceId, changeId, configType: type, durationMs: Date.now() - started, error: null, ...extra, status })
        .catch((err) => this.log.warn(`[runtime-config] ack failed: ${err.message}`));

    if (version && version <= this.seenVersion(type)) {
      await ack('skipped_stale', { version });
      return;
    }
    const snap = await this.client.snapshot([type]);
    const entry = snap.configs && snap.configs[type];
    if (!entry || entry.version <= this.seenVersion(type)) {
      if (version) await ack('skipped_stale', { version });
      return;
    }

    let data;
    let result;
    try {
      data = this.check(type, entry);
      result = await this.appliers[type].apply(data);
    } catch (err) {
      this.lastError = `${type} v${entry.version}: ${err.message}`;
      this.log.error(`[runtime-config] ${type} v${entry.version} NOT applied, previous settings kept: ${err.message}`);
      await ack('failed', { version: entry.version, error: String(err.message).slice(0, 2000) });
      return;
    }

    const record = { version: entry.version, checksum: entry.checksum, data, appliedAt: new Date().toISOString() };
    if (result.status === 'restart_required') {
      this.pendingRestart[type] = record;
      this.log.warn(`[runtime-config] ${type} v${entry.version} stored; takes effect at next restart`);
    } else {
      this.applied[type] = record;
      delete this.pendingRestart[type];
      this.log.log(`[runtime-config] ${type} v${entry.version} applied in ${Date.now() - started}ms`);
    }
    this.persist();
    await ack(result.status, { version: entry.version, details: result.details || {} });
  }

  /** Save what the next start should use: applied + pending-restart versions. */
  persist() {
    if (!this.s.cacheKey) return;
    const configs = {};
    for (const [type, r] of Object.entries({ ...this.applied, ...this.pendingRestart })) {
      configs[type] = { version: r.version, checksum: r.checksum, data: r.data };
    }
    try {
      lkg.save(this.s.cacheFile, this.s.cacheKey, { revision: 0, savedAt: new Date().toISOString(), configs });
    } catch (err) {
      this.log.warn(`[runtime-config] could not write last-known-good: ${err.message}`);
    }
  }

  // ------------------------------------------------------------------ heartbeat

  async heartbeat() {
    const res = await this.client.heartbeat({
      instanceId: this.s.instanceId,
      baseUrl: this.s.baseUrl,
      hostname: os.hostname().slice(0, 255),
      appVersion: pkgVersion,
      activeDatabase: databaseRegistry.getActiveType() || null,
      appliedVersions: this.appliedVersions(),
      pendingRestart: Object.keys(this.pendingRestart),
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
    });
    if (this.s.mode !== 'admin' || !res || !res.latestVersions) return res;
    for (const [type, latest] of Object.entries(res.latestVersions)) {
      if (CONFIG_TYPES[type] && latest > this.seenVersion(type)) {
        this.log.log(`[runtime-config] heartbeat: ${type} v${latest} available (have v${this.seenVersion(type)}), pulling`);
        this.enqueue(type, { version: latest });
      }
    }
    return res;
  }

  start() {
    if (!this.enabled || this.timer) return;
    const beat = () => this.heartbeat().catch((err) => this.log.warn(`[runtime-config] heartbeat failed: ${err.message}`));
    beat();
    this.timer = setInterval(beat, this.s.heartbeatMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status() {
    return {
      mode: this.s.mode,
      instanceId: this.s.instanceId,
      source: this.source,
      appliedVersions: this.appliedVersions(),
      pendingRestart: Object.fromEntries(Object.entries(this.pendingRestart).map(([k, v]) => [k, v.version])),
      lastError: this.lastError,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }
}

module.exports = { RuntimeConfig };
