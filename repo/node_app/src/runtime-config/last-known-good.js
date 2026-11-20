'use strict';

const fs = require('fs');
const crypto = require('crypto');

/**
 * Encrypted copy of the last configuration this instance applied, so it can
 * start with the admin-managed settings even while the Admin Application is
 * unreachable. AES-256-GCM with CONFIG_CACHE_KEY; written atomically, mode 0600.
 * Without CONFIG_CACHE_KEY nothing is written (the file would hold secrets).
 */

function save(file, key, snapshot) {
  if (!key) return false;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(snapshot), 'utf8'), cipher.final()]);
  const doc = JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, doc, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return true;
}

function load(file, key) {
  if (!key || !fs.existsSync(file)) return null;
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (doc.v !== 1) throw new Error('unsupported cache format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(doc.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(doc.tag, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(doc.ct, 'base64')), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

module.exports = { save, load };
