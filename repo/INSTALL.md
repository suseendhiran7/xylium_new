# Xylium — Installation Guide (SDK app + Admin app)

This guide installs and connects both applications, start to finish:

| Folder | What it is | Port |
| --- | --- | --- |
| `node_app` | The SDK / collector (your existing app) | 8080 |
| `admin_app` | The Admin Application (UI + API) | 8090 (UI), 8091 (internal, for the SDK) |
| `packages\xylium-config` | Shared code used by both. Nothing to run | — |

Commands are for **Windows Command Prompt (cmd)**. PowerShell differences are noted where they matter.
The examples assume the repo is unzipped to `D:\xylium-new\repo`. Change the paths if yours differ.

---

## 0. Requirements

- **Node.js 18 or newer.** Check with `node -v`.
- **PostgreSQL 13 or newer.** Check with `psql --version`.
- **MongoDB**, only if you use MongoDB as the event database.

---

## 1. Unzip and install packages (once)

Unzip `xylium-admin-app.zip` into a **new** folder. Keep `node_app`, `admin_app` and `packages` side by side; the apps find the shared package through that layout.

```bat
cd D:\xylium-new\repo
npm install
```

This installs packages for both apps in one go.

---

## 2. Create the databases (once)

Open `psql` (or pgAdmin) as the `postgres` user and run:

```sql
-- the Admin app's own database (configuration, users, audit log)
CREATE DATABASE xylium_admin;

-- the SDK's event database, if you don't already have one
CREATE DATABASE behavioral_events;
```

Command-line version (it asks for the postgres password):

```bat
psql -U postgres -c "CREATE DATABASE xylium_admin;"
psql -U postgres -c "CREATE DATABASE behavioral_events;"
```

> `xylium_admin` must be a **separate** database from the event database.

---

## 3. Configure the SDK app (`node_app\.env`)

Copy your existing `.env` into `node_app` (for example from your old project folder):

```bat
copy D:\path\to\old\project\.env D:\xylium-new\repo\node_app\.env
```

If you have no `.env` yet, start from the example:

```bat
cd D:\xylium-new\repo\node_app
copy .env.example .env
```

Open `node_app\.env` in a text editor and check these lines:

```ini
# Required: 32+ random characters (the server won't start in production without it)
JWT_SECRET=put-a-long-random-value-here-at-least-32-chars

# Event database
ACTIVE_DATABASE=postgresql
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_USER=postgres
POSTGRES_PASSWORD=your-postgres-password
POSTGRES_DATABASE=behavioral_events

# Only for local testing WITHOUT a real PostgreSQL (never in production):
# PG_ALLOW_EMBEDDED=true
```

**Test the SDK on its own** before connecting the admin app:

```bat
cd D:\xylium-new\repo\node_app
npm start
```

You should see `listening on :8080`. Check http://localhost:8080/health. Then stop it with `Ctrl + C`.

---

## 4. Configure the Admin app (`admin_app\.env`)

### 4a. Generate keys

```bat
cd D:\xylium-new\repo\admin_app
npm run gen-keys
```

It prints two blocks. **Keep this window open, or copy the output into a text file.** You need both blocks:

```
# ---- admin_app/.env ----
CONFIG_ENCRYPTION_KEYS=k1:....
SDK_TO_ADMIN_KEYS=sdk-1:....
ADMIN_TO_SDK_KEY_ID=admin-1
ADMIN_TO_SDK_KEY=....

# ---- node_app/.env (SDK) ----
SDK_TO_ADMIN_KEY_ID=sdk-1
SDK_TO_ADMIN_KEY=....
ADMIN_TO_SDK_KEYS=admin-1:....
CONFIG_CACHE_KEY=....
```

### 4b. Create the `.env`

```bat
copy .env.example .env
```

Open `admin_app\.env` and set:

```ini
ADMIN_DB_URL=postgres://postgres:YOUR_POSTGRES_PASSWORD@localhost:5432/xylium_admin

# paste the 4 lines from the "admin_app/.env" block:
CONFIG_ENCRYPTION_KEYS=k1:....
SDK_TO_ADMIN_KEYS=sdk-1:....
ADMIN_TO_SDK_KEY_ID=admin-1
ADMIN_TO_SDK_KEY=....

# where the SDK runs (host:port)
SDK_ALLOWED_HOSTS=localhost:8080,127.0.0.1:8080
```

> If your PostgreSQL password contains `@`, `:`, `/` or `#`, write it URL-encoded in `ADMIN_DB_URL`. For example, `p@ss` becomes `p%40ss`.

> **Back up `CONFIG_ENCRYPTION_KEYS` somewhere safe.** Without it, the stored passwords and keys cannot be decrypted.

---

## 5. Create your admin login (once)

Choose a password of **12 or more characters** and run (still in `admin_app`):

**Command Prompt:**
```bat
set ADMIN_PASSWORD=MyAdminPass-2026
npm run create-user -- --email you@example.com --role superadmin
set ADMIN_PASSWORD=
```

**PowerShell:**
```powershell
$env:ADMIN_PASSWORD = "MyAdminPass-2026"
npm run create-user -- --email you@example.com --role superadmin
Remove-Item Env:ADMIN_PASSWORD
```

Expected output: `Created superadmin you@example.com`

Your login is `you@example.com` / `MyAdminPass-2026`. Use your real email.

> If you skip `ADMIN_PASSWORD`, a random password is generated and printed **once** (`Password (shown once): ...`).
> To reset a forgotten password, run the same commands again with a new `ADMIN_PASSWORD`.

---

## 6. Import the SDK's current settings (once)

This copies the settings from `node_app\.env` (database, tenants and keys, limits, CORS…) and your custom pattern files into the admin app as **version 1**, so you don't retype them. It only reads `node_app`; nothing there changes.

Check first, without saving:

```bat
npm run import-from-env -- --env ..\node_app\.env --sdk-dir ..\node_app\sdk --dry-run
```

Then import for real:

```bat
npm run import-from-env -- --env ..\node_app\.env --sdk-dir ..\node_app\sdk
```

Expected output: a `✓ ... saved as version 1` line for each setting.

---

## 7. Build and start the Admin app

```bat
cd D:\xylium-new\repo\admin_app
npm run build
npm start
```

Expected output:

```
[admin] UI + API on :8090
[admin] internal SDK API on 127.0.0.1:8091
```

Open **http://localhost:8090** and sign in with the email and password from step 5.
**Overview → Configuration** should list all six settings at **v1**.

Leave this window running.

---

## 8. Connect the SDK to the Admin app

Open `node_app\.env` and **add** these lines at the end:

```ini
# ---- Admin app connection ----
CONFIG_SOURCE=shadow
ADMIN_INTERNAL_URL=http://127.0.0.1:8091
SDK_INSTANCE_ID=sdk-1
SDK_INTERNAL_BASE_URL=http://127.0.0.1:8080

# paste the 4 lines from the "node_app/.env (SDK)" block of step 4a:
SDK_TO_ADMIN_KEY_ID=sdk-1
SDK_TO_ADMIN_KEY=....
ADMIN_TO_SDK_KEYS=admin-1:....
CONFIG_CACHE_KEY=....
```

Start the SDK in a **second** window:

```bat
cd D:\xylium-new\repo\node_app
npm start
```

### Shadow check

`shadow` means the SDK compares the admin's settings with its own `.env`, logs the result, and **changes nothing**. In the SDK window, look for:

```
[runtime-config][shadow] database v1: matches env
[runtime-config][shadow] ingestion v1: matches env
...
```

In the admin UI, **SDK instances** should show `sdk-1` as **live** within about 30 seconds.

If a line says **DIFFERS**, the log shows both values (secrets hidden). Make them match, either on that setting's page in the UI or in `.env`.

---

## 9. Switch the SDK to Admin mode

When every line says `matches env`, open `node_app\.env` and change:

```ini
CONFIG_SOURCE=admin
```

Restart the SDK (`Ctrl + C`, then `npm start`). Expected output:

```
[runtime-config] configuration from admin: {"database":1,"ingestion":1,...}
[server] database configuration from runtime: postgresql
```

From now on, settings are managed in the admin UI and the SDK picks up changes **without a restart**.

---

## 10. Verify that live changes work

1. In the admin UI, open **All configuration → Ingestion** and set **Max batch events** to `5`. Enter a reason and click **Save new version**.
2. The rollout panel should show `sdk-1` as **delivered / applied** within a second or two.
3. Send 6 events (use one of your tenant ids):

```bat
curl.exe -X POST http://localhost:8080/collect -H "content-type: application/json" -d "{\"tenantId\":\"tenant_test001\",\"appId\":\"a\",\"deviceFingerprint\":\"fp_test_1\",\"events\":[{\"type\":\"click\",\"t\":1,\"sessionId\":\"sess_check_1\"},{\"type\":\"click\",\"t\":2,\"sessionId\":\"sess_check_1\"},{\"type\":\"click\",\"t\":3,\"sessionId\":\"sess_check_1\"},{\"type\":\"click\",\"t\":4,\"sessionId\":\"sess_check_1\"},{\"type\":\"click\",\"t\":5,\"sessionId\":\"sess_check_1\"},{\"type\":\"click\",\"t\":6,\"sessionId\":\"sess_check_1\"}]}"
```

   The expected answer is `{"error":"too many events (max 5)"}`.
4. Undo it: on the **History** page of that setting, use **Roll back to this** on v1.

---

## Daily use

Start both apps, each in its own window:

```bat
:: window 1 – Admin app
cd D:\xylium-new\repo\admin_app
npm start

:: window 2 – SDK
cd D:\xylium-new\repo\node_app
npm start
```

The SDK also starts if the admin app is down. It then uses its last saved settings.

---

## All commands at a glance

| Where | Command | What it does |
| --- | --- | --- |
| `repo` | `npm install` | Install packages for both apps |
| `admin_app` | `npm run gen-keys` | Print new keys for both `.env` files |
| `admin_app` | `npm run create-user -- --email <e> --role superadmin` | Create the first user, or reset a password |
| `admin_app` | `npm run import-from-env -- --env ..\node_app\.env --sdk-dir ..\node_app\sdk` | Import the SDK settings (`--dry-run` to only check) |
| `admin_app` | `npm run build` | Build the UI (again after any UI change) |
| `admin_app` | `npm start` | Run the admin app |
| `admin_app` | `npm run migrate` | Update the admin database only (`start` does this too) |
| `node_app` | `npm start` | Run the SDK |
| `node_app` | `npm run admin:token -- --user <e>` | Token for the old SDK admin page (until it's retired) |
| `node_app` | `npm run test:jest` / `npm run test:node` | SDK tests (`test:node` needs MongoDB) |
| `admin_app` | `npm test` | Admin tests (needs `ADMIN_TEST_PG_URL=postgres://user:pass@localhost:5432`) |

User roles: **viewer** (read only) · **operator** (ingestion, IP intel, patterns) · **admin** (+ database, tenants, HTTP security, rollback, audit) · **superadmin** (+ users).

---

## Troubleshooting

| Message | Fix |
| --- | --- |
| `ADMIN_DB_URL is required` / `CONFIG_ENCRYPTION_KEYS is required` | `admin_app\.env` is missing or incomplete. See step 4 |
| `password authentication failed` (admin start) | Wrong password in `ADMIN_DB_URL` |
| `database "xylium_admin" does not exist` | Run step 2 |
| `Cannot find module '@xylium/config'` | Run `npm install` in `repo` (step 1); keep the folders side by side |
| `JWT_SECRET must be set...` | Set `JWT_SECRET` (32+ characters) in `node_app\.env` |
| `CONFIG_SOURCE=admin needs ...` | Some step 8 lines are missing in `node_app\.env` |
| SDK log: `heartbeat failed: HTTP 401` | Keys don't match. Re-paste both blocks from the **same** `gen-keys` run |
| SDK log: `heartbeat failed: HTTP 403` | `SDK_INTERNAL_BASE_URL` host:port is not in the admin's `SDK_ALLOWED_HOSTS` |
| SDK log: `admin unreachable at startup` | The admin app isn't running, or `ADMIN_INTERNAL_URL` is wrong |
| `Account locked` | 5 wrong passwords. Wait 15 minutes, or reset with step 5 |
| Login page says "Admin UI not built" | Run `npm run build` in `admin_app` |
| PostgreSQL requests fail when running locally without PostgreSQL | Add `PG_ALLOW_EMBEDDED=true` to `node_app\.env` (testing only) |

**Go back to the old way at any time:** set `CONFIG_SOURCE=env` in `node_app\.env` and restart the SDK. It then uses only its `.env`, exactly as before.

More details: `admin_app\README.md` (admin app), `CHANGES-PHASE-0-1.md` and `CHANGES-PHASE-2-4.md` (what changed).
