'use strict';

/**
 * Helpers for the secret fields a config type declares in `secretPaths`
 * (dot paths such as 'postgresql.password'). Secrets are never returned to a
 * browser, never written to an audit diff, and stored encrypted.
 */

/** Sent by the UI for a secret it did not change ("keep the stored value"). */
const UNCHANGED = '__UNCHANGED__';

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}

function deletePath(obj, path) {
  const keys = path.split('.');
  const parent = keys.slice(0, -1).reduce((o, k) => (o == null ? undefined : o[k]), obj);
  if (parent && typeof parent === 'object') delete parent[keys[keys.length - 1]];
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function isSet(v) {
  if (v == null || v === '') return false;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/**
 * Replace each secret with a marker. Default marker is `{ set: boolean }`,
 * which is what the admin UI shows; pass a function for log-style masks.
 */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Replace each secret with a marker. Default marker is `{ set: boolean }`,
 * which is what the admin UI shows; pass a function for log-style masks.
 * A secret that is a map (e.g. tenantApiKeys) is masked per entry, so its
 * keys (tenant ids) stay visible and entries can be edited one at a time.
 */
function maskSecrets(data, secretPaths, marker = (v) => ({ set: isSet(v) })) {
  const out = clone(data);
  for (const p of secretPaths) {
    const v = getPath(out, p);
    if (v === undefined) continue;
    if (isPlainObject(v)) setPath(out, p, Object.fromEntries(Object.entries(v).map(([k, x]) => [k, marker(x)])));
    else setPath(out, p, marker(v));
  }
  return out;
}

/** Split into non-secret data (for a JSONB column) and the secrets (to encrypt). */
function splitSecrets(data, secretPaths) {
  const publicData = clone(data);
  const secrets = {};
  for (const p of secretPaths) {
    const v = getPath(publicData, p);
    if (v !== undefined) {
      secrets[p] = v;
      deletePath(publicData, p);
    }
  }
  return { publicData, secrets };
}

/** Inverse of splitSecrets. */
function mergeSecrets(publicData, secrets) {
  const out = clone(publicData) || {};
  for (const [p, v] of Object.entries(secrets || {})) setPath(out, p, v);
  return out;
}

/**
 * Admin edits: a secret left blank or sent as UNCHANGED keeps the previous
 * value, so the UI never needs to hold the real secret.
 */
function keepUnchangedSecrets(input, previous, secretPaths) {
  const out = clone(input);
  for (const p of secretPaths) {
    const v = getPath(out, p);
    const prev = getPath(previous || {}, p);
    if (v === undefined || v === '' || v === UNCHANGED) {
      if (prev !== undefined) setPath(out, p, clone(prev));
      else deletePath(out, p);
    } else if (isPlainObject(v)) {
      // Map secret: per-entry UNCHANGED/blank keeps that entry; absent entries are removed.
      const merged = {};
      for (const [k, x] of Object.entries(v)) {
        if (x === undefined || x === '' || x === UNCHANGED) {
          if (isPlainObject(prev) && prev[k] !== undefined) merged[k] = prev[k];
        } else merged[k] = x;
      }
      setPath(out, p, merged);
    }
  }
  return out;
}

module.exports = { UNCHANGED, getPath, setPath, maskSecrets, splitSecrets, mergeSecrets, keepUnchangedSecrets };
