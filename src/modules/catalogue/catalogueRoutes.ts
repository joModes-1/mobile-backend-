import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';
import { requireRole, getOrgId } from '@/middleware/requireRole';

const router = Router();

// --- Vehicle Classes ---

const createVehicleClassSchema = z.object({
  name: z.string().min(1),
  sort_order: z.number().int().min(0).default(0),
});

const updateVehicleClassSchema = z.object({
  name: z.string().min(1).optional(),
  sort_order: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
});

/**
 * GET /vehicle-classes
 */
router.get('/vehicle-classes', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req.actor!);
    const pool = getPool();

    const result = await pool.query(
      `SELECT id, name, sort_order, active, created_at
       FROM vehicle_classes WHERE org_id = $1 ORDER BY sort_order, name`,
      [orgId]
    );

    res.json({ ok: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /vehicle-classes
 */
router.post('/vehicle-classes', requireRole('orgadmin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createVehicleClassSchema.parse(req.body);
    const orgId = getOrgId(req.actor!);
    const pool = getPool();

    // Check unique name within org
    const existing = await pool.query(
      'SELECT id FROM vehicle_classes WHERE org_id = $1 AND lower(name) = lower($2)',
      [orgId, data.name]
    );
    if (existing.rows.length > 0) {
      next(createAppError(409, 'DUPLICATE_NAME', 'Vehicle class name already exists'));
      return;
    }

    const result = await pool.query(
      `INSERT INTO vehicle_classes (org_id, name, sort_order)
       VALUES ($1, $2, $3) RETURNING *`,
      [orgId, data.name, data.sort_order]
    );

    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /vehicle-classes/:id
 */
router.patch('/vehicle-classes/:id', requireRole('orgadmin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateVehicleClassSchema.parse(req.body);
    const orgId = getOrgId(req.actor!);
    const pool = getPool();
    const { id } = req.params;

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (data.name) { updates.push(`name = $${paramIndex++}`); values.push(data.name); }
    if (data.sort_order !== undefined) { updates.push(`sort_order = $${paramIndex++}`); values.push(data.sort_order); }
    if (data.active !== undefined) { updates.push(`active = $${paramIndex++}`); values.push(data.active); }

    if (updates.length === 0) {
      next(createAppError(400, 'NO_CHANGES', 'No fields to update'));
      return;
    }

    values.push(id, orgId);
    const result = await pool.query(
      `UPDATE vehicle_classes SET ${updates.join(', ')} WHERE id = $${paramIndex++} AND org_id = $${paramIndex} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Vehicle class not found'));
      return;
    }

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// --- Services ---

const createServiceSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  is_default: z.boolean().default(false),
  earns_point: z.boolean().default(true),
});

const updateServiceSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  is_default: z.boolean().optional(),
  earns_point: z.boolean().optional(),
  active: z.boolean().optional(),
});

/**
 * GET /services
 */
router.get('/services', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req.actor!);
    const pool = getPool();

    const result = await pool.query(
      `SELECT id, name, description, is_default, earns_point, active, created_at
       FROM services WHERE org_id = $1 ORDER BY name`,
      [orgId]
    );

    res.json({ ok: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /services
 */
router.post('/services', requireRole('orgadmin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createServiceSchema.parse(req.body);
    const orgId = getOrgId(req.actor!);
    const pool = getPool();

    // Check unique name
    const existing = await pool.query(
      'SELECT id FROM services WHERE org_id = $1 AND lower(name) = lower($2)',
      [orgId, data.name]
    );
    if (existing.rows.length > 0) {
      next(createAppError(409, 'DUPLICATE_NAME', 'Service name already exists'));
      return;
    }

    // If setting as default, clear existing default in same transaction
    if (data.is_default) {
      await pool.query(
        'UPDATE services SET is_default = false WHERE org_id = $1 AND is_default = true',
        [orgId]
      );
    }

    const result = await pool.query(
      `INSERT INTO services (org_id, name, description, is_default, earns_point)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [orgId, data.name, data.description || null, data.is_default, data.earns_point]
    );

    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /services/:id
 */
router.patch('/services/:id', requireRole('orgadmin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateServiceSchema.parse(req.body);
    const orgId = getOrgId(req.actor!);
    const pool = getPool();
    const { id } = req.params;

    // If setting as default, clear existing default in same transaction
    if (data.is_default === true) {
      await pool.query(
        'UPDATE services SET is_default = false WHERE org_id = $1 AND is_default = true AND id != $2',
        [orgId, id]
      );
    }

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (data.name) { updates.push(`name = $${paramIndex++}`); values.push(data.name); }
    if (data.description !== undefined) { updates.push(`description = $${paramIndex++}`); values.push(data.description); }
    if (data.is_default !== undefined) { updates.push(`is_default = $${paramIndex++}`); values.push(data.is_default); }
    if (data.earns_point !== undefined) { updates.push(`earns_point = $${paramIndex++}`); values.push(data.earns_point); }
    if (data.active !== undefined) { updates.push(`active = $${paramIndex++}`); values.push(data.active); }

    if (updates.length === 0) {
      next(createAppError(400, 'NO_CHANGES', 'No fields to update'));
      return;
    }

    values.push(id, orgId);
    const result = await pool.query(
      `UPDATE services SET ${updates.join(', ')} WHERE id = $${paramIndex++} AND org_id = $${paramIndex} RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Service not found'));
      return;
    }

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

export default router;
