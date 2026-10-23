import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';
import { requireRole, getOrgId } from '@/middleware/requireRole';
import { consumeToken, hashToken } from '@/modules/tokens/tokenRoutes';
import { processSettlement, ensureAccount, hasArmedPromo, redeemPromo } from '@/modules/loyalty';
import { awardForSettlement as awardWorkerPoints } from '@/modules/workerPoints';
import { awardForSettlement as awardClientPoints, refundForWash as refundClientPoints } from '@/modules/clientPoints';
import { commissionFor, recordSettlement as recordWalletSettlement } from '@/modules/wallet';
import { acceptCheck, requiredPointsFor, dispatchOverdue, getConfig as getDispatchConfig } from '@/modules/dispatch';
import { notify } from '@/modules/notify';
import { generateReceiptNo } from '@/utils/receiptNo';

const router = Router();

// ─── helpers ──────────────────────────────────────────────────

async function getOpenShift(pool: any, workerId: string, branchId: string): Promise<any | null> {
  // The branch's commission rate rides along: settlement freezes the
  // worker's cut onto the wash, and reading it here avoids a second query
  // inside the settle transaction.
  const r = await pool.query(
    `SELECT s.id, b.worker_commission_bp
       FROM shifts s
       JOIN branches b ON b.id = s.branch_id
      WHERE s.worker_id = $1 AND s.branch_id = $2 AND s.status = 'open'`,
    [workerId, branchId]
  );
  return r.rows.length > 0 ? r.rows[0] : null;
}

// Instant auto-assign (tryAutoAssign) was replaced by modules/dispatch: a
// booking now waits for its accept window, then the dispatcher assigns it.

export async function bumpJobNo(pool: any, branchId: string, branchCode: string): Promise<string> {
  const r = await pool.query(
    `INSERT INTO branch_counters (branch_id, day, last_job_seq)
     VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (branch_id, day) DO UPDATE SET last_job_seq = branch_counters.last_job_seq + 1
     RETURNING last_job_seq`,
    [branchId]
  );
  const seq = r.rows[0].last_job_seq;
  return `${branchCode}-${seq}`;
}

// ─── POST /washes — Start a wash ─────────────────────────────

const startSchema = z.object({
  start_token: z.string().optional(),
  service_id: z.string().uuid().optional(),
  vehicle_class_id: z.string().uuid(),
  plate: z.string().optional(),
  // Captured on the car-details step: two identical silver saloons in the
  // yard are told apart by colour, not by plate the worker cannot see.
  vehicle_color: z.string().max(40).optional(),
  use_free_wash: z.boolean().optional().default(false),
});

router.post('/', requireRole('orgadmin', 'manager', 'worker'), async (req: Request, res: Response, next: NextFunction) => {
  const pool = getPool();
  const orgId = getOrgId(req.actor!);
  const workerId = req.actor!.sub;
  const branchId = req.actor!.branch_id;

  if (!branchId) {
    next(createAppError(400, 'NO_BRANCH', 'Staff must have a branch to start a wash'));
    return;
  }

  // Use raw query for transactional start
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Idempotency check
    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    if (idempotencyKey) {
      const existing = await client.query(
        `SELECT id, job_no FROM washes WHERE started_by_worker_id = $1 AND idempotency_key = $2`,
        [workerId, idempotencyKey]
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK');
        res.status(200).json({ ok: true, data: { wash_id: existing.rows[0].id, job_no: existing.rows[0].job_no, message: 'Already started' } });
        return;
      }
    }

    // 2. Open shift check
    const shift = await getOpenShift(client, workerId, branchId);
    if (!shift) {
      await client.query('ROLLBACK');
      next(createAppError(409, 'NO_OPEN_SHIFT', 'You need an open shift to start a wash'));
      return;
    }

    // 3. Resolve service (default if omitted)
    //
    // Catalogue is branch-scoped: a type is either org-wide (branch_id NULL)
    // or private to one branch. Every lookup below therefore has to accept
    // both, and reject another branch's private type — otherwise a worker
    // could start a wash against a car type their branch does not offer, and
    // one with no price at their branch at that.
    let serviceId = req.body.service_id;
    if (!serviceId) {
      // A branch's own default wins over the org-wide one: if this branch
      // has defined its own services, the org default may not even be on
      // offer here. ORDER BY puts the branch-specific row first.
      const svcResult = await client.query(
        `SELECT id FROM services
         WHERE org_id = $1 AND is_default AND active
           AND (branch_id IS NULL OR branch_id = $2)
         ORDER BY branch_id NULLS LAST
         LIMIT 1`,
        [orgId, branchId]
      );
      if (svcResult.rows.length === 0) {
        await client.query('ROLLBACK');
        next(createAppError(422, 'NO_DEFAULT_SERVICE', 'No default service configured'));
        return;
      }
      serviceId = svcResult.rows[0].id;
    }

    // Validate service
    const svcCheck = await client.query(
      `SELECT id, name, earns_point, client_points_awarded, worker_points_awarded FROM services
       WHERE id = $1 AND org_id = $2 AND active
         AND (branch_id IS NULL OR branch_id = $3)`,
      [serviceId, orgId, branchId]
    );
    if (svcCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      next(createAppError(404, 'SERVICE_NOT_FOUND', 'Service not found or not offered at this branch'));
      return;
    }
    const service = svcCheck.rows[0];

    // Validate vehicle class
    const vcCheck = await client.query(
      `SELECT id, name FROM vehicle_classes
       WHERE id = $1 AND org_id = $2 AND active
         AND (branch_id IS NULL OR branch_id = $3)`,
      [req.body.vehicle_class_id, orgId, branchId]
    );
    if (vcCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      next(createAppError(404, 'VEHICLE_CLASS_NOT_FOUND', 'Car type not found or not offered at this branch'));
      return;
    }
    const vehicleClass = vcCheck.rows[0];

    // 4. Resolve price
    const priceResult = await client.query(
      `SELECT id, price_ugx FROM prices
       WHERE service_id = $1 AND vehicle_class_id = $2 AND active
         AND (branch_id = $3 OR branch_id IS NULL)
       ORDER BY branch_id NULLS LAST
       LIMIT 1`,
      [serviceId, req.body.vehicle_class_id, branchId]
    );
    if (priceResult.rows.length === 0 || !priceResult.rows[0].price_ugx) {
      await client.query('ROLLBACK');
      next(createAppError(422, 'NO_PRICE_SET', `No price set for ${service.name} + ${vehicleClass.name}`, {
        service_name: service.name,
        vehicle_class_name: vehicleClass.name,
      }));
      return;
    }
    const price = priceResult.rows[0];

    // 5. Consume start token if provided
    let clientId: string | null = null;
    let startVerified = false;
    let clientAttachMethod: string | null = null;

    if (req.body.start_token) {
      const tokenHash = hashToken(req.body.start_token);
      const consumed = await consumeToken(client, tokenHash, 'start', workerId);
      if (!consumed) {
        await client.query('ROLLBACK');
        next(createAppError(409, 'BAD_TOKEN', 'Invalid or expired start token'));
        return;
      }
      clientId = consumed.client_id;
      startVerified = true;
      clientAttachMethod = 'start_token';

      // Validate client belongs to same org
      const clientCheck = await client.query(
        `SELECT id FROM clients WHERE id = $1 AND org_id = $2`,
        [clientId, orgId]
      );
      if (clientCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        next(createAppError(409, 'WRONG_ORG', 'This client belongs to a different organization'));
        return;
      }
    }

    // 6. Free wash check
    let isRedemption = false;
    if (req.body.use_free_wash) {
      if (!clientId) {
        await client.query('ROLLBACK');
        next(createAppError(422, 'NO_CLIENT', 'Need a client attached to use free wash'));
        return;
      }
      // Check credits (don't consume yet — settlement consumes)
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

    // 7. Get branch code
    const branchResult = await client.query(`SELECT code FROM branches WHERE id = $1`, [branchId]);
    const branchCode = branchResult.rows[0].code;

    // 8. Bump job number
    const jobNo = await bumpJobNo(client, branchId, branchCode);

    // 9. Insert wash
    const washResult = await client.query(
      `INSERT INTO washes (
        org_id, branch_id, started_by_worker_id, started_shift_id,
        client_id, client_attach_method, plate, vehicle_color,
        service_id, vehicle_class_id, price_id,
        quoted_amount_ugx, is_redemption, earns_point,
        job_no, status, start_verified, idempotency_key, started_date,
        client_points_to_award, worker_points_to_award
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'in_progress',$16,$17, CURRENT_DATE, $18, $19)
      RETURNING *`,
      [
        orgId, branchId, workerId, shift.id,
        clientId, clientAttachMethod, req.body.plate || null,
        req.body.vehicle_color || null,
        serviceId, req.body.vehicle_class_id, price.id,
        price.price_ugx, isRedemption, service.earns_point,
        jobNo, startVerified, idempotencyKey || null,
        // Frozen like the price. Awarded at settlement only if a client is
        // attached by then (a walk-in can be attached later).
        service.earns_point ? Number(service.client_points_awarded) : 0,
        // The worker's points for this wash type, frozen the same way.
        Number(service.worker_points_awarded),
      ]
    );
    const wash = washResult.rows[0];

    // 10. Duplicate warning (non-blocking)
    let duplicateWarning: string | null = null;
    const dupCheck = await client.query(
      `SELECT COUNT(*) as cnt FROM washes
       WHERE branch_id = $1 AND vehicle_class_id = $2 AND service_id = $3
         AND status IN ('in_progress','ready')
         AND id <> $4
         AND (plate IS NULL OR plate = $5)`,
      [branchId, req.body.vehicle_class_id, serviceId, wash.id, req.body.plate || null]
    );
    if (parseInt(dupCheck.rows[0].cnt) > 0) {
      duplicateWarning = 'Possible duplicate: similar wash in queue';
    }

    // 11. Client loyalty info
    let loyaltyInfo: any = null;
    if (clientId) {
      const acct = await client.query(
        `SELECT wash_count, free_wash_credits FROM loyalty_accounts WHERE client_id = $1`,
        [clientId]
      );
      if (acct.rows.length > 0) {
        loyaltyInfo = acct.rows[0];
      }
    }

    await client.query('COMMIT');

    notify('client', clientId || '', 'wash_started', { wash_id: wash.id, job_no: jobNo });

    res.status(201).json({
      ok: true,
      data: {
        wash_id: wash.id,
        job_no: jobNo,
        quoted_amount_ugx: Number(wash.quoted_amount_ugx),
        service_name: service.name,
        vehicle_class_name: vehicleClass.name,
        client_name: clientId ? 'Attached' : null,
        is_redemption: isRedemption,
        loyalty: loyaltyInfo,
        duplicate_warning: duplicateWarning,
      },
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    // If it's our custom error, pass it through
    if (err.status) {
      next(err);
    } else {
      next(err);
    }
  } finally {
    client.release();
  }
});

// ─── GET /washes/queue — Worker's home screen ────────────────

router.get('/queue', requireRole('orgadmin', 'manager', 'worker'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const branchId = req.actor!.branch_id;
    if (!branchId) {
      next(createAppError(400, 'NO_BRANCH', 'Staff must have a branch'));
      return;
    }

    // Hand out any job whose accept window has passed before showing the
    // list, so the screen never shows a job as open after it should have
    // been assigned (the background tick may not have come round yet).
    await dispatchOverdue(pool, { branchId });

    // Get branch ready_alert_minutes
    const branchResult = await pool.query(
      `SELECT ready_alert_minutes FROM branches WHERE id = $1`,
      [branchId]
    );
    const readyAlertMin = branchResult.rows[0]?.ready_alert_minutes || 120;

    // Washing: in_progress rows at this branch
    const washingResult = await pool.query(
      `SELECT w.id, w.job_no, w.plate, w.quoted_amount_ugx, w.started_at,
              w.is_redemption, w.started_by_worker_id, w.worker_points_to_award,
              w.declared_payment_method, w.points_value_ugx,
              vc.name as vehicle_class_name, s.name as service_name,
              su.full_name as worker_name,
              c.full_name as client_name,
              EXTRACT(EPOCH FROM (now() - w.started_at)) / 60 as elapsed_minutes
       FROM washes w
       JOIN vehicle_classes vc ON w.vehicle_class_id = vc.id
       JOIN services s ON w.service_id = s.id
       JOIN staff_users su ON w.started_by_worker_id = su.id
       LEFT JOIN clients c ON w.client_id = c.id
       WHERE w.branch_id = $1 AND w.status = 'in_progress'
       ORDER BY w.started_at ASC`,
      [branchId]
    );

    // Ready: ready rows at this branch
    const readyResult = await pool.query(
      `SELECT w.id, w.job_no, w.plate, w.quoted_amount_ugx, w.wash_done_at,
              w.is_redemption, w.started_by_worker_id, w.worker_points_to_award,
              w.declared_payment_method, w.points_value_ugx,
              vc.name as vehicle_class_name, s.name as service_name,
              su.full_name as worker_name,
              c.full_name as client_name,
              EXTRACT(EPOCH FROM (now() - w.wash_done_at)) / 60 as elapsed_minutes
       FROM washes w
       JOIN vehicle_classes vc ON w.vehicle_class_id = vc.id
       JOIN services s ON w.service_id = s.id
       JOIN staff_users su ON w.started_by_worker_id = su.id
       LEFT JOIN clients c ON w.client_id = c.id
       WHERE w.branch_id = $1 AND w.status = 'ready'
       ORDER BY w.wash_done_at ASC`,
      [branchId]
    );

    const washing = washingResult.rows.map((r) => ({
      ...r,
      elapsed_minutes: Math.round((Date.now() - new Date(r.started_at).getTime()) / 60000),
    }));

    const ready = readyResult.rows.map((r) => ({
      ...r,
      elapsed_minutes: Math.round(parseFloat(r.elapsed_minutes) || 0),
      stale: (parseFloat(r.elapsed_minutes) || 0) > readyAlertMin,
    }));

    // Requested: client bookings nobody has accepted yet. Every worker at
    // the branch sees the whole list regardless of their own busy state —
    // only the accept endpoint itself gates who can actually claim one — so
    // this is a LEFT JOIN, not the INNER JOIN washing/ready use above:
    // started_by_worker_id is NULL here by definition, and an INNER JOIN
    // against it would silently return zero rows.
    const requestedResult = await pool.query(
      `SELECT w.id, w.job_no, w.plate, w.vehicle_color, w.quoted_amount_ugx,
              w.requested_at, w.is_redemption, w.declared_payment_method, w.worker_points_to_award,
              vc.name as vehicle_class_name, s.name as service_name,
              c.full_name as client_name,
              EXTRACT(EPOCH FROM (now() - w.requested_at)) / 60 as elapsed_minutes
       FROM washes w
       JOIN vehicle_classes vc ON w.vehicle_class_id = vc.id
       JOIN services s ON w.service_id = s.id
       LEFT JOIN clients c ON w.client_id = c.id
       WHERE w.branch_id = $1 AND w.status = 'requested' AND w.started_by_worker_id IS NULL
       ORDER BY w.requested_at ASC`,
      [branchId]
    );
    // Countdown and "can I take it?" for the caller, so the app can show a
    // timer on each job and grey out Accept rather than learn by a 409.
    const orgId = getOrgId(req.actor!);
    const dispatchCfg = await getDispatchConfig(pool, orgId);
    const rule = await acceptCheck(pool, { staffId: req.actor!.sub, role: req.actor!.role ?? '', branchId, orgId });
    const requested = requestedResult.rows.map((r) => {
      const waited = (Date.now() - new Date(r.requested_at).getTime()) / 1000;
      return {
        ...r,
        elapsed_minutes: Math.round(parseFloat(r.elapsed_minutes) || 0),
        auto_assign_at: new Date(new Date(r.requested_at).getTime() + dispatchCfg.accept_window_seconds * 1000),
        seconds_left: Math.max(0, Math.ceil(dispatchCfg.accept_window_seconds - waited)),
        can_accept: rule.allowed,
      };
    });

    res.json({
      ok: true,
      data: {
        washing, ready, requested,
        dispatch: {
          accept_window_seconds: dispatchCfg.accept_window_seconds,
          my_jobs: rule.myJobs,
          fewest_jobs_on_site: rule.fewestJobs,
          can_accept: rule.allowed,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /washes/:id/accept — Worker claims a client's request ──
//
// The client-booking counterpart of what used to be one act (a worker
// scanning a customer and creating the wash themselves). A 'requested' wash
// already exists with everything but a worker attached; accepting it is the
// moment started_by_worker_id is set for the first time — after that, every
// downstream function (wash-done, settle, handover) treats this wash
// identically to one a worker started the old way.

router.post('/:id/accept', requireRole('orgadmin', 'manager', 'worker'), async (req: Request, res: Response, next: NextFunction) => {
  const pool = getPool();
  const workerId = req.actor!.sub;
  const branchId = req.actor!.branch_id;

  if (!branchId) {
    next(createAppError(400, 'NO_BRANCH', 'Staff must have a branch to accept a wash'));
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const shift = await getOpenShift(client, workerId, branchId);
    if (!shift) {
      await client.query('ROLLBACK');
      next(createAppError(409, 'NO_OPEN_SHIFT', 'You need an open shift to accept a wash'));
      return;
    }

    // The fewest-jobs rule (modules/dispatch): nobody on site may have
    // fewer cars than the worker taking this one. Checked here, not as a
    // queue-visibility filter, so a busy worker still sees what's coming.
    const rule = await acceptCheck(client, {
      staffId: workerId, role: req.actor!.role ?? '', branchId, orgId: getOrgId(req.actor!),
    });
    if (!rule.allowed) {
      await client.query('ROLLBACK');
      next(createAppError(409, 'WORKER_BUSY',
        'Another worker has fewer cars right now — they get this one first',
        { your_jobs: rule.myJobs, fewest_jobs: rule.fewestJobs }));
      return;
    }

    // Experience gate for high-level cars — a no-op until that rule is
    // decided (see requiredPointsFor).
    const target = await client.query(
      `SELECT w.quoted_amount_ugx, w.vehicle_class_id, w.service_id, w.plate,
              COALESCE(a.lifetime_earned, 0) AS my_points
         FROM washes w LEFT JOIN worker_points_accounts a ON a.staff_id = $2
        WHERE w.id = $1`,
      [req.params.id, workerId]
    );
    if (target.rows[0] && req.actor!.role === 'worker'
        && Number(target.rows[0].my_points) < requiredPointsFor(target.rows[0])) {
      await client.query('ROLLBACK');
      next(createAppError(403, 'NOT_ENOUGH_POINTS', 'This car needs a more experienced worker'));
      return;
    }

    // Atomic claim — race-safe the same way consumeToken() is: two workers
    // accepting the same request at once, exactly one UPDATE matches.
    const claimed = await client.query(
      `UPDATE washes
          SET status = 'in_progress', started_by_worker_id = $1, started_shift_id = $2,
              started_at = now(), assigned_via = 'accept', updated_at = now()
        WHERE id = $3 AND branch_id = $4
          AND status = 'requested' AND started_by_worker_id IS NULL
        RETURNING id, job_no, client_id`,
      [workerId, shift.id, req.params.id, branchId]
    );

    if (claimed.rows.length === 0) {
      await client.query('ROLLBACK');
      const check = await pool.query(
        `SELECT status, branch_id, started_by_worker_id FROM washes WHERE id = $1`,
        [req.params.id]
      );
      if (check.rows.length === 0) {
        next(createAppError(404, 'NOT_FOUND', 'Wash not found'));
        return;
      }
      if (check.rows[0].branch_id !== branchId) {
        next(createAppError(409, 'WRONG_BRANCH', 'This request belongs to a different branch'));
        return;
      }
      next(createAppError(409, 'ALREADY_CLAIMED', 'Another worker already accepted this request'));
      return;
    }

    await client.query('COMMIT');
    const wash = claimed.rows[0];
    // Reuses wash_started rather than adding a near-duplicate event: from
    // the client's side, "a worker accepted" and "my wash started" are the
    // same moment, and that copy already fits.
    notify('client', wash.client_id || '', 'wash_started', { wash_id: wash.id, job_no: wash.job_no });
    res.json({ ok: true, data: { id: wash.id, status: 'in_progress', job_no: wash.job_no } });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ─── POST /washes/:id/wash-done — Mark ready ─────────────────

router.post('/:id/wash-done', requireRole('orgadmin', 'manager', 'worker'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { id } = req.params;
    const branchId = req.actor!.branch_id;

    if (!branchId) {
      next(createAppError(400, 'NO_BRANCH', 'Staff must have a branch'));
      return;
    }

    const result = await pool.query(
      `UPDATE washes SET status = 'ready', wash_done_at = now(), updated_at = now()
       WHERE id = $1 AND branch_id = $2 AND status = 'in_progress'
       RETURNING id, client_id, job_no`,
      [id, branchId]
    );

    if (result.rows.length === 0) {
      // Check if it exists but wrong state
      const check = await pool.query(`SELECT status, branch_id FROM washes WHERE id = $1`, [id]);
      if (check.rows.length === 0) {
        next(createAppError(404, 'NOT_FOUND', 'Wash not found'));
        return;
      }
      if (check.rows[0].branch_id !== branchId) {
        next(createAppError(409, 'WRONG_BRANCH', 'Wash is at a different branch'));
        return;
      }
      next(createAppError(409, 'BAD_STATE', `Wash is ${check.rows[0].status}, not in_progress`));
      return;
    }

    const wash = result.rows[0];
    notify('client', wash.client_id || '', 'ready_for_collection', { wash_id: wash.id, job_no: wash.job_no });

    res.json({ ok: true, data: { id: wash.id, status: 'ready', job_no: wash.job_no } });
  } catch (err) {
    next(err);
  }
});

// ─── POST /washes/settle-by-token — Default settle path ──────

const settleByTokenSchema = z.object({
  pay_token: z.string().min(1),
  handover_reason: z.string().optional(),
  handover_note: z.string().optional(),
  payment_method: z.enum(['cash', 'mtn', 'airtel']).optional(),
  payer_phone: z.string().max(20).optional(),
  payment_ref: z.string().max(64).optional(),
});

router.post('/settle-by-token', requireRole('orgadmin', 'manager', 'worker'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = settleByTokenSchema.parse(req.body);
    const pool = getPool();
    const workerId = req.actor!.sub;
    const branchId = req.actor!.branch_id;
    const orgId = getOrgId(req.actor!);

    if (!branchId) {
      next(createAppError(400, 'NO_BRANCH', 'Staff must have a branch'));
      return;
    }

    // Look the token up WITHOUT consuming it yet.
    //
    // It used to be consumed here, before settleWash ran. That transaction
    // can legitimately roll back — most often with HANDOVER_CONFIRM_REQUIRED,
    // when a different worker started the car — but the consume had already
    // committed outside it. The customer's QR was burnt by a settle that
    // never happened, so the retry (this time with a handover reason) failed
    // with "already used" and the customer had to generate a fresh code.
    const tokenHash = hashToken(body.pay_token);
    const found = await pool.query(
      `SELECT client_id, wash_id FROM client_tokens
       WHERE token_hash = $1 AND purpose = 'pay'
         AND consumed_at IS NULL AND expires_at > now()`,
      [tokenHash]
    );
    if (found.rows.length === 0) {
      next(createAppError(409, 'BAD_TOKEN', 'Invalid, expired, or already used pay token'));
      return;
    }
    const pending = found.rows[0];

    // settleWash marks it consumed inside its own transaction, so the token
    // survives a rollback and dies only with a settle that actually happened.
    await settleWash(pool, pending.wash_id!, {
      workerId,
      branchId,
      orgId,
      payTokenConsumed: true,
      consumeTokenHash: tokenHash,
      clientId: pending.client_id,
      handoverReason: body.handover_reason,
      handoverNote: body.handover_note,
      paymentMethod: body.payment_method,
      payerPhone: body.payer_phone,
      paymentRef: body.payment_ref,
    }, res, next);
  } catch (err) {
    next(err);
  }
});

// ─── POST /washes/:id/settle — Settle a specific job ─────────

const settleSchema = z.object({
  pay_token: z.string().optional(),
  unverified_reason: z.enum(['dead_phone', 'no_app', 'app_error']).optional(),
  handover_reason: z.enum(['starter_off_shift', 'starter_on_break', 'starter_phone_unusable', 'starter_left_for_day', 'other']).optional(),
  handover_note: z.string().optional(),
  // How the money arrived. Defaults to cash when omitted, which keeps every
  // existing caller working unchanged.
  payment_method: z.enum(['cash', 'mtn', 'airtel']).optional(),
  // The number a mobile money payment was requested from, for matching
  // against a statement later.
  payer_phone: z.string().max(20).optional(),
  payment_ref: z.string().max(64).optional(),
});

router.post('/:id/settle', requireRole('orgadmin', 'manager', 'worker'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = settleSchema.parse(req.body);
    const pool = getPool();
    const workerId = req.actor!.sub;
    const branchId = req.actor!.branch_id;
    const orgId = getOrgId(req.actor!);

    if (!branchId) {
      next(createAppError(400, 'NO_BRANCH', 'Staff must have a branch'));
      return;
    }

    // Validate: if no pay_token, must have unverified_reason
    if (!body.pay_token && !body.unverified_reason) {
      next(createAppError(422, 'REASON_REQUIRED', 'Either pay_token or unverified_reason is required'));
      return;
    }

    let payTokenConsumed = false;
    let clientId: string | null = null;

    if (body.pay_token) {
      // Consume pay token
      const tokenHash = hashToken(body.pay_token);
      const consumed = await consumeToken(pool, tokenHash, 'pay', workerId);
      if (!consumed) {
        next(createAppError(409, 'BAD_TOKEN', 'Invalid, expired, or already used pay token'));
        return;
      }
      payTokenConsumed = true;
      clientId = consumed.client_id;
    }

    await settleWash(pool, String(req.params.id), {
      workerId,
      branchId,
      orgId,
      payTokenConsumed,
      clientId,
      unverifiedReason: body.unverified_reason,
      handoverReason: body.handover_reason,
      handoverNote: body.handover_note,
      paymentMethod: body.payment_method,
      payerPhone: body.payer_phone,
      paymentRef: body.payment_ref,
    }, res, next);
  } catch (err) {
    next(err);
  }
});

// ─── Core settle logic (shared between settle-by-token and settle/:id) ───

interface SettleOpts {
  workerId: string;
  branchId: string;
  orgId: string;
  payTokenConsumed: boolean;
  /**
   * Pay token to mark consumed as part of this settle's transaction, so a
   * rollback leaves the customer's code still usable for the retry.
   */
  consumeTokenHash?: string;
  clientId: string | null;
  unverifiedReason?: string;
  handoverReason?: string;
  handoverNote?: string;
  /** Defaults to cash when not given, which is what it always was. */
  paymentMethod?: string;
  payerPhone?: string;
  paymentRef?: string;
}

async function settleWash(
  pool: any,
  washId: string,
  opts: SettleOpts,
  res: Response,
  next: NextFunction
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Lock the wash row
    const washResult = await client.query(
      `SELECT w.*, b.code as branch_code
       FROM washes w
       JOIN branches b ON w.branch_id = b.id
       WHERE w.id = $1 FOR UPDATE`,
      [washId]
    );

    if (washResult.rows.length === 0) {
      await client.query('ROLLBACK');
      next(createAppError(404, 'NOT_FOUND', 'Wash not found'));
      return;
    }

    const wash = washResult.rows[0];

    // 2. Must be ready
    if (wash.status !== 'ready') {
      await client.query('ROLLBACK');
      next(createAppError(409, 'BAD_STATE', `Wash is ${wash.status}, not ready`));
      return;
    }

    // 3. Open shift at same branch
    const shift = await getOpenShift(client, opts.workerId, opts.branchId);
    if (!shift) {
      await client.query('ROLLBACK');
      next(createAppError(409, 'NO_OPEN_SHIFT', 'You need an open shift to settle'));
      return;
    }

    if (wash.branch_id !== opts.branchId) {
      await client.query('ROLLBACK');
      next(createAppError(409, 'WRONG_BRANCH', 'Wash is at a different branch'));
      return;
    }

    // 4. Handover check: if caller didn't start this wash and no handover reason
    const isHandover = wash.started_by_worker_id !== opts.workerId;
    if (isHandover && !opts.handoverReason) {
      // Get starter's name for confirmation
      const starterResult = await client.query(
        `SELECT full_name FROM staff_users WHERE id = $1`,
        [wash.started_by_worker_id]
      );
      await client.query('ROLLBACK');
      next(createAppError(409, 'HANDOVER_CONFIRM_REQUIRED', 'Different worker started this wash. Provide handover_reason.', {
        starter_name: starterResult.rows[0]?.full_name,
        job_no: wash.job_no,
        // The scanning worker cannot see this job in their own list, so the
        // client has nothing to look the details up from — send enough to
        // put a name and job number in front of them.
        wash_id: washId,
      }));
      return;
    }

    // 5. Pay token client match check
    if (opts.payTokenConsumed && opts.clientId && wash.client_id) {
      if (opts.clientId !== wash.client_id) {
        await client.query('ROLLBACK');
        // Include the job details it belongs to
        const correctWash = await client.query(
          `SELECT w.job_no, w.status FROM washes w WHERE w.id = (SELECT wash_id FROM client_tokens WHERE client_id = $1 AND purpose = 'pay' AND consumed_at IS NOT NULL ORDER BY consumed_at DESC LIMIT 1)`,
          [opts.clientId]
        );
        next(createAppError(409, 'CLIENT_MISMATCH', 'Pay token belongs to a different client/job', {
          correct_job: correctWash.rows[0] || null,
        }));
        return;
      }
    }

    // 6. Settle
    //
    // What the client hands over is the price less whatever their points
    // already covered at booking. A wash covered entirely by points is its
    // own payment method — no money moved, but it wasn't free either.
    const pointsCoverUgx = Number(wash.points_value_ugx || 0);
    const amountUgx = wash.is_redemption ? 0 : Math.max(0, Number(wash.quoted_amount_ugx) - pointsCoverUgx);
    const fullyCoveredByPoints = !wash.is_redemption && Number(wash.points_used) > 0 && amountUgx === 0;
    const settleVerified = opts.payTokenConsumed;
    const paymentMethod = wash.is_redemption ? 'free'
      : fullyCoveredByPoints ? 'points'
      : (opts.paymentMethod || 'cash');

    // Worker commission, frozen onto the row at settlement.
    //
    // On the FULL price, for every payment method — cash, mobile money,
    // points, even a free wash: the worker did the same work either way,
    // and the business absorbs the discount. It goes into the wallet of the
    // worker who washed the car (see recordSettlement below), not kept out
    // of the cash, so a mobile-money wash pays the worker too.
    const commissionBp = Number(shift.worker_commission_bp || 0);
    const commissionUgx = commissionFor(Number(wash.quoted_amount_ugx), commissionBp);

    await client.query(
      `UPDATE washes SET
        status = 'settled',
        settled_at = now(),
        settled_by_worker_id = $1,
        settled_shift_id = $2,
        amount_ugx = $3,
        settle_verified = $4,
        unverified_reason = $5,
        handover_reason = $6,
        handover_note = $7,
        payment_method = $8,
        payer_phone = $9,
        payment_ref = $10,
        worker_commission_ugx = $12,
        worker_commission_bp = $13,
        updated_at = now()
       WHERE id = $11`,
      [
        opts.workerId,
        shift.id,
        amountUgx,
        settleVerified,
        opts.unverifiedReason || null,
        opts.handoverReason || null,
        opts.handoverNote || null,
        // A free wash is its own method: no money moved, so it should not
        // be counted as cash the worker is holding.
        paymentMethod,
        opts.payerPhone || null,
        opts.paymentRef || null,
        washId,
        commissionUgx,
        commissionBp,
      ]
    );

    // 7. Receipt number — keep the one the client already saw when they
    // declared a payment method; only generate if there isn't one yet.
    const receiptRes = await client.query(
      `UPDATE washes SET receipt_no = COALESCE(receipt_no, $1) WHERE id = $2 RETURNING receipt_no`,
      [generateReceiptNo(), washId]
    );
    const receiptNo: string = receiptRes.rows[0].receipt_no;

    // 8. Loyalty
    //
    // The "wash 2 for the price of 1" promo is checked FIRST and inside
    // this transaction: an is_redemption wash backed by an armed promo goes
    // to redeemPromo() — which burns NO credit and stamps NO extra wash —
    // instead of processSettlement's redemption branch, which would
    // otherwise decrement a real free_wash_credit the client earned.
    let promoRedeemed = false;
    if (wash.client_id && wash.promo_key && wash.is_redemption) {
      promoRedeemed = await hasArmedPromo(client, wash.client_id, wash.promo_key);
    }

    //
    // Points replaced the stamp card, so a paid wash no longer stamps
    // anything. processSettlement is still called for a free-wash credit
    // redemption, so credits clients earned under the old card stay
    // spendable — `earnsPoint` is passed false so it never stamps.
    let loyaltyResult: any = null;
    if (wash.client_id) {
      await ensureAccount(client, wash.client_id, opts.orgId);
      if (promoRedeemed) {
        loyaltyResult = await redeemPromo(client, wash.client_id, washId, opts.workerId);
      } else if (wash.is_redemption) {
        loyaltyResult = await processSettlement(
          client,
          wash.client_id,
          opts.orgId,
          washId,
          true,
          false,
          amountUgx,
          opts.workerId
        );
      }
    }

    // 8a. Client points — the number frozen onto the wash at booking. A
    // free wash (credit or promo) and a wash paid entirely with points earn
    // nothing.
    let clientPointsResult: { points: number; account: any } | null = null;
    if (wash.client_id && !wash.is_redemption) {
      clientPointsResult = await awardClientPoints(client, {
        clientId: wash.client_id,
        orgId: wash.org_id,
        washId,
        points: Number(wash.client_points_to_award || 0),
        fullyCoveredByPoints,
        createdBy: opts.workerId,
      });
    }

    // 8b. Worker points — the staff side of the same moment. Inside this
    // transaction on purpose: if the settlement rolls back the payout has
    // to roll back with it, or a worker keeps points for a wash that never
    // happened. A walk-in with no client_id still earns the worker points;
    // the work was done either way.
    //
    // Points are experience: they go to the worker who WASHED the car, and
    // are earned on every wash — paid with points, a free promo wash, a
    // credit — valued at the full price, because the work was the same.
    // They drive auto-assign priority and the leaderboard.
    const workerPointsResult = await awardWorkerPoints(client, {
      staffId: wash.started_by_worker_id,
      orgId: wash.org_id,
      washId,
      // Frozen at booking from the wash type's Settings value.
      points: Number(wash.worker_points_to_award ?? 0),
    });

    // 8c. Wallet — commission to the worker who washed, the cash against
    // the worker who took it. Same transaction, so a rolled-back settle
    // moves no money.
    const walletResult = await recordWalletSettlement(client, {
      washId,
      orgId: wash.org_id,
      starterId: wash.started_by_worker_id,
      settlerId: opts.workerId,
      commissionUgx,
      cashUgx: paymentMethod === 'cash' ? amountUgx : 0,
    });

    // Burn the customer's pay token as part of this transaction — see the
    // note in /settle-by-token. Guarded on consumed_at so two workers racing
    // the same code cannot both settle: the second update matches no row.
    if (opts.consumeTokenHash) {
      const burn = await client.query(
        `UPDATE client_tokens SET consumed_at = now(), consumed_by = $1
         WHERE token_hash = $2 AND purpose = 'pay'
           AND consumed_at IS NULL AND expires_at > now()`,
        [opts.workerId, opts.consumeTokenHash]
      );
      if (burn.rowCount === 0) {
        await client.query('ROLLBACK');
        next(createAppError(409, 'BAD_TOKEN', 'Invalid, expired, or already used pay token'));
        return;
      }
    }

    await client.query('COMMIT');

    // 9. Notifications (after commit)
    if (wash.client_id) {
      notify('client', wash.client_id, 'paid', {
        wash_id: washId, receipt_no: receiptNo, amount_ugx: amountUgx,
        points_earned: clientPointsResult?.points ?? 0,
        points_balance: clientPointsResult?.account?.balance,
      });
      if (loyaltyResult?.rewardGranted) {
        notify('client', wash.client_id, 'reward_earned', {
          free_wash_credits: loyaltyResult.account.free_wash_credits,
        });
      }
    }
    if (isHandover) {
      // Get starter name for notification
      const starterResult = await pool.query(`SELECT full_name FROM staff_users WHERE id = $1`, [wash.started_by_worker_id]);
      notify('staff', wash.started_by_worker_id, 'job_collected_by', {
        wash_id: washId, collected_by_name: starterResult.rows[0]?.full_name || 'another worker',
        job_no: wash.job_no, amount_ugx: amountUgx,
      });
    }
    if (promoRedeemed) {
      notify('client', wash.client_id, 'promo_used', { wash_id: washId, job_no: wash.job_no });
    }
    if (
      !promoRedeemed &&
      wash.client_id &&
      wash.promo_key &&
      wash.status === 'settled' &&
      !wash.is_redemption
    ) {
      // The paid wash of a promo just settled — the reward is earned.
      // Narrow on promo_key + not-redemption: a settled wash WITH the key
      // that was NOT free is the paid one, by construction. Guarded by the
      // same UPDATE predicate that flips the row, so re-settling (already
      // impossible — status gate above) or a plain booking with a stray key
      // cannot double-fire.
      notify('client', wash.client_id, 'promo_earned', { wash_id: washId, job_no: wash.job_no });
    }

    res.json({
      ok: true,
      data: {
        wash_id: washId,
        status: 'settled',
        receipt_no: receiptNo,
        amount_ugx: amountUgx,
        settle_verified: settleVerified,
        is_handover: isHandover,
        payment_method: paymentMethod,
        points_value_ugx: pointsCoverUgx,
        loyalty: loyaltyResult ? {
          wash_count: loyaltyResult.account.wash_count,
          free_wash_credits: loyaltyResult.account.free_wash_credits,
          reward_granted: loyaltyResult.rewardGranted,
        } : null,
        client_points: clientPointsResult ? {
          earned: clientPointsResult.points,
          balance: clientPointsResult.account.balance,
        } : null,
        worker_commission_ugx: commissionUgx,
        // The settling worker's wallet after this wash — negative while they
        // hold cash that is owed to the business.
        wallet_balance_ugx: (walletResult.settler ?? (wash.started_by_worker_id === opts.workerId ? walletResult.starter : null))
          ?.balance_ugx ?? null,
        // What this job earned the worker, so the app can show it on the
        // receipt the way the customer's stamp is shown. Null when the
        // scheme is off. Credited to the washer, who on a handover is not
        // the caller.
        worker_points: workerPointsResult ? {
          staff_id: wash.started_by_worker_id,
          earned: workerPointsResult.points,
          balance: workerPointsResult.account.points_balance,
        } : null,
      },
    });
  } catch (err: any) {
    await client.query('ROLLBACK');
    // Handle loyalty 422 errors (NO_CREDITS)
    if (err?.status === 422) {
      next(err);
    } else {
      next(err);
    }
  } finally {
    client.release();
  }
}

// ─── POST /washes/:id/cancel ─────────────────────────────────

const cancelSchema = z.object({
  reason: z.enum(['client_left', 'started_by_mistake', 'wrong_car_type_restart', 'client_refused_price', 'other']),
  note: z.string().optional(),
});

router.post('/:id/cancel', requireRole('orgadmin', 'manager', 'worker'), async (req: Request, res: Response, next: NextFunction) => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const body = cancelSchema.parse(req.body);
    await client.query('BEGIN');

    // 'requested' is cancellable too: bookings now wait for their accept
    // window, and a client who drives off before anyone takes the car has
    // to be cancellable by staff, not only by the client.
    //
    // Scoped to the caller's organisation always, and to their own branch
    // unless they are an org admin. This used to match on id alone, so
    // staff anywhere could cancel any organisation's wash by its id.
    const isOrgAdmin = req.actor!.role === 'orgadmin';
    const result = await client.query(
      `UPDATE washes SET
        status = 'cancelled',
        cancelled_at = now(),
        cancelled_by = $1,
        cancel_reason = $2,
        cancel_note = $3,
        updated_at = now()
       WHERE id = $4 AND status IN ('requested', 'in_progress', 'ready')
         AND org_id = $5 AND ($6::boolean OR branch_id = $7)
       RETURNING id, job_no, status`,
      [req.actor!.sub, body.reason, body.note || null, id,
       getOrgId(req.actor!), isOrgAdmin, req.actor!.branch_id ?? null]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      // Another organisation's wash reads as not found — its existence is
      // not this caller's business.
      const check = await pool.query(
        `SELECT status, branch_id FROM washes WHERE id = $1 AND org_id = $2`,
        [id, getOrgId(req.actor!)]
      );
      if (check.rows.length === 0) {
        next(createAppError(404, 'NOT_FOUND', 'Wash not found'));
        return;
      }
      if (!isOrgAdmin && check.rows[0].branch_id !== req.actor!.branch_id) {
        next(createAppError(409, 'WRONG_BRANCH', 'Wash is at a different branch'));
        return;
      }
      next(createAppError(409, 'BAD_STATE', `Cannot cancel wash in ${check.rows[0].status} status`));
      return;
    }

    // Promo unwinding: if a promo redemption still points its PAID wash at
    // this cancelled wash and the reward was never spent, the offer never
    // legitimately armed — the paid wash never settled — so the row goes
    // away and the client can grab the offer again. (The client's own
    // cancel-request route has the equivalent cleanup for not-yet-accepted
    // bookings.) Once used, immutable: the reward was consumed by a settled
    // wash, and no later cancellation rewrites history.
    await client.query(
      `DELETE FROM promo_redemptions
        WHERE started_wash_id = $1 AND status = 'armed' AND free_wash_id IS NULL`,
      [id]
    );

    // The client paid points for a wash they are not getting — give them
    // back, in the same transaction as the cancel.
    const pointsRefunded = await refundClientPoints(client, {
      washId: String(id), reason: `Wash cancelled: ${body.reason}`, createdBy: req.actor!.sub,
    });

    await client.query('COMMIT');
    res.json({ ok: true, data: { ...result.rows[0], points_refunded: pointsRefunded } });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ─── POST /washes/:id/attach-client ──────────────────────────

// The member_code lookup was removed with the member code itself — it was
// the old worker-typed-the-customer's-code path, replaced by self-service
// booking. A start token is now the only way to attach a customer.
const attachSchema = z.object({
  start_token: z.string().min(1),
  // Attaching late should still allow spending a saved credit, otherwise the
  // only way to redeem is to cancel the car and start it again.
  use_free_wash: z.boolean().optional().default(false),
});

router.post('/:id/attach-client', requireRole('orgadmin', 'manager', 'worker'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { id } = req.params;
    const body = attachSchema.parse(req.body);

    // Wash must exist and be in_progress
    const washResult = await pool.query(
      `SELECT id, client_id, status FROM washes WHERE id = $1`,
      [id]
    );
    if (washResult.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Wash not found'));
      return;
    }
    if (washResult.rows[0].status !== 'in_progress') {
      next(createAppError(409, 'BAD_STATE', 'Can only attach client to in-progress wash'));
      return;
    }
    if (washResult.rows[0].client_id) {
      next(createAppError(409, 'ALREADY_ATTACHED', 'Client already attached'));
      return;
    }

    const tokenHash = hashToken(body.start_token);
    const consumed = await consumeToken(pool, tokenHash, 'start', req.actor!.sub);
    if (!consumed) {
      next(createAppError(409, 'BAD_TOKEN', 'Invalid or expired start token'));
      return;
    }
    const clientId: string | null = consumed.client_id;
    const startVerified = true;
    const attachMethod = 'start_token';

    // Optionally spend a saved credit now that we know who the customer is.
    // The credit itself is consumed at settlement, exactly as it is when a
    // wash is started with use_free_wash — this only marks the wash.
    let isRedemption = false;
    if (body.use_free_wash) {
      const acct = await pool.query(
        `SELECT free_wash_credits FROM loyalty_accounts WHERE client_id = $1`,
        [clientId]
      );
      if (acct.rows.length === 0 || acct.rows[0].free_wash_credits < 1) {
        next(createAppError(422, 'NO_CREDITS', 'This customer has no free wash saved'));
        return;
      }
      isRedemption = true;
    }

    await pool.query(
      `UPDATE washes SET
        client_id = $1, client_attach_method = $2,
        client_attached_at = now(), start_verified = $3,
        is_redemption = $4, updated_at = now()
       WHERE id = $5`,
      [clientId, attachMethod, startVerified, isRedemption, id]
    );

    // Return the balance so the worker can be told what the customer has.
    const loyalty = await pool.query(
      `SELECT wash_count, free_wash_credits FROM loyalty_accounts WHERE client_id = $1`,
      [clientId]
    );

    res.json({
      ok: true,
      data: {
        wash_id: id,
        client_id: clientId,
        verified: startVerified,
        is_redemption: isRedemption,
        loyalty: loyalty.rows[0] || null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /washes/:id/apply-free-wash — convert an already-attached wash ───
//
// A customer's start-token identity is only known once it is consumed inside
// POST /washes, so the worker cannot see whether that customer has a saved
// credit until *after* the car is already started and linked. attach-client
// cannot help here because it refuses once a client is attached. This is the
// one-tap "use it now" for exactly that moment — no cancel-and-restart.
router.post('/:id/apply-free-wash', requireRole('orgadmin', 'manager', 'worker'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { id } = req.params;

    const washResult = await pool.query(
      `SELECT id, client_id, status, is_redemption FROM washes WHERE id = $1`,
      [id]
    );
    if (washResult.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Wash not found'));
      return;
    }
    const wash = washResult.rows[0];

    if (wash.status !== 'in_progress') {
      next(createAppError(409, 'BAD_STATE', 'Can only apply a free wash to an in-progress job'));
      return;
    }
    if (!wash.client_id) {
      next(createAppError(422, 'NO_CLIENT', 'This wash has no customer attached'));
      return;
    }
    if (wash.is_redemption) {
      next(createAppError(409, 'ALREADY_FREE', 'This wash is already free'));
      return;
    }

    const acct = await pool.query(
      `SELECT free_wash_credits FROM loyalty_accounts WHERE client_id = $1`,
      [wash.client_id]
    );
    if (acct.rows.length === 0 || acct.rows[0].free_wash_credits < 1) {
      next(createAppError(422, 'NO_CREDITS', 'This customer has no free wash saved'));
      return;
    }

    // The credit itself is consumed at settlement, exactly like every other
    // redemption path — this only marks the wash so settlement charges 0.
    await pool.query(`UPDATE washes SET is_redemption = true, updated_at = now() WHERE id = $1`, [id]);

    const loyalty = await pool.query(
      `SELECT wash_count, free_wash_credits FROM loyalty_accounts WHERE client_id = $1`,
      [wash.client_id]
    );

    res.json({
      ok: true,
      data: { wash_id: id, is_redemption: true, loyalty: loyalty.rows[0] || null },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /washes/mine/today — Worker's three figures ─────────

router.get('/mine/today', requireRole('orgadmin', 'manager', 'worker'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const workerId = req.actor!.sub;

    // Started by me, settled by me.
    // paid_count and free_count are mutually exclusive so the two figures on
    // the worker's card never double-count the same car: a free wash is not a
    // car they "got paid for". `count` stays as the combined total for any
    // existing caller.
    const byMe = await pool.query(
      `SELECT COUNT(*) as count,
              COALESCE(SUM(amount_ugx), 0) as total,
              COUNT(*) FILTER (WHERE is_redemption) as free_count,
              COUNT(*) FILTER (WHERE NOT is_redemption) as paid_count
       FROM washes WHERE started_by_worker_id = $1 AND settled_by_worker_id = $1
         AND started_at::date = CURRENT_DATE AND status = 'settled'`,
      [workerId]
    );

    // Started by me, settled by another
    const byOther = await pool.query(
      `SELECT w.id, w.job_no, w.amount_ugx, w.settled_at,
              su.full_name as settled_by_name, w.handover_reason
       FROM washes w
       JOIN staff_users su ON w.settled_by_worker_id = su.id
       WHERE w.started_by_worker_id = $1 AND w.settled_by_worker_id <> $1
         AND w.started_at::date = CURRENT_DATE AND w.status = 'settled'`,
      [workerId]
    );

    // Settled by me, started by another
    const iSettled = await pool.query(
      `SELECT w.id, w.job_no, w.amount_ugx, w.settled_at,
              su.full_name as started_by_name, w.handover_reason
       FROM washes w
       JOIN staff_users su ON w.started_by_worker_id = su.id
       WHERE w.settled_by_worker_id = $1 AND w.started_by_worker_id <> $1
         AND w.settled_at::date = CURRENT_DATE AND w.status = 'settled'`,
      [workerId]
    );

    res.json({
      ok: true,
      data: {
        started_and_settled_by_me: {
          count: parseInt(byMe.rows[0].count),
          total_amount_ugx: Number(byMe.rows[0].total),
          free_count: parseInt(byMe.rows[0].free_count),
          paid_count: parseInt(byMe.rows[0].paid_count),
        },
        started_by_me_settled_by_others: byOther.rows,
        settled_by_me_started_by_others: iSettled.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /washes/:id — Wash detail ───────────────────────────

router.get('/:id', requireRole('orgadmin', 'manager', 'worker'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { id } = req.params;

    // started_by_worker_id is nullable now (a client-booked wash that
    // nobody has accepted yet) — this must stay a LEFT JOIN, or a
    // 'requested' wash silently returns zero rows here.
    const result = await pool.query(
      `SELECT w.*,
              vc.name as vehicle_class_name, svc.name as service_name,
              sw.full_name as started_by_name,
              stw.full_name as settled_by_name,
              cb.full_name as cancelled_by_name,
              c.full_name as client_name
       FROM washes w
       JOIN vehicle_classes vc ON w.vehicle_class_id = vc.id
       JOIN services svc ON w.service_id = svc.id
       LEFT JOIN staff_users sw ON w.started_by_worker_id = sw.id
       LEFT JOIN staff_users stw ON w.settled_by_worker_id = stw.id
       LEFT JOIN staff_users cb ON w.cancelled_by = cb.id
       LEFT JOIN clients c ON w.client_id = c.id
       WHERE w.id = $1
         AND w.org_id = $2
         AND ($3::boolean OR w.branch_id = $4)`,
      // Scoped like every other org read: the caller's organisation always,
      // and a manager or worker only their own branch. This used to match
      // on id alone, so any signed-in staff member — including another
      // company's — could read a wash's client, amounts and staff by id.
      [id, getOrgId(req.actor!), req.actor!.role === 'orgadmin', req.actor!.branch_id ?? null]
    );

    if (result.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Wash not found'));
      return;
    }

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// ─── GET /washes — List (role-scoped) ────────────────────────

router.get('/', requireRole('orgadmin', 'manager', 'worker'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const orgId = getOrgId(req.actor!);

    // Same LEFT JOIN reasoning as GET /washes/:id above — a 'requested'
    // wash has no started_by_worker_id yet.
    let query = `
      SELECT w.id, w.job_no, w.status, w.plate, w.quoted_amount_ugx, w.amount_ugx,
             w.is_redemption, w.started_at, w.wash_done_at, w.settled_at, w.receipt_no,
             w.handover_reason, w.cancel_reason, w.created_at,
             vc.name as vehicle_class_name, svc.name as service_name,
             sw.full_name as started_by_name, stw.full_name as settled_by_name,
             c.full_name as client_name, b.name as branch_name
      FROM washes w
      JOIN vehicle_classes vc ON w.vehicle_class_id = vc.id
      JOIN services svc ON w.service_id = svc.id
      LEFT JOIN staff_users sw ON w.started_by_worker_id = sw.id
      JOIN branches b ON w.branch_id = b.id
      LEFT JOIN staff_users stw ON w.settled_by_worker_id = stw.id
      LEFT JOIN clients c ON w.client_id = c.id
      WHERE w.org_id = $1
    `;
    const params: any[] = [orgId];
    let paramIdx = 2;

    // Manager locked to own branch
    if (req.actor!.role === 'manager') {
      query += ` AND w.branch_id = $${paramIdx++}`;
      params.push(req.actor!.branch_id);
    }

    // Filters
    const { branch_id, worker_id, client_id, vehicle_class_id, status, from, to } = req.query;

    if (branch_id && req.actor!.role === 'orgadmin') {
      query += ` AND w.branch_id = $${paramIdx++}`;
      params.push(branch_id as string);
    }
    if (worker_id) {
      query += ` AND (w.started_by_worker_id = $${paramIdx} OR w.settled_by_worker_id = $${paramIdx})`;
      params.push(worker_id as string);
      paramIdx++;
    }
    if (client_id) {
      query += ` AND w.client_id = $${paramIdx++}`;
      params.push(client_id as string);
    }
    if (vehicle_class_id) {
      query += ` AND w.vehicle_class_id = $${paramIdx++}`;
      params.push(vehicle_class_id as string);
    }
    if (status) {
      query += ` AND w.status = $${paramIdx++}`;
      params.push(status as string);
    }
    if (from) {
      query += ` AND w.started_at >= $${paramIdx++}`;
      params.push(from as string);
    }
    if (to) {
      query += ` AND w.started_at <= $${paramIdx++}`;
      params.push(to as string);
    }

    query += ' ORDER BY w.started_at DESC LIMIT 50';

    const result = await pool.query(query, params);
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// ─── GET /washes/mine/earnings — what the worker has earned ──

/**
 * The worker's own commission earnings, today / this week / this month,
 * plus a recent breakdown.
 *
 * Reads `worker_commission_ugx` off each wash rather than recomputing from
 * the branch's current rate: the rate can change, and a worker looking at
 * last week must see what they actually earned then, not what this week's
 * rate would have paid.
 *
 * Attributed to `started_by_worker_id` — the worker who washed the car
 * earned the cut, whoever took the money. Commission is paid into the
 * wallet (modules/wallet), so on a handover the settler holds the cash and
 * the washer still gets paid.
 */
router.get('/mine/earnings', requireRole('orgadmin', 'manager', 'worker'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const workerId = req.actor!.sub;

    const totals = await pool.query(
      `SELECT
         COALESCE(SUM(worker_commission_ugx) FILTER (
           WHERE settled_at::date = CURRENT_DATE), 0) AS today_ugx,
         COUNT(*) FILTER (
           WHERE settled_at::date = CURRENT_DATE) AS today_washes,
         -- date_trunc('week') is Monday-based in Postgres, which matches
         -- how a shift week is actually talked about on the forecourt.
         COALESCE(SUM(worker_commission_ugx) FILTER (
           WHERE settled_at >= date_trunc('week', CURRENT_DATE)), 0) AS week_ugx,
         COUNT(*) FILTER (
           WHERE settled_at >= date_trunc('week', CURRENT_DATE)) AS week_washes,
         COALESCE(SUM(worker_commission_ugx) FILTER (
           WHERE settled_at >= date_trunc('month', CURRENT_DATE)), 0) AS month_ugx,
         COUNT(*) FILTER (
           WHERE settled_at >= date_trunc('month', CURRENT_DATE)) AS month_washes
       FROM washes
       WHERE started_by_worker_id = $1 AND status = 'settled'`,
      [workerId]
    );

    // Per-day for the last 14 days, for a small trend on the earnings page.
    const daily = await pool.query(
      `SELECT settled_at::date AS day,
              COALESCE(SUM(worker_commission_ugx), 0) AS earned_ugx,
              COUNT(*) AS washes
         FROM washes
        WHERE started_by_worker_id = $1 AND status = 'settled'
          AND settled_at >= CURRENT_DATE - INTERVAL '13 days'
        GROUP BY settled_at::date
        ORDER BY day`,
      [workerId]
    );

    // The individual washes behind today's figure, so a worker can check
    // the number against cars they remember rather than trust a total.
    const recent = await pool.query(
      `SELECT w.id, w.job_no, w.amount_ugx, w.worker_commission_ugx,
              w.payment_method, w.settled_at,
              vc.name AS vehicle_class_name, s.name AS service_name
         FROM washes w
         LEFT JOIN vehicle_classes vc ON vc.id = w.vehicle_class_id
         LEFT JOIN services s ON s.id = w.service_id
        WHERE w.started_by_worker_id = $1 AND w.status = 'settled'
        ORDER BY w.settled_at DESC
        LIMIT 20`,
      [workerId]
    );

    // The rate in force right now, so the page can explain the figures.
    const rate = await pool.query(
      `SELECT worker_commission_bp FROM branches WHERE id = $1`,
      [req.actor!.branch_id]
    );

    const t = totals.rows[0];
    res.json({
      ok: true,
      data: {
        commission_pct: Number(rate.rows[0]?.worker_commission_bp || 0) / 100,
        today: { earned_ugx: Number(t.today_ugx), washes: Number(t.today_washes) },
        week: { earned_ugx: Number(t.week_ugx), washes: Number(t.week_washes) },
        month: { earned_ugx: Number(t.month_ugx), washes: Number(t.month_washes) },
        daily: daily.rows.map((r: any) => ({
          day: r.day,
          earned_ugx: Number(r.earned_ugx),
          washes: Number(r.washes),
        })),
        recent: recent.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
