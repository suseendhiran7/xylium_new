'use strict';

const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function randomBase62(n) {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += B62[bytes[i] % 62];
  return s;
}

const newChangeId = () => `chg_${randomBase62(20)}`;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Flatten nested objects to dot paths; arrays and scalars are leaves. */
function flatten(obj, prefix = '', out = {}) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const keys = Object.keys(obj);
    if (keys.length === 0 && prefix) out[prefix] = {};
    for (const k of keys) flatten(obj[k], prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out[prefix] = obj;
  }
  return out;
}

/**
 * Field-level diff between two configs. Values under a secret path are
 * replaced by "(changed)" / "(unchanged)" — the audit log never holds secrets.
 */
function diffConfigs(before, after, secretPaths = []) {
  const a = flatten(before || {});
  const b = flatten(after || {});
  const isSecret = (p) => secretPaths.some((s) => p === s || p.startsWith(`${s}.`));
  const changes = [];
  const seenSecret = new Set();
  for (const path of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const same = JSON.stringify(a[path]) === JSON.stringify(b[path]);
    if (isSecret(path)) {
      const root = secretPaths.find((s) => path === s || path.startsWith(`${s}.`));
      if (!same && !seenSecret.has(root)) {
        seenSecret.add(root);
        changes.push({ path: root, from: '(secret)', to: '(changed)' });
      }
      continue;
    }
    if (!same) changes.push({ path, from: a[path] === undefined ? null : a[path], to: b[path] === undefined ? null : b[path] });
  }
  return changes;
}

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { HttpError, newChangeId, sha256, randomBase62, diffConfigs, flatten, asyncRoute };
