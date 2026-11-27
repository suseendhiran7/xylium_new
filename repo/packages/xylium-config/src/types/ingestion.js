'use strict';

const { z } = require('zod');

/**
 * /collect behaviour. Every field is read per request through the SDK's
 * config singleton, so changes apply without a restart.
 */
const IngestionConfigSchema = z.object({
  maxBatchEvents: z.number().int().min(1).max(10000).default(500),
  // Raw event retention; 0 = keep forever.
  rawTtlDays: z.number().int().min(0).max(3650).default(0),
});

module.exports = {
  key: 'ingestion',
  description: 'Event batch limits and raw-event retention',
  applyMode: 'hot',
  secretPaths: [],
  schema: IngestionConfigSchema,
};
