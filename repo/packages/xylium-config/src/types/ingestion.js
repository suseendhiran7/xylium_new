'use strict';

const { z } = require('zod');
const { safeRegexSource } = require('../regex-safety');

/**
 * /collect behaviour. Every field is read per request through the SDK's
 * config singleton, so changes apply without a restart.
 */
const IngestionConfigSchema = z.object({
  maxBatchEvents: z.number().int().min(1).max(10000).default(500),
  // Regex source, matched case-insensitively against each event's page path.
  paymentPagePattern: z
    .string()
    .min(1)
    .max(200)
    .superRefine((src, ctx) => {
      const problem = safeRegexSource(src);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    })
    .default('(payment|checkout|pay|billing)'),
  // Raw event retention; 0 = keep forever.
  rawTtlDays: z.number().int().min(0).max(3650).default(0),
});

module.exports = {
  key: 'ingestion',
  description: 'Event batch limits, payment-page routing pattern and raw-event retention',
  applyMode: 'hot',
  secretPaths: [],
  schema: IngestionConfigSchema,
};
