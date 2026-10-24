import { Router, Request, Response, NextFunction } from 'express';
import { PoolClient } from 'pg';
import { z } from 'zod';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';
import { resolvePrice } from '@/modules/pricing/resolvePrice';
import { notify } from '@/modules/notify';
import { bumpJobNo } from '@/modules/washes/washRoutes';
import { dispatchOverdue, getConfig as getDispatchConfig } from '@/modules/dispatch';
import { generateReceiptNo } from '@/utils/receiptNo';
import { planRedemption, applyRedemption, refundForWash, getAccount, getConfig as getPointsConfig } from '@/modules/clientPoints';
import { releasePromoPair } from '@/modules/loyalty';

// The one promo the platform ships. Constant rather than config: there is a
// single offer on the home screen, and the promo_redemptions.promo_key
// DEFAULT matches it, so a rename would be a migration, not a settings
// flip.
export const PROMO_KEY = 'wash2_price1';

const router = Router();

/**
 * Every car this client has on the go, newest first.
 *
 * A client watching a booking's countdown should see it assigned the moment
 * the window ends, not whenever the background tick runs — so any overdue
 * request is dispatched first. is_redemption tells the app a car costs
 * nothing, so it can skip the payment flow for it; promo_key marks the
 * free car of a 2-for-1 pair. 'requested' is included so a client sees a
 * booking from the moment they confirm it.
 */
async function activeWashes(clientId: string, limit?: number) {
  const pool = getPool();
  const waiting = await pool.query(
    `SELECT DISTINCT branch_id FROM washes WHERE client_id = $1 AND status = 'requested'`,
    [clientId]
  );
  for (const row of waiting.rows) await dispatchOverdue(pool, { branchId: row.branch_id });

  const result = await pool.query(
    `SELECT w.id, w.job_no, w.receipt_no, w.status, w.quoted_amount_ugx, w.started_at,
            w.requested_at, w.is_redemption, w.declared_payment_method, w.paid_online_at, w.promo_key, w.plate,
            w.points_used, w.points_value_ugx, w.client_points_to_award,
            CASE WHEN w.status = 'requested'
                 THEN w.requested_at + make_interval(secs => dc.accept_window_seconds) END AS auto_assign_at,
            CASE WHEN w.is_redemption THEN 0
                 ELSE w.quoted_amount_ugx - w.points_value_ugx END AS amount_due_ugx,
            vc.name as vehicle_class_name, svc.name as service_name,
            b.name as branch_name
     FROM washes w
     JOIN vehicle_classes vc ON w.vehicle_class_id = vc.id
     JOIN services svc ON w.service_id = svc.id
     JOIN branches b ON w.branch_id = b.id
     LEFT JOIN dispatch_configs dc ON dc.org_id = w.org_id
     WHERE w.client_id = $1 AND w.status IN ('requested', 'in_progress', 'ready')
     ORDER BY COALESCE(w.requested_at, w.started_at) DESC, w.job_no DESC
     ${limit ? `LIMIT ${Number(limit)}` : ''}`,
    [clientId]
  );
  return result.rows;
}

// GET /me/washes/active — the client's newest live car (kept for callers
// that only ever show one)
router.get('/active', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.actor || req.actor.type !== 'client') {
      next(createAppError(403, 'FORBIDDEN', 'Client access required'));
      return;
    }
    const rows = await activeWashes(req.actor.sub, 1);
    res.json({ ok: true, data: rows[0] || null });
  } catch (err) {
    next(err);
  }
});

// GET /me/washes/active-list — every live car. A client can have more than
// one: the two cars of a 2-for-1 booking, or a second car booked while the
// first is still being washed.
router.get('/active-list', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.actor || req.actor.type !== 'client') {
      next(createAppError(403, 'FORBIDDEN', 'Client access required'));
      return;
    }
    res.json({ ok: true, data: await activeWashes(req.actor.sub) });
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
              w.is_redemption, w.started_at, w.settled_at, w.requested_at, w.receipt_no,
              w.points_used, w.points_value_ugx, w.payment_method,
              vc.name as vehicle_class_name, svc.name as service_name
       FROM washes w
       JOIN vehicle_classes vc ON w.vehicle_class_id = vc.id
       JOIN services svc ON w.service_id = svc.id
       WHERE w.client_id = $1
       ORDER BY COALESCE(w.started_at, w.requested_at, w.created_at) DESC LIMIT 50`,
      [req.actor.sub]
    );

    res.json({ ok: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /me/washes/promo — the home screen's promo card state
//
// The offer is one booking of two cars, so it is either still there to
// take ({ available: true }) or taken ({ used: true }) — taken the moment
// the pair is booked, not when the cars are washed. The promo_redemptions
// row is the record of it (UNIQUE per client); it only ever goes away when
// a car of the pair is cancelled before the free one is washed, which
// hands the offer back (loyalty.releasePromoPair).
router.get('/promo', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.actor || req.actor.type !== 'client') {
      next(createAppError(403, 'FORBIDDEN', 'Client access required'));
      return;
    }

    const pool = getPool();
    const result = await pool.query(
      `SELECT status FROM promo_redemptions WHERE client_id = $1 AND promo_key = $2`,
      [req.actor.sub, PROMO_KEY]
    );
    const row = result.rows[0];

    res.json({
      ok: true,
      data: {
        promo_key: PROMO_KEY,
        available: !row,
        used: !!row,
        // 'armed' = booked, free car not washed yet; 'used' = free car done.
        status: row?.status ?? null,
      },
    });
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
      `SELECT id, name, earns_point, client_points_awarded FROM services
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
          // "Earns N points" on the booking screen; 0 when the type doesn't earn.
          client_points_awarded: svc.earns_point ? Number(svc.client_points_awarded) : 0,
        };
      }),
    }));

    res.json({ ok: true, data: { vehicle_classes: result } });
  } catch (err) {
    next(err);
  }
});

// ─── Booking ──────────────────────────────────────────────────────────
//
// A client books their own wash, self-service. Each car becomes a wash in
// status='requested' with no worker attached — a client has no shift to
// check and no scanned token to consume, since they ARE the authenticated
// actor. A worker picks it up later via POST /washes/:id/accept
// (washRoutes.ts), or the dispatcher assigns it when the window runs out.
//
// A client may have more than one car on the go: a second car booked while
// the first is still being washed is a normal visit, not an error (the
// owner's call, Oct 2026), and the 2-for-1 offer books two at once.

type BookingCar = {
  vehicle_class_id: string;
  service_id?: string;
  plate?: string;
  vehicle_color?: string;
};

const carSchema = z.object({
  vehicle_class_id: z.string().uuid(),
  service_id: z.string().uuid().optional(),
  plate: z.string().optional(),
  vehicle_color: z.string().max(40).optional(),
});

/**
 * The branch being booked at, which must exist and be taking bookings.
 * The wash belongs to whichever org actually owns that branch — not
 * necessarily the org on the client's own token: the QR they just scanned
 * is the source of truth for where they are standing.
 */
async function bookableBranch(client: PoolClient, branchId: string) {
  const r = await client.query(`SELECT id, org_id, code, status FROM branches WHERE id = $1`, [branchId]);
  if (r.rows.length === 0) throw createAppError(404, 'BRANCH_NOT_FOUND', 'Branch not found');
  if (r.rows[0].status !== 'active') {
    throw createAppError(409, 'BRANCH_INACTIVE', 'This branch is not currently accepting bookings');
  }
  return r.rows[0] as { id: string; org_id: string; code: string };
}

/**
 * One car of a booking, checked against the branch: its wash type, its car
 * type and the price for that pair. Same branch-scoping rule as the
 * worker's own POST /washes — a type is either org-wide or private to one
 * branch, and with no wash type named, the branch's own default wins over
 * the org-wide one.
 */
async function resolveCar(client: PoolClient, orgId: string, branchId: string, car: BookingCar) {
  let serviceId = car.service_id;
  if (!serviceId) {
    const def = await client.query(
      `SELECT id FROM services
        WHERE org_id = $1 AND is_default AND active
          AND (branch_id IS NULL OR branch_id = $2)
        ORDER BY branch_id NULLS LAST LIMIT 1`,
      [orgId, branchId]
    );
    if (def.rows.length === 0) throw createAppError(422, 'NO_DEFAULT_SERVICE', 'No default service configured');
    serviceId = def.rows[0].id as string;
  }

  const svc = await client.query(
    `SELECT id, name, earns_point, client_points_awarded, worker_points_awarded FROM services
      WHERE id = $1 AND org_id = $2 AND active AND (branch_id IS NULL OR branch_id = $3)`,
    [serviceId, orgId, branchId]
  );
  if (svc.rows.length === 0) {
    throw createAppError(404, 'SERVICE_NOT_FOUND', 'Service not found or not offered at this branch');
  }
  const service = svc.rows[0];

  const vc = await client.query(
    `SELECT id, name FROM vehicle_classes
      WHERE id = $1 AND org_id = $2 AND active AND (branch_id IS NULL OR branch_id = $3)`,
    [car.vehicle_class_id, orgId, branchId]
  );
  if (vc.rows.length === 0) {
    throw createAppError(404, 'VEHICLE_CLASS_NOT_FOUND', 'Car type not found or not offered at this branch');
  }
  const vehicleClass = vc.rows[0];

  const price = await resolvePrice(serviceId, car.vehicle_class_id, branchId, orgId);
  if (!price) {
    throw createAppError(422, 'NO_PRICE_SET', `No price set for ${service.name} + ${vehicleClass.name}`, {
      service_name: service.name,
      vehicle_class_name: vehicleClass.name,
    });
  }

  return { car, serviceId, service, vehicleClass, price, priceUgx: Number(price.price_ugx) };
}

type ResolvedCar = Awaited<ReturnType<typeof resolveCar>>;

/** The points a car's wash type gives the client once it is paid; 0 when the type doesn't earn. */
const clientPointsFor = (r: ResolvedCar) =>
  r.service.earns_point ? Number(r.service.client_points_awarded) : 0;

/**
 * Writes one car as a requested wash. The price and both points numbers —
 * the client's, and the worker's who washes it — are frozen now: a
 * settings change later affects new bookings only.
 */
async function insertBookedWash(client: PoolClient, o: {
  orgId: string;
  branch: { id: string; code: string };
  clientId: string;
  resolved: ResolvedCar;
  isRedemption: boolean;
  promoKey: string | null;
  clientPointsToAward: number;
  points?: { pointsUsed: number; valueUgx: number; pointValueUgx: number } | null;
  declaredMethod?: string;
  declaredPhone?: string;
}) {
  const { resolved } = o;
  const jobNo = await bumpJobNo(client, o.branch.id, o.branch.code);
  const r = await client.query(
    `INSERT INTO washes (
       org_id, branch_id, client_id, client_attach_method,
       plate, vehicle_color, service_id, vehicle_class_id, price_id,
       quoted_amount_ugx, is_redemption, earns_point,
       job_no, status, origin, start_verified, requested_at, started_date,
       declared_payment_method, declared_payment_phone, promo_key,
       client_points_to_award, points_used, points_value_ugx, point_value_ugx,
       worker_points_to_award
     ) VALUES ($1,$2,$3,'client_booking',$4,$5,$6,$7,$8,$9,$10,$11,$12,
               'requested','client',true, now(), CURRENT_DATE, $13, $14, $15,
               $16, $17, $18, $19, $20)
     RETURNING *`,
    [
      o.orgId, o.branch.id, o.clientId,
      resolved.car.plate || null, resolved.car.vehicle_color || null,
      resolved.serviceId, resolved.car.vehicle_class_id, resolved.price.price_id,
      resolved.price.price_ugx, o.isRedemption, resolved.service.earns_point,
      jobNo,
      o.declaredMethod || null, o.declaredPhone || null,
      o.promoKey,
      o.clientPointsToAward,
      o.points?.pointsUsed ?? 0,
      o.points?.valueUgx ?? 0,
      o.points?.pointValueUgx ?? null,
      Number(resolved.service.worker_points_awarded),
    ]
  );
  return r.rows[0];
}

/**
 * Every worker on shift at the branch is told about each new car; the
 * first eligible one to tap Accept gets it, and if nobody does the
 * dispatcher assigns it (modules/dispatch). Called after commit, so a slow
 * push never holds a booking open.
 */
async function tellBranchWorkers(branchId: string, cars: { wash: any; resolved: ResolvedCar }[]) {
  const workers = await getPool().query(
    `SELECT DISTINCT s.worker_id FROM shifts s JOIN staff_users su ON su.id = s.worker_id
      WHERE s.branch_id = $1 AND s.status = 'open' AND su.role = 'worker'`,
    [branchId]
  );
  for (const row of workers.rows) {
    for (const { wash, resolved } of cars) {
      notify('staff', row.worker_id, 'wash_requested', {
        wash_id: wash.id,
        job_no: wash.job_no,
        vehicle_class_name: resolved.vehicleClass.name,
        service_name: resolved.service.name,
      });
    }
  }
}

/** When the dispatcher will assign a car if no worker has accepted it. */
const autoAssignAt = (wash: any, windowSeconds: number) =>
  new Date(new Date(wash.requested_at).getTime() + windowSeconds * 1000);

// POST /me/washes — one car
const bookSchema = carSchema.extend({
  branch_id: z.string().uuid(),
  use_free_wash: z.boolean().optional().default(false),
  // "Use my points": spend the client's points against this wash's price.
  // Deducted inside the booking transaction, refunded if it is cancelled.
  use_points: z.boolean().optional().default(false),
  declared_payment_method: z.enum(['cash', 'mtn', 'airtel']).optional(),
  declared_payment_phone: z.string().max(20).optional(),
}).refine((b) => !(b.use_points && b.use_free_wash), {
  // A free wash costs nothing, so there is nothing for points to pay —
  // accepting both would burn points for no reason.
  message: 'Use either points or a free wash, not both',
  path: ['use_points'],
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
    const branch = await bookableBranch(client, body.branch_id);
    const orgId = branch.org_id;

    // The client's own row is locked first. It no longer stops a second
    // car being booked; it serialises this client's bookings, so two sent
    // at the same moment (a double-tap, a retry) can never both spend the
    // same points or the same free-wash credit.
    await client.query(`SELECT id FROM clients WHERE id = $1 FOR UPDATE`, [clientId]);

    const resolved = await resolveCar(client, orgId, body.branch_id, body);

    // A free-wash credit left over from the old stamp card — checked here,
    // only actually spent at settlement.
    let isRedemption = false;
    if (body.use_free_wash) {
      const acct = await client.query(
        `SELECT free_wash_credits FROM loyalty_accounts WHERE client_id = $1`,
        [clientId]
      );
      if (acct.rows.length === 0 || acct.rows[0].free_wash_credits < 1) {
        throw createAppError(422, 'NO_CREDITS', 'No free wash credits available');
      }
      isRedemption = true;
    }

    // "Use my points": worked out (and the account locked) before the wash
    // exists, deducted against it right after the insert, all in this one
    // transaction — so two bookings can never spend the same points.
    const pointsPlan = body.use_points
      ? await planRedemption(client, { clientId, orgId, priceUgx: resolved.priceUgx })
      : null;

    const pointsToAward = clientPointsFor(resolved);
    const wash = await insertBookedWash(client, {
      orgId, branch, clientId, resolved,
      isRedemption,
      promoKey: null,
      clientPointsToAward: pointsToAward,
      points: pointsPlan,
      declaredMethod: body.declared_payment_method,
      declaredPhone: body.declared_payment_phone,
    });

    if (pointsPlan) {
      await applyRedemption(client, { clientId, orgId, washId: wash.id, pointsUsed: pointsPlan.pointsUsed });
    }

    await client.query('COMMIT');

    const dispatchCfg = await getDispatchConfig(pool, orgId);
    await tellBranchWorkers(body.branch_id, [{ wash, resolved }]);

    res.status(201).json({
      ok: true,
      data: {
        wash_id: wash.id,
        job_no: wash.job_no,
        status: 'requested',
        auto_assign_at: autoAssignAt(wash, dispatchCfg.accept_window_seconds),
        quoted_amount_ugx: resolved.priceUgx,
        service_name: resolved.service.name,
        vehicle_class_name: resolved.vehicleClass.name,
        is_redemption: isRedemption,
        points_used: pointsPlan?.pointsUsed ?? 0,
        points_value_ugx: pointsPlan?.valueUgx ?? 0,
        // What the client still has to pay after points. A free wash owes
        // nothing regardless.
        amount_due_ugx: isRedemption ? 0 : resolved.priceUgx - (pointsPlan?.valueUgx ?? 0),
        client_points_to_award: pointsToAward,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// POST /me/washes/promo — "wash 2 cars for the price of 1"
//
// One booking, two cars, one branch. The dearer car is charged at its own
// price and the other is free; on a tie the first car is the one charged.
// Each car is its own wash — its own job number, possibly its own worker —
// and the promo_redemptions row written here links them: it is the record
// that the offer was taken (one per client, ever, unless a cancellation
// hands it back — loyalty.releasePromoPair).
//
// Points don't combine with the offer (the owner's call), so there is no
// use_points here; the free car earns nothing, the charged car earns its
// wash type's points as usual.
const promoBookSchema = z.object({
  branch_id: z.string().uuid(),
  cars: z.array(carSchema).length(2),
  declared_payment_method: z.enum(['cash', 'mtn', 'airtel']).optional(),
  declared_payment_phone: z.string().max(20).optional(),
});

router.post('/promo', async (req: Request, res: Response, next: NextFunction) => {
  if (!req.actor || req.actor.type !== 'client') {
    next(createAppError(403, 'FORBIDDEN', 'Client access required'));
    return;
  }

  const pool = getPool();
  const clientId = req.actor.sub;

  let body: z.infer<typeof promoBookSchema>;
  try {
    body = promoBookSchema.parse(req.body);
  } catch (err: any) {
    next(createAppError(400, 'VALIDATION_ERROR', 'Request validation failed', err.errors));
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const branch = await bookableBranch(client, body.branch_id);
    const orgId = branch.org_id;
    await client.query(`SELECT id FROM clients WHERE id = $1 FOR UPDATE`, [clientId]);

    // Taken already — a clean conflict, never a UNIQUE violation surfacing
    // as a 500. The lock above means two attempts at once queue here.
    const taken = await client.query(
      `SELECT id FROM promo_redemptions WHERE client_id = $1 AND promo_key = $2`,
      [clientId, PROMO_KEY]
    );
    if (taken.rows.length > 0) {
      throw createAppError(409, 'PROMO_CONFLICT', 'You have already used this offer');
    }

    const resolved = [
      await resolveCar(client, orgId, body.branch_id, body.cars[0]),
      await resolveCar(client, orgId, body.branch_id, body.cars[1]),
    ];
    const paidIndex = resolved[1].priceUgx > resolved[0].priceUgx ? 1 : 0;

    // Inserted in the order the client listed them, so the job numbers
    // read car 1, car 2. The declared payment method belongs to the charged
    // car — the free one has nothing to pay.
    const washes = [];
    for (let i = 0; i < 2; i++) {
      const paid = i === paidIndex;
      washes.push(await insertBookedWash(client, {
        orgId, branch, clientId,
        resolved: resolved[i],
        isRedemption: !paid,
        promoKey: PROMO_KEY,
        clientPointsToAward: paid ? clientPointsFor(resolved[i]) : 0,
        declaredMethod: paid ? body.declared_payment_method : undefined,
        declaredPhone: paid ? body.declared_payment_phone : undefined,
      }));
    }
    const paidWash = washes[paidIndex];
    const freeWash = washes[1 - paidIndex];

    // 'armed' until the free car settles (loyalty.redeemPromo flips it to
    // 'used'). Either way the row existing means the offer is taken.
    await client.query(
      `INSERT INTO promo_redemptions (client_id, org_id, started_wash_id, free_wash_id)
       VALUES ($1, $2, $3, $4)`,
      [clientId, orgId, paidWash.id, freeWash.id]
    );

    await client.query('COMMIT');

    const dispatchCfg = await getDispatchConfig(pool, orgId);
    await tellBranchWorkers(body.branch_id, washes.map((wash, i) => ({ wash, resolved: resolved[i] })));

    res.status(201).json({
      ok: true,
      data: {
        washes: washes.map((wash, i) => ({
          wash_id: wash.id,
          job_no: wash.job_no,
          status: 'requested',
          plate: wash.plate,
          service_name: resolved[i].service.name,
          vehicle_class_name: resolved[i].vehicleClass.name,
          quoted_amount_ugx: resolved[i].priceUgx,
          is_redemption: i !== paidIndex,
          amount_due_ugx: i === paidIndex ? resolved[i].priceUgx : 0,
        })),
        paid_wash_id: paidWash.id,
        free_wash_id: freeWash.id,
        auto_assign_at: autoAssignAt(paidWash, dispatchCfg.accept_window_seconds),
        // What the client pays for the pair: the dearer car's price.
        amount_due_ugx: resolved[paidIndex].priceUgx,
        client_points_to_award: clientPointsFor(resolved[paidIndex]),
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
    // receipt_no is kept if already set (re-declaring a method keeps the
    // same receipt). A fresh one can collide with the unique index in
    // theory, so retry a few times on 23505 before giving up.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const result = await pool.query(
          `UPDATE washes
              SET declared_payment_method = $1, declared_payment_phone = $2,
                  receipt_no = COALESCE(receipt_no, $5), updated_at = now()
            WHERE id = $3 AND client_id = $4 AND status IN ('requested', 'in_progress', 'ready')
            RETURNING id, receipt_no`,
          [body.method, body.phone || null, req.params.id, req.actor.sub, generateReceiptNo()]
        );
        if (result.rows.length === 0) {
          next(createAppError(404, 'NOT_FOUND', 'Wash not found, not yours, or already closed'));
          return;
        }
        res.json({ ok: true, data: { id: result.rows[0].id, receipt_no: result.rows[0].receipt_no } });
        return;
      } catch (err: any) {
        if (err?.code !== '23505' || attempt === 4) throw err;
      }
    }
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

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE washes
          SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'client_cancelled', updated_at = now()
        WHERE id = $1 AND client_id = $2 AND status = 'requested' AND started_by_worker_id IS NULL
        RETURNING id`,
      [req.params.id, req.actor.sub]
    );
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      next(createAppError(409, 'BAD_STATE', 'This booking can no longer be cancelled — it may already have been accepted'));
      return;
    }

    // If this car was one of a 2-for-1 pair, the other carries on at its
    // own price and the offer comes back — same as the staff cancel route.
    await releasePromoPair(client, String(req.params.id));

    // Points spent on this booking go back: no wash, no charge. Same
    // transaction as the cancel, so a booking is never cancelled with its
    // points still gone.
    const pointsRefunded = await refundForWash(client, {
      washId: String(req.params.id), reason: 'Booking cancelled by client', createdBy: req.actor.sub,
    });

    await client.query('COMMIT');
    res.json({ ok: true, data: { id: result.rows[0].id, points_refunded: pointsRefunded } });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
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

// GET /me/washes/points — the client's points balance and what it is worth
//
// Scoped to the organisation on the client's token: points one car wash
// company gave away are only spendable at that company.
router.get('/points', async (req: Request, res: Response, next: NextFunction) => {
  if (!req.actor || req.actor.type !== 'client') {
    next(createAppError(403, 'FORBIDDEN', 'Client access required'));
    return;
  }
  const orgId = req.actor.org_id;
  if (!orgId) {
    next(createAppError(409, 'NO_ORG', 'Your account is not linked to a car wash yet'));
    return;
  }
  const client = await getPool().connect();
  try {
    const cfg = await getPointsConfig(client, orgId);
    const acct = await getAccount(client, req.actor.sub, orgId);
    res.json({
      ok: true,
      data: {
        enabled: cfg.enabled,
        balance: acct.balance,
        point_value_ugx: cfg.point_value_ugx,
        worth_ugx: acct.balance * cfg.point_value_ugx,
        lifetime_earned: acct.lifetime_earned,
        lifetime_redeemed: acct.lifetime_redeemed,
      },
    });
  } catch (err) {
    next(err);
  } finally {
    client.release();
  }
});

// GET /me/washes/points/ledger — why the balance is what it is
router.get('/points/ledger', async (req: Request, res: Response, next: NextFunction) => {
  if (!req.actor || req.actor.type !== 'client') {
    next(createAppError(403, 'FORBIDDEN', 'Client access required'));
    return;
  }
  try {
    const result = await getPool().query(
      `SELECT l.entry_type, l.points_delta, l.balance_after, l.reason, l.created_at,
              w.job_no, svc.name AS service_name
         FROM client_points_ledger l
         LEFT JOIN washes w ON w.id = l.wash_id
         LEFT JOIN services svc ON svc.id = w.service_id
        WHERE l.client_id = $1 AND l.org_id = $2
        ORDER BY l.seq DESC LIMIT 50`,
      [req.actor.sub, req.actor.org_id]
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// GET /me/qr was removed along with the member code. It existed so a client
// could show their own QR for a worker to scan; booking is self-service now
// (the client scans the branch's wall QR instead), so nothing consumed it.

export default router;
