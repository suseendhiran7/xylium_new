'use strict';

const crypto = require('crypto');
const { query } = require('../db/pool');
const { getConfig } = require('../config');
const { HttpError, sha256 } = require('../lib/util');

const COOKIE = 'xa_session';
const ROLES = ['viewer', 'operator', 'admin', 'superadmin'];
const rank = (r) => ROLES.indexOf(r);

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token) {
  const cfg = getConfig();
  const attrs = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${Math.floor(cfg.sessionAbsoluteMs / 1000)}`];
  if (cfg.cookieSecure) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  const attrs = [`${COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (getConfig().cookieSecure) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

/** Create a session row; returns { token, csrfToken }. The token is only ever stored hashed. */
async function createSession(userId, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrfToken = crypto.randomBytes(24).toString('base64url');
  const cfg = getConfig();
  await query(
    `INSERT INTO admin_sessions (user_id, token_hash, csrf_token, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, NOW() + ($4 || ' milliseconds')::interval, $5, $6)`,
    [userId, sha256(token), csrfToken, String(cfg.sessionAbsoluteMs), req.ip, String(req.get('user-agent') || '').slice(0, 300)]
  );
  return { token, csrfToken };
}

/**
 * Loads req.session / req.user from the cookie when valid. Enforces the idle
 * and absolute timeouts and the user's disabled flag on every request.
 */
async function loadSession(req, res, next) {
  try {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return next();
    const cfg = getConfig();
    const { rows } = await query(
      `SELECT s.id, s.csrf_token, s.last_seen_at, s.expires_at, s.revoked_at,
              u.id AS user_id, u.email, u.role, u.disabled
         FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
        WHERE s.token_hash = $1`,
      [sha256(token)]
    );
    const s = rows[0];
    const now = Date.now();
    const valid =
      s && !s.revoked_at && !s.disabled && new Date(s.expires_at).getTime() > now && now - new Date(s.last_seen_at).getTime() < cfg.sessionIdleMs;
    if (!valid) {
      clearSessionCookie(res);
      return next();
    }
    req.session = { id: s.id, csrfToken: s.csrf_token };
    req.user = { id: s.user_id, email: s.email, role: s.role };
    // Touch at most once a minute to keep writes low.
    if (now - new Date(s.last_seen_at).getTime() > 60000) {
      query('UPDATE admin_sessions SET last_seen_at = NOW() WHERE id = $1', [s.id]).catch(() => {});
    }
    next();
  } catch (err) {
    next(err);
  }
}

function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'unauthenticated', 'Sign in required'));
  next();
}

function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'unauthenticated', 'Sign in required'));
    if (rank(req.user.role) < rank(minRole)) return next(new HttpError(403, 'forbidden', `Requires role ${minRole} or higher`));
    next();
  };
}

const hasRole = (user, minRole) => !!user && rank(user.role) >= rank(minRole);

/**
 * CSRF: every state-changing request must echo the session's CSRF token in
 * X-CSRF-Token. Combined with SameSite=Strict cookies.
 */
function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.session) return next();
  const sent = req.get('x-csrf-token') || '';
  const a = Buffer.from(sent);
  const b = Buffer.from(req.session.csrfToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return next(new HttpError(403, 'csrf_failed', 'Missing or invalid CSRF token'));
  }
  next();
}

module.exports = {
  COOKIE, ROLES, rank, hasRole, parseCookies, setSessionCookie, clearSessionCookie, createSession,
  loadSession, requireAuth, requireRole, requireCsrf,
};
