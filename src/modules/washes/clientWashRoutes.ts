import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';
import { resolvePrice } from '@/modules/pricing/resolvePrice';
import { notify } from '@/modules/notify';
import { bumpJobNo } from '@/modules/washes/washRoutes';

const router = Router();

// GET /me/washes/active — client's live wash in progress
router.get('/active', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.actor || req.actor.type !== 'client') {
      next(createAppError(403, 'FORBIDDEN', 'Client access required'));
      return;
    }

    const pool = getPool();
    const result = await pool.query(
      // is_redemption tells the app this wash costs nothing, so it can skip
      // the whole payment flow instead of quoting a price the client owes.
      // 'requested' is included so a client sees their own booking on this
      // screen from the moment they confirm it — before this, a client had
      // nothing to poll between tapping "book" and a worker accepting.
      `SELECT w.id, w.job_no, w.status, w.quoted_amount_ugx, w.started_at,
              w.requested_at, w.is_redemption,
              vc.name as vehicle_class_name, svc.name as service_name,
              b.name as branch_name
       FROM washes w
       JOIN vehicle_classes vc ON w.vehicle_class_id = vc.id
       JOIN services svc ON w.service_id = svc.id
       JOIN branches b ON w.branch_id = b.id
       WHERE w.client_id = $1 AND w.status IN ('requested', 'in_progress', 'ready')
       ORDER BY COALESCE(w.requested_at, w.started_at) DESC LIMIT 1`,
      [req.actor.sub]
    );

    res.json({ ok: true, data: result.rows[0] || null });
  } catch (err) {
    next(err);
  }
});

// GET /me/washes/history — client's wash history
router.get('/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.actor || req.actor.type !== 'client') {
      next(createAppError(403, 'FORBIDDEN', 'Client access required'));
      return;
    }

    const pool = getPool();
    const result = await pool.query(
      `SELECT w.id, w.job_no, w.status, w.amount_ugx, w.quoted_amount_ugx,
              w.is_redemption, w.started_at, w.settled_at, w.receipt_no,
              vc.name as vehicle_class_name, svc.name as service_name
       FROM washes w
       JOIN vehicle_classes vc ON w.vehicle_class_id = vc.id
       JOIN services svc ON w.service_id = svc.id
       WHERE w.client_id = $1
       ORDER BY w.started_at DESC LIMIT 50`,
      [req.actor.sub]
    );

    res.json({ ok: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /me/washes/prices — what a wash costs, for the client's home screen
//
// A client isn't scoped to one branch the way staff are — they can walk into
// any branch of their org — so there is no branch_id on their token to
// reuse. Reusing the same nested vehicle-class/service shape as
// /prices/effective (staff-only) rather than a client seeing that endpoint
// directly, since it also exposes branch identity and is otherwise wide
// open to any authenticated staff role.
router.get('/prices', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.actor || req.actor.type !== 'client') {
      next(createAppError(403, 'FORBIDDEN', 'Client access required'));
      return;
    }

    const pool = getPool();
    const orgId = req.actor.org_id;

    // Which branch's prices to show: an explicit ?branch_id (once a client
    // has scanned a branch's QR and is booking there specifically), else the
    // one from this client's most recent wash, else the org's oldest active
    // branch — the same deterministic "first" used to pick a brand-new
    // client's org, so this never depends on how Postgres happens to order
    // an unsorted result.
    let branchId = (req.query.branch_id as string | undefined)?.trim() || undefined;

    if (!branchId) {
      const lastBranch = await pool.query(
        `SELECT branch_id FROM washes WHERE client_id = $1 ORDER BY started_at DESC LIMIT 1`,
        [req.actor.sub]
      );
      branchId = lastBranch.rows[0]?.branch_id as string | undefined;
    }

    if (!branchId) {
      const fallback = await pool.query(
        `SELECT id FROM branches WHERE org_id = $1 AND status = 'active' ORDER BY created_at ASC LIMIT 1`,
        [orgId]
      );
      branchId = fallback.rows[0]?.id;
    }

    if (!branchId) {
      // An org with no active branch yet — show nothing rather than 500.
      res.json({ ok: true, data: { vehicle_classes: [] } });
      return;
    }

    const vehicleClasses = await pool.query(
      `SELECT id, name, sort_order FROM vehicle_classes
        WHERE org_id = $1 AND active AND (branch_id IS NULL OR branch_id = $2)
        ORDER BY sort_order, name`,
      [orgId, branchId]
    );

    const services = await pool.query(
      `SELECT id, name FROM services
        WHERE org_id = $1 AND active AND (branch_id IS NULL OR branch_id = $2)
        ORDER BY name`,
      [orgId, branchId]
    );

    const prices = await pool.query(
      `SELECT service_id, vehicle_class_id, branch_id, price_ugx
         FROM prices WHERE org_id = $1 AND active`,
      [orgId]
    );

    const result = vehicleClasses.rows.map((vc: any) => ({
      id: vc.id,
      name: vc.name,
      sort_order: vc.sort_order,
      services: services.rows.map((svc: any) => {
        const branchPrice = prices.rows.find(
          (p: any) => p.service_id === svc.id && p.vehicle_class_id === vc.id && p.branch_id === branchId
        );
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

// POST /me/washes — client books their own wash, self-service
//
// Creates the wash the instant the client confirms, in status='requested'
// with no worker attached — a client has no shift to check and no scanned
// token to consume, since they ARE the authenticated actor. A worker picks
// it up later via POST /washes/:id/accept (washRoutes.ts).
const bookSchema = z.object({
  branch_id: z.string().uuid(),
  service_id: z.string().uuid().optional(),
  vehicle_class_id: z.string().uuid(),
  plate: z.string().optional(),
  vehicle_color: z.string().max(40).optional(),
  use_free_wash: z.boolean().optional().default(false),
  declared_payment_method: z.enum(['cash', 'mtn', 'airtel']).optional(),
  declared_payment_phone: z.string().max(20).optional(),
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  if (!req.actor || req.actor.type !== 'client') {
    next(createAppError(403, 'FORBIDDEN', 'Client access required'));
    return;
  }

  const pool = getPool();
  const clientId = req.actor.sub;

  let body: z.infer<typeof bookSchema>;
  try {
    body = bookSchema.parse(req.body);
  } catch (err: any) {
    next(createAppError(400, 'VALIDATION_ERROR', 'Request validation failed', err.errors));
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The wash belongs to whichever org actually owns the branch the client
    // scanned — not necessarily the org on the client's own token. A client
    // can physically visit a branch of a different organisation; the QR they
    // just scanned is the source of truth for where they are standing.
    const branchCheck = await client.query(
      `SELECT id, org_id, code, status FROM branches WHERE id = $1`,
      [body.branch_id]
    );
    if (branchCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      next(createAppError(404, 'BRANCH_NOT_FOUND', 'Branch not found'));
      return;
    }
    const branch = branchCheck.rows[0];
    if (branch.status !== 'active') {
      await client.query('ROLLBACK');
      next(createAppError(409, 'BRANCH_INACTIVE', 'This branch is not currently accepting bookings'));
      return;
    }
    const orgId = branch.org_id;

    // A client should not have two simultaneous pending requests — a double
    // tap of "book" must not queue a second car nobody is waiting for.
    const already = await client.query(
      `SELECT id FROM washes WHERE client_id = $1 AND status = 'requested'`,
      [clientId]
    );
    if (already.rows.length > 0) {
      await client.query('ROLLBACK');
      next(createAppError(409, 'ALREADY_REQUESTED', 'You already have a wash waiting to be accepted'));
      return;
    }

    // Resolve service (default if omitted) — same branch-scoping rule as the
    // worker's own POST /washes: a type is either org-wide or private to one
    // branch, and a branch's own default wins over the org-wide one.
    let serviceId: string | undefined = body.service_id;
    if (!serviceId) {
      const svcResult = await client.query(
        `SELECT id FROM services
          WHERE org_id = $1 AND is_default AND active
            AND (branch_id IS NULL OR branch_id = $2)
          ORDER BY branch_id NULLS LAST LIMIT 1`,
        [orgId, body.branch_id]
      );
      if (svcResult.rows.length === 0) {
        await client.query('ROLLBACK');
        next(createAppError(422, 'NO_DEFAULT_SERVICE', 'No default service configured'));
        return;
      }
      serviceId = svcResult.rows[0].id;
    }
    // Resolved above: either the caller supplied it or the default lookup
    // returned early on failure — by this point it is always a real id.
    // TypeScript can't see that across the reassignment inside the `if`, so
    // this is asserted, not inferred.
    const resolvedServiceId: string = serviceId!;

    const svcCheck = await client.query(
      `SELECT id, name, earns_point FROM services
        WHERE id = $1 AND org_id = $2 AND active AND (branch_id IS NULL OR branch_id = $3)`,
      [resolvedServiceId, orgId, body.branch_id]
    );
    if (svcCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      next(createAppError(404, 'SERVICE_NOT_FOUND', 'Service not found or not offered at this branch'));
      return;
    }
    const service = svcCheck.rows[0];

    const vcCheck = await client.query(
      `SELECT id, name FROM vehicle_classes
        WHERE id = $1 AND org_id = $2 AND active AND (branch_id IS NULL OR branch_id = $3)`,
      [body.vehicle_class_id, orgId, body.branch_id]
    );
    if (vcCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      next(createAppError(404, 'VEHICLE_CLASS_NOT_FOUND', 'Car type not found or not offered at this branch'));
      return;
    }
    const vehicleClass = vcCheck.rows[0];

    const price = await resolvePrice(resolvedServiceId, body.vehicle_class_id, body.branch_id, orgId);
    if (!price) {
      await client.query('ROLLBACK');
      next(createAppError(422, 'NO_PRICE_SET', `No price set for ${service.name} + ${vehicleClass.name}`, {
        service_name: service.name,
        vehicle_class_name: vehicleClass.name,
      }));
      return;
    }

    // Free-wash check — same "check credits, don't consume yet" rule as the
    // worker-initiated flow; the credit is only actually spent at settlement.
    let isRedemption = false;
    if (body.use_free_wash) {
      const acct = await client.query(
        `SELECT free_wash_credits FROM loyalty_accounts WHERE client_id = $1`,
        [clientId]
      );
      if (acct.rows.length === 0 || acct.rows[0].free_wash_credits < 1) {
        await client.query('ROLLBACK');
        next(createAppError(422, 'NO_CREDITS', 'No free wash credits available'));
        return;
      }
      isRedemption = true;
    }

    const jobNo = await bumpJobNo(client, body.branch_id, branch.code);

    const washResult = await client.query(
      `INSERT INTO washes (
         org_id, branch_id, client_id, client_attach_method,
         plate, vehicle_color, service_id, vehicle_class_id, price_id,
         quoted_amount_ugx, is_redemption, earns_point,
         job_no, status, origin, start_verified, requested_at, started_date,
         declared_payment_method, declared_payment_phone
       ) VALUES ($1,$2,$3,'client_booking',$4,$5,$6,$7,$8,$9,$10,$11,$12,
                 'requested','client',true, now(), CURRENT_DATE, $13, $14)
       RETURNING *`,
      [
        orgId, body.branch_id, clientId,
        body.plate || null, body.vehicle_color || null,
        resolvedServiceId, body.vehicle_class_id, price.price_id,
        price.price_ugx, isRedemption, service.earns_point,
        jobNo,
        body.declared_payment_method || null, body.declared_payment_phone || null,
      ]
    );
    const wash = washResult.rows[0];

    await client.query('COMMIT');

    // Every worker with an open shift at this branch can accept it — nobody
    // is attached yet, so there is no single recipient the way settled/ready
    // events have one.
    const openShiftWorkers = await pool.query(
      `SELECT DISTINCT worker_id FROM shifts WHERE branch_id = $1 AND status = 'open'`,
      [body.branch_id]
    );
    for (const row of openShiftWorkers.rows) {
      notify('staff', row.worker_id, 'wash_requested', {
        wash_id: wash.id,
        job_no: jobNo,
        vehicle_class_name: vehicleClass.name,
        service_name: service.name,
      });
    }

    res.status(201).json({
      ok: true,
      data: {
        wash_id: wash.id,
        job_no: jobNo,
        status: 'requested',
        quoted_amount_ugx: Number(wash.quoted_amount_ugx),
        service_name: service.name,
        vehicle_class_name: vehicleClass.name,
        is_redemption: isRedemption,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// POST /me/washes/:id/payment-intent — client declares how they'll pay
//
// Purely informational: does not settle, does not charge, does not award
// loyalty. It only lets the worker's own settle screen pre-fill instead of
// defaulting blind — settlement itself remains 100% a worker action.
const paymentIntentSchema = z.object({
  method: z.enum(['cash', 'mtn', 'airtel']),
  phone: z.string().max(20).optional(),
});

router.post('/:id/payment-intent', async (req: Request, res: Response, next: NextFunction) => {
  if (!req.actor || req.actor.type !== 'client') {
    next(createAppError(403, 'FORBIDDEN', 'Client access required'));
    return;
  }

  let body: z.infer<typeof paymentIntentSchema>;
  try {
    body = paymentIntentSchema.parse(req.body);
  } catch (err: any) {
    next(createAppError(400, 'VALIDATION_ERROR', 'Request validation failed', err.errors));
    return;
  }

  try {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE washes
          SET declared_payment_method = $1, declared_payment_phone = $2, updated_at = now()
        WHERE id = $3 AND client_id = $4 AND status = 'ready'
        RETURNING id`,
      [body.method, body.phone || null, req.params.id, req.actor.sub]
    );
    if (result.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Wash not found, not yours, or not ready for payment'));
      return;
    }
    res.json({ ok: true, data: { id: result.rows[0].id } });
  } catch (err) {
    next(err);
  }
});

// POST /me/washes/:id/cancel-request — client backs out of their own
// still-unclaimed booking. The staff-only /washes/:id/cancel reason enum
// (client_left, started_by_mistake, ...) is written for a worker explaining
// why THEY cancelled someone else's car — none of those fit "I changed my
// mind before anyone started," so this is a separate, simpler endpoint
// rather than overloading that schema with a client-facing branch.
router.post('/:id/cancel-request', async (req: Request, res: Response, next: NextFunction) => {
  if (!req.actor || req.actor.type !== 'client') {
    next(createAppError(403, 'FORBIDDEN', 'Client access required'));
    return;
  }

  try {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE washes
          SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'client_cancelled', updated_at = now()
        WHERE id = $1 AND client_id = $2 AND status = 'requested' AND started_by_worker_id IS NULL
        RETURNING id`,
      [req.params.id, req.actor.sub]
    );
    if (result.rows.length === 0) {
      next(createAppError(409, 'BAD_STATE', 'This booking can no longer be cancelled — it may already have been accepted'));
      return;
    }
    res.json({ ok: true, data: { id: result.rows[0].id } });
  } catch (err) {
    next(err);
  }
});

// GET /me/loyalty — client's loyalty progress
router.get('/loyalty', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.actor || req.actor.type !== 'client') {
      next(createAppError(403, 'FORBIDDEN', 'Client access required'));
      return;
    }

    const pool = getPool();
    const result = await pool.query(
      `SELECT la.*, lc.washes_required, lc.min_amount_ugx
       FROM loyalty_accounts la
       JOIN loyalty_configs lc ON lc.org_id = la.org_id
       WHERE la.client_id = $1`,
      [req.actor.sub]
    );

    if (result.rows.length === 0) {
      res.json({ ok: true, data: null });
      return;
    }

    const acct = result.rows[0];
    res.json({
      ok: true,
      data: {
        wash_count: acct.wash_count,
        free_wash_credits: acct.free_wash_credits,
        lifetime_washes: acct.lifetime_washes,
        lifetime_redeemed: acct.lifetime_redeemed,
        washes_required: acct.washes_required,
        progress: `${acct.wash_count}/${acct.washes_required}`,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /me/loyalty/ledger — client's loyalty ledger
router.get('/loyalty/ledger', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.actor || req.actor.type !== 'client') {
      next(createAppError(403, 'FORBIDDEN', 'Client access required'));
      return;
    }

    const pool = getPool();
    const result = await pool.query(
      `SELECT entry_type, wash_delta, credit_delta, wash_count_after, credits_after,
              reason, created_at
       FROM loyalty_ledger
       WHERE client_id = $1
       ORDER BY created_at DESC LIMIT 50`,
      [req.actor.sub]
    );

    res.json({ ok: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /me/qr — client's static member_code
router.get('/qr', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.actor || req.actor.type !== 'client') {
      next(createAppError(403, 'FORBIDDEN', 'Client access required'));
      return;
    }

    const pool = getPool();
    const result = await pool.query(
      `SELECT member_code, full_name FROM clients WHERE id = $1`,
      [req.actor.sub]
    );

    if (result.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Client not found'));
      return;
    }

    res.json({
      ok: true,
      data: {
        member_code: result.rows[0].member_code,
        name: result.rows[0].full_name,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
