'use strict';

const { z } = require('zod');

const TENANT_ID = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'tenant id: letters, digits, _ . - (max 64)');

/**
 * Tenant allow-list for /collect and /ip-intel, and per-tenant API keys for
 * server-to-server calls (/identify, /payments/verify). Read per request.
 */
const TenantsConfigSchema = z.object({
  // Empty = allow every tenant (dev only), same as ALLOWED_TENANTS today.
  allowedTenants: z.array(TENANT_ID).max(10000).default([]),
  tenantApiKeys: z.record(TENANT_ID, z.string().min(12, 'API key must be at least 12 characters').max(256)).default({}),
});

module.exports = {
  key: 'tenants',
  description: 'Tenant allow-list and per-tenant server API keys',
  applyMode: 'hot',
  secretPaths: ['tenantApiKeys'],
  schema: TenantsConfigSchema,
};
