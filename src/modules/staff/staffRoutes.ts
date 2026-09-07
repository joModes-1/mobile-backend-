import { Router, Request, Response, NextFunction } from 'express';
import argon2 from 'argon2';
import { z } from 'zod';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';
import { authenticate } from '@/middleware/auth';
import { requireRole, getOrgId, getBranchId } from '@/middleware/requireRole';
import { generateTempPassword } from '@/utils/tempPassword';
import { sendStaffTempPasswordEmail } from '@/utils/email';

const router = Router();

// authenticate is applied globally in app.ts

// Role hierarchy: worker < manager < orgadmin < sysadmin
const ROLE_RANK: Record<string, number> = {
  worker: 1,
  manager: 2,
  orgadmin: 3,
};

// Validation schemas
const createStaffSchema = z.object({
  full_name: z.string().min(1),
  username: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  role: z.enum(['orgadmin', 'manager', 'worker']),
  branch_id: z.string().uuid().optional(),
});

const updateStaffSchema = z.object({
  full_name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  role: z.enum(['orgadmin', 'manager', 'worker']).optional(),
  branch_id: z.string().uuid().optional(),
});

const resetPasswordSchema = z.object({});

const setPinSchema = z.object({
  pin: z.string().min(4).max(6),
});

/**
 * POST /staff
 * Create a new staff member
 */
router.post('/', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createStaffSchema.parse(req.body);
    const orgId = getOrgId(req.actor!);
    const pool = getPool();

    // Managers can only create workers in their own branch
    if (req.actor!.role === 'manager') {
      if (data.role !== 'worker') {
        next(createAppError(403, 'FORBIDDEN', 'Managers can only create workers'));
        return;
      }
      if (data.branch_id !== req.actor!.branch_id) {
        next(createAppError(403, 'FORBIDDEN', 'Managers can only create workers in their own branch'));
        return;
      }
    }

    // Orgadmin: if creating orgadmin, no branch_id; otherwise must have branch_id
    if (data.role === 'orgadmin') {
      if (data.branch_id) {
        next(createAppError(400, 'VALIDATION_ERROR', 'Orgadmin cannot have a branch_id'));
        return;
      }
    } else {
      if (!data.branch_id) {
        next(createAppError(400, 'VALIDATION_ERROR', 'Manager and worker must have a branch_id'));
        return;
      }
      // Verify branch belongs to org
      const branchCheck = await pool.query(
        'SELECT id FROM branches WHERE id = $1 AND org_id = $2',
        [data.branch_id, orgId]
      );
      if (branchCheck.rows.length === 0) {
        next(createAppError(404, 'NOT_FOUND', 'Branch not found in your organization'));
        return;
      }
    }

    // Generate temp password
    const tempPassword = generateTempPassword();
    const passwordHash = await argon2.hash(tempPassword);

    const result = await pool.query(
      `INSERT INTO staff_users (org_id, branch_id, role, full_name, username, email, phone, password_hash, must_change_password, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9) RETURNING id`,
      [orgId, data.branch_id || null, data.role, data.full_name, data.username, data.email || null, data.phone || null, passwordHash, req.actor!.sub]
    );

    // Audit
    await pool.query(
      `INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity, entity_id, "after")
       VALUES ($1, 'staff', $2, 'staff.created', 'staff_users', $3, $4)`,
      [orgId, req.actor!.sub, result.rows[0].id, JSON.stringify({ role: data.role, username: data.username })]
    );

    // Best-effort: the staff row is already committed, so a mail failure must
    // not turn a created account into a 500. It previously threw straight out
    // of the handler — the worker existed but the caller saw an error and no
    // password. `emailed` also assumed success from merely having an address.
    let emailed = false;
    if (data.email) {
      try {
        await sendStaffTempPasswordEmail(data.email, data.full_name, data.username, tempPassword, 'created');
        emailed = true;
      } catch (mailErr) {
        console.error(`[email] temp password to ${data.email} failed:`, mailErr);
      }
    }

    res.status(201).json({
      ok: true,
      data: {
        staff_id: result.rows[0].id,
        temp_password: tempPassword,
        emailed,
        message: emailed
          ? 'Staff member created. The temp password has also been emailed to them.'
          : 'Staff member created. No email on file — share the temp password directly. It will not be shown again.',
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /staff
 * List staff members (manager sees own branch only)
 */
router.get('/', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req.actor!);
    const pool = getPool();

    let query = `
      SELECT s.id, s.full_name, s.username, s.email, s.phone, s.role, s.status,
             s.must_change_password, s.last_login_at, s.created_at,
             s.branch_id, b.name as branch_name
      FROM staff_users s
      LEFT JOIN branches b ON s.branch_id = b.id
      WHERE s.org_id = $1
    `;
    const params: any[] = [orgId];

    // Manager sees own branch only
    if (req.actor!.role === 'manager') {
      query += ` AND s.branch_id = $2`;
      params.push(req.actor!.branch_id);
    }

    query += ` ORDER BY s.created_at DESC`;

    const result = await pool.query(query, params);
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /staff/:id
 */
router.get('/:id', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req.actor!);
    const pool = getPool();
    const { id } = req.params;

    const result = await pool.query(
      `SELECT s.id, s.full_name, s.username, s.email, s.phone, s.role, s.status,
              s.must_change_password, s.last_login_at, s.created_at,
              s.branch_id, b.name as branch_name
       FROM staff_users s
       LEFT JOIN branches b ON s.branch_id = b.id
       WHERE s.id = $1 AND s.org_id = $2`,
      [id, orgId]
    );

    if (result.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Staff member not found'));
      return;
    }

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /staff/:id
 */
router.patch('/:id', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateStaffSchema.parse(req.body);
    const orgId = getOrgId(req.actor!);
    const pool = getPool();
    const { id } = req.params;

    // Check target exists in same org
    const existing = await pool.query(
      'SELECT id, role, branch_id FROM staff_users WHERE id = $1 AND org_id = $2',
      [id, orgId]
    );

    if (existing.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Staff member not found'));
      return;
    }

    // Role and branch changes are orgadmin-only
    if ((data.role || data.branch_id) && req.actor!.role !== 'orgadmin') {
      next(createAppError(403, 'FORBIDDEN', 'Only orgadmin can change role or branch'));
      return;
    }

    // Validate role/branch combo
    if (data.role === 'orgadmin' && data.branch_id) {
      next(createAppError(400, 'VALIDATION_ERROR', 'Orgadmin cannot have a branch_id'));
      return;
    }
    if (data.role && data.role !== 'orgadmin' && !data.branch_id && !existing.rows[0].branch_id) {
      next(createAppError(400, 'VALIDATION_ERROR', 'Manager and worker must have a branch_id'));
      return;
    }

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (data.full_name) { updates.push(`full_name = $${paramIndex++}`); values.push(data.full_name); }
    if (data.email !== undefined) { updates.push(`email = $${paramIndex++}`); values.push(data.email); }
    if (data.phone !== undefined) { updates.push(`phone = $${paramIndex++}`); values.push(data.phone); }
    if (data.role) { updates.push(`role = $${paramIndex++}`); values.push(data.role); }
    if (data.branch_id !== undefined) { updates.push(`branch_id = $${paramIndex++}`); values.push(data.branch_id); }

    if (updates.length === 0) {
      next(createAppError(400, 'NO_CHANGES', 'No fields to update'));
      return;
    }

    updates.push(`updated_at = now()`);
    values.push(id, orgId);

    await pool.query(
      `UPDATE staff_users SET ${updates.join(', ')} WHERE id = $${paramIndex++} AND org_id = $${paramIndex}`,
      values
    );

    res.json({ ok: true, data: { message: 'Staff member updated' } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /staff/:id/reset-password
 * Strictly-junior rule: can only reset someone of strictly lower rank
 */
router.post('/:id/reset-password', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req.actor!);
    const pool = getPool();
    const { id } = req.params;

    // Get target
    const targetResult = await pool.query(
      'SELECT id, role, branch_id, full_name, username, email FROM staff_users WHERE id = $1 AND org_id = $2',
      [id, orgId]
    );

    if (targetResult.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Staff member not found'));
      return;
    }

    const target = targetResult.rows[0];
    const callerRank = ROLE_RANK[req.actor!.role!] || 0;
    const targetRank = ROLE_RANK[target.role] || 0;

    // Strictly-junior: target must be strictly lower rank
    if (targetRank >= callerRank) {
      // Audit the refused attempt
      await pool.query(
        `INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity, entity_id, "before")
         VALUES ($1, 'staff', $2, 'staff.reset_password_refused', 'staff_users', $3, $4)`,
        [orgId, req.actor!.sub, id, JSON.stringify({ target_role: target.role, reason: 'insufficient_rank' })]
      );
      next(createAppError(403, 'CANNOT_RESET_PEER_OR_SENIOR', 'Cannot reset password of peer or senior'));
      return;
    }

    // Manager can only reset workers in own branch
    if (req.actor!.role === 'manager' && target.branch_id !== req.actor!.branch_id) {
      await pool.query(
        `INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity, entity_id, "before")
         VALUES ($1, 'staff', $2, 'staff.reset_password_refused', 'staff_users', $3, $4)`,
        [orgId, req.actor!.sub, id, JSON.stringify({ target_role: target.role, reason: 'wrong_branch' })]
      );
      next(createAppError(403, 'CANNOT_RESET_PEER_OR_SENIOR', 'Cannot reset password of staff in another branch'));
      return;
    }

    // Generate temp password
    const tempPassword = generateTempPassword();
    const passwordHash = await argon2.hash(tempPassword);

    await pool.query(
      'UPDATE staff_users SET password_hash = $1, must_change_password = true, updated_at = now() WHERE id = $2',
      [passwordHash, id]
    );

    // Revoke all refresh tokens
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE owner_type = $1 AND owner_id = $2 AND revoked_at IS NULL',
      ['staff', id]
    );

    // Audit
    await pool.query(
      `INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity, entity_id, "after")
       VALUES ($1, 'staff', $2, 'staff.password_reset', 'staff_users', $3, $4)`,
      [orgId, req.actor!.sub, id, JSON.stringify({ target_role: target.role })]
    );

    // Same reasoning as staff creation: the password has already been changed
    // by this point. Throwing here would return a 500 while leaving the user
    // locked out of an account whose new password nobody was ever shown.
    let emailed = false;
    if (target.email) {
      try {
        await sendStaffTempPasswordEmail(target.email, target.full_name, target.username, tempPassword, 'reset');
        emailed = true;
      } catch (mailErr) {
        console.error(`[email] reset password to ${target.email} failed:`, mailErr);
      }
    }

    res.json({
      ok: true,
      data: {
        temp_password: tempPassword,
        emailed,
        message: emailed
          ? 'Password reset. The temp password has also been emailed to them.'
          : 'Password reset. Share the temp password directly. It will not be shown again.',
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /staff/:id/set-pin
 * Manager can set own PIN; orgadmin can set any manager's PIN
 */
router.post('/:id/set-pin', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = setPinSchema.parse(req.body);
    const orgId = getOrgId(req.actor!);
    const pool = getPool();
    const { id } = req.params;

    // Get target
    const targetResult = await pool.query(
      'SELECT id, role, branch_id FROM staff_users WHERE id = $1 AND org_id = $2',
      [id, orgId]
    );

    if (targetResult.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Staff member not found'));
      return;
    }

    const target = targetResult.rows[0];

    // Managers can only set their own PIN
    if (req.actor!.role === 'manager' && id !== req.actor!.sub) {
      next(createAppError(403, 'FORBIDDEN', 'Managers can only set their own PIN'));
      return;
    }

    // Can only set PIN for managers
    if (target.role !== 'manager') {
      next(createAppError(400, 'VALIDATION_ERROR', 'PIN can only be set for managers'));
      return;
    }

    const pinHash = await argon2.hash(data.pin);

    await pool.query(
      'UPDATE staff_users SET pin_hash = $1, updated_at = now() WHERE id = $2',
      [pinHash, id]
    );

    // Audit
    await pool.query(
      `INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity, entity_id)
       VALUES ($1, 'staff', $2, 'staff.pin_set', 'staff_users', $3)`,
      [orgId, req.actor!.sub, id]
    );

    res.json({ ok: true, data: { message: 'PIN set successfully' } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /staff/:id/suspend
 */
router.post('/:id/suspend', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req.actor!);
    const pool = getPool();
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE staff_users SET status = 'suspended', updated_at = now()
       WHERE id = $1 AND org_id = $2 AND status = 'active' RETURNING id`,
      [id, orgId]
    );

    if (result.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Staff member not found or already suspended'));
      return;
    }

    res.json({ ok: true, data: { message: 'Staff member suspended' } });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /staff/:id/activate
 */
router.post('/:id/activate', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req.actor!);
    const pool = getPool();
    const { id } = req.params;

    const result = await pool.query(
      `UPDATE staff_users SET status = 'active', updated_at = now()
       WHERE id = $1 AND org_id = $2 AND status = 'suspended' RETURNING id`,
      [id, orgId]
    );

    if (result.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Staff member not found or already active'));
      return;
    }

    res.json({ ok: true, data: { message: 'Staff member activated' } });
  } catch (err) {
    next(err);
  }
});

export default router;
