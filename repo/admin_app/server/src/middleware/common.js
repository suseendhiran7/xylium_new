'use strict';

const crypto = require('crypto');
const { ZodError } = require('zod');

function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  req.requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.set('X-Request-Id', req.requestId);
  next();
}

function notFound(req, res) {
  res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}`, requestId: req.requestId });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'validation_failed', message: 'Invalid input', details: err.flatten(), requestId: req.requestId });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid_json', message: 'Body is not valid JSON', requestId: req.requestId });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large', message: 'Request body too large', requestId: req.requestId });
  }
  const status = err && Number.isInteger(err.status) ? err.status : 500;
  if (status >= 500) console.error(`[admin] ${req.method} ${req.originalUrl} (${req.requestId})`, err);
  res.status(status).json({
    error: (err && err.code) || (status >= 500 ? 'internal_error' : 'error'),
    message: status >= 500 ? 'Internal server error' : err.message,
    ...(err && err.details !== undefined && status < 500 ? { details: err.details } : {}),
    requestId: req.requestId,
  });
}

module.exports = { requestId, notFound, errorHandler };
