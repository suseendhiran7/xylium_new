'use strict';

const crypto = require('crypto');
const { getConfig } = require('../config');

/**
 * AES-256-GCM envelope for configuration secrets.
 *
 *   [1 byte version=1][12 byte IV][16 byte tag][ciphertext]
 *
 * The key id is stored next to the ciphertext (config_versions.secrets_key_id)
 * and is also bound in as AAD, so a blob cannot be decrypted under a different
 * key id. To rotate: add a new key to CONFIG_ENCRYPTION_KEYS, make it active;
 * old versions keep decrypting with their own key id.
 */

const VERSION = 1;

function encryptJson(obj, { keyId } = {}) {
  const cfg = getConfig();
  const id = keyId || cfg.activeKeyId;
  const key = cfg.encryptionKeys[id];
  if (!key) throw new Error(`unknown encryption key id ${id}`);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`xylium-config:${id}`));
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return { blob: Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]), keyId: id };
}

function decryptJson(blob, keyId) {
  const key = getConfig().encryptionKeys[keyId];
  if (!key) throw new Error(`encryption key "${keyId}" is not configured — cannot decrypt stored secrets`);
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf[0] !== VERSION) throw new Error('unsupported secret envelope version');
  const iv = buf.subarray(1, 13);
  const tag = buf.subarray(13, 29);
  const ct = buf.subarray(29);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(`xylium-config:${keyId}`));
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8'));
}

module.exports = { encryptJson, decryptJson };
