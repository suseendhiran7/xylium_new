'use strict';

const { z } = require('zod');

/**
 * Database configuration: which event store is active and how to reach each.
 * Moved unchanged from node_app/src/config/database.config.js, which now
 * re-exports it. Defaults must stay identical — the SDK parses env through it.
 */
const DatabaseConfigSchema = z.object({
  activeDatabase: z.enum(['mongodb', 'postgresql']).default('mongodb'),

  mongodb: z.object({
    uri: z.string().default('mongodb://localhost:27017/xylium'),
    database: z.string().default('xylium'),
    maxPoolSize: z.number().int().positive().default(20),
    minPoolSize: z.number().int().nonnegative().default(2),
    serverSelectionTimeoutMS: z.number().int().positive().default(5000),
    socketTimeoutMS: z.number().int().positive().default(30000),
  }),

  postgresql: z.object({
    host: z.string().default('localhost'),
    port: z.number().int().positive().default(5432),
    database: z.string().default('behavioral_events'),
    user: z.string().default('postgres'),
    password: z.string().default(''),
    ssl: z.boolean().default(false),
    maxPoolSize: z.number().int().positive().default(20),
    idleTimeoutMillis: z.number().int().positive().default(30000),
    connectionTimeoutMillis: z.number().int().positive().default(5000),
  }),
});

/**
 * Mask sensitive credentials for API responses and logs.
 * (Same output as the SDK's previous sanitizeConfig.)
 */
function sanitizeDatabaseConfig(config) {
  const masked = JSON.parse(JSON.stringify(config));
  if (masked.postgresql) {
    masked.postgresql.password = masked.postgresql.password ? '******' : '';
  }
  if (masked.mongodb && masked.mongodb.uri) {
    masked.mongodb.uri = masked.mongodb.uri.replace(/(mongodb(?:\+srv)?:\/\/[^:]+:)[^@]+(@)/, '$1******$2');
  }
  return masked;
}

/** Connection fields per engine: a change to any of these needs a new connection. */
const CONNECTION_FIELDS = {
  postgresql: ['host', 'port', 'database', 'user', 'password', 'ssl', 'maxPoolSize', 'idleTimeoutMillis', 'connectionTimeoutMillis'],
  mongodb: ['uri', 'database', 'maxPoolSize', 'minPoolSize', 'serverSelectionTimeoutMS', 'socketTimeoutMS'],
};

module.exports = {
  key: 'database',
  description: 'Active event database and the connection settings for PostgreSQL and MongoDB',
  applyMode: 'reconnect',
  // mongodb.uri usually embeds credentials, so the whole URI is treated as secret.
  secretPaths: ['postgresql.password', 'mongodb.uri'],
  schema: DatabaseConfigSchema,
  DatabaseConfigSchema,
  sanitizeDatabaseConfig,
  CONNECTION_FIELDS,
};
