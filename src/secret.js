'use strict';

// Turns a user's Gemini key into an opaque token that only this server can
// read, so the key never appears in any URL in readable form.
//
// The token is AES-256-GCM. The encryption secret lives in the SECRET
// environment variable and never leaves the server. Change it and every
// previously issued install URL stops working, so set it once and leave it.

const crypto = require('crypto');

const RAW = process.env.SECRET || '';
const HAVE_SECRET = RAW.length >= 16;
const KEY = HAVE_SECRET
  ? crypto.createHash('sha256').update(RAW).digest()
  : null;

/** @returns {boolean} whether this server can issue encrypted tokens */
function enabled() {
  return HAVE_SECRET;
}

/**
 * Encrypt a config object into a URL-safe token.
 * @param {object} cfg e.g. { key: 'AQ.xxx' }
 */
function seal(cfg) {
  if (!HAVE_SECRET) throw new Error('SECRET is not configured on this server');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([c.update(JSON.stringify(cfg), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  // v1 marker keeps the door open for changing the scheme later.
  return 'e1' + Buffer.concat([iv, tag, body]).toString('base64url');
}

/**
 * Decrypt a token produced by seal(). Returns null for anything we cannot
 * verify — a wrong secret, a truncated token or a tampered one all land here.
 */
function open(token) {
  if (!HAVE_SECRET || typeof token !== 'string' || !token.startsWith('e1')) return null;
  try {
    const raw = Buffer.from(token.slice(2), 'base64url');
    if (raw.length < 12 + 16 + 1) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const body = raw.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    d.setAuthTag(tag);
    const out = Buffer.concat([d.update(body), d.final()]).toString('utf8');
    const cfg = JSON.parse(out);
    return cfg && typeof cfg === 'object' ? cfg : null;
  } catch {
    return null;
  }
}

/** A short, stable id for a token - used for rate limiting, never logged raw. */
function fingerprint(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 12);
}

module.exports = { enabled, seal, open, fingerprint };
