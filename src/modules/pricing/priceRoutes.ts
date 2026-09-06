import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';
import { requireRole, getOrgId } from '@/middleware/requireRole';

const router = Router();

// --- Validation schemas ---

const upsertPriceSchema = z.object({
  service_id: z.string().uuid(),
  vehicle_class_id: z.string().uuid(),
  branch_id: z.string().uuid().optional(), // undefined = org-wide
  price_ugx: z.number().int().min(0),
});

const bulkPriceSchema = z.object({
  prices: z.array(upsertPriceSchema).min(1),
});

// --- GET /prices — the management matrix ---

/**
 * GET /prices?branch_id=
 * Returns the full price matrix with org/branch/effective prices
 */
router.get('/', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req.actor!);
    const pool = getPool();
    const branchId = req.query.branch_id as string | undefined;

    // Get services and vehicle classes
    const services = await pool.query(
      'SELECT id, name, is_default FROM services WHERE org_id = $1 AND active ORDER BY name',
      [orgId]
    );
    const vehicleClasses = await pool.query(
      'SELECT id, name, sort_order FROM vehicle_classes WHERE org_id = $1 AND active ORDER BY sort_order, name',
      [orgId]
    );

    // Get all active prices for this org
    const prices = await pool.query(
      `SELECT p.id, p.service_id, p.vehicle_class_id, p.branch_id, p.price_ugx, p.updated_at,
              s.full_name as updated_by_name
       FROM prices p
       LEFT JOIN staff_users s ON p.updated_by = s.id
       WHERE p.org_id = $1 AND p.active`,
      [orgId]
    );

    // Build matrix: for each (service, car_type) combination
    const matrix: any[] = [];
    const missing: any[] = [];

    for (const svc of services.rows) {
      for (const vc of vehicleClasses.rows) {
        // Find org-wide price (branch_id IS NULL)
        const orgPrice = prices.rows.find(
          (p: any) => p.service_id === svc.id && p.vehicle_class_id === vc.id && p.branch_id === null
        );

        // Find branch-specific override
        const branchPrice = branchId
          ? prices.rows.find(
              (p: any) => p.service_id === svc.id && p.vehicle_class_id === vc.id && p.branch_id === branchId
            )
          : undefined;

        if (branchPrice) {
          matrix.push({
            service_id: svc.id,
            vehicle_class_id: vc.id,
            org_price_ugx: orgPrice ? Number(orgPrice.price_ugx) : null,
            branch_price_ugx: Number(branchPrice.price_ugx),
            effective_price_ugx: Number(branchPrice.price_ugx),
            source: 'branch_override',
            updated_by: branchPrice.updated_by_name,
            updated_at: branchPrice.updated_at,
          });
        } else if (orgPrice) {
          matrix.push({
            service_id: svc.id,
            vehicle_class_id: vc.id,
            org_price_ugx: Number(orgPrice.price_ugx),
            branch_price_ugx: null,
            effective_price_ugx: Number(orgPrice.price_ugx),
            source: 'org_default',
            updated_by: orgPrice.updated_by_name,
            updated_at: orgPrice.updated_at,
          });
        } else {
          missing.push({
            service_id: svc.id,
            vehicle_class_id: vc.id,
            reason: 'no price set',
          });
        }
      }
    }

    res.json({
      ok: true,
      data: {
        services: services.rows,
        vehicle_classes: vehicleClasses.rows,
        matrix,
        missing,
      },
    });
  } catch (err) {
    next(err);
  }
});

// --- GET /prices/effective — what the worker app calls ---

/**
 * GET /prices/effective?branch_id=&vehicle_class_id=
 * Returns prices nested by car type, with has_price flag
 */
router.get('/effective', requireRole('orgadmin', 'manager', 'worker'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req.actor!);
    const pool = getPool();
    const branchId = (req.query.branch_id as string) || req.actor!.branch_id;
    const vehicleClassId = req.query.vehicle_class_id as string | undefined;

    if (!branchId) {
      next(createAppError(400, 'BRANCH_REQUIRED', 'branch_id is required'));
      return;
    }

    // Get vehicle classes
    let vcQuery = 'SELECT id, name, sort_order FROM vehicle_classes WHERE org_id = $1 AND active ORDER BY sort_order, name';
    const vcParams: any[] = [orgId];
    if (vehicleClassId) {
      vcQuery += ' AND id = $2';
      vcParams.push(vehicleClassId);
    }
    const vehicleClasses = await pool.query(vcQuery, vcParams);

    // Get active services
    const services = await pool.query(
      'SELECT id, name FROM services WHERE org_id = $1 AND active ORDER BY name',
      [orgId]
    );

    // Get all prices for this org
    const prices = await pool.query(
      `SELECT service_id, vehicle_class_id, branch_id, price_ugx
       FROM prices WHERE org_id = $1 AND active`,
      [orgId]
    );

    // Build nested response
    const result = vehicleClasses.rows.map((vc: any) => ({
      id: vc.id,
      name: vc.name,
      sort_order: vc.sort_order,
      services: services.rows.map((svc: any) => {
        // Find branch override first
        const branchPrice = prices.rows.find(
          (p: any) => p.service_id === svc.id && p.vehicle_class_id === vc.id && p.branch_id === branchId
        );
        // Fall back to org default
        const orgPrice = prices.rows.find(
          (p: any) => p.service_id === svc.id && p.vehicle_class_id === vc.id && p.branch_id === null
        );
        const price = branchPrice || orgPrice;
        return {
          id: svc.id,
          name: svc.name,
          price_ugx: price ? Number(price.price_ugx) : null,
          has_price: !!price,
        };
      }),
    }));

    res.json({ ok: true, data: { vehicle_classes: result } });
  } catch (err) {
    next(err);
  }
});

// --- PUT /prices — upsert org-wide price ---

router.put('/', requireRole('orgadmin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = upsertPriceSchema.parse(req.body);
    const orgId = getOrgId(req.actor!);
    const pool = getPool();

    if (data.branch_id) {
      next(createAppError(400, 'INVALID', 'Use PUT /prices/branch/:branch_id for branch prices'));
      return;
    }

    // Check for existing org-wide price
    const existing = await pool.query(
      `SELECT id, price_ugx FROM prices
       WHERE service_id = $1 AND vehicle_class_id = $2 AND branch_id IS NULL AND org_id = $3`,
      [data.service_id, data.vehicle_class_id, orgId]
    );

    let result;
    if (existing.rows.length > 0) {
      result = await pool.query(
        `UPDATE prices SET price_ugx = $1, updated_by = $2, updated_at = now()
         WHERE id = $3 RETURNING *`,
        [data.price_ugx, req.actor!.sub, existing.rows[0].id]
      );
      // Audit
      await pool.query(
        `INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity, entity_id, "before", "after")
         VALUES ($1, 'staff', $2, 'price.update', 'prices', $3, $4, $5)`,
        [orgId, req.actor!.sub, result.rows[0].id,
         JSON.stringify({ price_ugx: Number(existing.rows[0].price_ugx) }),
         JSON.stringify({ price_ugx: data.price_ugx, branch_id: null })]
      );
    } else {
      result = await pool.query(
        `INSERT INTO prices (org_id, service_id, vehicle_class_id, branch_id, price_ugx, updated_by)
         VALUES ($1, $2, $3, NULL, $4, $5) RETURNING *`,
        [orgId, data.service_id, data.vehicle_class_id, data.price_ugx, req.actor!.sub]
      );
    }

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// --- PUT /prices/branch/:branch_id — branch override ---

router.put('/branch/:branch_id', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = upsertPriceSchema.parse(req.body);
    const orgId = getOrgId(req.actor!);
    const pool = getPool();
    const { branch_id } = req.params;

    // Manager can only write to own branch
    if (req.actor!.role === 'manager' && branch_id !== req.actor!.branch_id) {
      next(createAppError(403, 'FORBIDDEN', 'Managers can only set prices for their own branch'));
      return;
    }

    // Verify branch belongs to org
    const branchCheck = await pool.query(
      'SELECT id FROM branches WHERE id = $1 AND org_id = $2',
      [branch_id, orgId]
    );
    if (branchCheck.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Branch not found'));
      return;
    }

    // Get current price for audit
    const currentPrice = await pool.query(
      `SELECT id, price_ugx FROM prices
       WHERE service_id = $1 AND vehicle_class_id = $2 AND branch_id = $3 AND active`,
      [data.service_id, data.vehicle_class_id, branch_id]
    );

    // Upsert branch override
    const existingBranch = await pool.query(
      `SELECT id FROM prices
       WHERE service_id = $1 AND vehicle_class_id = $2 AND branch_id = $3 AND org_id = $4`,
      [data.service_id, data.vehicle_class_id, branch_id, orgId]
    );

    let result;
    if (existingBranch.rows.length > 0) {
      result = await pool.query(
        `UPDATE prices SET price_ugx = $1, updated_by = $2, active = true, updated_at = now()
         WHERE id = $3 RETURNING *`,
        [data.price_ugx, req.actor!.sub, existingBranch.rows[0].id]
      );
    } else {
      result = await pool.query(
        `INSERT INTO prices (org_id, service_id, vehicle_class_id, branch_id, price_ugx, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [orgId, data.service_id, data.vehicle_class_id, branch_id, data.price_ugx, req.actor!.sub]
      );
    }

    // Audit log
    await pool.query(
      `INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity, entity_id, "before", "after")
       VALUES ($1, 'staff', $2, 'price.update', 'prices', $3, $4, $5)`,
      [
        orgId,
        req.actor!.sub,
        result.rows[0].id,
        JSON.stringify(currentPrice.rows[0] ? { price_ugx: Number(currentPrice.rows[0].price_ugx) } : null),
        JSON.stringify({ price_ugx: data.price_ugx, branch_id }),
      ]
    );

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// --- DELETE /prices/branch/:branch_id/:price_id — remove branch override ---

router.delete('/branch/:branch_id/:price_id', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req.actor!);
    const pool = getPool();
    const { branch_id, price_id } = req.params;

    // Manager can only delete from own branch
    if (req.actor!.role === 'manager' && branch_id !== req.actor!.branch_id) {
      next(createAppError(403, 'FORBIDDEN', 'Managers can only remove prices for their own branch'));
      return;
    }

    // Soft-delete the override (set inactive)
    const result = await pool.query(
      `UPDATE prices SET active = false, updated_at = now()
       WHERE id = $1 AND org_id = $2 AND branch_id = $3 AND branch_id IS NOT NULL
       RETURNING id`,
      [price_id, orgId, branch_id]
    );

    if (result.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Branch price not found'));
      return;
    }

    res.json({ ok: true, data: { message: 'Branch price override removed. Org default now applies.' } });
  } catch (err) {
    next(err);
  }
});

// --- POST /prices/bulk — batch upsert in one transaction ---

router.post('/bulk', requireRole('orgadmin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = bulkPriceSchema.parse(req.body);
    const orgId = getOrgId(req.actor!);
    const pool = getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const results: any[] = [];
      for (const price of data.prices) {
        // The branch clause is conditional, so the parameter list has to be
        // built alongside it. Previously the org filter was always written as
        // $4 while only three values were supplied for the org-wide case,
        // leaving $4 unbound — Postgres rejected the whole statement with
        // 42P18 (indeterminate parameter type) and bulk pricing never worked.
        const params: any[] = [price.service_id, price.vehicle_class_id];
        const branchClause = price.branch_id
          ? `branch_id = $${params.push(price.branch_id)}`
          : 'branch_id IS NULL';
        const existing = await client.query(
          `SELECT id FROM prices
           WHERE service_id = $1 AND vehicle_class_id = $2
             AND ${branchClause}
             AND org_id = $${params.push(orgId)}`,
          params
        );

        let result;
        if (existing.rows.length > 0) {
          result = await client.query(
            `UPDATE prices SET price_ugx = $1, updated_by = $2, active = true, updated_at = now()
             WHERE id = $3 RETURNING id, service_id, vehicle_class_id, branch_id, price_ugx`,
            [price.price_ugx, req.actor!.sub, existing.rows[0].id]
          );
        } else {
          result = await client.query(
            `INSERT INTO prices (org_id, service_id, vehicle_class_id, branch_id, price_ugx, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, service_id, vehicle_class_id, branch_id, price_ugx`,
            [orgId, price.service_id, price.vehicle_class_id, price.branch_id || null, price.price_ugx, req.actor!.sub]
          );
        }
        results.push(result.rows[0]);
      }

      await client.query('COMMIT');

      res.json({ ok: true, data: results });
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

// --- GET /prices/history — from audit_logs ---

router.get('/history', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req.actor!);
    const pool = getPool();
    const { service_id, vehicle_class_id } = req.query;

    let query = `
      SELECT al.id, al.action, al.entity_id, al."before", al."after", al.created_at,
             s.full_name as actor_name
      FROM audit_logs al
      LEFT JOIN staff_users s ON al.actor_id = s.id
      WHERE al.org_id = $1 AND al.action = 'price.update'
    `;
    const params: any[] = [orgId];

    if (service_id) {
      // Filter by service_id in the after JSON
      query += ` AND al."after" @> $${++params.length}::jsonb`;
      params.push(JSON.stringify({ service_id }));
    }
    if (vehicle_class_id) {
      query += ` AND al."after" @> $${++params.length}::jsonb`;
      params.push(JSON.stringify({ vehicle_class_id }));
    }

    query += ' ORDER BY al.created_at DESC LIMIT 100';

    const result = await pool.query(query, params);

    res.json({ ok: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// --- POST /prices/resolve — helper for other modules ---

/**
 * POST /prices/resolve
 * Internal helper: resolves price for a given combination.
 * Used by wash start, correction, etc. in later phases.
 */
router.post('/resolve', requireRole('orgadmin', 'manager', 'worker'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { service_id, vehicle_class_id, branch_id } = z.object({
      service_id: z.string().uuid(),
      vehicle_class_id: z.string().uuid(),
      branch_id: z.string().uuid(),
    }).parse(req.body);

    const orgId = getOrgId(req.actor!);
    const pool = getPool();

    // Verify both service and vehicle class are active
    const checkResult = await pool.query(
      `SELECT
         (SELECT active FROM services WHERE id = $1 AND org_id = $4) AS service_active,
         (SELECT active FROM vehicle_classes WHERE id = $2 AND org_id = $4) AS vc_active`,
      [service_id, vehicle_class_id, orgId]
    );

    const checkRow = checkResult.rows[0];
    if (!checkRow.service_active || !checkRow.vc_active) {
      next(createAppError(422, 'INACTIVE_ITEM', 'Service or vehicle class is inactive'));
      return;
    }

    // Resolve price: branch override wins over org default
    const priceResult = await pool.query(
      `SELECT id, price_ugx FROM prices
       WHERE service_id = $1 AND vehicle_class_id = $2 AND active
         AND (branch_id = $3 OR branch_id IS NULL)
         AND org_id = $4
       ORDER BY branch_id NULLS LAST
       LIMIT 1`,
      [service_id, vehicle_class_id, branch_id, orgId]
    );

    if (priceResult.rows.length === 0) {
      next(createAppError(422, 'NO_PRICE_SET', 'No price set for this combination'));
      return;
    }

    res.json({
      ok: true,
      data: {
        price_id: priceResult.rows[0].id,
        price_ugx: Number(priceResult.rows[0].price_ugx),
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
