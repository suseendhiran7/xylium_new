'use strict';

const { signRequest } = require('@xylium/config');
const { getConfig } = require('../../config');
const { HttpError } = require('../../lib/util');

/** Only call SDK base URLs whose host:port is on SDK_ALLOWED_HOSTS. */
function assertAllowed(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new HttpError(400, 'bad_base_url', 'Instance base URL is not a valid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'bad_base_url', 'Instance base URL must be http(s)');
  const host = url.host.toLowerCase();
  if (!getConfig().sdkAllowedHosts.includes(host)) {
    throw new HttpError(403, 'host_not_allowed', `SDK host ${host} is not in SDK_ALLOWED_HOSTS`);
  }
  return url;
}

/**
 * Signed request from the admin app to one SDK instance.
 * @returns {Promise<{ status: number, body: any }>}
 */
async function callSdk(baseUrl, method, path, payload, { timeoutMs } = {}) {
  const cfg = getConfig();
  const base = assertAllowed(baseUrl);
  const url = new URL(path, base.href.endsWith('/') ? base.href : `${base.href}/`);
  const body = payload === undefined ? '' : JSON.stringify(payload);
  const headers = {
    ...signRequest({ keyId: cfg.adminToSdk.keyId, secret: cfg.adminToSdk.secret, method, path: url.pathname + url.search, body }),
    ...(body ? { 'content-type': 'application/json' } : {}),
  };
  const res = await fetch(url, {
    method,
    headers,
    body: body || undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs || cfg.sdkRequestTimeoutMs),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 500) };
  }
  return { status: res.status, body: parsed };
}

module.exports = { callSdk, assertAllowed };
