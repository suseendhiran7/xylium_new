'use strict';

const config = require('../../src/config');
const tenantGuard = require('../../src/middleware/tenantGuard');
const apiKeyGuard = require('../../src/middleware/apiKeyGuard');
const { APPLIERS } = require('../../src/runtime-config/appliers');

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const run = (guard, req) => {
  const res = makeRes();
  const next = jest.fn();
  guard({ method: 'POST', originalUrl: '/collect', ...req }, res, next);
  return { res, next };
};

describe('per-tenant IP whitelist', () => {
  const before = { a: config.allowedTenants, k: config.tenantApiKeys, w: config.tenantIpWhitelist };
  let warn;

  beforeAll(async () => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Applied the same way the admin panel does it.
    await APPLIERS.tenants.apply({
      allowedTenants: ['tenant_a', 'tenant_b', 'tenant_open'],
      tenantApiKeys: { tenant_a: 'key-aaaaaaaaaaaa', tenant_b: 'key-bbbbbbbbbbbb' },
      ipWhitelist: {
        tenant_a: ['203.0.113.0/24', '198.51.100.7'],
        tenant_b: ['2001:db8::/32'],
        tenant_open: [],
      },
    });
  });
  afterAll(() => {
    Object.assign(config, { allowedTenants: before.a, tenantApiKeys: before.k, tenantIpWhitelist: before.w });
    warn.mockRestore();
  });

  test('a whitelisted IP (exact or in a range) is let through', () => {
    expect(run(tenantGuard, { ip: '203.0.113.99', body: { tenantId: 'tenant_a' } }).next).toHaveBeenCalled();
    expect(run(tenantGuard, { ip: '198.51.100.7', body: { tenantId: 'tenant_a' } }).next).toHaveBeenCalled();
    expect(run(tenantGuard, { ip: '::ffff:203.0.113.5', body: { tenantId: 'tenant_a' } }).next).toHaveBeenCalled();
    expect(run(tenantGuard, { ip: '2001:db8:1::5', body: { tenantId: 'tenant_b' } }).next).toHaveBeenCalled();
  });

  test('an IP outside the tenant list is refused with 403', () => {
    const { res, next } = run(tenantGuard, { ip: '198.51.100.8', body: { tenantId: 'tenant_a' } });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'ip not allowed for this tenant' });
  });

  test('lists are per tenant: one tenant\'s IP does not unlock another tenant', () => {
    expect(run(tenantGuard, { ip: '203.0.113.10', body: { tenantId: 'tenant_b' } }).res.status).toHaveBeenCalledWith(403);
    expect(run(tenantGuard, { ip: '2001:db8::1', body: { tenantId: 'tenant_a' } }).res.status).toHaveBeenCalledWith(403);
  });

  test('a tenant with an empty list accepts any IP', () => {
    expect(run(tenantGuard, { ip: '8.8.8.8', body: { tenantId: 'tenant_open' } }).next).toHaveBeenCalled();
  });

  test('query-string tenant (GET /ip-intel) is checked too', () => {
    expect(run(tenantGuard, { ip: '8.8.8.8', query: { tenantId: 'tenant_a' } }).res.status).toHaveBeenCalledWith(403);
  });

  test('server-to-server calls with a valid API key are also IP-checked', () => {
    const header = (h) => (k) => h[k.toLowerCase()];
    const ok = run(apiKeyGuard, { ip: '203.0.113.1', header: header({ 'x-tenant-id': 'tenant_a', 'x-api-key': 'key-aaaaaaaaaaaa' }) });
    expect(ok.next).toHaveBeenCalled();
    const blocked = run(apiKeyGuard, { ip: '10.1.1.1', header: header({ 'x-tenant-id': 'tenant_a', 'x-api-key': 'key-aaaaaaaaaaaa' }) });
    expect(blocked.res.status).toHaveBeenCalledWith(403);
    // wrong key is still 401 (no hint about the IP list)
    const badKey = run(apiKeyGuard, { ip: '10.1.1.1', header: header({ 'x-tenant-id': 'tenant_a', 'x-api-key': 'wrong-key-123456' }) });
    expect(badKey.res.status).toHaveBeenCalledWith(401);
  });

  test('a new config from the admin panel takes effect on the next request', async () => {
    await APPLIERS.tenants.apply({
      allowedTenants: ['tenant_a'], tenantApiKeys: {}, ipWhitelist: { tenant_a: ['8.8.8.8'] },
    });
    expect(run(tenantGuard, { ip: '8.8.8.8', body: { tenantId: 'tenant_a' } }).next).toHaveBeenCalled();
    expect(run(tenantGuard, { ip: '203.0.113.99', body: { tenantId: 'tenant_a' } }).res.status).toHaveBeenCalledWith(403);
  });
});
