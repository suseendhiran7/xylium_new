'use strict';

const crypto = require('crypto');

/**
 * Every admin-managed configuration type, in one place.
 *
 *   applyMode  hot        swapped in memory; the next request sees it
 *              reconnect  a new connection is built, health-checked, swapped
 *              restart    stored and acknowledged; applied at next restart
 *
 * Adding a type = a file in ./types + an entry here + an applier in the SDK.
 */
const TYPES = [
  require('./types/database'),
  require('./types/ingestion'),
  require('./types/tenants'),
  require('./types/ip-intel'),
  require('./types/http-security'),
  require('./types/custom-patterns'),
];

const APPLY_MODES = Object.freeze(['hot', 'reconnect', 'restart']);

const CONFIG_TYPES = Object.freeze(
  Object.fromEntries(
    TYPES.map((t) => {
      if (!APPLY_MODES.includes(t.applyMode)) throw new Error(`config type ${t.key}: bad applyMode ${t.applyMode}`);
      return [t.key, Object.freeze({ key: t.key, description: t.description, applyMode: t.applyMode, secretPaths: t.secretPaths, schema: t.schema })];
    })
  )
);

class UnknownConfigTypeError extends Error {
  constructor(key) {
    super(`Unknown config type '${key}'. Known types: ${Object.keys(CONFIG_TYPES).join(', ')}`);
    this.status = 400;
    this.code = 'unknown_config_type';
  }
}

function getConfigType(key) {
  const t = CONFIG_TYPES[key];
  if (!t) throw new UnknownConfigTypeError(key);
  return t;
}

/**
 * Validate (and fill defaults for) one type's data.
 * @returns {{ success: true, data: object } | { success: false, error: import('zod').ZodError }}
 */
function parseConfig(key, data) {
  return getConfigType(key).schema.safeParse(data);
}

/** JSON with object keys sorted at every level, so equal configs hash equally. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function checksum(data) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(data), 'utf8').digest('hex')}`;
}

module.exports = { CONFIG_TYPES, APPLY_MODES, getConfigType, parseConfig, canonicalJson, checksum, UnknownConfigTypeError };
