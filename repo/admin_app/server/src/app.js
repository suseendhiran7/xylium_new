'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const { requestId, notFound, errorHandler } = require('./middleware/common');
const { loadSession, requireAuth, requireCsrf } = require('./middleware/session');
const authRoutes = require('./modules/auth/auth.routes');
const usersRoutes = require('./modules/users/users.routes');
const configsRoutes = require('./modules/configs/configs.routes');
const { instances, rollouts, audit } = require('./modules/instances/instances.routes');
const internalRoutes = require('./internal/internal.routes');

const { getConfig } = require('./config');

const WEB_DIST = path.join(__dirname, '../../web/dist');

/** Browser-facing app: /api/* plus the built React UI. Same origin, so no CORS. */
function createPublicApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(requestId);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          // Production runs behind TLS; locally (http://localhost) upgrading would break asset loads.
          upgradeInsecureRequests: getConfig().production ? [] : null,
        },
      },
    })
  );
  app.use(express.json({ limit: '512kb' }));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  const api = express.Router();
  api.use(loadSession);
  api.use(requireCsrf);
  api.use('/auth', authRoutes);
  api.use(requireAuth);
  api.use('/users', usersRoutes);
  api.use('/configs', configsRoutes);
  api.use('/instances', instances);
  api.use('/rollouts', rollouts);
  api.use('/audit', audit);
  api.use(notFound);
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  }, api);

  if (fs.existsSync(path.join(WEB_DIST, 'index.html'))) {
    app.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }));
    app.get('*', (req, res) => res.sendFile(path.join(WEB_DIST, 'index.html')));
  } else {
    app.get('/', (req, res) => res.type('text').send('Admin UI not built. Run `npm run build` in admin_app (or `npm run dev:web` for development).'));
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

/** SDK-facing app on INTERNAL_PORT: HMAC-signed /internal/* only. */
function createInternalApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  // Keep the exact bytes: the signature covers the raw body.
  app.use(express.json({ limit: '2mb', verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }));
  app.use('/internal', internalRoutes);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createPublicApp, createInternalApp };
