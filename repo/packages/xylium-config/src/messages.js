'use strict';

const { z } = require('zod');
const { CONFIG_TYPES } = require('./registry');

/**
 * Wire contracts between the Admin Application and SDK instances.
 * Notifications never carry configuration data or secrets — only
 * "type T is now at version V". The SDK then pulls the snapshot.
 */

const ConfigTypeKey = z.enum(Object.keys(CONFIG_TYPES));
const InstanceId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const ChangeId = z.string().regex(/^chg_[A-Za-z0-9]{8,64}$/);

/** POST {sdk}/internal/config/changed */
const ConfigChangedNotice = z.object({
  changeId: ChangeId,
  configType: ConfigTypeKey,
  action: z.enum(['updated', 'rolled_back', 'deleted']),
  version: z.number().int().min(1),
  revision: z.number().int().min(1),
  applyMode: z.enum(['hot', 'reconnect', 'restart']),
  changedAt: z.string().datetime(),
  changedBy: z.string().max(128).nullable().optional(),
});

/** GET {admin}/internal/config/snapshot?types=a,b → 200 body */
const SnapshotResponse = z.object({
  revision: z.number().int().min(0),
  configs: z.record(
    ConfigTypeKey,
    z.object({
      version: z.number().int().min(1),
      checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      data: z.unknown(),
    })
  ),
});

/** POST {admin}/internal/config/ack */
const ConfigAck = z.object({
  instanceId: InstanceId,
  changeId: ChangeId.nullable(),
  configType: ConfigTypeKey,
  version: z.number().int().min(1),
  status: z.enum(['applied', 'failed', 'restart_required', 'skipped_stale']),
  durationMs: z.number().int().min(0),
  error: z.string().max(2000).nullable(),
  details: z.record(z.unknown()).optional(),
});

/** POST {admin}/internal/sdk-instances/heartbeat */
const Heartbeat = z.object({
  instanceId: InstanceId,
  baseUrl: z.string().url(),
  hostname: z.string().max(255).optional(),
  appVersion: z.string().max(64).optional(),
  activeDatabase: z.enum(['postgresql', 'mongodb']).nullable(),
  appliedVersions: z.record(ConfigTypeKey, z.number().int().min(0)),
  pendingRestart: z.array(ConfigTypeKey).default([]),
  uptimeSec: z.number().int().min(0),
});

/** Heartbeat response: latest versions, so the SDK can detect a missed notice. */
const HeartbeatResponse = z.object({
  revision: z.number().int().min(0),
  latestVersions: z.record(ConfigTypeKey, z.number().int().min(1)),
});

/** POST {sdk}/internal/config/validate — dry run, nothing applied. */
const ValidateRequest = z.object({
  configType: ConfigTypeKey,
  data: z.unknown(),
});

module.exports = { ConfigChangedNotice, SnapshotResponse, ConfigAck, Heartbeat, HeartbeatResponse, ValidateRequest };
