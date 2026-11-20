'use strict';

const { getConfig } = require('./config');
const { migrate } = require('./db/migrate');
const { closePool } = require('./db/pool');
const { createPublicApp, createInternalApp } = require('./app');
const { startOutboxWorker } = require('./modules/notifier/outbox.worker');

async function main() {
  const cfg = getConfig(); // fails fast on a bad environment
  await migrate();

  const pub = createPublicApp().listen(cfg.port, () => console.log(`[admin] UI + API on :${cfg.port}`));
  const internal = createInternalApp().listen(cfg.internalPort, cfg.internalHost, () =>
    console.log(`[admin] internal SDK API on ${cfg.internalHost}:${cfg.internalPort}`)
  );
  const worker = startOutboxWorker();

  const shutdown = async (signal) => {
    console.log(`[admin] ${signal}, shutting down`);
    worker.stop();
    pub.close();
    internal.close();
    await closePool().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[admin] fatal startup error:', err.message);
  process.exit(1);
});
