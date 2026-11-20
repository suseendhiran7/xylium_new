'use strict';

/**
 * Create (or reset) an admin user from the command line. Use it once to create
 * the first superadmin; manage everyone else from the Users page.
 *
 *   npm run create-user -- --email you@example.com --role superadmin
 *
 * The password is read from ADMIN_PASSWORD if set, otherwise a strong random
 * one is generated and printed once.
 */
const crypto = require('crypto');
const { query, closePool } = require('../src/db/pool');
const { migrate } = require('../src/db/migrate');
const { hashPassword, checkPasswordPolicy } = require('../src/auth/passwords');
const { ROLES } = require('../src/middleware/session');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg('email');
  const role = arg('role') || 'superadmin';
  if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('Usage: npm run create-user -- --email you@example.com [--role superadmin|admin|operator|viewer]');
  if (!ROLES.includes(role)) throw new Error(`--role must be one of ${ROLES.join(', ')}`);

  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64url');
  const problem = checkPasswordPolicy(password);
  if (problem) throw new Error(problem);

  await migrate({ log: () => {} });
  const hash = await hashPassword(password);
  const { rows } = await query(
    `INSERT INTO admin_users (email, role, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT ((lower(email))) DO UPDATE SET role = EXCLUDED.role, password_hash = EXCLUDED.password_hash,
       disabled = FALSE, failed_logins = 0, locked_until = NULL
     RETURNING id, (xmax = 0) AS inserted`,
    [email, role, hash]
  );
  await query("INSERT INTO config_audit_log (action, outcome, detail) VALUES ('user.create_cli', 'success', $1)", [JSON.stringify({ email, role, reset: !rows[0].inserted })]);
  console.log(`${rows[0].inserted ? 'Created' : 'Reset'} ${role} ${email}`);
  if (generated) console.log(`Password (shown once): ${password}`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
