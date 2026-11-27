'use strict';

const { z } = require('zod');
const { ipEntryProblem } = require('../ip-whitelist');

const TENANT_ID = z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/, 'tenant id: letters, digits, _ . - (max 64)');

const IP_ENTRY = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .superRefine((v, ctx) => {
    const problem = ipEntryProblem(v);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  });

/**
 * Tenant allow-list for /collect and /ip-intel, per-tenant API keys for
 * server-to-server calls (/identify), and a per-tenant IP whitelist.
 * Read per request.
 */
const TenantsConfigSchema = z.object({
  // Empty = allow every tenant (dev only), same as ALLOWED_TENANTS today.
  allowedTenants: z.array(TENANT_ID).max(10000).default([]),
  tenantApiKeys: z.record(TENANT_ID, z.string().min(12, 'API key must be at least 12 characters').max(256)).default({}),
  // tenant id -> IPs / CIDR ranges allowed to call the SDK for that tenant.
  // A tenant with no entries (or not listed) accepts requests from any IP.
  ipWhitelist: z.record(TENANT_ID, z.array(IP_ENTRY).max(1000)).default({}),
});

module.exports = {
  key: 'tenants',
  description: 'Tenant allow-list, per-tenant server API keys and per-tenant IP whitelist',
  applyMode: 'hot',
  secretPaths: ['tenantApiKeys'],
  schema: TenantsConfigSchema,
};
