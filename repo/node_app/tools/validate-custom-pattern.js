#!/usr/bin/env node
/* ============================================================================
 * validate-custom-pattern.js
 * ----------------------------------------------------------------------------
 * Gatekeeper for user-submitted "custom pattern" modules.
 *
 * The Xylium SDK's whole design principle is: capture *behavioral metadata*
 * (timing, coordinates, key codes, field IDs) — never the actual content the
 * user typed, pasted, or has stored. This tool statically analyses a
 * submitted module's source code for the JS patterns that would break that
 * rule, and only allows the module through if none are found.
 *
 * Usage:
 *   node validate-custom-pattern.js <submission.js> \
 *     --name "rage_click"  \
 *     --description "Flags 3+ rapid clicks on the same element."
 *
 * Exit code 0 + writes ../xylium-custom.js  -> pattern ACCEPTED
 * Exit code 1, writes nothing               -> pattern REJECTED (violations printed)
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
// Rules live in the shared package so the SDK, this CLI and the Admin
// Application all apply the same checks.
const { analyze, MODULE_WRAPPER_RE } = require('@xylium/config/src/pattern-validator');

// ---------------------------------------------------------------------------
// 3. CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') out.name = argv[++i];
    else if (a === '--description') out.description = argv[++i];
    else if (a === '--author') out.author = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else out._.push(a);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args._[0];
  if (!file) {
    console.error('Usage: node validate-custom-pattern.js <submission.js> --name "<id>" --description "<text>" [--author "<name>"] [--out <path>]');
    process.exit(2);
  }
  if (!args.name) {
    console.error('Missing required --name "<pattern_id>"');
    process.exit(2);
  }
  if (!args.description) {
    console.error('Missing required --description "<what this pattern captures and why>"');
    process.exit(2);
  }

  const source = fs.readFileSync(file, 'utf8');
  const violations = analyze(source);

  console.log(`\nXylium custom-pattern review: "${args.name}"`);
  console.log('='.repeat(60));

  if (violations.length > 0) {
    console.log(`REJECTED — ${violations.length} violation(s) found:\n`);
    violations.forEach((v, i) => {
      console.log(`  ${i + 1}. [${v.rule}] line ${v.line}: ${v.message}`);
    });
    console.log('\nThis pattern appears to capture actual user data (not just behavior),');
    console.log('so it was NOT added to the SDK. Remove the flagged code and resubmit.');
    process.exit(1);
  }

  console.log('ACCEPTED — no user-data capture detected. Behavior-only signals confirmed.\n');

  const outPath = args.out || path.join(__dirname, '..', 'xylium-custom.js');
  const header =
    `/* ============================================================================\n` +
    ` * xylium-custom.js — Custom pattern: ${args.name}\n` +
    ` * ----------------------------------------------------------------------------\n` +
    ` * Description: ${args.description}\n` +
    (args.author ? ` * Submitted by: ${args.author}\n` : '') +
    ` * Reviewed: ${new Date().toISOString()} — no user-data capture detected\n` +
    ` *           by validate-custom-pattern.js (static AST checks: field .value\n` +
    ` *           reads, document.cookie, innerText/innerHTML, InputEvent.data,\n` +
    ` *           non-namespaced storage access, clipboard content reads, PII-shaped\n` +
    ` *           regexes, and any transport call that bypasses core.pushEvent).\n` +
    ` *\n` +
    ` * Load order does not matter: this file self-registers with the core, same\n` +
    ` * as every other pattern file.\n` +
    ` * ==========================================================================*/\n`;

  fs.writeFileSync(outPath, header + source);
  console.log(`Written to: ${outPath}`);
  console.log('Add <script src="xylium-custom.js"></script> after xylium-core.js to enable it.');
  process.exit(0);
}

// Only run the CLI when this file is executed directly (`node validate-custom-pattern.js ...`).
// When required from other code (e.g. an Express route), `analyze()` and
// `MODULE_WRAPPER_RE` are exported below so the same checks can run over HTTP.
if (require.main === module) {
  main();
}

module.exports = { analyze, MODULE_WRAPPER_RE };
