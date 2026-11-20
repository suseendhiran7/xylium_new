'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

// scrypt from Node's standard library: no native add-on to build on Windows.
const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const KEYLEN = 32;

const MIN_LENGTH = 12;

function checkPasswordPolicy(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_LENGTH) return `Password must be at least ${MIN_LENGTH} characters`;
  if (pw.length > 256) return 'Password is too long';
  if (/^(.)\1+$/.test(pw)) return 'Password is too simple';
  return null;
}

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, KEYLEN, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(String(pw), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: PARAMS.maxmem,
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Spent when the email is unknown, so response time doesn't reveal which accounts exist.
let dummyHash = null;
async function burnTime(pw) {
  if (!dummyHash) dummyHash = await hashPassword('not-a-real-password-xx');
  await verifyPassword(pw, dummyHash);
}

module.exports = { hashPassword, verifyPassword, checkPasswordPolicy, burnTime, MIN_LENGTH };
