-- Xylium Admin Application — control-plane schema.
-- Lives in its OWN database (e.g. xylium_admin), never in the SDK's
-- switchable event store.

CREATE TABLE admin_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL,
  password_hash   TEXT NOT NULL,                  -- scrypt$N$r$p$salt$hash
  role            TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'admin', 'superadmin')),
  failed_logins   INT NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  disabled        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX admin_users_email_uq ON admin_users (lower(email));

CREATE TABLE admin_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,            -- sha256 of the cookie value
  csrf_token      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,            -- absolute limit
  revoked_at      TIMESTAMPTZ,
  ip              TEXT,
  user_agent      TEXT
);
CREATE INDEX admin_sessions_user_idx ON admin_sessions (user_id);

CREATE SEQUENCE config_revision_seq;

-- Append-only history of every configuration version.
CREATE TABLE config_versions (
  id                BIGSERIAL PRIMARY KEY,
  config_type       TEXT NOT NULL,
  version           INT NOT NULL,
  revision          BIGINT NOT NULL,
  data              JSONB NOT NULL,                -- non-secret fields only
  secrets_enc       BYTEA,                         -- AES-256-GCM of the secret fields
  secrets_key_id    TEXT,
  checksum          TEXT NOT NULL,                 -- sha256 of the canonical full config
  source            TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'env-import', 'rollback')),
  based_on_version  INT,
  change_reason     TEXT NOT NULL,
  created_by        UUID REFERENCES admin_users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (config_type, version)
);

CREATE TABLE config_current (
  config_type   TEXT PRIMARY KEY,
  version       INT NOT NULL,
  revision      BIGINT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Append-only audit trail. In production grant the app role INSERT, SELECT only.
CREATE TABLE config_audit_log (
  id            BIGSERIAL PRIMARY KEY,
  at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_id      UUID,
  actor_email   TEXT,
  actor_ip      TEXT,
  request_id    TEXT,
  action        TEXT NOT NULL,
  config_type   TEXT,
  from_version  INT,
  to_version    INT,
  diff          JSONB,                             -- secrets masked
  outcome       TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  detail        JSONB
);
CREATE INDEX config_audit_log_at_idx ON config_audit_log (at DESC);
CREATE INDEX config_audit_log_type_idx ON config_audit_log (config_type, at DESC);

-- Transactional outbox: written in the same transaction as the version.
CREATE TABLE notification_outbox (
  id              BIGSERIAL PRIMARY KEY,
  change_id       TEXT NOT NULL UNIQUE,
  config_type     TEXT NOT NULL,
  version         INT NOT NULL,
  revision        BIGINT NOT NULL,
  payload         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts        INT NOT NULL DEFAULT 0,
  processed_at    TIMESTAMPTZ
);
CREATE INDEX notification_outbox_pending_idx ON notification_outbox (next_attempt_at) WHERE processed_at IS NULL;

-- SDK instances, registered by their heartbeats.
CREATE TABLE sdk_instances (
  instance_id        TEXT PRIMARY KEY,
  base_url           TEXT NOT NULL,
  hostname           TEXT,
  app_version        TEXT,
  active_database    TEXT,
  applied_versions   JSONB NOT NULL DEFAULT '{}'::jsonb,
  pending_restart    JSONB NOT NULL DEFAULT '[]'::jsonb,
  uptime_sec         INT,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-instance delivery and outcome of each version.
CREATE TABLE config_rollouts (
  id               BIGSERIAL PRIMARY KEY,
  config_type      TEXT NOT NULL,
  version          INT NOT NULL,
  instance_id      TEXT NOT NULL REFERENCES sdk_instances(instance_id) ON DELETE CASCADE,
  change_id        TEXT,
  notify_status    TEXT NOT NULL DEFAULT 'pending' CHECK (notify_status IN ('pending', 'delivered', 'unreachable', 'not_notified')),
  notify_attempts  INT NOT NULL DEFAULT 0,
  last_error       TEXT,
  ack_status       TEXT CHECK (ack_status IN ('applied', 'failed', 'restart_required', 'skipped_stale')),
  ack_error        TEXT,
  ack_detail       JSONB,
  acked_at         TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (config_type, version, instance_id)
);
