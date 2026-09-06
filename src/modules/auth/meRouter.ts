import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';
import { authenticate } from '@/middleware/auth';

const router = Router();

const updateMeSchema = z.object({
  full_name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  phone: z.string().min(1).optional(),
});

/**
 * GET /me
 * Returns current user info based on token type
 */
router.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const actor = req.actor!;

    if (actor.type === 'platform') {
      const result = await pool.query(
        'SELECT id, full_name, username, email, phone, status, must_change_password, last_login_at FROM platform_admins WHERE id = $1',
        [actor.sub]
      );
      if (result.rows.length === 0) {
        next(createAppError(404, 'NOT_FOUND', 'Admin not found'));
        return;
      }
      res.json({ ok: true, data: { ...result.rows[0], type: 'platform', role: 'sysadmin' } });
    } else if (actor.type === 'staff') {
      const result = await pool.query(
        `SELECT s.id, s.full_name, s.username, s.email, s.phone, s.role, s.status, s.must_change_password,
                s.branch_id, s.org_id, b.name as branch_name, o.name as org_name
         FROM staff_users s
         LEFT JOIN branches b ON s.branch_id = b.id
         JOIN organizations o ON s.org_id = o.id
         WHERE s.id = $1`,
        [actor.sub]
      );
      if (result.rows.length === 0) {
        next(createAppError(404, 'NOT_FOUND', 'Staff not found'));
        return;
      }
      res.json({ ok: true, data: result.rows[0] });
    } else if (actor.type === 'client') {
      const result = await pool.query(
        'SELECT id, full_name, username, email, email_verified, member_code, status FROM clients WHERE id = $1',
        [actor.sub]
      );
      if (result.rows.length === 0) {
        next(createAppError(404, 'NOT_FOUND', 'Client not found'));
        return;
      }
      res.json({ ok: true, data: { ...result.rows[0], type: 'client' } });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /me
 * Self-service profile update (full_name, email, phone) for any actor type.
 */
router.patch('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateMeSchema.parse(req.body);
    const pool = getPool();
    const actor = req.actor!;

    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;
    if (data.full_name !== undefined) { updates.push(`full_name = $${idx++}`); values.push(data.full_name); }
    if (data.email !== undefined) { updates.push(`email = $${idx++}`); values.push(data.email); }
    if (data.phone !== undefined) { updates.push(`phone = $${idx++}`); values.push(data.phone); }

    if (updates.length === 0) {
      next(createAppError(400, 'NO_CHANGES', 'No fields to update'));
      return;
    }
    updates.push(`updated_at = now()`);
    values.push(actor.sub);

    const table = actor.type === 'platform' ? 'platform_admins' : actor.type === 'staff' ? 'staff_users' : 'clients';

    if (data.email !== undefined) {
      const existing = await pool.query(
        `SELECT id FROM ${table} WHERE lower(email) = lower($1) AND id <> $2`,
        [data.email, actor.sub]
      );
      if (existing.rows.length > 0) {
        next(createAppError(409, 'EMAIL_EXISTS', 'Email already in use'));
        return;
      }
    }

    try {
      await pool.query(`UPDATE ${table} SET ${updates.join(', ')} WHERE id = $${idx}`, values);
    } catch (err: any) {
      if (err.code === '23505') {
        next(createAppError(409, 'EMAIL_EXISTS', 'Email already in use'));
        return;
      }
      throw err;
    }

    res.json({ ok: true, data: { message: 'Profile updated' } });
  } catch (err) {
    next(err);
  }
});

export default router;
