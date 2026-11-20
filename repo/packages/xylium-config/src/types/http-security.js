'use strict';

const { z } = require('zod');

/**
 * Settings the SDK reads once in createApp() / at module load. A change is
 * stored and acknowledged as `restart_required`, and takes effect on the next
 * (rolling) restart.
 */
const HttpSecurityConfigSchema = z.object({
  corsOrigins: z.array(z.string().min(1).max(256)).default([]),
  // Express `trust proxy`: true/false, a hop count, or a comma list of subnets/keywords.
  trustProxy: z.union([z.boolean(), z.number().int().min(0).max(10), z.string().max(512)]).default('loopback, linklocal, uniquelocal'),
  maxPayloadBytes: z.number().int().min(1024).max(10 * 1024 * 1024).default(262144),
  rateLimitWindowMs: z.number().int().min(1000).default(60000),
  rateLimitMax: z.number().int().min(1).default(3000),
  ipIntelRateLimitWindowMs: z.number().int().min(1000).default(60000),
  ipIntelRateLimitMax: z.number().int().min(1).default(30),
}).superRefine((v, ctx) => {
  if (v.trustProxy === true) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['trustProxy'], message: 'trustProxy=true lets any client spoof X-Forwarded-For; use a hop count or subnet list' });
  }
});

module.exports = {
  key: 'http-security',
  description: 'CORS, proxy trust, body size and rate limits (applied at restart)',
  applyMode: 'restart',
  secretPaths: [],
  schema: HttpSecurityConfigSchema,
};
