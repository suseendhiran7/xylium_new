'use strict';
const crypto = require('crypto');

const { zodToJsonSchema } = require('zod-to-json-schema');
const {
  CONFIG_TYPES, getConfigType, checksum, maskSecrets, splitSecrets, mergeSecrets, keepUnchangedSecrets,
} = require('@xylium/config');
const { query, tx } = require('../../db/pool');
const { encryptJson, decryptJson } = require('../../crypto/secret-box');
const { writeAudit } = require('../audit/audit.service');
const { HttpError, newChangeId, diffConfigs } = require('../../lib/util');

/** Who may change which type. Everything else needs `operator`. */
const WRITE_ROLE = { database: 'admin', tenants: 'admin', 'http-security': 'admin' };
const writeRoleFor = (type) => WRITE_ROLE[type] || 'operator';

/** Defaults for a type with no stored version yet. */
function defaultsFor(type) {
  const t = getConfigType(type);
  const seed = type === 'database' ? { mongodb: {}, postgresql: {} } : {};
  const r = t.schema.safeParse(seed);
  return r.success ? r.data : {};
}

function zodIssues(error) {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/** Decrypted, full data of one stored version row. */
function rowToData(row) {
  const secrets = row.secrets_enc ? decryptJson(row.secrets_enc, row.secrets_key_id) : {};
  return mergeSecrets(row.data, secrets);
}

async function loadVersionRow(type, version, client = null) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q('SELECT * FROM config_versions WHERE config_type = $1 AND version = $2', [type, version]);
  return rows[0] || null;
}

/** Current version of a type: { version, revision, data (full, decrypted), row } or null. */
async function getCurrentFull(type, client = null) {
  const q = client ? client.query.bind(client) : query;
  const { rows } = await q(
    `SELECT v.* FROM config_current c JOIN config_versions v ON v.config_type = c.config_type AND v.version = c.version
      WHERE c.config_type = $1`,
    [type]
  );
  if (!rows[0]) return null;
  return { version: rows[0].version, revision: Number(rows[0].revision), data: rowToData(rows[0]), row: rows[0] };
}

function describeTypes() {
  return Object.values(CONFIG_TYPES).map((t) => ({
    key: t.key,
    description: t.description,
    applyMode: t.applyMode,
    secretPaths: t.secretPaths,
    writeRole: writeRoleFor(t.key),
    jsonSchema: zodToJsonSchema(t.schema, { target: 'jsonSchema7', $refStrategy: 'none' }),
  }));
}

async function listCurrent() {
  const { rows } = await query(
    `SELECT c.config_type, c.version, c.revision, c.updated_at, u.email AS updated_by
       FROM config_current c
       JOIN config_versions v ON v.config_type = c.config_type AND v.version = c.version
       LEFT JOIN admin_users u ON u.id = v.created_by`
  );
  const byType = Object.fromEntries(rows.map((r) => [r.config_type, r]));
  return Object.keys(CONFIG_TYPES).map((key) => {
    const r = byType[key];
    return { configType: key, version: r ? r.version : 0, revision: r ? Number(r.revision) : 0, updatedAt: r ? r.updated_at : null, updatedBy: r ? r.updated_by : null };
  });
}

/** For the UI: current data with secrets shown only as { set: boolean }. */
async function getCurrentMasked(type) {
  const t = getConfigType(type);
  const cur = await getCurrentFull(type);
  if (!cur) return { configType: type, version: 0, revision: 0, data: maskSecrets(defaultsFor(type), t.secretPaths), isDefault: true };
  return {
    configType: type,
    version: cur.version,
    revision: cur.revision,
    data: maskSecrets(cur.data, t.secretPaths),
    checksum: cur.row.checksum,
    updatedAt: cur.row.created_at,
    reason: cur.row.change_reason,
    source: cur.row.source,
  };
}

/**
 * Validate a candidate for `type` against the current stored version:
 * blank / UNCHANGED secrets keep the stored value. Returns the full data.
 */
/**
 * Custom patterns: the server computes each file's sha256 and per-file
 * version (bumped only when the code changes), so the UI only sends
 * filename, description and code.
 */
function normalizeCustomPatterns(input, current) {
  const prev = Object.fromEntries(((current && current.data.patterns) || []).map((p) => [p.filename.toLowerCase(), p]));
  const patterns = Array.isArray(input && input.patterns) ? input.patterns : [];
  return {
    patterns: patterns.map((p) => {
      const code = typeof p.code === 'string' ? p.code.replace(/\r\n/g, '\n') : p.code;
      const sha256 = typeof code === 'string' ? crypto.createHash('sha256').update(code, 'utf8').digest('hex') : undefined;
      const before = prev[String(p.filename || '').toLowerCase()];
      const version = before ? (before.sha256 === sha256 ? before.version : before.version + 1) : 1;
      return { filename: p.filename, description: p.description, code, sha256, version };
    }),
  };
}

async function resolveCandidate(type, input, client = null) {
  const t = getConfigType(type);
  const cur = await getCurrentFull(type, client);
  if (type === 'custom-patterns') input = normalizeCustomPatterns(input, cur);
  const merged = keepUnchangedSecrets(input || {}, cur ? cur.data : {}, t.secretPaths);
  const parsed = t.schema.safeParse(merged);
  if (!parsed.success) throw new HttpError(400, 'validation_failed', `Invalid ${type} configuration`, { issues: zodIssues(parsed.error) });
  return { data: parsed.data, current: cur };
}

/**
 * Save a new version. One transaction: version row (secrets encrypted),
 * current pointer (optimistic lock on expectedVersion), audit row, outbox row.
 * The outbox worker notifies SDK instances after commit.
 */
async function updateConfig(type, input, { actor, req, expectedVersion, reason, source = 'admin', basedOnVersion = null }) {
  const t = getConfigType(type);
  if (typeof reason !== 'string' || reason.trim().length < 3) {
    throw new HttpError(400, 'reason_required', 'Describe the reason for this change (3+ characters)');
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw new HttpError(400, 'expected_version_required', 'expectedVersion (the version you edited) is required');
  }

  return tx(async (client) => {
    const lock = await client.query('SELECT version FROM config_current WHERE config_type = $1 FOR UPDATE', [type]);
    const currentVersion = lock.rows[0] ? lock.rows[0].version : 0;
    if (currentVersion !== expectedVersion) {
      throw new HttpError(409, 'version_conflict', `Someone saved version ${currentVersion} after you loaded version ${expectedVersion}. Reload and re-apply your change.`, { currentVersion });
    }

    const { data, current } = await resolveCandidate(type, input, client);
    const sum = checksum(data);
    if (current && current.row.checksum === sum) {
      throw new HttpError(400, 'no_change', 'Nothing changed compared to the current version');
    }

    const version = currentVersion + 1;
    const { rows: [{ revision }] } = await client.query("SELECT nextval('config_revision_seq') AS revision");
    const { publicData, secrets } = splitSecrets(data, t.secretPaths);
    const enc = Object.keys(secrets).length ? encryptJson(secrets) : null;

    await client.query(
      `INSERT INTO config_versions (config_type, version, revision, data, secrets_enc, secrets_key_id, checksum, source, based_on_version, change_reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [type, version, revision, JSON.stringify(publicData), enc ? enc.blob : null, enc ? enc.keyId : null, sum, source, basedOnVersion, reason.trim(), actor ? actor.id : null]
    );
    await client.query(
      `INSERT INTO config_current (config_type, version, revision, updated_at) VALUES ($1,$2,$3,NOW())
       ON CONFLICT (config_type) DO UPDATE SET version = EXCLUDED.version, revision = EXCLUDED.revision, updated_at = NOW()`,
      [type, version, revision]
    );

    const diff = diffConfigs(current ? current.data : null, data, t.secretPaths);
    await writeAudit(
      { actor, req, action: source === 'rollback' ? 'config.rollback' : source === 'env-import' ? 'config.import' : 'config.update', configType: type, fromVersion: currentVersion || null, toVersion: version, diff, detail: { reason: reason.trim(), basedOnVersion } },
      client
    );

    const changeId = newChangeId();
    const notice = {
      changeId,
      configType: type,
      action: source === 'rollback' ? 'rolled_back' : 'updated',
      version,
      revision: Number(revision),
      applyMode: t.applyMode,
      changedAt: new Date().toISOString(),
      changedBy: actor ? actor.id : null,
    };
    await client.query(
      'INSERT INTO notification_outbox (change_id, config_type, version, revision, payload) VALUES ($1,$2,$3,$4,$5)',
      [changeId, type, version, revision, JSON.stringify(notice)]
    );

    return { configType: type, version, revision: Number(revision), changeId, applyMode: t.applyMode, diff };
  });
}

async function rollback(type, toVersion, { actor, req, reason }) {
  getConfigType(type);
  const row = await loadVersionRow(type, toVersion);
  if (!row) throw new HttpError(404, 'not_found', `${type} version ${toVersion} does not exist`);
  const cur = await getCurrentFull(type);
  return updateConfig(type, rowToData(row), {
    actor, req, expectedVersion: cur ? cur.version : 0, reason: reason || `Rollback to version ${toVersion}`, source: 'rollback', basedOnVersion: toVersion,
  });
}

async function listVersions(type, { limit = 50 } = {}) {
  getConfigType(type);
  const { rows } = await query(
    `SELECT v.version, v.revision, v.checksum, v.source, v.based_on_version, v.change_reason, v.created_at, u.email AS created_by
       FROM config_versions v LEFT JOIN admin_users u ON u.id = v.created_by
      WHERE v.config_type = $1 ORDER BY v.version DESC LIMIT $2`,
    [type, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500)]
  );
  return rows.map((r) => ({ ...r, revision: Number(r.revision) }));
}

async function getVersionMasked(type, version) {
  const t = getConfigType(type);
  const row = await loadVersionRow(type, version);
  if (!row) throw new HttpError(404, 'not_found', `${type} version ${version} does not exist`);
  return { configType: type, version: row.version, data: maskSecrets(rowToData(row), t.secretPaths), checksum: row.checksum, reason: row.change_reason, source: row.source, createdAt: row.created_at };
}

async function diffVersions(type, from, to) {
  const t = getConfigType(type);
  const [a, b] = await Promise.all([from > 0 ? loadVersionRow(type, from) : null, loadVersionRow(type, to)]);
  if (!b || (from > 0 && !a)) throw new HttpError(404, 'not_found', 'Version not found');
  return diffConfigs(a ? rowToData(a) : null, rowToData(b), t.secretPaths);
}

/** For SDK instances: full (decrypted) data of the current versions. */
async function snapshot(types) {
  const wanted = types && types.length ? types : Object.keys(CONFIG_TYPES);
  for (const k of wanted) getConfigType(k);
  const configs = {};
  for (const k of wanted) {
    const cur = await getCurrentFull(k);
    if (cur) configs[k] = { version: cur.version, checksum: cur.row.checksum, data: cur.data };
  }
  const { rows } = await query("SELECT COALESCE(MAX(revision), 0) AS revision FROM config_current");
  return { revision: Number(rows[0].revision), configs };
}

async function latestVersions() {
  const { rows } = await query('SELECT config_type, version, revision FROM config_current');
  return {
    revision: rows.reduce((m, r) => Math.max(m, Number(r.revision)), 0),
    latestVersions: Object.fromEntries(rows.map((r) => [r.config_type, r.version])),
  };
}

module.exports = {
  describeTypes, listCurrent, getCurrentMasked, getCurrentFull, resolveCandidate, updateConfig, rollback,
  listVersions, getVersionMasked, diffVersions, snapshot, latestVersions, writeRoleFor, defaultsFor,
};
