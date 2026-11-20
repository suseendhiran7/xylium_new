# Xylium Admin Application

One deployable app: a React UI and a Node.js API in the same process. It manages the SDK's configuration (database, ingestion limits, tenants and API keys, IP intelligence, HTTP security, custom patterns) and tells every running SDK instance when something changes.

```
Browser ──► admin_app :8090  (UI + /api, login, versions, audit)
                │  own PostgreSQL database: xylium_admin
                │
                │  notify (signed)            pull / ack / heartbeat (signed)
                ▼                             ▲
            node_app (SDK) :8080 ── /internal ┘ ──► event database (PostgreSQL or MongoDB)
```

* Every save creates a **new version**; nothing is overwritten. Rollback = a new version with old settings.
* Secrets (database passwords, Mongo URI, tenant API keys, IPQS key) are **encrypted** in the database and never sent to the browser.
* A notice to the SDK carries only "type T is now version V"; the SDK pulls the data itself, validates it, applies it and reports back.
* Database changes are **tested on every live SDK instance first**; if one can't connect, nothing is saved.
* Every change, rollback, test and sign-in is in the **audit log**.

## First-time setup

Requirements: Node.js 18+, PostgreSQL 13+ (any server the admin app can reach; it can be the same server the SDK uses, but a **separate database**).

All commands from the repository root unless noted. Windows: use PowerShell or Command Prompt, the commands are the same.

1. **Install everything** (root of the repo, once):

   ```bat
   npm install
   ```

2. **Create the admin database** (psql or pgAdmin):

   ```sql
   CREATE DATABASE xylium_admin;
   ```

3. **Generate keys** and create `admin_app\.env`:

   ```bat
   cd admin_app
   npm run gen-keys
   copy .env.example .env
   ```

   Paste the `admin_app/.env` lines that `gen-keys` printed into `admin_app\.env`, set `ADMIN_DB_URL`, and set `SDK_ALLOWED_HOSTS` to the `host:port` your SDK runs on (default `localhost:8080,127.0.0.1:8080`). **Keep the `node_app/.env` lines** printed by `gen-keys` for step 6.

4. **Create your first user** (a superadmin; add everyone else from the Users page):

   ```bat
   npm run create-user -- --email you@example.com --role superadmin
   ```

   It prints a generated password once. (Or set `ADMIN_PASSWORD` before running it.)

5. **Import the SDK's current settings** as version 1 (recommended):

   ```bat
   npm run import-from-env -- --env ..\node_app\.env --sdk-dir ..\node_app\sdk
   ```

   Use `--dry-run` first to just validate. Types that already have a version are skipped.

6. **Connect the SDK** — add to `node_app\.env` the lines `gen-keys` printed for the SDK, plus:

   ```ini
   CONFIG_SOURCE=shadow
   ADMIN_INTERNAL_URL=http://127.0.0.1:8091
   SDK_INSTANCE_ID=sdk-1
   SDK_INTERNAL_BASE_URL=http://127.0.0.1:8080
   ```

   Start with `shadow`: the SDK registers with the admin app and **logs any difference** between the admin settings and its `.env`, but changes nothing. When the log shows `matches env` for every type, switch to `CONFIG_SOURCE=admin` and restart the SDK.

7. **Build the UI and start**:

   ```bat
   npm run build
   npm start
   ```

   Open http://localhost:8090 and sign in.

For UI development, run `npm run dev:server` and `npm run dev:web` (Vite on http://localhost:5173, proxied to the API).

## Roles

| Role | Can |
| --- | --- |
| viewer | see everything except the audit log and users |
| operator | change ingestion, IP intelligence, custom patterns |
| admin | + database, tenants & API keys, HTTP security, rollbacks, audit log |
| superadmin | + manage users |

Accounts lock for 15 minutes after 5 failed sign-ins. Sessions end after 30 minutes idle or 8 hours.

## How each setting takes effect

| Setting | On the SDK |
| --- | --- |
| Ingestion, Tenants & API keys, IP intelligence, Custom patterns | **Live**, on the next request |
| Database | **Live reconnect**: new connection is tested, swapped in, the old one drained after 30 s. On failure the old one stays. Exception: changing the MongoDB connection *while MongoDB is active* needs a restart |
| HTTP security (CORS, proxy trust, body size, rate limits) | **Next restart** of each instance (shown as "restart pending") |

Switching the active database changes where **new** events go; history stays where it was written. MongoDB → PostgreSQL history can be copied with `npm run migrate` in `node_app`.

## When things go wrong

* **Admin app down**: SDK instances keep running. They start with their encrypted last-known-good copy (`CONFIG_CACHE_KEY` must be set), or their `.env` if there is none.
* **A notice gets lost**: each SDK checks in every 30 s, sees the newer version and pulls it.
* **An SDK can't apply a version**: it keeps its previous settings and reports `failed` with the reason; the rollout panel shows it and offers "Notify again".
* **Go back to the old way**: set `CONFIG_SOURCE=env` in `node_app\.env` and restart the SDK.

## Commands

| Command (in admin_app) | Does |
| --- | --- |
| `npm start` | run the app (migrates the database first) |
| `npm run build` | build the React UI into `web/dist` |
| `npm run migrate` | apply database migrations only |
| `npm run create-user -- --email … --role …` | create or reset a user |
| `npm run import-from-env -- --env <file> [--sdk-dir <dir>] [--dry-run] [--force]` | import SDK settings |
| `npm run gen-keys` | print fresh keys for both apps |
| `npm test` | backend tests; needs `ADMIN_TEST_PG_URL=postgres://user:pass@host:5432` (server URL, no database) |

## Production checklist

* `NODE_ENV=production` (Secure cookies, strict CSP), TLS in front of port 8090.
* Port 8091 reachable **only** from the SDK hosts (firewall / private network).
* Back up `CONFIG_ENCRYPTION_KEYS` separately from database backups — without it stored secrets cannot be decrypted.
* Grant the admin DB role only `INSERT, SELECT` on `config_audit_log` to make the audit log append-only.
