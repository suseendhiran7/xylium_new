require('dotenv').config();

function list(v) {
  if (!v) return [];
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function jsonMap(v, name = 'TENANT_API_KEYS') {
  if (!v) return {};
  try {
    const o = JSON.parse(v);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    console.warn(`[config] ${name} is not valid JSON — treating as empty`);
    return {};
  }
}

// TENANT_IP_WHITELIST={"tenant_a":["203.0.113.0/24","198.51.100.7"]}
// (a comma-separated string per tenant also works).
function ipWhitelist(v) {
  return Object.fromEntries(
    Object.entries(jsonMap(v, 'TENANT_IP_WHITELIST')).map(([t, ips]) => [t, Array.isArray(ips) ? ips.map(String) : list(String(ips))])
  );
}

// TRUST_PROXY → Express `trust proxy`. "true"/"false", a hop count, or a
// comma list of subnets/keywords (loopback, linklocal, uniquelocal, CIDRs).
function trustProxy(v) {
  if (v === undefined || v === '') return 'loopback, linklocal, uniquelocal';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  return v;
}

const ipIntelProvider = (process.env.IP_INTEL_PROVIDER || 'none').toLowerCase();
if (!['none', 'ipqs', 'ipapi'].includes(ipIntelProvider)) {
  console.warn(`[config] unknown IP_INTEL_PROVIDER "${ipIntelProvider}" — /ip-intel will return nulls`);
}
if (ipIntelProvider === 'ipqs' && !process.env.IPQS_API_KEY) {
  console.warn('[config] IP_INTEL_PROVIDER=ipqs but IPQS_API_KEY is empty — /ip-intel will return nulls');
}

// JWT_SECRET signs admin and user tokens. The built-in fallback is public (it
// is in the source), so production must never run on it.
const DEV_JWT_SECRET = 'xylium-default-dev-secret-key-32chars!!';
function jwtSecret() {
  const v = process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    if (!v || v === DEV_JWT_SECRET || v.startsWith('change-me') || v.length < 32) {
      throw new Error('[config] JWT_SECRET must be set to a random value of 32+ characters in production');
    }
  }
  return v || DEV_JWT_SECRET;
}

module.exports = {
  nodeEnv: process.env.NODE_ENV || 'development',
  trustProxy: trustProxy(process.env.TRUST_PROXY),
  port: parseInt(process.env.PORT || '8080', 10),
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/xylium',
  allowedTenants: list(process.env.ALLOWED_TENANTS),
  corsOrigins: list(process.env.CORS_ORIGINS),
  tenantApiKeys: jsonMap(process.env.TENANT_API_KEYS),
  // tenant id -> IPs / CIDR ranges allowed for that tenant (see middleware/tenantIpWhitelist.js)
  tenantIpWhitelist: ipWhitelist(process.env.TENANT_IP_WHITELIST),
  maxBatchEvents: parseInt(process.env.MAX_BATCH_EVENTS || '500', 10),
  maxPayloadBytes: parseInt(process.env.MAX_PAYLOAD_BYTES || '262144', 10),
  rawTtlDays: parseInt(process.env.RAW_TTL_DAYS || '0', 10),
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '3000', 10),
  jwtSecret: jwtSecret(),
  ipIntel: {
    provider: ipIntelProvider,
    apiKey: process.env.IPQS_API_KEY || '',
    strictness: parseInt(process.env.IPQS_STRICTNESS || '1', 10),
    timeoutMs: parseInt(process.env.IP_INTEL_TIMEOUT_MS || '3000', 10),
    cacheTtlMs: parseInt(process.env.IP_INTEL_CACHE_TTL_MS || String(6 * 60 * 60 * 1000), 10),
    cacheMax: parseInt(process.env.IP_INTEL_CACHE_MAX || '10000', 10),
    rateLimitWindowMs: parseInt(process.env.IP_INTEL_RATE_LIMIT_WINDOW_MS || '60000', 10),
    rateLimitMax: parseInt(process.env.IP_INTEL_RATE_LIMIT_MAX || '30', 10),
    // Dev only: public IP to classify instead of localhost. Ignored in production.
    devIp: process.env.IP_INTEL_DEV_IP || '',
  },
};
