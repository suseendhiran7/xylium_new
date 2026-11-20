#!/usr/bin/env node
'use strict';

/**
 * Mint a short-lived platform-admin JWT for the SDK's admin routes
 * (/api/admin/database/*, /cp) until the separate Admin Application
 * replaces them. Needs the same JWT_SECRET as the running server, so only
 * someone with access to the server's environment can run it.
 *
 *   npm run admin:token -- --user alice@example.com --minutes 30
 *
 * Prints the token only. Paste it into admin-database.html ("Admin token")
 * or send it as `Authorization: Bearer <token>`.
 */

const { generateToken } = require('../src/utils/token');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const user = arg('user', null);
const minutes = parseInt(arg('minutes', '30'), 10);

if (!user) {
  console.error('Usage: npm run admin:token -- --user <who> [--minutes 30]');
  process.exit(1);
}
if (!Number.isFinite(minutes) || minutes < 1 || minutes > 480) {
  console.error('--minutes must be between 1 and 480');
  process.exit(1);
}

// `username` is what the switch history records as the actor.
process.stdout.write(generateToken({ userId: user, username: user, role: 'admin' }, minutes * 60) + '\n');
