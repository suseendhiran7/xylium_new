const mongoose = require('mongoose');
const config = require('./config');
const databaseRegistry = require('./config/database-registry');
const createApp = require('./app');
const { ensureTtlIndexes } = require('./database/mongo-models-connection');
const { startForwardWorker } = require('./forward/worker');
const { getRuntimeConfig } = require('./runtime-config');
const { loadDatabaseConfig, getDatabaseConfigSource } = require('./config/database.config');

async function main() {
  // CONFIG_SOURCE=admin: load settings from the Admin Application (or the
  // last-known-good file) before anything below reads them. env: no-op.
  const runtimeConfig = getRuntimeConfig();
  await runtimeConfig.bootstrap();

  // ACTIVE_DATABASE from env, or the admin-managed database config.
  const dbCfg = loadDatabaseConfig();
  const usePostgres = dbCfg.activeDatabase === 'postgresql';
  console.log(`[server] database configuration from ${getDatabaseConfigSource()}: ${dbCfg.activeDatabase}`);

  // Connect Mongoose only when MongoDB is the active database. With PostgreSQL
  // active nothing is stored in Mongo (if an admin switches to MongoDB later,
  // the Mongo adapter connects then).
  if (!usePostgres) try {
    await mongoose.connect(dbCfg.mongodb.uri);
    console.log(`[XyliumIngestion] connected to Mongo`);

    await ensureTtlIndexes(config.rawTtlDays);
  } catch (err) {
    console.warn(`[server] MongoDB startup warning: ${err.message}`);
  }

  // Initialize Dual Database Registry with default active database in code (mongodb)
  try {
    const db = usePostgres ? 'postgresql' : 'mongodb';
    await databaseRegistry.initialize(db);
    const activeAdapter = databaseRegistry.getActiveAdapter();
    const health = await activeAdapter.healthCheck();
    if (health.status !== 'healthy') {
      console.warn(`[server] Warning: Active database (${databaseRegistry.getActiveType()}) reported unhealthy status:`, health.error);
    } else {
      console.log(`[server] Active database (${databaseRegistry.getActiveType()}) verified healthy (${health.latencyMs}ms)`);
    }
  } catch (err) {
    console.error(`[server] Active database initialization error: ${err.message}`);
  }

  // PostgreSQL version of the Mongo TTL index: purge raw event rows older than
  // RAW_TTL_DAYS from login_/session_/payment_events and event_batches, hourly.
  // Always scheduled: rawTtlDays can now change at runtime (admin ingestion config).
  let retentionTimer = null;
  {
    const purge = async () => {
      if (!(config.rawTtlDays > 0)) return;
      if (databaseRegistry.getActiveType() !== 'postgresql') return;
      try {
        const res = await databaseRegistry.getActiveAdapter().getAppStore().purgeRawOlderThan(config.rawTtlDays);
        const total = Object.values(res).reduce((a, b) => a + b, 0);
        if (total) console.log(`[retention] purged ${total} PostgreSQL row(s) older than ${config.rawTtlDays} day(s)`, res);
      } catch (err) {
        console.warn('[retention] PostgreSQL purge failed:', err.message);
      }
    };
    purge();
    retentionTimer = setInterval(purge, 60 * 60 * 1000);
    retentionTimer.unref();
  }

  const worker = startForwardWorker();

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`[XyliumIngestion] listening on :${config.port}`);
    runtimeConfig.start();
  });

  const shutdown = async (signal) => {
    console.log(`[server] received ${signal}, shutting down...`);
    server.close();
    runtimeConfig.stop();
    if (retentionTimer) clearInterval(retentionTimer);
    await worker.close();
    await databaseRegistry.shutdownAll();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[server] fatal startup error', err);
  process.exit(1);
});
