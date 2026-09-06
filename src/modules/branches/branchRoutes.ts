import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';
import { authenticate } from '@/middleware/auth';
import { requireRole, getOrgId } from '@/middleware/requireRole';

const router = Router();

// authenticate is applied globally in app.ts

const createBranchSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1).max(10),
  address: z.string().optional(),
  phone: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  ready_alert_minutes: z.number().min(1).optional(),
});

const updateBranchSchema = z.object({
  name: z.string().min(1).optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  ready_alert_minutes: z.number().min(1).optional(),
});

/**
 * POST /branches
 * Create a new branch (orgadmin only)
 */
router.post('/', requireRole('orgadmin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createBranchSchema.parse(req.body);
    const orgId = getOrgId(req.actor!);
    const pool = getPool();

    // Check unique code within org (case-insensitive)
    const codeCheck = await pool.query(
      'SELECT id FROM branches WHERE org_id = $1 AND upper(code) = upper($2)',
      [orgId, data.code]
    );
    if (codeCheck.rows.length > 0) {
      next(createAppError(409, 'DUPLICATE_CODE', 'Branch code already exists in this organization'));
      return;
    }

    const result = await pool.query(
      `INSERT INTO branches (org_id, name, code, address, phone, latitude, longitude, ready_alert_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [orgId, data.name, data.code, data.address || null, data.phone || null, data.latitude || null, data.longitude || null, data.ready_alert_minutes || 120]
    );

    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /branches
 * List branches (orgadmin sees all in org, manager sees own branch)
 */
router.get('/', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req.actor!);
    const pool = getPool();

    let query = `
      SELECT b.id, b.name, b.code, b.address, b.phone, b.latitude, b.longitude,
             b.ready_alert_minutes, b.status, b.created_at,
             (SELECT COUNT(*) FROM staff_users WHERE branch_id = b.id) as staff_count
      FROM branches b
      WHERE b.org_id = $1
    `;
    const params: any[] = [orgId];

    // Manager sees own branch only
    if (req.actor!.role === 'manager') {
      query += ` AND b.id = $2`;
      params.push(req.actor!.branch_id);
    }

    query += ` ORDER BY b.name`;

    const result = await pool.query(query, params);
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /branches/:id
 */
router.get('/:id', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req.actor!);
    const pool = getPool();
    const { id } = req.params;

    const result = await pool.query(
      `SELECT b.id, b.name, b.code, b.address, b.phone, b.latitude, b.longitude,
              b.ready_alert_minutes, b.status, b.created_at,
              (SELECT COUNT(*) FROM staff_users WHERE branch_id = b.id) as staff_count
       FROM branches b
       WHERE b.id = $1 AND b.org_id = $2`,
      [id, orgId]
    );

    if (result.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Branch not found'));
      return;
    }

    // Manager can only see own branch
    if (req.actor!.role === 'manager' && id !== req.actor!.branch_id) {
      next(createAppError(403, 'FORBIDDEN', 'Cannot access branches outside your scope'));
      return;
    }

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /branches/:id
 * Update branch (orgadmin only)
 */
router.patch('/:id', requireRole('orgadmin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateBranchSchema.parse(req.body);
    const orgId = getOrgId(req.actor!);
    const pool = getPool();
    const { id } = req.params;

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (data.name) { updates.push(`name = $${paramIndex++}`); values.push(data.name); }
    if (data.address !== undefined) { updates.push(`address = $${paramIndex++}`); values.push(data.address); }
    if (data.phone !== undefined) { updates.push(`phone = $${paramIndex++}`); values.push(data.phone); }
    if (data.latitude !== undefined) { updates.push(`latitude = $${paramIndex++}`); values.push(data.latitude); }
    if (data.longitude !== undefined) { updates.push(`longitude = $${paramIndex++}`); values.push(data.longitude); }
    if (data.ready_alert_minutes) { updates.push(`ready_alert_minutes = $${paramIndex++}`); values.push(data.ready_alert_minutes); }

    if (updates.length === 0) {
      next(createAppError(400, 'NO_CHANGES', 'No fields to update'));
      return;
    }

    updates.push(`updated_at = now()`);
    values.push(id, orgId);

    const result = await pool.query(
      `UPDATE branches SET ${updates.join(', ')} WHERE id = $${paramIndex++} AND org_id = $${paramIndex} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Branch not found'));
      return;
    }

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

export default router;
