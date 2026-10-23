import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';
import { resolvePrice } from '@/modules/pricing/resolvePrice';
import { notify } from '@/modules/notify';
import { bumpJobNo } from '@/modules/washes/washRoutes';
import { dispatchOverdue, getConfig as getDispatchConfig } from '@/modules/dispatch';
import { generateReceiptNo } from '@/utils/receiptNo';
import { planRedemption, applyRedemption, refundForWash, getAccount, getConfig as getPointsConfig } from '@/modules/clientPoints';

// The one promo the platform ships. Constant rather than config: there is a
// single offer on the home screen, and the promo_redemptions.promo_key
// DEFAULT matches it, so a rename would be a migration, not a settings
// flip.
export const PROMO_KEY = 'wash2_price1';

const router = Router();

// GET /me/washes/active — client's live wash in progress
router.get('/active', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.actor || req.actor.type !== 'client') {
      next(createAppError(403, 'FORBIDDEN', 'Client access required'));
      return;
    }

    const pool = getPool();

    // A client watching their booking's countdown should see it assigned
    // the moment the window ends, not whenever the background tick runs.
    const waiting = await pool.query(
      `SELECT DISTINCT branch_id FROM washes WHERE client_id = $1 AND status = 'requested'`,
      [req.actor.sub]
    );
    for (const row of waiting.rows) await dispatchOverdue(pool, { branchId: row.branch_id });

    const result = await pool.query(
      // is_redemption tells the app this wash costs nothing, so it can skip
      // the whole payment flow instead of quoting a price the client owes.
      // 'requested' is included so a client sees their own booking on this
      // screen from the moment they confirm it — before this, a client had
      // nothing to poll between tapping "book" and a worker accepting.
      `SELECT w.id, w.job_no, w.receipt_no, w.status, w.quoted_amount_ugx, w.started_at,
              w.requested_at, w.is_redemption, w.declared_payment_method,
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
// The client's own one-time offer, as the card should render it:
//  - { used: true }                      → the offer is spent entirely.
//  - { used: false, active_wash: true }  → grabbed, paid wash still running.
//  - { used: false, active_wash: false } → grabbed, next wash is free.
//  - { used: false, available: true }    → not yet grabbed.
// Anything that exists as a row means the client grabbed it — status moves
// armed → used, never backwards — and the UNIQUE(client_id) is what makes
// the offer strictly one-time per client, enforced by the database itself.
router.get('/promo', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.actor || req.actor.type !== 'client') {
      next(createAppError(403, 'FORBIDDEN', 'Client access required'));
      return;
    }

    const pool = getPool();
    const result = await pool.query(
      `SELECT r.status, r.free_wash_id, r.created_at,
              (w.id IS NOT NULL) AS started_wash_active
         FROM promo_redemptions r
         LEFT JOIN washes w
           ON w.id = r.started_wash_id
          AND w.status IN ('requested', 'in_progress', 'ready')
        WHERE r.client_id = $1 AND r.promo_key = $2`,
      [req.actor.sub, PROMO_KEY]
    );

    const row = result.rows[0];
    if (!row) {
      res.json({ ok: true, data: { promo_key: PROMO_KEY, used: false, available: true } });
      return;
    }

    res.json({
      ok: true,
      data: {
        promo_key: PROMO_KEY,
        used: row.status === 'used',
        available: false,
        active_wash: row.status === 'armed' && row.started_wash_active,
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
  // Grabbed "wash 2 for the price of 1": this booking is the PAID first
  // wash of the offer, which arms the client's next free one at settlement.
  use_promo: z.boolean().optional().default(false),
  // The armed free wash itself — booked at zero cost. Server-side promo
  // state is the source of truth; this flag only tells the server the
  // client INTENDS to spend it now.
  use_promo_free: z.boolean().optional().default(false),
  // "Use my points": spend the client's points against this wash's price.
  // Deducted inside the booking transaction, refunded if it is cancelled.
  use_points: z.boolean().optional().default(false),
  declared_payment_method: z.enum(['cash', 'mtn', 'airtel']).optional(),
  declared_payment_phone: z.string().max(20).optional(),
}).refine((b) => !(b.use_points && (b.use_free_wash || b.use_promo_free)), {
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

    // A client should not have two simultaneous active washes — one car at
    // a time. This used to check only status='requested' (a double-tap of
    // "book" queuing a second unclaimed request), but once a booking can be
    // auto-assigned straight to 'in_progress' that check no longer covers
    // the case that actually matters: a client with a wash already being
    // washed booking a second one before the first is even done.
    //
    // The client's own row is locked first. Without it two bookings sent at
    // the same moment (a double-tap, a retry) both passed this check before
    // either committed, and the client ended up with two active washes.
    await client.query(`SELECT id FROM clients WHERE id = $1 FOR UPDATE`, [clientId]);
    const already = await client.query(
      `SELECT id FROM washes WHERE client_id = $1 AND status IN ('requested', 'in_progress', 'ready')`,
      [clientId]
    );
    if (already.rows.length > 0) {
      await client.query('ROLLBACK');
      next(createAppError(409, 'ALREADY_REQUESTED', 'You already have a wash in progress'));
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
      `SELECT id, name, earns_point, client_points_awarded, worker_points_awarded FROM services
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

    // ── Promo state resolution ──
    // The grabbed-but-unspent offer is a fact about the CLIENT (a row in
    // promo_redemptions), not about what the request body claims, so the
    // row itself is read (and locked) here whenever either promo flag is
    // sent. The body flags only ever express intent; a stale client can
    // never conjure a discount the database does not owe.
    const promoRow = body.use_promo || body.use_promo_free
      ? await client.query(
          `SELECT id, status FROM promo_redemptions
            WHERE client_id = $1 AND promo_key = $2
            FOR UPDATE`,
          [clientId, PROMO_KEY]
        )
      : null;
    // A query that RAN but found no row (fresh client) is not the same as
    // the query not being needed at all — both mean "the offer is ungrabbed".
    const promoExists = !!promoRow && promoRow.rows.length > 0;
    const armed = promoExists && promoRow!.rows[0].status === 'armed';
    const isPromoStart = !!body.use_promo && !promoExists;
    const isPromoFree = !!body.use_promo_free && armed;

    // Grabbing with any row already in place — armed or used — is a clean
    // conflict, never a UNIQUE violation bubbling up as a 500. The offer is
    // one-time per client, forever: a used row is never re-armed.
    if (body.use_promo && !isPromoStart) {
      await client.query('ROLLBACK');
      next(createAppError(409, 'PROMO_CONFLICT', 'This offer has already been claimed on your account'));
      return;
    }

    // The client believes their next wash is free but the armed row is gone
    // (used from another device, or unwound by a cancellation) — fail loudly
    // rather than silently booking a wash at full price they expected to be
    // free. The client app offers a normal rebook on this code.
    if (body.use_promo_free && !armed) {
      await client.query('ROLLBACK');
      next(createAppError(409, 'PROMO_UNAVAILABLE', 'Your free promo wash is not available — it may have been used already'));
      return;
    }

    // Free-wash check — same "check credits, don't consume yet" rule as the
    // worker-initiated flow; the credit is only actually spent at settlement.
    // Mutually exclusive with the promo by schema contract: is_promo_free
    // (an already-paid reward) and use_free_wash (a banked credit) are never
    // both sent, and if a client sends both anyway the promo wins — a reward
    // the client has already paid for must not silently burn a credit too.
    let isRedemption = false;
    if (isPromoFree) {
      isRedemption = true;
    } else if (body.use_free_wash) {
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

    // Points to award at settlement, frozen now like the price: a settings
    // change later affects new bookings only.
    const pointsToAward = service.earns_point ? Number(service.client_points_awarded) : 0;

    // "Use my points": worked out (and the account locked) before the wash
    // exists, deducted against it right after the insert, all in this one
    // transaction — so two bookings can never spend the same points.
    const priceUgx = Number(price.price_ugx);
    let pointsPlan: { pointsUsed: number; valueUgx: number; pointValueUgx: number } | null = null;
    if (body.use_points) {
      try {
        pointsPlan = await planRedemption(client, { clientId, orgId, priceUgx });
      } catch (err) {
        await client.query('ROLLBACK');
        next(err);
        return;
      }
    }

    const jobNo = await bumpJobNo(client, body.branch_id, branch.code);

    const washResult = await client.query(
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
        orgId, body.branch_id, clientId,
        body.plate || null, body.vehicle_color || null,
        resolvedServiceId, body.vehicle_class_id, price.price_id,
        price.price_ugx, isRedemption, service.earns_point,
        jobNo,
        body.declared_payment_method || null, body.declared_payment_phone || null,
        // The offer's washes carry the key so app copy can distinguish a
        // promo reward from a credit redemption; NULL for plain bookings.
        (isPromoStart || isPromoFree) ? PROMO_KEY : null,
        pointsToAward,
        pointsPlan?.pointsUsed ?? 0,
        pointsPlan?.valueUgx ?? 0,
        pointsPlan?.pointValueUgx ?? null,
        // What the worker who washes it will earn, frozen from Settings now.
        Number(service.worker_points_awarded),
      ]
    );
    const wash = washResult.rows[0];

    if (pointsPlan) {
      await applyRedemption(client, { clientId, orgId, washId: wash.id, pointsUsed: pointsPlan.pointsUsed });
    }

    // Arming happens HERE, inside the booking transaction: the offer is
    // only armed by a booking that reached this point having passed the
    // price/full-price checks above. The insertion happens after the wash
    // row so started_wash_id can point at it. The armed reward is granted
    // once the paid wash settles (settleWash → markPromoStarted); the row
    // already existing now means a grab can never race itself.
    let promoRedemptionId: string | null = null;
    if (isPromoStart) {
      // UNIQUE(client_id) is the one-time guarantee: a second grab (or a
      // double-tap) violates the constraint and the whole booking fails.
      const promoInsert = await client.query(
        `INSERT INTO promo_redemptions (client_id, org_id, started_wash_id)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [clientId, orgId, wash.id]
      );
      promoRedemptionId = promoInsert.rows[0].id;
    } else if (isPromoFree) {
      // Point the armed offer at the free wash it is being spent on now.
      // Status stays 'armed' — only settlement flips it to 'used', so a
      // cancelled free wash leaves the reward intact.
      await client.query(
        `UPDATE promo_redemptions
            SET free_wash_id = $2
          WHERE client_id = $1 AND status = 'armed'`,
        [clientId, wash.id]
      );
    }

    await client.query('COMMIT');

    // The booking now waits for its accept window: every worker on shift
    // here is told, the first eligible one to tap Accept gets it, and if
    // nobody does the dispatcher assigns it (modules/dispatch). Told after
    // commit so a slow push never holds the booking open.
    const finalStatus = 'requested';
    const dispatchCfg = await getDispatchConfig(pool, orgId);
    const openShiftWorkers = await pool.query(
      `SELECT DISTINCT s.worker_id FROM shifts s JOIN staff_users su ON su.id = s.worker_id
        WHERE s.branch_id = $1 AND s.status = 'open' AND su.role = 'worker'`,
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
        status: finalStatus,
        // When the dispatcher will assign it if no worker has accepted.
        auto_assign_at: new Date(new Date(wash.requested_at).getTime() + dispatchCfg.accept_window_seconds * 1000),
        quoted_amount_ugx: Number(wash.quoted_amount_ugx),
        service_name: service.name,
        vehicle_class_name: vehicleClass.name,
        is_redemption: isRedemption,
        is_promo_free: isPromoFree,
        promo_earned: isPromoStart,
        points_used: pointsPlan?.pointsUsed ?? 0,
        points_value_ugx: pointsPlan?.valueUgx ?? 0,
        // What the client still has to pay after points. A free wash owes
        // nothing regardless.
        amount_due_ugx: isRedemption ? 0 : priceUgx - (pointsPlan?.valueUgx ?? 0),
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

    // Same promo unwinding as the staff cancel route: the paid wash of a
    // grab is gone before anyone ever worked on it, so the armed row must
    // not survive — the client must be able to grab again, and an armed row
    // whose paid wash never settled must never be spendable as a free wash.
    await client.query(
      `DELETE FROM promo_redemptions
        WHERE started_wash_id = $1 AND status = 'armed' AND free_wash_id IS NULL`,
      [req.params.id]
    );

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
