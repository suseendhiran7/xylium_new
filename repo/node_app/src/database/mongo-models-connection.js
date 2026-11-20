'use strict';

/**
 * The Mongoose models (Session, EventBatch, login_/session_/payment_events,
 * BehaviourSession, ...) are bound to the GLOBAL mongoose connection, while
 * the registry's MongoDBAdapter uses its own dedicated connection.
 *
 * server.js only opens the global connection when MongoDB is active at boot.
 * Before this module, a runtime switch PostgreSQL -> MongoDB left it closed,
 * and the `readyState === 1` guards in collectService/analyticsService then
 * silently skipped sessions, event batches and the login/session/payment
 * split — only behaviour_events (via the adapter) was written.
 */

const mongoose = require('mongoose');
const { COLLECTIONS } = require('../models/EventStores');

/** Raw-event TTL indexes (moved here from server.js so a switch can reuse it). */
async function ensureTtlIndexes(rawTtlDays) {
  if (!(rawTtlDays > 0) || mongoose.connection.readyState !== 1) return;
  for (const name of COLLECTIONS) {
    await mongoose.connection
      .collection(name)
      .createIndex({ receivedAt: 1 }, { expireAfterSeconds: rawTtlDays * 86400 })
      .catch((e) => console.warn(`[mongo] TTL index setup failed for ${name}`, e.message));
  }
}

/**
 * Open the global connection the models use, if it is not open yet.
 * Does nothing when it is already connected — in particular it never
 * re-points an open connection at a different URI (that needs a restart).
 * @param {{ uri: string, maxPoolSize?: number, minPoolSize?: number, serverSelectionTimeoutMS?: number, socketTimeoutMS?: number }} mongoConfig
 * @param {{ rawTtlDays?: number }} [opts]
 * @returns {Promise<{ connected: boolean, opened: boolean }>}
 */
async function ensureModelsConnection(mongoConfig, { rawTtlDays = 0 } = {}) {
  if (mongoose.connection.readyState === 1) return { connected: true, opened: false };
  await mongoose.connect(mongoConfig.uri, {
    maxPoolSize: mongoConfig.maxPoolSize,
    minPoolSize: mongoConfig.minPoolSize,
    serverSelectionTimeoutMS: mongoConfig.serverSelectionTimeoutMS,
    socketTimeoutMS: mongoConfig.socketTimeoutMS,
  });
  await ensureTtlIndexes(rawTtlDays);
  return { connected: true, opened: true };
}

module.exports = { ensureModelsConnection, ensureTtlIndexes };
