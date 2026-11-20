const databaseRegistry = require('../config/database-registry');
const DatabaseFactory = require('../database/factories/database.factory');
const {
  loadDatabaseConfig,
  parseDatabaseConfig,
  sanitizeConfig,
  connectionFingerprint,
  normalizeType,
} = require('../config/database.config');
const { ensureModelsConnection } = require('../database/mongo-models-connection');
const appConfig = require('../config');

const ALLOWED_DATABASES = ['postgresql', 'mongodb'];
const DEFAULT_RETIRE_GRACE_MS = 30000;

function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

const actorName = (adminUser) => adminUser.username || adminUser.userId || 'admin';

class DatabaseSwitchService {
  /**
   * Validate that the requested database type is in the allowlist.
   */
  validateDatabaseType(type) {
    if (!type || typeof type !== 'string') {
      throw httpError(400, 'Database type is required');
    }
    const resolved = normalizeType(type) || type.toLowerCase().trim();
    if (!ALLOWED_DATABASES.includes(resolved)) {
      throw httpError(400, `Invalid database type: '${type}'. Allowed types are: ${ALLOWED_DATABASES.join(', ')}`);
    }
    return resolved;
  }

  /**
   * Resolve the configuration to use: an explicit candidate (validated with
   * the shared schema) or the current configuration (runtime override or env).
   * @returns {{ config: object, explicit: boolean }}
   */
  _resolveConfig(candidateConfig) {
    if (candidateConfig) return { config: parseDatabaseConfig(candidateConfig), explicit: true };
    return { config: loadDatabaseConfig(), explicit: false };
  }

  /**
   * Build an adapter from `config`. Explicit (admin-supplied) configs never
   * fall back to the embedded engine: a candidate either reaches the real
   * database or fails.
   */
  _createAdapter(type, config, explicit) {
    const options = explicit ? { allowEmbeddedFallback: false } : {};
    const adapter = DatabaseFactory.createAdapter(type, config, null, options);
    adapter.connectionFingerprint = connectionFingerprint(type, config);
    return adapter;
  }

  /**
   * Test a candidate database connection without switching the active adapter.
   *
   * @param {string} type
   * @param {object} [candidateConfig] full database config (same shape as
   *   DatabaseConfigSchema). When given, a fresh connection is built from it
   *   (never the embedded engine) and closed again afterwards. When omitted,
   *   the current configuration is tested, reusing a cached adapter if one
   *   exists. A temporary adapter is always disconnected afterwards.
   */
  async testConnection(type, candidateConfig = null) {
    const targetType = this.validateDatabaseType(type);
    const { config, explicit } = this._resolveConfig(candidateConfig);
    const fingerprint = connectionFingerprint(targetType, config);

    let candidate = explicit ? null : databaseRegistry.getCachedAdapter(targetType);
    if (candidate && explicit === false && candidate.connectionFingerprint && candidate.connectionFingerprint !== fingerprint) {
      candidate = null; // cached adapter was built from older settings
    }
    let temporary = false;
    if (!candidate) {
      candidate = this._createAdapter(targetType, config, explicit);
      temporary = true;
    }

    const startTime = Date.now();
    try {
      if (!candidate.isConnected) {
        await candidate.connect();
      }
      const health = await candidate.healthCheck();
      if (health.status !== 'healthy') {
        throw new Error(health.error || 'Health check returned unhealthy status');
      }
      if (explicit && candidate.isEmbedded) {
        throw new Error('Connected to the embedded engine, not the configured server');
      }

      return {
        ok: true,
        databaseType: targetType,
        status: 'healthy',
        latencyMs: health.latencyMs || (Date.now() - startTime),
        info: candidate.getAdapterInfo(),
        details: health.details || {},
      };
    } catch (err) {
      return {
        ok: false,
        databaseType: targetType,
        status: 'unhealthy',
        latencyMs: Date.now() - startTime,
        error: err.message,
      };
    } finally {
      // Previously temporary adapters were left connected, leaking a pool per test.
      if (temporary) {
        await candidate.disconnect().catch(() => {});
      }
    }
  }

  /**
   * Execute a controlled, atomic database switch with pre-validation and rollback.
   *
   * @param {string} requestedType
   * @param {Object} adminUser
   * @param {{ config?: object, retireGraceMs?: number }} [options]
   *   config: explicit database configuration (e.g. from the Admin
   *   Application). Omitted = current configuration, exactly as before.
   *   If the target type is already active but `config` changes its
   *   connection settings, this becomes reconfigureActive().
   */
  async switchDatabase(requestedType, adminUser = {}, options = {}) {
    const targetType = this.validateDatabaseType(requestedType);
    const currentActiveType = databaseRegistry.getActiveType();
    const { config, explicit } = this._resolveConfig(options.config);
    const fingerprint = connectionFingerprint(targetType, config);

    if (targetType === currentActiveType) {
      const activeAdapter = databaseRegistry.getActiveAdapter();
      const sameSettings = !explicit || !activeAdapter.connectionFingerprint || activeAdapter.connectionFingerprint === fingerprint;
      if (!sameSettings) {
        return this.reconfigureActive(config, adminUser, { retireGraceMs: options.retireGraceMs });
      }
      const health = await activeAdapter.healthCheck();
      return {
        ok: true,
        alreadyActive: true,
        activeDatabase: currentActiveType,
        status: health.status,
        health,
        info: activeAdapter.getAdapterInfo(),
      };
    }

    // Acquire concurrency lock to prevent simultaneous switches
    databaseRegistry.acquireSwitchLock();

    let candidate = null;
    let createdHere = false;
    try {
      // Reuse a cached adapter only if it was built from these settings.
      const cached = databaseRegistry.adapters.get(targetType) || null;
      candidate = explicit ? databaseRegistry.getCachedAdapter(targetType, fingerprint) : cached;
      const stale = cached && cached !== candidate ? cached : null;

      if (!candidate) {
        candidate = this._createAdapter(targetType, config, explicit);
        createdHere = true;
      }

      // Establish connection if not already connected
      if (!candidate.isConnected) {
        try {
          await candidate.connect();
        } catch (connErr) {
          throw httpError(502, `Connection to ${targetType} failed: ${connErr.message}`);
        }
      }

      // Health check & schema validation
      const health = await candidate.healthCheck();
      const embeddedNotAllowed = explicit && candidate.isEmbedded;
      if (health.status !== 'healthy' || embeddedNotAllowed) {
        const errorMsg = embeddedNotAllowed
          ? 'connected to the embedded engine, not the configured server'
          : (health.error || 'Candidate database failed health check validation');
        databaseRegistry.recordHistory({
          admin: actorName(adminUser),
          fromDatabase: currentActiveType,
          toDatabase: targetType,
          status: 'FAILED',
          message: `Switch to ${targetType} rejected: candidate health check failed`,
          error: new Error(errorMsg),
        });
        throw httpError(502, `Cannot switch to ${targetType}: database is unhealthy (${errorMsg})`);
      }

      // The Mongoose models write through the global connection; make sure it
      // is open before any request is routed to MongoDB.
      if (targetType === 'mongodb') {
        try {
          await ensureModelsConnection(config.mongodb, { rawTtlDays: appConfig.rawTtlDays });
        } catch (mErr) {
          throw httpError(502, `Connection to mongodb (models) failed: ${mErr.message}`);
        }
      }

      // Perform atomic switch in registry
      databaseRegistry.setActiveAdapter(targetType, candidate, adminUser);
      createdHere = false; // now owned by the registry

      // An adapter cached from older settings is no longer reachable by type.
      if (stale) {
        databaseRegistry.retireAdapter(stale, { graceMs: options.retireGraceMs ?? DEFAULT_RETIRE_GRACE_MS }).catch(() => {});
      }

      return {
        ok: true,
        previousDatabase: currentActiveType,
        activeDatabase: targetType,
        status: 'healthy',
        health,
        info: candidate.getAdapterInfo(),
      };
    } catch (err) {
      if (err.status !== 502) {
        databaseRegistry.recordHistory({
          admin: actorName(adminUser),
          fromDatabase: currentActiveType,
          toDatabase: targetType,
          status: 'FAILED',
          message: `Switch to ${targetType} failed: ${err.message}`,
          error: err,
        });
      }
      throw err;
    } finally {
      // A candidate built for this attempt that never became active is closed.
      if (createdHere && candidate) {
        await candidate.disconnect().catch(() => {});
      }
      databaseRegistry.releaseSwitchLock();
    }
  }

  /**
   * Apply new connection settings to the database type that is ALREADY active
   * (e.g. PostgreSQL host move or password rotation) without a restart:
   * build a new adapter, connect, health-check, swap atomically, then drain
   * and disconnect the old adapter after a grace period. On any failure the
   * old adapter stays active and untouched.
   *
   * MongoDB: the Mongoose models share the global connection, which cannot be
   * re-pointed safely while serving traffic, so a changed MongoDB connection
   * is rejected with status 409 / code 'restart_required'.
   *
   * @param {object} candidateConfig full database config
   * @param {object} adminUser
   * @param {{ retireGraceMs?: number }} [options]
   */
  async reconfigureActive(candidateConfig, adminUser = {}, options = {}) {
    const config = parseDatabaseConfig(candidateConfig);
    const activeType = databaseRegistry.getActiveType();
    const oldAdapter = databaseRegistry.getActiveAdapter();
    const fingerprint = connectionFingerprint(activeType, config);

    if (oldAdapter.connectionFingerprint === fingerprint) {
      return { ok: true, unchanged: true, activeDatabase: activeType };
    }
    if (activeType === 'mongodb') {
      throw httpError(409, 'Changing the MongoDB connection of the active database requires a restart', {
        code: 'restart_required',
      });
    }

    databaseRegistry.acquireSwitchLock();
    const candidate = this._createAdapter(activeType, config, true);
    let swapped = false;
    try {
      try {
        await candidate.connect();
      } catch (connErr) {
        throw httpError(502, `Connection to ${activeType} failed: ${connErr.message}`);
      }
      const health = await candidate.healthCheck();
      if (health.status !== 'healthy' || candidate.isEmbedded) {
        throw httpError(502, `Cannot reconfigure ${activeType}: database is unhealthy (${health.error || 'embedded engine'})`);
      }

      databaseRegistry.setActiveAdapter(activeType, candidate, adminUser, {
        message: `Reconfigured ${activeType} connection (new settings ${fingerprint.split(':')[1]})`,
      });
      swapped = true;

      const retired = databaseRegistry.retireAdapter(oldAdapter, {
        graceMs: options.retireGraceMs ?? DEFAULT_RETIRE_GRACE_MS,
      });
      retired.catch(() => {});

      return {
        ok: true,
        reconfigured: true,
        activeDatabase: activeType,
        status: 'healthy',
        health,
        info: candidate.getAdapterInfo(),
        retired, // promise; resolves once the old connection is closed
      };
    } catch (err) {
      databaseRegistry.recordHistory({
        admin: actorName(adminUser),
        fromDatabase: activeType,
        toDatabase: activeType,
        status: 'FAILED',
        message: `Reconfigure ${activeType} failed: ${err.message}`,
        error: err,
      });
      throw err;
    } finally {
      if (!swapped) await candidate.disconnect().catch(() => {});
      databaseRegistry.releaseSwitchLock();
    }
  }

  /**
   * Get operational health status for all databases and the active adapter.
   */
  async getStatus() {
    const activeType = databaseRegistry.getActiveType();
    const config = loadDatabaseConfig();
    const results = {};

    for (const type of ALLOWED_DATABASES) {
      const adapter = databaseRegistry.adapters.get(type);
      if (adapter && adapter.isConnected) {
        try {
          const health = await adapter.healthCheck();
          results[type] = {
            configured: true,
            connected: true,
            isActive: type === activeType,
            status: health.status,
            latencyMs: health.latencyMs,
            details: health.details || {},
            info: adapter.getAdapterInfo(),
          };
        } catch (e) {
          results[type] = {
            configured: true,
            connected: false,
            isActive: type === activeType,
            status: 'unhealthy',
            error: e.message,
          };
        }
      } else {
        // Not connected yet; show configured status
        results[type] = {
          configured: true,
          connected: false,
          isActive: type === activeType,
          status: 'idle_or_disconnected',
          target: type === 'postgresql' ? `${config.postgresql.host}:${config.postgresql.port}/${config.postgresql.database}` : config.mongodb.database,
        };
      }
    }

    return {
      activeDatabase: activeType,
      isSwitchInProgress: databaseRegistry.isSwitchInProgress(),
      databases: results,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get sanitized configuration.
   */
  getConfig() {
    const rawConfig = loadDatabaseConfig();
    return {
      activeDatabase: databaseRegistry.getActiveType() || rawConfig.activeDatabase,
      configuration: sanitizeConfig(rawConfig),
      allowedDatabases: ALLOWED_DATABASES,
    };
  }

  /**
   * Get audit log of database switches.
   */
  getSwitchHistory() {
    return databaseRegistry.getSwitchHistory();
  }
}

module.exports = new DatabaseSwitchService();
