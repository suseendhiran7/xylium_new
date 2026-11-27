-- Daily backup schedule of the SDK's event database (one row).
-- The backups themselves are written by an SDK instance (BACKUP_DIR on that host).
CREATE TABLE db_backup_schedule (
  id               INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  time_of_day      TEXT NOT NULL DEFAULT '02:00' CHECK (time_of_day ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  retention_days   INT NOT NULL DEFAULT 14 CHECK (retention_days BETWEEN 0 AND 3650),
  instance_id      TEXT,                              -- preferred SDK instance; NULL = any live one
  last_run_date    DATE,                              -- local date of the last scheduled run (claimed)
  last_run_at      TIMESTAMPTZ,
  last_status      TEXT,                              -- running | succeeded | failed
  last_message     TEXT,
  last_job_id      TEXT,
  last_instance_id TEXT,
  last_backup_name TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by       TEXT
);

INSERT INTO db_backup_schedule (id) VALUES (1);
