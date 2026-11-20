'use strict';

/**
 * @xylium/config — contracts shared by the SDK application (node_app) and the
 * Admin Application. Schemas, secret handling, signing and the pattern
 * validator only: no runtime state, no I/O, no database access.
 */

const registry = require('./registry');
const secrets = require('./secrets');
const signing = require('./signing');
const messages = require('./messages');
const { analyze, MODULE_WRAPPER_RE } = require('./pattern-validator');
const { safeRegexSource } = require('./regex-safety');
const database = require('./types/database');
const { configsFromEnv } = require('./from-env');

module.exports = {
  ...registry,
  ...secrets,
  ...signing,
  messages,
  configsFromEnv,
  analyze,
  MODULE_WRAPPER_RE,
  safeRegexSource,
  DatabaseConfigSchema: database.DatabaseConfigSchema,
  sanitizeDatabaseConfig: database.sanitizeDatabaseConfig,
  DATABASE_CONNECTION_FIELDS: database.CONNECTION_FIELDS,
};
