'use strict';

const crypto = require('crypto');

/**
 * HMAC signing for /internal calls between the Admin Application and SDK
 * instances (both directions, separate keys per direction).
 *
 *   X-Xylium-Key-Id     which shared secret signed it (allows rotation)
 *   X-Xylium-Timestamp  unix seconds; rejected outside ±maxSkewSec
 *   X-Xylium-Nonce      random; rejected if seen before (replay)
 *   X-Xylium-Signature  v1=hex(HMAC-SHA256(secret, ts.nonce.METHOD.path.sha256(body)))
 *
 * `path` includes the query string exactly as sent.
 */

const HEADER = {
  keyId: 'x-xylium-key-id',
  timestamp: 'x-xylium-timestamp',
  nonce: 'x-xylium-nonce',
  signature: 'x-xylium-signature',
};

const sha256Hex = (s) => crypto.createHash('sha256').update(s == null ? '' : s, 'utf8').digest('hex');

function signingString({ timestamp, nonce, method, path, body }) {
  return `${timestamp}.${nonce}.${String(method).toUpperCase()}.${path}.${sha256Hex(body)}`;
}

function hmac(secret, str) {
  return crypto.createHmac('sha256', secret).update(str, 'utf8').digest('hex');
}

/**
 * @param {{ keyId: string, secret: string, method: string, path: string, body?: string, now?: number }} p
 * @returns {Record<string,string>} headers to send
 */
function signRequest({ keyId, secret, method, path, body = '', now = Date.now() }) {
  if (!secret || secret.length < 32) throw new Error('signing secret must be at least 32 characters');
  const timestamp = String(Math.floor(now / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const sig = hmac(secret, signingString({ timestamp, nonce, method, path, body }));
  return {
    [HEADER.keyId]: keyId,
    [HEADER.timestamp]: timestamp,
    [HEADER.nonce]: nonce,
    [HEADER.signature]: `v1=${sig}`,
  };
}

/** Remembers nonces for `ttlMs` so a captured request cannot be replayed. */
class NonceCache {
  constructor({ ttlMs = 10 * 60 * 1000, max = 100000 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.seen = new Map(); // nonce -> expiresAt
  }

  /** @returns {boolean} true if the nonce is new (and is now recorded) */
  checkAndAdd(nonce, now = Date.now()) {
    for (const [n, exp] of this.seen) {
      if (exp > now && this.seen.size < this.max) break; // Map keeps insertion order
      this.seen.delete(n);
    }
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now + this.ttlMs);
    return true;
  }
}

function safeEqualHex(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * @param {object} p
 * @param {(keyId: string) => string|undefined} p.getSecret
 * @param {Record<string,string|string[]|undefined>} p.headers  lower-cased header names (Node's req.headers)
 * @param {string} p.method
 * @param {string} p.path      original URL incl. query (req.originalUrl)
 * @param {string} p.rawBody   exact bytes received, as a string
 * @param {NonceCache} [p.nonceCache]
 * @param {number} [p.maxSkewSec]
 * @param {number} [p.now]
 * @returns {{ ok: true, keyId: string } | { ok: false, reason: string }}
 */
function verifyRequest({ getSecret, headers, method, path, rawBody = '', nonceCache, maxSkewSec = 300, now = Date.now() }) {
  const h = (k) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const keyId = h(HEADER.keyId);
  const timestamp = h(HEADER.timestamp);
  const nonce = h(HEADER.nonce);
  const sigHeader = h(HEADER.signature);
  if (!keyId || !timestamp || !nonce || !sigHeader) return { ok: false, reason: 'missing signature headers' };
  if (!/^\d{9,12}$/.test(timestamp)) return { ok: false, reason: 'bad timestamp' };
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > maxSkewSec) return { ok: false, reason: 'timestamp outside allowed window' };
  if (!/^[a-f0-9]{16,128}$/i.test(nonce)) return { ok: false, reason: 'bad nonce' };
  const secret = getSecret(keyId);
  if (!secret) return { ok: false, reason: 'unknown key id' };
  const m = /^v1=([a-f0-9]{64})$/i.exec(sigHeader);
  if (!m) return { ok: false, reason: 'bad signature format' };
  const expected = hmac(secret, signingString({ timestamp, nonce, method, path, body: rawBody }));
  if (!safeEqualHex(m[1].toLowerCase(), expected)) return { ok: false, reason: 'signature mismatch' };
  // Only record the nonce once the signature is proven, so junk can't fill the cache.
  if (nonceCache && !nonceCache.checkAndAdd(nonce, now)) return { ok: false, reason: 'replayed nonce' };
  return { ok: true, keyId };
}

module.exports = { HEADER, signRequest, verifyRequest, NonceCache };
