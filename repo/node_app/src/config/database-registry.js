const crypto = require('crypto');
const DatabaseFactory = require('../database/factories/database.factory');
const { loadDatabaseConfig, connectionFingerprint } = require('./database.config');

class DatabaseRegistry {
  constructor() {
    this.activeType = null;
    this.activeAdapter = null;
    this.adapters = new Map(); // Cache of initialized adapters
    this.isSwitching = false;
    this.switchHistory = [];
    this.initialized = false;
    this.retiring = new Set(); // adapters replaced by a newer connection, draining
  }

  /**
   * Initialize the database registry with the configured default active database.
   * @param {string} [initialType]
   * @param {Object} [customConnections] - Optional custom connections for tests
   */
  async initialize(initialType = null, customConnections = {}) {
    const config = loadDatabaseConfig();
    const raw = String(initialType || 'mongodb').toLowerCase().trim();
    // Accept the same aliases as the adapter factory ('postgres', 'mongo').
    const targetType = raw === 'postgres' ? 'postgresql' : raw === 'mongo' ? 'mongodb' : raw;

    // If an adapter is already active and healthy, don't reinitialize unless forced
    if (this.initialized && this.activeAdapter && this.activeType === targetType) {
      return this.activeAdapter;
    }

    let adapter = this.adapters.get(targetType);
    if (!adapter) {
      adapter = DatabaseFactory.createAdapter(targetType, config, customConnections[targetType]);
      await adapter.connect();
      this.cacheAdapter(targetType, adapter, connectionFingerprint(targetType, config));
    } else if (!adapter.isConnected) {
      await adapter.connect();
    }

    this.activeType = targetType;
    this.activeAdapter = adapter;
    this.initialized = true;

    this.recordHistory({
      admin: 'SYSTEM_BOOT',
      fromDatabase: null,
      toDatabase: targetType,
      status: 'SUCCESS',
      message: `System initialized with active database: ${targetType}`,
    });

    console.log(`[DatabaseRegistry] Active database initialized: ${targetType.toUpperCase()}`);
    return this.activeAdapter;
  }

  /**
   * Return the currently active event repository adapter.
   * Auto-initializes if not yet called.
   * @returns {import('../database/interfaces/event.repository')}
   */
  getActiveAdapter() {
    if (!this.activeAdapter) {
      const config = loadDatabaseConfig();
      const targetType = this.activeType || 'mongodb';
      this.activeAdapter = DatabaseFactory.createAdapter(targetType, config);
      this.activeType = targetType;
      this.cacheAdapter(targetType, this.activeAdapter, connectionFingerprint(targetType, config));
      this.initialized = true;
    }
    return this.activeAdapter;
  }

  /**
   * Return the active database type ('postgresql' | 'mongodb').
   * @returns {string}
   */
  getActiveType() {
    return this.activeType || 'mongodb';
  }

  /**
   * Check if a database switch is currently in progress.
   * @returns {boolean}
   */
  isSwitchInProgress() {
    return this.isSwitching;
  }

  /**
   * Acquire switching lock. Throws if another switch is underway.
   */
  acquireSwitchLock() {
    if (this.isSwitching) {
      const err = new Error('A database switch is already in progress. Please wait for completion.');
      err.status = 409;
      throw err;
    }
    this.isSwitching = true;
  }

  /**
   * Release switching lock.
   */
  releaseSwitchLock() {
    this.isSwitching = false;
  }

  /**
   * Atomically switch the active database adapter.
   * Retains the previous adapter so any in-flight requests finish safely.
   * @param {string} targetType
   * @param {import('../database/interfaces/event.repository')} candidateAdapter
   * @param {Object} adminInfo
   */
  setActiveAdapter(targetType, candidateAdapter, adminInfo = {}, { message } = {}) {
    const previousType = this.activeType;

    // Cache the adapter instance (keeps a fingerprint already stamped on it)
    this.cacheAdapter(targetType, candidateAdapter, candidateAdapter.connectionFingerprint);

    // Controlled atomic assignment
    this.activeAdapter = candidateAdapter;
    this.activeType = targetType;

    this.recordHistory({
      admin: adminInfo.username || adminInfo.userId || 'admin',
      fromDatabase: previousType,
      toDatabase: targetType,
      status: 'SUCCESS',
      message: message || `Successfully switched active database from ${previousType} to ${targetType}`,
    });

    console.log(`[DatabaseRegistry] Active database switched to: ${targetType.toUpperCase()}`);
  }

  /**
   * Put an adapter in the per-type cache, stamping the fingerprint of the
   * connection settings it was built from (see connectionFingerprint).
   */
  cacheAdapter(type, adapter, fingerprint) {
    if (fingerprint) adapter.connectionFingerprint = fingerprint;
    this.adapters.set(type, adapter);
    return adapter;
  }

  /**
   * The cached adapter for `type`, but only if it was built from the same
   * connection settings. An adapter with no fingerprint (injected by tests or
   * created before fingerprints existed) matches when no fingerprint is asked for.
   */
  getCachedAdapter(type, fingerprint = null) {
    const adapter = this.adapters.get(type);
    if (!adapter) return null;
    if (!fingerprint) return adapter;
    return adapter.connectionFingerprint === fingerprint ? adapter : null;
  }

  /**
   * Take an adapter out of service: drop it from the cache (if it is still the
   * cached one), then disconnect it after `graceMs` so requests that already
   * hold it can finish. disconnect() itself also waits for activeRequests.
   * Refuses the active adapter. Never closes the global mongoose connection
   * that the Mongoose models share.
   * @returns {Promise<void>} resolves once disconnected
   */
  retireAdapter(adapter, { graceMs = 30000 } = {}) {
    if (!adapter) return Promise.resolve();
    if (adapter === this.activeAdapter) {
      return Promise.reject(new Error('Refusing to retire the active database adapter'));
    }
    for (const [type, cached] of this.adapters.entries()) {
      if (cached === adapter) this.adapters.delete(type);
    }
    // eslint-disable-next-line global-require
    const mongoose = require('mongoose');
    if (adapter.connection && adapter.connection === mongoose.connection) {
      return Promise.resolve();
    }
    this.retiring.add(adapter);
    return new Promise((resolve) => {
      const timer = setTimeout(async () => {
        try {
          await adapter.disconnect();
        } catch (err) {
          console.warn('[DatabaseRegistry] Error disconnecting retired adapter:', err.message);
        } finally {
          this.retiring.delete(adapter);
          resolve();
        }
      }, Math.max(0, graceMs));
      if (typeof timer.unref === 'function') timer.unref();
    });
  }

  /**
   * Record a database switch or startup event in audit log.
   */
  recordHistory({ admin, fromDatabase, toDatabase, status, message, error = null }) {
    const entry = {
      id: `sw_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      timestamp: new Date().toISOString(),
      admin: admin || 'unknown_admin',
      fromDatabase,
      toDatabase,
      status, // 'SUCCESS' | 'FAILED'
      message,
      error: error ? (error.message || String(error)) : null,
    };
    this.switchHistory.unshift(entry);
    if (this.switchHistory.length > 50) {
      this.switchHistory.pop();
    }
    return entry;
  }

  /**
   * Retrieve switch history audit log.
   */
  getSwitchHistory() {
    return [...this.switchHistory];
  }

  /**
   * Graceful shutdown of all open adapters.
   */
  async shutdownAll() {
    console.log('[DatabaseRegistry] Gracefully disconnecting all database adapters...');
    for (const [type, adapter] of this.adapters.entries()) {
      try {
        await adapter.disconnect();
        console.log(`[DatabaseRegistry] Disconnected ${type}`);
      } catch (err) {
        console.warn(`[DatabaseRegistry] Error disconnecting ${type}:`, err.message);
      }
    }
    for (const adapter of this.retiring) {
      try {
        await adapter.disconnect();
      } catch (err) {
        console.warn('[DatabaseRegistry] Error disconnecting retiring adapter:', err.message);
      }
    }
    this.retiring.clear();
    this.activeAdapter = null;
    this.activeType = null;
    this.adapters.clear();
    this.initialized = false;
  }
}

// Export singleton instance
module.exports = new DatabaseRegistry();
