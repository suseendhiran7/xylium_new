'use strict';

/**
 * Print fresh random values for the admin app's .env and the matching lines
 * for the SDK's .env. Run once per environment; keep the output secret.
 */
const crypto = require('crypto');

const b64 = (n) => crypto.randomBytes(n).toString('base64');
const hex = (n) => crypto.randomBytes(n).toString('hex');

const enc = b64(32);
const sdkToAdmin = hex(32);
const adminToSdk = hex(32);
const cache = b64(32);

console.log(`# ---- admin_app/.env ----
CONFIG_ENCRYPTION_KEYS=k1:${enc}
SDK_TO_ADMIN_KEYS=sdk-1:${sdkToAdmin}
ADMIN_TO_SDK_KEY_ID=admin-1
ADMIN_TO_SDK_KEY=${adminToSdk}

# ---- node_app/.env (SDK) ----
SDK_TO_ADMIN_KEY_ID=sdk-1
SDK_TO_ADMIN_KEY=${sdkToAdmin}
ADMIN_TO_SDK_KEYS=admin-1:${adminToSdk}
CONFIG_CACHE_KEY=${cache}
`);
