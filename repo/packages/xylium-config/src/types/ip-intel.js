'use strict';

const { z } = require('zod');

/**
 * IP intelligence provider for /ip-intel. Read per lookup; the SDK applier
 * clears the in-memory lookup cache when the provider or key changes.
 * The per-IP rate limit is built at startup, so it lives in http-security.
 */
const IpIntelConfigSchema = z
  .object({
    provider: z.enum(['none', 'ipqs', 'ipapi']).default('none'),
    apiKey: z.string().max(256).default(''),
    strictness: z.number().int().min(0).max(3).default(1),
    timeoutMs: z.number().int().min(100).max(30000).default(3000),
    cacheTtlMs: z.number().int().min(0).default(6 * 60 * 60 * 1000),
    cacheMax: z.number().int().min(0).max(1000000).default(10000),
    devIp: z.string().max(64).default(''),
  })
  .superRefine((v, ctx) => {
    if (v.provider === 'ipqs' && !v.apiKey) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['apiKey'], message: 'apiKey is required when provider is ipqs' });
    }
  });

module.exports = {
  key: 'ip-intel',
  description: 'VPN / proxy / datacenter lookup provider, credentials and cache',
  applyMode: 'hot',
  secretPaths: ['apiKey'],
  schema: IpIntelConfigSchema,
};
