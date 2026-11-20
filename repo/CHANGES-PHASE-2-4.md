# Phases 2–4 — the Admin Application

This builds on Phases 0–1 (`CHANGES-PHASE-0-1.md`). Setup steps are in **`admin_app/README.md`**.

## What's new

```
repo/
├─ admin_app/                 NEW  the Admin Application (one deployable)
│  ├─ server/                      Express API, PostgreSQL control plane, notifier
│  └─ web/                         React UI (built into web/dist, served by the server)
├─ node_app/src/runtime-config/ NEW  SDK side: notice → pull → check → apply → ack
└─ packages/xylium-config/         + env→config mapping, per-entry secret maps
```

### Admin backend (`admin_app/server`)

- Its own PostgreSQL database (`xylium_admin`), with migrations applied on start: users, sessions, append-only config versions, current pointers, audit log, outbox, SDK instances, rollouts.
- Local sign-in: scrypt password hashes, lockout after 5 failures, httpOnly SameSite=Strict session cookie (30 min idle / 8 h maximum), CSRF token on every write, 4 roles.
- Versioned config service. One transaction writes the version, the encrypted secrets (AES-256-GCM, key from env), the current pointer (optimistic lock on `expectedVersion`), the audit row with a masked diff, and the outbox notice.
- Database saves are **tested on every live SDK instance before saving** (prepare/commit). Any failure → 422, nothing saved.
- Outbox worker sends signed notices to live instances, with retries and backoff.
- Internal API on a separate port (8091), HMAC-signed with replay protection: snapshot, ack, heartbeat. SDK base URLs are restricted to `SDK_ALLOWED_HOSTS`.
- Scripts: `gen-keys`, `create-user`, `import-from-env`, `migrate`.

### SDK side (`node_app`)

- `CONFIG_SOURCE`:
  - `env` is the default: **nothing changes**. No routes, no timers, no admin calls.
  - `shadow` compares the admin settings with `.env` and logs the differences.
  - `admin` applies the admin settings.
- At startup the SDK uses the admin snapshot, then the encrypted last-known-good file, then `.env`, in that order.
- Live changes:
  - Ingestion, tenants and IP intel: the config singleton is updated, so the next request sees the change.
  - Custom patterns: files are written atomically and checked against their SHA-256.
  - Database: switch, or live reconnect with the old connection drained.
  - HTTP security: reported as `restart_required`.
- A heartbeat every 30 s re-pulls any version the instance missed.
- Other changes:
  - `server.js` reads the active database through the config layer.
  - The retention timer is always scheduled, so `rawTtlDays` can change at runtime.
  - `ipIntelService.clearCache()` added.

### React UI (`admin_app/web`)

The pages are:
- Overview
- Database wizard: test on instances, then type the target name to confirm, then a live rollout panel
- All configuration, with forms generated from the shared schemas
- Tenant API keys editable one key at a time
- Custom patterns: upload, validate, publish
- History, with diffs and rollback
- SDK instances: live/stale, drift, restart pending
- Audit log, with filters and CSV export
- Users

## Verified here

| Check | Result |
| --- | --- |
| `node_app` Jest | 206 / 206 (adds 20 sync-engine tests) |
| `packages/xylium-config` | 20 / 20 |
| `admin_app` backend tests (real PostgreSQL 16) | 25 / 25 |
| End to end, admin app + SDK on real PostgreSQL with password auth | see below |

End-to-end runs, all with real processes:

- SDK booted from the admin's settings (batch limit 250 over `.env`'s 500; only allowed tenants accepted).
- A live batch-limit change was applied in about 0.5 s with no restart.
- Wrong database password: 422, nothing saved, and the SDK kept running.
- Live move to a second PostgreSQL database. Events before the move are in database A, events after it in database B. The old pool was drained.
- With the admin app stopped, the SDK restarted from its encrypted last-known-good copy (database B, limit 100). The password does not appear in the file.
- HTTP-security change: `restart_required`. Custom pattern: written and served; an unsafe pattern was refused.
- UI clicked through in headless Chrome:
  - Added tenant `t2` with a new key while keeping `t1`'s stored key. Both keys work on `/identify`.
  - Database wizard: test, then confirm, then rollout complete.
- Shadow mode: logged differences with secrets masked, applied nothing.

**Not run here:** MongoDB paths (no MongoDB available) and `node_app`'s `npm run test:node` suites. Please run those locally.

## Still open

- MFA (TOTP) was in the design but is not built yet. Local passwords plus lockout are in place.
- Tenant isolation for analytics reads and deletes (from Phase 0) is still waiting for your decision.
- Changing the MongoDB connection while MongoDB is active needs a restart, until the Mongoose models move to a dedicated connection (Phase 5).
