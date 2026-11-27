const config = require('../config');
const { enforceTenantIp } = require('./tenantIpWhitelist');

function tenantGuard(req, res, next) {
  // req.body can be undefined if Content-Type was wrong (e.g. sendBeacon)
  // Parse it safely
  const body = req.body || {};
  // POST /collect sends it in the body; GET /ip-intel in the query string.
  const tenantId = body.tenantId || (req.query && req.query.tenantId);

  // Gate is open in dev if no tenants configured (the tenant's IP whitelist,
  // if it has one, still applies).
  if (config.allowedTenants.length === 0) {
    if (typeof tenantId === 'string' && !enforceTenantIp(req, res, tenantId)) return;
    return next();
  }

  if (!tenantId) {
    return res.status(400).json({ error: 'tenantId missing' });
  }

  if (!config.allowedTenants.includes(tenantId)) {
    return res.status(403).json({ error: 'unknown tenant' });
  }

  if (!enforceTenantIp(req, res, tenantId)) return;

  next();
}

module.exports = tenantGuard;
