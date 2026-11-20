'use strict';

const { signRequest } = require('@xylium/config');

/** Signed calls from this SDK instance to the Admin Application's internal API. */
class AdminClient {
  constructor(settings) {
    this.s = settings;
  }

  async request(method, pathAndQuery, payload) {
    const url = new URL(`${this.s.adminUrl}${pathAndQuery}`);
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const headers = {
      ...signRequest({ keyId: this.s.sdkToAdmin.keyId, secret: this.s.sdkToAdmin.secret, method, path: url.pathname + url.search, body }),
      ...(body ? { 'content-type': 'application/json' } : {}),
    };
    const res = await fetch(url, { method, headers, body: body || undefined, redirect: 'error', signal: AbortSignal.timeout(this.s.requestTimeoutMs) });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const err = new Error(`admin ${method} ${url.pathname} → HTTP ${res.status}${json && json.message ? `: ${json.message}` : ''}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  snapshot(types) {
    const q = types && types.length ? `?types=${encodeURIComponent(types.join(','))}` : '';
    return this.request('GET', `/internal/config/snapshot${q}`);
  }

  ack(ack) {
    return this.request('POST', '/internal/config/ack', ack);
  }

  heartbeat(hb) {
    return this.request('POST', '/internal/sdk-instances/heartbeat', hb);
  }
}

module.exports = { AdminClient };
