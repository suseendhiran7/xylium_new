# Phase 0 + Phase 1 — change notes

Phases 0 and 1 of the Admin Application plan (see the architecture doc). Nothing public changes shape: `/collect`, `/identify`, `/ip-intel`, `/api/analytics/*` and `/api/events*` behave as before. What changes is who may call the admin routes, and how the database layer takes its configuration.

## Layout

```
repo/
├─ package.json                  NEW  npm workspaces root (node_app, packages/*)
├─ packages/xylium-config/       NEW  shared contracts for SDK + Admin App
└─ node_app/                          existing app (same folder layout)
```

`node_app` depends on `"@xylium/config": "file:../packages/xylium-config"`, so a plain `npm install` inside `node_app` still works, and so does `npm install` at the root.

## Phase 0 — security fixes

| Change | Files | Behaviour |
| --- | --- | --- |
| Admin routes need an admin JWT | `middleware/authMiddleware.js` (`requireAdmin`), `routes/admin-database.routes.js` | `/api/admin/database/*` and `/admin/database/*`: no token → 401, tenant API key → 401, non-admin token → 403 |
| `/cp` needs an admin JWT | `tools/customPatternRoute.js` | Previously open to anyone |
| Payment verification is tenant-scoped | `routes/analytics.js` | A tenant key sending another tenant's `tenantId` → 403. Omitting `tenantId` behaves as before |
| `JWT_SECRET` required in production | `config/index.js` | With `NODE_ENV=production`, startup fails if it is unset, under 32 characters, the built-in dev value, or the `change-me…` placeholder |
| Embedded PostgreSQL is opt-in | `adapters/postgresql.adapter.js`, `factories/database.factory.js` | An unreachable PostgreSQL now fails loudly. `PG_ALLOW_EMBEDDED=true` restores the old fallback (tests set it) |
| Admin token for operators | `scripts/issue-admin-token.js`, `npm run admin:token` | `npm run admin:token -- --user you@example.com --minutes 30` (1–480 min) |
| No credentials in pages | `admin-database.html` (3 copies), `user-inspector.html` (2 copies) | Admin page asks for an admin token; inspector asks once per tab for its key |
| Pattern validator gap | `packages/xylium-config/src/pattern-validator.js` | `new XMLHttpRequest()`, `new WebSocket()` and `new EventSource()` are now rejected. This fixes the 2 tests that were failing before |

## Phase 1 — shared package + config-driven switching

**`@xylium/config`**: config-type registry (`database`, `ingestion`, `tenants`, `ip-intel`, `http-security`, `custom-patterns`) with zod schemas, apply modes and secret paths. It also holds secret helpers (mask / split / merge / keep-unchanged), HMAC request signing with replay protection, the wire-message schemas, a ReDoS screen for admin-entered regexes, and the pattern validator (moved from `tools/validate-custom-pattern.js`, which now imports it; the CLI is unchanged).

**SDK database layer:**

- `config/database.config.js` re-exports the schema and sanitizer from the package. `ACTIVE_DATABASE` is now honoured (it was hard-coded to `mongodb`). New functions: `setRuntimeDatabaseConfig()`, `clearRuntimeDatabaseConfig()`, `parseDatabaseConfig()` and `connectionFingerprint()`. With no override, everything still comes from env.
- `config/database-registry.js`: adapters carry a fingerprint of their connection settings. New `getCachedAdapter(type, fp)` and `retireAdapter(adapter, { graceMs })`, which drains the adapter and then disconnects it. It refuses the active adapter and never closes the global mongoose connection.
- `services/database-switch.service.js`:
  - `testConnection(type, candidateConfig?)`: tests explicit settings, never falls back to the embedded engine, and always closes temporary adapters (they used to leak).
  - `switchDatabase(type, actor, { config })`: rebuilds a cached adapter whose settings are stale, and becomes a reconfigure when the type is unchanged but the settings differ.
  - `reconfigureActive(config, actor)`: new password or host for the active PostgreSQL without a restart. It builds the new adapter, health-checks it, swaps it in, and retires the old one after 30 s. On failure the old adapter stays. A changed MongoDB connection returns 409 `restart_required`.
  - Called without the new arguments, all three behave as before.
- `database/mongo-models-connection.js`: switching **to** MongoDB now opens the global connection the Mongoose models use, and creates the TTL indexes. Before, a PostgreSQL→MongoDB switch at runtime silently skipped sessions, event batches and the login/session/payment collections; only `behaviour_events` was written.

## Tests

| Suite | Result |
| --- | --- |
| `node_app` Jest (`npm run test:jest`) | 186 / 186 pass (was 149 / 151). 35 new tests: `tests/config-driven-switch.test.js` + 3 auth tests in `customPatternRoute.test.js` |
| `packages/xylium-config` (`npm test`) | 19 / 19 pass |
| `node_app` node:test (`analytics.test.js`, `dual-database.test.js`) | **Not run here.** They need a real MongoDB on localhost, which was unavailable in this environment. Test 16 now uses an admin JWT and also asserts that a tenant key gets 401. Please run `npm run test:node` locally |

A smoke run of `node src/server.js` was also done: `/health` 200; admin status with a tenant key 401 and with an admin token 200; `/cp` without auth 401; `/collect` 202.

## Behaviour changes to know before deploying

1. Anything calling `/api/admin/database/*` or `/cp` with a tenant API key now gets 401. Use `npm run admin:token`.
2. Local development without PostgreSQL needs `PG_ALLOW_EMBEDDED=true`. Otherwise PostgreSQL requests fail instead of quietly using memory.
3. Production needs a real `JWT_SECRET`. Rotate it, and the tenant keys: the uploaded zip contained a filled-in `.env`. That file is not included in this delivery.

## Not done yet (needs your call)

- **Tenant isolation for analytics reads and deletes.** `GET /users/:id/sessions`, `GET /users/:id/risk` and `DELETE /users/:id` let any tenant key act on any `userId`, because the data layer has no tenant filter there. Separately, the PostgreSQL `deleteUserData` always deletes with tenant `'default'`. Fixing either changes the data-access layer and could affect existing GDPR-delete integrations, so I left them for a decision.
- Demo pages (`test-page-v2.html`, `nexus-bank.html`) still embed the dev key `changeme-secret`. They should not be served in production.
- Phases 2–5 (the admin backend, SDK sync endpoints, React UI, cut-over) as in the doc.
