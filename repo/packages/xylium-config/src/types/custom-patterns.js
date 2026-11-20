'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const { analyze } = require('../pattern-validator');

const PatternSchema = z
  .object({
    filename: z.string().regex(/^[\w.-]+\.js$/i, 'plain "name.js": letters, digits, _ . - only'),
    description: z.string().min(1).max(1000),
    version: z.number().int().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    code: z.string().min(1).max(256 * 1024),
  })
  .superRefine((p, ctx) => {
    const digest = crypto.createHash('sha256').update(p.code, 'utf8').digest('hex');
    if (digest !== p.sha256) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sha256'], message: 'sha256 does not match code' });
    }
    // Defence in depth: the SDK re-runs the same static checks before writing.
    const violations = analyze(p.code);
    if (violations.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['code'], message: `pattern fails validation: ${violations.map((v) => v.rule).join(', ')}` });
    }
  });

/** The full set of published custom pattern files the SDK should serve. */
const CustomPatternsConfigSchema = z
  .object({ patterns: z.array(PatternSchema).max(100).default([]) })
  .superRefine((v, ctx) => {
    const seen = new Set();
    for (const p of v.patterns) {
      if (seen.has(p.filename.toLowerCase())) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['patterns'], message: `duplicate filename ${p.filename}` });
      }
      seen.add(p.filename.toLowerCase());
    }
  });

module.exports = {
  key: 'custom-patterns',
  description: 'Approved custom SDK pattern files published into the SDK folder',
  applyMode: 'hot',
  secretPaths: [],
  schema: CustomPatternsConfigSchema,
};
