'use strict';

/**
 * Migration step 1: import the SDK's current .env as version 1 of each
 * config type (source = 'env-import'), plus existing custom pattern files.
 *
 *   npm run import-from-env -- --env ../node_app/.env [--sdk-dir ../node_app/sdk] [--force] [--dry-run]
 *
 * Types that already have a version are skipped unless --force (which adds a
 * new version on top). Secrets are encrypted before they are stored.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dotenv = require('dotenv');
const { configsFromEnv, parseConfig, analyze } = require('@xylium/config');
const { migrate } = require('../src/db/migrate');
const { closePool } = require('../src/db/pool');
const configs = require('../src/modules/configs/configs.service');

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const flag = (name) => process.argv.includes(`--${name}`);

function customPatternsFrom(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /^xylium-(data-)?custom[\w.-]*\.js$/i.test(f)).sort();
  const patterns = [];
  for (const f of files) {
    const code = fs.readFileSync(path.join(dir, f), 'utf8');
    const violations = analyze(code);
    if (violations.length) {
      console.warn(`  ! ${f} fails validation (${violations.map((v) => v.rule).join(', ')}) — not imported`);
      continue;
    }
    patterns.push({ filename: f, description: `Imported from ${f}`, version: 1, sha256: crypto.createHash('sha256').update(code, 'utf8').digest('hex'), code });
  }
  return { patterns };
}

async function main() {
  const envFile = arg('env');
  if (!envFile || !fs.existsSync(envFile)) throw new Error('Usage: npm run import-from-env -- --env <path to node_app/.env> [--sdk-dir <path to node_app/sdk>] [--force] [--dry-run]');
  const env = dotenv.parse(fs.readFileSync(envFile));
  const candidates = configsFromEnv(env);
  const patterns = customPatternsFrom(arg('sdk-dir'));
  if (patterns) candidates['custom-patterns'] = patterns;

  const dry = flag('dry-run');
  if (!dry) await migrate({ log: () => {} });

  let failed = 0;
  for (const [type, data] of Object.entries(candidates)) {
    const parsed = parseConfig(type, data);
    if (!parsed.success) {
      failed++;
      console.error(`✗ ${type}: invalid — ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      continue;
    }
    if (dry) {
      console.log(`✓ ${type}: valid (dry run, not saved)`);
      continue;
    }
    const cur = await configs.getCurrentFull(type);
    if (cur && !flag('force')) {
      console.log(`- ${type}: already at version ${cur.version}, skipped (use --force to add a new version)`);
      continue;
    }
    try {
      const r = await configs.updateConfig(type, parsed.data, {
        actor: null, req: null, expectedVersion: cur ? cur.version : 0, reason: `Imported from ${path.basename(envFile)}`, source: 'env-import',
      });
      console.log(`✓ ${type}: saved as version ${r.version}`);
    } catch (err) {
      if (err.code === 'no_change') console.log(`- ${type}: identical to version ${cur.version}, skipped`);
      else {
        failed++;
        console.error(`✗ ${type}: ${err.message}`);
      }
    }
  }
  if (failed) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
