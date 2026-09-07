import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';
import { requireRole, getOrgId } from '@/middleware/requireRole';
import { catalogueScope, catalogueWriteBranch, assertCanEditCatalogueRow } from './scope';

const router = Router();

// --- Vehicle Classes ---

const createVehicleClassSchema = z.object({
  name: z.string().min(1),
  sort_order: z.number().int().min(0).default(0),
  // Org admins may target a specific branch; managers may not (their own
  // branch is taken from the token) — see catalogueWriteBranch.
  branch_id: z.string().uuid().nullable().optional(),
});

const updateVehicleClassSchema = z.object({
  name: z.string().min(1).optional(),
  sort_order: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
});

/**
 * GET /vehicle-classes?branch_id=
 *
 * Returns org-wide types plus the caller's branch-specific ones. A manager
 * always gets their own branch regardless of the query string.
 */
router.get('/vehicle-classes', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req.actor!);
    const pool = getPool();

    const scope = catalogueScope(req.actor!, req.query.branch_id as string | undefined, 'vc', 2);

    const result = await pool.query(
      `SELECT vc.id, vc.name, vc.sort_order, vc.active, vc.created_at, vc.branch_id,
              b.name AS branch_name
       FROM vehicle_classes vc
       LEFT JOIN branches b ON b.id = vc.branch_id
       WHERE vc.org_id = $1${scope.sql}
       ORDER BY vc.sort_order, vc.name`,
      [orgId, ...scope.params]
    );

    res.json({ ok: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /vehicle-classes
 */
router.post('/vehicle-classes', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createVehicleClassSchema.parse(req.body);
    const orgId = getOrgId(req.actor!);
    const pool = getPool();

    const branchId = catalogueWriteBranch(req.actor!, data.branch_id);

    // Name has to be unique within its own scope, and must also not collide
    // with a shared org-wide type — a branch "SUV" sitting alongside an
    // org-wide "SUV" would show up twice in the same picker.
    const clash = await pool.query(
      `SELECT id, branch_id FROM vehicle_classes
       WHERE org_id = $1 AND lower(name) = lower($2)
         AND (branch_id IS NULL OR branch_id = $3)`,
      [orgId, data.name, branchId]
    );
    if (clash.rows.length > 0) {
      const shared = clash.rows.some((r: any) => r.branch_id === null);
      next(createAppError(
        409,
        'DUPLICATE_NAME',
        shared && branchId
          ? 'A car type with that name already exists for the whole organisation'
          : 'Car type name already exists'
      ));
      return;
    }

    const result = await pool.query(
      `INSERT INTO vehicle_classes (org_id, branch_id, name, sort_order)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [orgId, branchId, data.name, data.sort_order]
    );

    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /vehicle-classes/:id
 */
router.patch('/vehicle-classes/:id', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateVehicleClassSchema.parse(req.body);
    const orgId = getOrgId(req.actor!);
    const pool = getPool();
    const id = String(req.params.id);

    // Load first so a manager cannot edit a shared row or another branch's.
    const existing = await pool.query(
      'SELECT id, branch_id FROM vehicle_classes WHERE id = $1 AND org_id = $2',
      [id, orgId]
    );
    if (existing.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Car type not found'));
      return;
    }
    assertCanEditCatalogueRow(req.actor!, existing.rows[0]);

    if (data.name) {
      const clash = await pool.query(
        `SELECT id FROM vehicle_classes
         WHERE org_id = $1 AND lower(name) = lower($2) AND id <> $3
           AND (branch_id IS NULL OR branch_id = $4)`,
        [orgId, data.name, id, existing.rows[0].branch_id]
      );
      if (clash.rows.length > 0) {
        next(createAppError(409, 'DUPLICATE_NAME', 'Car type name already exists'));
        return;
      }
    }

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
  branch_id: z.string().uuid().nullable().optional(),
});

const updateServiceSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  is_default: z.boolean().optional(),
  earns_point: z.boolean().optional(),
  active: z.boolean().optional(),
});

/**
 * Demote whatever is currently the default in this scope.
 *
 * `is_default` is unique per scope (org-wide vs per-branch), so clearing the
 * old default has to match the same scope — clearing org-wide defaults when
 * promoting a branch service would knock out every other branch's fallback.
 * Builds its own placeholders rather than assuming a caller's param order.
 */
async function demoteCurrentDefault(
  client: { query: (sql: string, params: any[]) => Promise<any> },
  orgId: string,
  branchId: string | null,
  exceptId?: string
): Promise<void> {
  const params: any[] = [orgId];
  let sql = `UPDATE services SET is_default = false WHERE org_id = $1 AND is_default = true`;

  if (branchId === null) {
    sql += ` AND branch_id IS NULL`;
  } else {
    params.push(branchId);
    sql += ` AND branch_id = $${params.length}`;
  }

  if (exceptId) {
    params.push(exceptId);
    sql += ` AND id <> $${params.length}`;
  }

  await client.query(sql, params);
}

/**
 * GET /services?branch_id=
 */
router.get('/services', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req.actor!);
    const pool = getPool();

    const scope = catalogueScope(req.actor!, req.query.branch_id as string | undefined, 's', 2);

    const result = await pool.query(
      `SELECT s.id, s.name, s.description, s.is_default, s.earns_point, s.active,
              s.created_at, s.branch_id, b.name AS branch_name
       FROM services s
       LEFT JOIN branches b ON b.id = s.branch_id
       WHERE s.org_id = $1${scope.sql}
       ORDER BY s.name`,
      [orgId, ...scope.params]
    );

    res.json({ ok: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /services
 */
router.post('/services', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = createServiceSchema.parse(req.body);
    const orgId = getOrgId(req.actor!);
    const pool = getPool();

    const branchId = catalogueWriteBranch(req.actor!, data.branch_id);

    const clash = await pool.query(
      `SELECT id, branch_id FROM services
       WHERE org_id = $1 AND lower(name) = lower($2)
         AND (branch_id IS NULL OR branch_id = $3)`,
      [orgId, data.name, branchId]
    );
    if (clash.rows.length > 0) {
      const shared = clash.rows.some((r: any) => r.branch_id === null);
      next(createAppError(
        409,
        'DUPLICATE_NAME',
        shared && branchId
          ? 'A wash type with that name already exists for the whole organisation'
          : 'Wash type name already exists'
      ));
      return;
    }

    // Clearing the previous default and inserting the new one have to be
    // atomic: previously these were two separate pool queries, so a failure
    // between them left the scope with no default service at all and every
    // wash started without an explicit service would 422.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (data.is_default) {
        await demoteCurrentDefault(client, orgId, branchId);
      }

      const result = await client.query(
        `INSERT INTO services (org_id, branch_id, name, description, is_default, earns_point)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [orgId, branchId, data.name, data.description || null, data.is_default, data.earns_point]
      );

      await client.query('COMMIT');
      res.status(201).json({ ok: true, data: result.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /services/:id
 */
router.patch('/services/:id', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = updateServiceSchema.parse(req.body);
    const orgId = getOrgId(req.actor!);
    const pool = getPool();
    const id = String(req.params.id);

    const existing = await pool.query(
      'SELECT id, branch_id FROM services WHERE id = $1 AND org_id = $2',
      [id, orgId]
    );
    if (existing.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Wash type not found'));
      return;
    }
    assertCanEditCatalogueRow(req.actor!, existing.rows[0]);
    const rowBranchId: string | null = existing.rows[0].branch_id;

    if (data.name) {
      const clash = await pool.query(
        `SELECT id FROM services
         WHERE org_id = $1 AND lower(name) = lower($2) AND id <> $3
           AND (branch_id IS NULL OR branch_id = $4)`,
        [orgId, data.name, id, rowBranchId]
      );
      if (clash.rows.length > 0) {
        next(createAppError(409, 'DUPLICATE_NAME', 'Wash type name already exists'));
        return;
      }
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

    // Same atomicity point as POST: demoting the old default and promoting
    // this one are one change, not two.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (data.is_default === true) {
        await demoteCurrentDefault(client, orgId, rowBranchId, id);
      }

      values.push(id, orgId);
      const result = await client.query(
        `UPDATE services SET ${updates.join(', ')} WHERE id = $${paramIndex++} AND org_id = $${paramIndex} RETURNING *`,
        values
      );

      await client.query('COMMIT');
      res.json({ ok: true, data: result.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

export default router;
