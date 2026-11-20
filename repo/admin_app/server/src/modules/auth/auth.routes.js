'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const { query } = require('../../db/pool');
const { verifyPassword, burnTime } = require('../../auth/passwords');
const { createSession, setSessionCookie, clearSessionCookie, requireAuth } = require('../../middleware/session');
const { safeAudit } = require('../audit/audit.service');
const { HttpError, asyncRoute } = require('../../lib/util');

const router = express.Router();

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate_limited', message: 'Too many sign-in attempts. Try again later.' },
});

const LoginBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
});

router.post(
  '/login',
  loginLimiter,
  asyncRoute(async (req, res) => {
    const { email, password } = LoginBody.parse(req.body);
    const { rows } = await query('SELECT id, email, role, password_hash, disabled, failed_logins, locked_until FROM admin_users WHERE lower(email) = lower($1)', [email]);
    const user = rows[0];
    const generic = new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');

    if (!user) {
      await burnTime(password);
      await safeAudit({ req, action: 'login.failed', outcome: 'failure', detail: { email, reason: 'unknown_user' } });
      throw generic;
    }
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await safeAudit({ req, actor: user, action: 'login.failed', outcome: 'denied', detail: { reason: 'locked' } });
      throw new HttpError(423, 'account_locked', `Account locked after ${MAX_FAILED} failed attempts. Try again later.`);
    }
    const ok = await verifyPassword(password, user.password_hash);
    if (!ok || user.disabled) {
      if (!ok) {
        await query(
          `UPDATE admin_users SET failed_logins = failed_logins + 1,
             locked_until = CASE WHEN failed_logins + 1 >= $2 THEN NOW() + ($3 || ' minutes')::interval ELSE locked_until END
           WHERE id = $1`,
          [user.id, MAX_FAILED, String(LOCK_MINUTES)]
        );
      }
      await safeAudit({ req, actor: user, action: 'login.failed', outcome: 'failure', detail: { reason: ok ? 'disabled' : 'bad_password' } });
      throw generic;
    }

    await query('UPDATE admin_users SET failed_logins = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1', [user.id]);
    const { token, csrfToken } = await createSession(user.id, req);
    setSessionCookie(res, token);
    await safeAudit({ req, actor: user, action: 'login', outcome: 'success' });
    res.json({ user: { id: user.id, email: user.email, role: user.role }, csrfToken });
  })
);

router.post(
  '/logout',
  asyncRoute(async (req, res) => {
    if (req.session) {
      await query('UPDATE admin_sessions SET revoked_at = NOW() WHERE id = $1', [req.session.id]);
      await safeAudit({ req, actor: req.user, action: 'logout', outcome: 'success' });
    }
    clearSessionCookie(res);
    res.status(204).end();
  })
);

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user, csrfToken: req.session.csrfToken });
});

module.exports = router;
