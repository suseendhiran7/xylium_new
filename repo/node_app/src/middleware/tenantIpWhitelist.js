'use strict';

const { compileIpWhitelist } = require('@xylium/config');
const config = require('../config');
const { getClientIp } = require('../utils/clientIp');

/**
 * Per-tenant IP whitelist (admin panel → Tenants & API keys → IP whitelist).
 *
 * Each tenant has its own list of IPs / CIDR ranges. When a tenant's list is
 * non-empty, requests for that tenant are accepted only from those addresses;
 * a tenant without entries accepts any IP. The client IP is req.ip, so
 * X-Forwarded-For is only believed through a trusted proxy (TRUST_PROXY).
 */

// Matchers are compiled once per config object; applying a new tenants
// config replaces config.tenantIpWhitelist, which drops the old cache.
let cachedFor = null;
let matchers = new Map();

function matcherFor(tenantId) {
  const lists = config.tenantIpWhitelist || {};
  if (lists !== cachedFor) {
    cachedFor = lists;
    matchers = new Map();
  }
  const entries = Object.prototype.hasOwnProperty.call(lists, tenantId) ? lists[tenantId] : null;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  if (!matchers.has(tenantId)) matchers.set(tenantId, compileIpWhitelist(entries));
  return matchers.get(tenantId);
}

/** true when the request's IP may act for this tenant. */
function isIpAllowedForTenant(req, tenantId) {
  const match = matcherFor(tenantId);
  if (!match) return true;
  return match(getClientIp(req));
}

/**
 * Sends 403 and returns false when the IP is not whitelisted for the tenant.
 * Use inside a guard: `if (!enforceTenantIp(req, res, tenantId)) return;`
 */
function enforceTenantIp(req, res, tenantId) {
  if (isIpAllowedForTenant(req, tenantId)) return true;
  console.warn(`[tenant-ip] blocked ${req.method} ${req.originalUrl} for tenant ${tenantId} from ${getClientIp(req)}`);
  res.status(403).json({ error: 'ip not allowed for this tenant' });
  return false;
}

module.exports = { isIpAllowedForTenant, enforceTenantIp };
