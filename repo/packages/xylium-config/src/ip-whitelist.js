'use strict';

const net = require('net');

/**
 * Per-tenant IP whitelist entries: a single address ("203.0.113.7",
 * "2001:db8::1") or a CIDR range ("203.0.113.0/24", "2001:db8::/32").
 */

const stripMapped = (ip) => (typeof ip === 'string' && ip.toLowerCase().startsWith('::ffff:') && net.isIPv4(ip.slice(7)) ? ip.slice(7) : ip);

/** Parse one entry. Returns { address, prefix, family } or null when invalid. */
function parseIpEntry(entry) {
  if (typeof entry !== 'string') return null;
  const [rawAddr, rawPrefix, extra] = entry.trim().split('/');
  if (extra !== undefined || !rawAddr) return null;
  const address = stripMapped(rawAddr);
  const v = net.isIP(address);
  if (!v) return null;
  const family = v === 4 ? 'ipv4' : 'ipv6';
  const max = v === 4 ? 32 : 128;
  if (rawPrefix === undefined) return { address, prefix: max, family };
  if (!/^\d{1,3}$/.test(rawPrefix)) return null;
  const prefix = Number(rawPrefix);
  if (prefix > max) return null;
  return { address, prefix, family };
}

/** Problem text for an invalid entry, or null when it is valid. */
function ipEntryProblem(entry) {
  return parseIpEntry(entry) ? null : `"${entry}" is not an IP address or CIDR range (e.g. 203.0.113.7 or 203.0.113.0/24)`;
}

/** Build a matcher for a list of entries: (ip) => boolean. */
function compileIpWhitelist(entries) {
  const list = new net.BlockList();
  for (const e of entries || []) {
    const p = parseIpEntry(e);
    if (!p) continue;
    if (p.prefix === (p.family === 'ipv4' ? 32 : 128)) list.addAddress(p.address, p.family);
    else list.addSubnet(p.address, p.prefix, p.family);
  }
  return (ip) => {
    const addr = stripMapped(ip);
    const v = net.isIP(addr || '');
    if (!v) return false;
    return list.check(addr, v === 4 ? 'ipv4' : 'ipv6');
  };
}

module.exports = { parseIpEntry, ipEntryProblem, compileIpWhitelist };
