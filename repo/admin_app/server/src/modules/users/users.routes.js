'use strict';

const express = require('express');
const { z } = require('zod');
const { query } = require('../../db/pool');
const { hashPassword, checkPasswordPolicy } = require('../../auth/passwords');
const { requireRole, ROLES } = require('../../middleware/session');
const { safeAudit } = require('../audit/audit.service');
const { HttpError, asyncRoute } = require('../../lib/util');

const router = express.Router();
router.use(requireRole('superadmin'));

const Role = z.enum(ROLES);

router.get(
  '/',
  asyncRoute(async (req, res) => {
    const { rows } = await query(
      'SELECT id, email, role, disabled, created_at, last_login_at, locked_until FROM admin_users ORDER BY lower(email)'
    );
    res.json({ users: rows });
  })
);

const CreateBody = z.object({ email: z.string().email().max(254), role: Role, password: z.string() });

router.post(
  '/',
  asyncRoute(async (req, res) => {
    const body = CreateBody.parse(req.body);
    const problem = checkPasswordPolicy(body.password);
    if (problem) throw new HttpError(400, 'weak_password', problem);
    try {
      const { rows } = await query(
        'INSERT INTO admin_users (email, role, password_hash) VALUES ($1, $2, $3) RETURNING id, email, role, disabled, created_at',
        [body.email, body.role, await hashPassword(body.password)]
      );
      await safeAudit({ req, actor: req.user, action: 'user.create', detail: { email: body.email, role: body.role } });
      res.status(201).json({ user: rows[0] });
    } catch (err) {
      if (err.code === '23505') throw new HttpError(409, 'email_taken', 'A user with that email already exists');
      throw err;
    }
  })
);

const PatchBody = z
  .object({ role: Role.optional(), disabled: z.boolean().optional(), password: z.string().optional() })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

router.patch(
  '/:id',
  asyncRoute(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = PatchBody.parse(req.body);
    if (id === req.user.id && (body.disabled === true || (body.role && body.role !== 'superadmin'))) {
      throw new HttpError(400, 'self_lockout', 'You cannot disable or demote your own account');
    }
    const sets = [];
    const params = [id];
    if (body.role) { params.push(body.role); sets.push(`role = $${params.length}`); }
    if (body.disabled !== undefined) { params.push(body.disabled); sets.push(`disabled = $${params.length}`); }
    if (body.password !== undefined) {
      const problem = checkPasswordPolicy(body.password);
      if (problem) throw new HttpError(400, 'weak_password', problem);
      params.push(await hashPassword(body.password));
      sets.push(`password_hash = $${params.length}`, 'failed_logins = 0', 'locked_until = NULL');
    }
    const { rows } = await query(`UPDATE admin_users SET ${sets.join(', ')} WHERE id = $1 RETURNING id, email, role, disabled`, params);
    if (!rows[0]) throw new HttpError(404, 'not_found', 'User not found');
    // Any security-relevant change ends the user's existing sessions.
    await query('UPDATE admin_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    await safeAudit({
      req, actor: req.user, action: 'user.update',
      detail: { email: rows[0].email, role: body.role, disabled: body.disabled, passwordReset: body.password !== undefined },
    });
    res.json({ user: rows[0] });
  })
);

module.exports = router;
