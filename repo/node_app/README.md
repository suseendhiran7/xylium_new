# Xylium Behavioral Fingerprinting — SDK + Backend

Xylium is a two-part system for collecting behavioral and device signals
from a web page and turning them into a fraud/bot-risk signal for a login or
transaction flow:

1. **`sdk/`** — a modular JavaScript SDK that runs in the browser, capturing
   mouse, keyboard, touch, scroll, form, navigation, device-fingerprint,
   idle, geolocation, and automation/bot signals, and batching them to a
   backend.
2. **`node_app/`** — an Express + MongoDB backend that receives those
   batches, stores them keyed on session, stitches in the real `userId` once
   login succeeds, and lets an admin submit new custom pattern modules for
   the SDK (with an automatic guard against ones that capture actual user
   data instead of just behavior).

```
project-root/
├── sdk/                     the browser SDK (see "The SDK" below)
│   ├── xylium-core.js       landing file: session id, API pointer, transport
│   ├── xylium-mouse.js
│   ├── xylium-keyboard.js
│   ├── xylium-touch.js
│   ├── xylium-scroll.js
│   ├── xylium-form.js
│   ├── xylium-clipboard.js
│   ├── xylium-navigation.js
│   ├── xylium-device.js
│   ├── xylium-idle.js
│   ├── xylium-geo.js
│   ├── xylium-bot.js
│   ├── xylium-identity.js
│   └── xylium-custom.js     (only present once a custom pattern is accepted)
│
└── node_app/                the backend (see "The backend" below)
    ├── package.json
    ├── .env
    ├── src/
    │   ├── server.js         entrypoint: connects Mongo, starts Express
    │   ├── app.js             Express app: CORS, body parsing, rate limit, routes
    │   ├── config/index.js    env var loading
    │   ├── validation.js      zod schemas for /collect and /identify
    │   ├── collectService.js  core stitching logic
    │   ├── middleware/
    │   │   ├── tenantGuard.js   allowlist check for /collect
    │   │   └── apiKeyGuard.js   x-tenant-id + x-api-key check for /identify
    │   ├── models/
    │   │   ├── EventBatch.js    one doc per flushed SDK batch
    │   │   └── Session.js       one summary doc per session
    │   ├── routes/
    │   │   ├── collect.js, identify.js, health.js
    │   └── forward/            (stubbed — Redis/BullMQ forwarding disabled)
    ├── tools/
    │   ├── validate-custom-pattern.js   static analyzer: rejects patterns
    │   │                                 that capture real user data
    │   ├── customPatternRoute.js        HTTP endpoint wrapping the validator
    │   └── samples/                     example accepted/rejected submissions
    └── tests/                 Jest + Supertest unit/integration tests
```

---

## The SDK (`sdk/`)

### How it's structured

`xylium-core.js` is the **landing file** — it holds the session id, reads
its own `data-*` attributes for config (including the backend API pointer),
owns the event queue and transport (batching + `navigator.sendBeacon` on
unload), and exposes the public `window.XyliumBF` API.

Every other file is a **pattern module** — a single behavioral signal
category. Each one self-registers with the core through a small queue that
works regardless of script load order:

```js
(window.XyliumBFModules = window.XyliumBFModules || []).push(function (core) {
  // core.pushEvent(...), core.config, core.state, core.onConsent(order, fn), ...
});
```

Dropping a pattern's `<script>` tag removes that entire signal category —
no other code changes needed.

### What it captures

| Module | Signal |
|---|---|
| `xylium-mouse.js` | Mouse movement, clicks, trajectory, overshoot, hover, double-click, entropy |
| `xylium-keyboard.js` | Key timing, n-grams, corrections, shortcuts, shift/caps, typing summary |
| `xylium-touch.js` | Touch pressure, tap, swipe, multi-touch |
| `xylium-scroll.js` | Scroll position/velocity/direction |
| `xylium-form.js` | Field focus order, time-in-field, clear/retype, autofill, password toggle, submit/abandon/return |
| `xylium-clipboard.js` | Copy/paste occurrence (never clipboard *content*) |
| `xylium-navigation.js` | Page entry method, referrer, time context, back/forward, resize, tab visibility, window blur/focus |
| `xylium-device.js` | Device/browser fingerprint, plugins, battery, connection, canvas/WebGL/font/audio fingerprints, network timing |
| `xylium-idle.js` | Idle start/end |
| `xylium-geo.js` | Coarse geolocation + timezone-vs-location consistency (opt-in via `data-capture-geo`) |
| `xylium-bot.js` | Automation/headless-browser detection, media-query anomalies, event-integrity (isTrusted / timestamp precision) |
| `xylium-identity.js` | Persistent cross-session device id, local failed-login-attempt window |

Every module follows one rule: capture **behavior** (timing, coordinates,
counts), never **content** (what was typed, pasted, or stored). See
"Custom patterns" below for how that rule is enforced for new modules.

### Public API (`window.XyliumBF`)

| Method | Purpose |
|---|---|
| `identify(userId)` | Associate the session with a logged-in user (browser-reported, lower trust than server-side `/identify`) |
| `track(name, props)` | Send an arbitrary named custom event |
| `grantConsent()` | Start capture (required unless `requireConsent` is disabled) |
| `revokeConsent()` | Stop capture and erase persisted identifiers (device id, failed-attempt log, form-abandon marker) |
| `reportLoginResult(success, reason)` | Record a login attempt outcome (from `xylium-identity.js`) |
| `markFormSubmitted()` | Manually mark a form submitted, for SPA forms with no native submit event |
| `requestGeo()` | Manually (re-)trigger a geolocation capture |
| `getSessionId()` | Read the current session id (needed for the server-side `/identify` call — see the integration guide) |
| `_debugFlushNow()` | Force an immediate flush to the backend, for debugging |
| `use(factory)` | Register a pattern module programmatically |

Full integration steps are in **`INTEGRATION_GUIDE.md`**.

### Custom patterns

`tools/validate-custom-pattern.js` statically analyzes a submitted pattern
module and blocks it if it reads actual field values, cookies, rendered page
content, clipboard content, non-namespaced storage, PII-shaped regexes, or
bypasses the SDK's own transport. Only patterns that pass become
`sdk/xylium-custom.js`. See `node_app/tools/README.md` for the CLI and HTTP
(`/cp`) usage.

---

## The backend (`node_app/`)

Express + MongoDB service that receives SDK batches, stores them keyed on
`sessionId` (not `userId` — the valuable behavioral data on a login page
happens *before* the user is known), and backfills `userId` onto everything
once identification happens.

### Endpoints

| Method | Path | Auth | Who calls it |
|---|---|---|---|
| `GET` | `/health` | none | uptime checks |
| `POST` | `/collect` | tenant allowlist (`ALLOWED_TENANTS`) + the tenant's IP whitelist | the SDK, from browsers |
| `POST` | `/identify` | `x-tenant-id` + `x-api-key` + the tenant's IP whitelist | your login backend, server-to-server |
| `POST` | `/cp` | admin JWT (`Authorization: Bearer …`) | a platform operator submitting a custom pattern |
| `*` | `/api/admin/database/*` | admin JWT only — tenant API keys are rejected | platform operators |

`/collect` returns `202 Accepted` (storage is synchronous to Mongo; forwarding
to a downstream scoring service is currently stubbed/disabled).

**`/identify` example:**
```bash
curl -X POST http://localhost:8080/identify \
  -H 'content-type: application/json' \
  -H 'x-tenant-id: tenant_test001' \
  -H 'x-api-key: changeme-secret' \
  -d '{"sessionId":"<the session id>","userId":"user_42"}'
```

**`/cp` example** (multipart upload — see `node_app/tools/README.md` for the
full Postman walkthrough):
```
POST http://localhost:8080/cp
Body → form-data:
  file         [File]   the .js pattern file
  filename     [Text]   e.g. "xylium-custom.js"
  description  [Text]   what this pattern captures and why
```

### Setup

```bash
cd node_app
npm install
cp .env.example .env    # then edit values — see below
npm run dev              # or: npm start
```

### Environment variables (`.env`)

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default `8080`) |
| `MONGO_URI` | MongoDB connection string |
| `ALLOWED_TENANTS` | Comma-separated tenant allowlist for `/collect`. Empty = allow all (dev only) |
| `CORS_ORIGINS` | Comma-separated allowed origins, or `*` |
| `TENANT_API_KEYS` | JSON map of `tenantId → apiKey`, used by `/identify` |
| `TENANT_IP_WHITELIST` | JSON map of `tenantId → [IP or CIDR, …]`. A listed tenant's `/collect`, `/ip-intel` and `/identify` requests are accepted only from those IPs (403 otherwise); unlisted tenants accept any IP. Managed in the admin panel under **Tenants & API keys** |
| `MAX_BATCH_EVENTS` | Max events accepted per `/collect` batch |
| `MAX_PAYLOAD_BYTES` | Max request body size |
| `RAW_TTL_DAYS` | Auto-expire raw event batches after N days (`0` = keep forever) |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | Rate limiting, per IP |
| `XYLIUM_SDK_DIR` | Where `/cp` writes an accepted `xylium-custom.js` — point this at your real `sdk/` folder |

### Data model

- **`EventBatch`** — one document per flushed SDK batch (not one growing
  array per session, to stay well under Mongo's 16MB document limit).
- **`Session`** — one summary document per session (`_id = sessionId`):
  running counts, current `userId`, and `identifiedBy` (`'browser'` or
  `'server'` — a server-side `/identify` call always wins over and is never
  overwritten by a later browser-reported one).

### Testing

```bash
npm test
```
Jest + Supertest, Mongoose mocked (no real MongoDB needed to run the suite).
See `node_app/tests/` for the full breakdown by file.

### Security notes

- **Admin routes need an admin JWT.** `/api/admin/database/*` and `/cp`
  accept only a token with `role: 'admin'`; tenant API keys are rejected (a
  tenant key used to be able to switch the global database). Until the
  separate Admin Application exists, mint a short-lived token on the server:
  `npm run admin:token -- --user you@example.com --minutes 30`.
- **`JWT_SECRET` is mandatory in production** (32+ characters); the server
  will not start without it.
- **No silent in-memory PostgreSQL.** If PostgreSQL is unreachable the adapter
  now fails instead of switching to `pg-mem`. Set `PG_ALLOW_EMBEDDED=true`
  only for tests and local demos.
- `/identify`'s API key comparison is timing-safe (`crypto.timingSafeEqual`).
- The custom-pattern validator is a static, rule-based gate against
  accidental/naive over-capture — not a security boundary against a
  determined, obfuscating bad actor. Review anything it accepts.
