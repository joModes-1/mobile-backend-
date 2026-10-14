import { Router, Request, Response, NextFunction } from 'express';
import argon2 from 'argon2';
import { z } from 'zod';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';
import { authenticate } from '@/middleware/auth';
import { requireRole, getOrgId, getBranchId } from '@/middleware/requireRole';
import { normalizeUgPhone, displayUgPhone } from '@/utils/sms';

const router = Router();

// authenticate is applied globally in app.ts

// Validation schemas
//
// Phone is how staff actually sign in (phone + OTP), so it is required on
// creation and carries the uniqueness. Username stays as the internal
// handle shown in listings and audit entries; email is optional contact
// detail only — nothing is sent to it.
const createStaffSchema = z.object({
  full_name: z.string().min(1),
  username: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().min(9),
  role: z.enum(['orgadmin', 'manager', 'worker']),
  branch_id: z.string().uuid().optional(),
});

const updateStaffSchema = z.object({
  full_name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().min(9).optional(),
  role: z.enum(['orgadmin', 'manager', 'worker']).optional(),
  branch_id: z.string().uuid().optional(),
});

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

    // Phone is the sign-in identity, so it has to be stored in the same
    // canonical form the login path normalises to — otherwise the account
    // exists but the number never matches at sign-in.
    const phone = normalizeUgPhone(data.phone);
    if (!phone) {
      next(createAppError(422, 'INVALID_PHONE', 'Enter a valid Ugandan mobile number'));
      return;
    }

    // One number, one account — across every org and role, since phone
    // login resolves a number without knowing which org it belongs to.
    const phoneTaken = await pool.query('SELECT id FROM staff_users WHERE phone = $1 LIMIT 1', [phone]);
    if (phoneTaken.rows.length > 0) {
      next(createAppError(409, 'PHONE_TAKEN', 'Another staff member already uses this number'));
      return;
    }

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

    // No password and nothing emailed: staff sign in with their phone and a
    // one-time code. `must_change_password` is false because there is no
    // password to change — leaving it true would send them straight to the
    // change-password screen on first sign-in with nothing to enter.
    const result = await pool.query(
      `INSERT INTO staff_users (org_id, branch_id, role, full_name, username, email, phone, password_hash, must_change_password, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, false, $8) RETURNING id`,
      [orgId, data.branch_id || null, data.role, data.full_name, data.username, data.email || null, phone, req.actor!.sub]
    );

    // Audit
    await pool.query(
      `INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity, entity_id, "after")
       VALUES ($1, 'staff', $2, 'staff.created', 'staff_users', $3, $4)`,
      [orgId, req.actor!.sub, result.rows[0].id, JSON.stringify({ role: data.role, username: data.username })]
    );

    res.status(201).json({
      ok: true,
      data: {
        staff_id: result.rows[0].id,
        phone,
        phone_display: displayUgPhone(phone),
        message: `Staff member created. They sign in with ${displayUgPhone(phone)} and the code sent to that phone.`,
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

    // Same normalisation and uniqueness as creation — a phone edited to a
    // raw local form here would silently stop working as a sign-in.
    let normalizedPhone: string | undefined;
    if (data.phone !== undefined) {
      const p = normalizeUgPhone(data.phone);
      if (!p) {
        next(createAppError(422, 'INVALID_PHONE', 'Enter a valid Ugandan mobile number'));
        return;
      }
      const taken = await pool.query(
        'SELECT id FROM staff_users WHERE phone = $1 AND id <> $2 LIMIT 1',
        [p, id]
      );
      if (taken.rows.length > 0) {
        next(createAppError(409, 'PHONE_TAKEN', 'Another staff member already uses this number'));
        return;
      }
      normalizedPhone = p;
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
    if (normalizedPhone !== undefined) { updates.push(`phone = $${paramIndex++}`); values.push(normalizedPhone); }
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
