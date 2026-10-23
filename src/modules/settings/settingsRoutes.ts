import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';
import { requireRole, getOrgId } from '@/middleware/requireRole';
import { getConfig as getClientPointsConfig, adjust as adjustClientPoints } from '@/modules/clientPoints';
import { getConfig as getDispatchConfig } from '@/modules/dispatch';

/**
 * The owner's settings area. One place for the rules that used to be
 * hard-coded, scoped to the caller's organisation.
 *
 * Phase 1 holds client points: whether the scheme is on, what a point is
 * worth, and per wash type whether it earns points and how many. Later
 * phases add commission, dispatch and worker-points rules here too.
 */
const router = Router();

async function clientPointsView(orgId: string) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const cfg = await getClientPointsConfig(client, orgId);
    const services = await client.query(
      `SELECT s.id, s.name, s.branch_id, b.name AS branch_name, s.active,
              s.earns_point, s.client_points_awarded
         FROM services s
         LEFT JOIN branches b ON b.id = s.branch_id
        WHERE s.org_id = $1
        ORDER BY s.active DESC, s.name`,
      [orgId]
    );
    return {
      enabled: cfg.enabled,
      point_value_ugx: cfg.point_value_ugx,
      services: services.rows.map((s: any) => ({
        ...s,
        client_points_awarded: Number(s.client_points_awarded),
      })),
    };
  } finally {
    client.release();
  }
}

// GET /settings/client-points — managers can read the rules their branch runs on
router.get('/client-points', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ ok: true, data: await clientPointsView(getOrgId(req.actor!)) });
  } catch (err) {
    next(err);
  }
});

const clientPointsSchema = z.object({
  enabled: z.boolean().optional(),
  point_value_ugx: z.number().int().min(0).max(1_000_000).optional(),
  // Per wash type, so the whole settings screen saves in one request.
  services: z.array(z.object({
    id: z.string().uuid(),
    earns_point: z.boolean(),
    client_points_awarded: z.number().int().min(0).max(100_000),
  })).optional(),
}).refine(
  (b) => !b.services || b.services.every((s) => !s.earns_point || s.client_points_awarded > 0),
  { message: 'A wash type that earns points must award more than 0', path: ['services'] }
);

// PUT /settings/client-points — org admin only; one transaction, audit-logged
router.put('/client-points', requireRole('orgadmin'), async (req: Request, res: Response, next: NextFunction) => {
  let body: z.infer<typeof clientPointsSchema>;
  try {
    body = clientPointsSchema.parse(req.body);
  } catch (err: any) {
    next(createAppError(400, 'VALIDATION_ERROR', 'Request validation failed', err.errors));
    return;
  }

  const orgId = getOrgId(req.actor!);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const before = await getClientPointsConfig(client, orgId);

    await client.query(
      `UPDATE client_points_configs
          SET enabled = COALESCE($2, enabled),
              point_value_ugx = COALESCE($3, point_value_ugx),
              updated_at = now()
        WHERE org_id = $1`,
      [orgId, body.enabled ?? null, body.point_value_ugx ?? null]
    );

    for (const s of body.services ?? []) {
      // org_id in the WHERE is the tenancy guard: an id from another
      // organisation simply matches nothing and is reported.
      const r = await client.query(
        `UPDATE services SET earns_point = $3, client_points_awarded = $4
          WHERE id = $1 AND org_id = $2 RETURNING id`,
        [s.id, orgId, s.earns_point, s.client_points_awarded]
      );
      if (r.rows.length === 0) {
        await client.query('ROLLBACK');
        next(createAppError(404, 'SERVICE_NOT_FOUND', `Wash type ${s.id} not found`));
        return;
      }
    }

    await client.query(
      `INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity, entity_id, "before", "after")
       VALUES ($1, 'staff', $2, 'client_points_config.updated', 'client_points_configs', $1, $3, $4)`,
      [orgId, req.actor!.sub, JSON.stringify(before), JSON.stringify(body)]
    );

    await client.query('COMMIT');
    res.json({ ok: true, data: await clientPointsView(orgId) });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ─── Worker points: on/off, what a point is worth, points per wash type ───
//
// Same shape as client points. The worth and the switch live on
// worker_points_configs (`point_value_ugx`, `active`); the per-type number is
// services.worker_points_awarded, frozen onto each wash at booking.

async function workerPointsView(orgId: string) {
  const pool = getPool();
  const cfg = await pool.query(
    `SELECT active, point_value_ugx FROM worker_points_configs WHERE org_id = $1`, [orgId]
  );
  const services = await pool.query(
    `SELECT s.id, s.name, s.branch_id, b.name AS branch_name, s.active, s.worker_points_awarded
       FROM services s LEFT JOIN branches b ON b.id = s.branch_id
      WHERE s.org_id = $1
      ORDER BY s.active DESC, s.name`,
    [orgId]
  );
  return {
    enabled: cfg.rows[0]?.active ?? true,
    point_value_ugx: Number(cfg.rows[0]?.point_value_ugx ?? 100),
    services: services.rows.map((s: any) => ({ ...s, worker_points_awarded: Number(s.worker_points_awarded) })),
  };
}

router.get('/worker-points', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ ok: true, data: await workerPointsView(getOrgId(req.actor!)) });
  } catch (err) {
    next(err);
  }
});

const workerPointsSchema = z.object({
  enabled: z.boolean().optional(),
  point_value_ugx: z.number().int().min(0).max(1_000_000).optional(),
  services: z.array(z.object({
    id: z.string().uuid(),
    worker_points_awarded: z.number().int().min(0).max(100_000),
  })).optional(),
});

router.put('/worker-points', requireRole('orgadmin'), async (req: Request, res: Response, next: NextFunction) => {
  let body: z.infer<typeof workerPointsSchema>;
  try {
    body = workerPointsSchema.parse(req.body);
  } catch (err: any) {
    next(createAppError(400, 'VALIDATION_ERROR', 'Request validation failed', err.errors));
    return;
  }
  const orgId = getOrgId(req.actor!);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const before = await workerPointsView(orgId);
    await client.query(
      `INSERT INTO worker_points_configs (org_id) VALUES ($1) ON CONFLICT (org_id) DO NOTHING`, [orgId]
    );
    await client.query(
      `UPDATE worker_points_configs
          SET active = COALESCE($2, active),
              point_value_ugx = COALESCE($3, point_value_ugx),
              updated_at = now()
        WHERE org_id = $1`,
      [orgId, body.enabled ?? null, body.point_value_ugx ?? null]
    );
    for (const s of body.services ?? []) {
      const r = await client.query(
        `UPDATE services SET worker_points_awarded = $3 WHERE id = $1 AND org_id = $2 RETURNING id`,
        [s.id, orgId, s.worker_points_awarded]
      );
      if (r.rows.length === 0) {
        await client.query('ROLLBACK');
        next(createAppError(404, 'SERVICE_NOT_FOUND', `Wash type ${s.id} not found`));
        return;
      }
    }
    await client.query(
      `INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity, entity_id, "before", "after")
       VALUES ($1, 'staff', $2, 'worker_points_config.updated', 'worker_points_configs', $1, $3, $4)`,
      [orgId, req.actor!.sub, JSON.stringify({ enabled: before.enabled, point_value_ugx: before.point_value_ugx }), JSON.stringify(body)]
    );
    await client.query('COMMIT');
    res.json({ ok: true, data: await workerPointsView(orgId) });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ─── Dispatch: the accept window, presence, unassigned alert ───

// GET /settings/dispatch
router.get('/dispatch', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ ok: true, data: await getDispatchConfig(getPool(), getOrgId(req.actor!)) });
  } catch (err) {
    next(err);
  }
});

const dispatchSchema = z.object({
  accept_window_seconds: z.number().int().min(5).max(3600).optional(),
  presence_minutes: z.number().int().min(1).max(1440).optional(),
  unassigned_alert_minutes: z.number().int().min(1).max(1440).optional(),
});

// PUT /settings/dispatch — org admin only, audit-logged
router.put('/dispatch', requireRole('orgadmin'), async (req: Request, res: Response, next: NextFunction) => {
  let body: z.infer<typeof dispatchSchema>;
  try {
    body = dispatchSchema.parse(req.body);
  } catch (err: any) {
    next(createAppError(400, 'VALIDATION_ERROR', 'Request validation failed', err.errors));
    return;
  }
  const orgId = getOrgId(req.actor!);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const before = await getDispatchConfig(client, orgId);
    const r = await client.query(
      `UPDATE dispatch_configs
          SET accept_window_seconds = COALESCE($2, accept_window_seconds),
              presence_minutes = COALESCE($3, presence_minutes),
              unassigned_alert_minutes = COALESCE($4, unassigned_alert_minutes),
              updated_at = now()
        WHERE org_id = $1
        RETURNING accept_window_seconds, presence_minutes, unassigned_alert_minutes`,
      [orgId, body.accept_window_seconds ?? null, body.presence_minutes ?? null, body.unassigned_alert_minutes ?? null]
    );
    await client.query(
      `INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity, entity_id, "before", "after")
       VALUES ($1, 'staff', $2, 'dispatch_config.updated', 'dispatch_configs', $1, $3, $4)`,
      [orgId, req.actor!.sub, JSON.stringify(before), JSON.stringify(body)]
    );
    await client.query('COMMIT');
    res.json({ ok: true, data: r.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

const adjustSchema = z.object({
  client_id: z.string().uuid(),
  points: z.number().int().refine((n) => n !== 0, 'points must not be 0'),
  reason: z.string().min(3).max(500),
});

// POST /settings/client-points/adjust — org admin corrects a client's
// balance in THIS organisation's scheme, with a mandatory reason. The
// account is keyed by (client, org), so this can never touch what another
// organisation gave the same client.
router.post('/client-points/adjust', requireRole('orgadmin'), async (req: Request, res: Response, next: NextFunction) => {
  let body: z.infer<typeof adjustSchema>;
  try {
    body = adjustSchema.parse(req.body);
  } catch (err: any) {
    next(createAppError(400, 'VALIDATION_ERROR', 'Request validation failed', err.errors));
    return;
  }

  const orgId = getOrgId(req.actor!);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query(`SELECT 1 FROM clients WHERE id = $1 AND status <> 'deleted'`, [body.client_id]);
    if (exists.rows.length === 0) {
      await client.query('ROLLBACK');
      next(createAppError(404, 'CLIENT_NOT_FOUND', 'Client not found'));
      return;
    }
    const account = await adjustClientPoints(client, {
      clientId: body.client_id, orgId, points: body.points, reason: body.reason, by: req.actor!.sub,
    });
    await client.query(
      `INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity, entity_id, "after")
       VALUES ($1, 'staff', $2, 'client_points.adjusted', 'clients', $3, $4)`,
      [orgId, req.actor!.sub, body.client_id, JSON.stringify(body)]
    );
    await client.query('COMMIT');
    res.json({ ok: true, data: account });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

export default router;
