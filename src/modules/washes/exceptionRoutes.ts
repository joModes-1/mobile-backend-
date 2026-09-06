import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';
import { requireRole, getOrgId } from '@/middleware/requireRole';
import { processSettlement, lockAccount, ensureAccount, getConfig, writeLedgerEntry } from '@/modules/loyalty';
import { resolvePrice } from '@/modules/pricing/resolvePrice';
import { notify } from '@/modules/notify';

const router = Router();

// ─── Helpers ─────────────────────────────────────────────────

async function auditLog(pool: any, params: {
  orgId: string | null;
  actorType: string;
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  before: any;
  after: any;
}) {
  await pool.query(
    `INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity, entity_id, "before", "after")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [params.orgId, params.actorType, params.actorId, params.action, params.entity, params.entityId,
     JSON.stringify(params.before), JSON.stringify(params.after)]
  );
}

// ─── POST /washes/:id/correct — Manager correction ───────────

const correctSchema = z.object({
  vehicle_class_id: z.string().uuid(),
  service_id: z.string().uuid().nullable().optional(),
  reason: z.string().min(1),
});

router.post('/:id/correct', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  const pool = getPool();
  const orgId = getOrgId(req.actor!);
  const managerId = req.actor!.sub;
  const id = String(req.params.id);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the wash row
    const washResult = await client.query(
      `SELECT w.*, b.code as branch_code
       FROM washes w
       JOIN branches b ON w.branch_id = b.id
       WHERE w.id = $1 AND w.org_id = $2 FOR UPDATE`,
      [id, orgId]
    );

    if (washResult.rows.length === 0) {
      await client.query('ROLLBACK');
      next(createAppError(404, 'NOT_FOUND', 'Wash not found'));
      return;
    }

    const wash = washResult.rows[0];

    // Must be settled
    if (wash.status !== 'settled') {
      await client.query('ROLLBACK');
      next(createAppError(409, 'BAD_STATE', `Wash is ${wash.status}, not settled`));
      return;
    }

    // Parse body
    const body = correctSchema.parse(req.body);
    const serviceId = body.service_id || wash.service_id;

    // Re-resolve price with new vehicle class
    const priceResult = await resolvePrice(serviceId, body.vehicle_class_id, wash.branch_id, orgId);
    if (!priceResult) {
      await client.query('ROLLBACK');
      const vc = await client.query(`SELECT name FROM vehicle_classes WHERE id = $1`, [body.vehicle_class_id]);
      const svc = await client.query(`SELECT name FROM services WHERE id = $1`, [serviceId]);
      next(createAppError(422, 'NO_PRICE_SET', `No price for ${svc.rows[0]?.name || 'service'} + ${vc.rows[0]?.name || 'vehicle class'}`));
      return;
    }

    // Store original only on FIRST correction
    let originalAmountUgx = wash.original_amount_ugx;
    let originalVcId = wash.original_vehicle_class_id;
    if (!wash.corrected_at) {
      originalAmountUgx = wash.amount_ugx;
      originalVcId = wash.vehicle_class_id;
    }

    // Compute new amount (loyalty untouched — just update the financials)
    const newAmount = wash.is_redemption ? 0 : Number(priceResult.price_ugx);

    // Snapshot before
    const before = {
      amount_ugx: Number(wash.amount_ugx),
      vehicle_class_id: wash.vehicle_class_id,
      service_id: wash.service_id,
      price_id: wash.price_id,
    };

    // Update wash
    await client.query(
      `UPDATE washes SET
        vehicle_class_id = $1, service_id = $2, price_id = $3,
        amount_ugx = $4, corrected_at = now(), corrected_by = $5,
        original_amount_ugx = $6, original_vehicle_class_id = $7,
        updated_at = now()
       WHERE id = $8`,
      [
        body.vehicle_class_id, serviceId, priceResult.price_id,
        newAmount, managerId,
        originalAmountUgx, originalVcId,
        id,
      ]
    );

    const after = {
      amount_ugx: newAmount,
      vehicle_class_id: body.vehicle_class_id,
      service_id: serviceId,
      price_id: priceResult.price_id,
    };

    // Audit log
    await auditLog(client, {
      orgId,
      actorType: 'staff',
      actorId: managerId,
      action: 'correct',
      entity: 'washes',
      entityId: id,
      before,
      after,
    });

    await client.query('COMMIT');

    res.json({
      ok: true,
      data: {
        wash_id: id,
        status: 'settled',
        amount_ugx: newAmount,
        corrected: true,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ─── POST /washes/:id/reverse — Manager reversal ─────────────

const reverseSchema = z.object({
  reason: z.string().min(1),
});

router.post('/:id/reverse', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  const pool = getPool();
  const orgId = getOrgId(req.actor!);
  const managerId = req.actor!.sub;
  const id = String(req.params.id);
  const body = reverseSchema.parse(req.body);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the wash row
    const washResult = await client.query(
      `SELECT w.*, b.code as branch_code
       FROM washes w
       JOIN branches b ON w.branch_id = b.id
       WHERE w.id = $1 AND w.org_id = $2 FOR UPDATE`,
      [id, orgId]
    );

    if (washResult.rows.length === 0) {
      await client.query('ROLLBACK');
      next(createAppError(404, 'NOT_FOUND', 'Wash not found'));
      return;
    }

    const wash = washResult.rows[0];

    if (wash.status !== 'settled') {
      await client.query('ROLLBACK');
      next(createAppError(409, 'BAD_STATE', `Wash is ${wash.status}, not settled`));
      return;
    }

    // Snapshot before
    const before = {
      status: wash.status,
      amount_ugx: Number(wash.amount_ugx),
    };

    // Update wash status
    await client.query(
      `UPDATE washes SET
        status = 'reversed', reversed_at = now(), reversed_by = $1,
        reverse_reason = $2, updated_at = now()
       WHERE id = $3`,
      [managerId, body.reason, id]
    );

    // Loyalty reversal (if client attached)
    let loyaltyResult: any = null;
    if (wash.client_id) {
      const account = await lockAccount(client, wash.client_id);
      if (account) {
        const config = await getConfig(client, orgId);

        // Read the ledger entries for this wash
        const ledgerEntries = await client.query(
          `SELECT entry_type FROM loyalty_ledger WHERE wash_id = $1 AND client_id = $2`,
          [id, wash.client_id]
        );
        const entryTypes = ledgerEntries.rows.map((r: any) => r.entry_type);

        let washDelta = 0;
        let creditDelta = 0;
        let reversalReason: string | null = null;

        if (entryTypes.includes('redeem')) {
          // Refund the credit
          creditDelta = 1;
        }

        if (entryTypes.includes('earn')) {
          const newCount = account.wash_count - 1;
          if (newCount < 0) {
            // The earn rolled over into a granted reward
            if (account.free_wash_credits >= 1) {
              // Credit is unspent — remove it
              creditDelta -= 1;
              washDelta = -1 + config.washes_required; // restore count to washes_required - 1
            } else {
              // Credit was already spent — floor at 0
              washDelta = -account.wash_count; // can't go below 0
              reversalReason = 'credit already redeemed; shortfall absorbed';
            }
          } else {
            washDelta = -1;
          }
        }

        const finalWashCount = Math.max(0, account.wash_count + washDelta);
        const finalCredits = account.free_wash_credits + creditDelta;
        const finalRedeemed = entryTypes.includes('redeem') ? account.lifetime_redeemed - 1 : account.lifetime_redeemed;
        const finalWashes = entryTypes.includes('earn') ? account.lifetime_washes - 1 : account.lifetime_washes;

        await client.query(
          `UPDATE loyalty_accounts
           SET wash_count = $1, free_wash_credits = $2,
               lifetime_washes = $3, lifetime_redeemed = $4, updated_at = now()
           WHERE client_id = $5`,
          [finalWashCount, finalCredits, Math.max(0, finalWashes), Math.max(0, finalRedeemed), wash.client_id]
        );

        await writeLedgerEntry(client, {
          clientId: wash.client_id,
          washId: id,
          entryType: 'reversal',
          washDelta,
          creditDelta,
          washCountAfter: finalWashCount,
          creditsAfter: finalCredits,
          reason: body.reason,
          createdBy: managerId,
        });

        loyaltyResult = { wash_count: finalWashCount, free_wash_credits: finalCredits };
      }
    }

    // Audit log
    const after = { status: 'reversed', loyalty: loyaltyResult };
    await auditLog(client, {
      orgId,
      actorType: 'staff',
      actorId: managerId,
      action: 'reverse',
      entity: 'washes',
      entityId: id,
      before,
      after,
    });

    await client.query('COMMIT');

    notify('client', wash.client_id || '', 'wash_reversed', { wash_id: id, reason: body.reason });

    res.json({
      ok: true,
      data: {
        wash_id: id,
        status: 'reversed',
        loyalty: loyaltyResult,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ─── POST /washes/:id/dispute — Client dispute ───────────────

const disputeSchema = z.object({
  reason: z.enum(['amount_wrong', 'service_wrong', 'car_type_wrong', 'never_washed', 'already_paid', 'other']),
  note: z.string().optional(),
});

router.post('/:id/dispute', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.actor || req.actor.type !== 'client') {
      next(createAppError(403, 'FORBIDDEN', 'Client access required'));
      return;
    }

    const pool = getPool();
    const clientId = req.actor.sub;
    const id = String(req.params.id);
    const body = disputeSchema.parse(req.body);

    // Must be within 24h of settled_at
    const washResult = await pool.query(
      `SELECT id, client_id, status, settled_at FROM washes WHERE id = $1`,
      [id]
    );

    if (washResult.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Wash not found'));
      return;
    }

    const wash = washResult.rows[0];

    if (wash.client_id !== clientId) {
      next(createAppError(403, 'FORBIDDEN', 'This wash does not belong to you'));
      return;
    }

    if (wash.status !== 'settled') {
      next(createAppError(409, 'BAD_STATE', `Wash is ${wash.status}, not settled`));
      return;
    }

    // 24h check
    const settledAt = new Date(wash.settled_at);
    const now = new Date();
    const hoursDiff = (now.getTime() - settledAt.getTime()) / (1000 * 60 * 60);
    if (hoursDiff > 24) {
      next(createAppError(422, 'TOO_LATE', 'Disputes must be filed within 24 hours of settlement'));
      return;
    }

    await pool.query(
      `UPDATE washes SET
        status = 'disputed', disputed_at = now(),
        dispute_reason = $1, notes = $2, updated_at = now()
       WHERE id = $3`,
      [body.reason, body.note || null, id]
    );

    // Notify manager
    const managerResult = await pool.query(
      `SELECT DISTINCT su.id FROM staff_users su
       JOIN washes w ON w.branch_id = su.branch_id
       WHERE w.id = $1 AND su.role IN ('manager', 'orgadmin')
       LIMIT 1`,
      [id]
    );
    for (const mgr of managerResult.rows) {
      notify('staff', mgr.id, 'wash_disputed', { wash_id: id, reason: body.reason });
    }

    // Audit
    await pool.query(
      `INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity, entity_id, "before", "after")
       VALUES ($1, 'client', $2, 'dispute', 'washes', $3, $4, $5)`,
      [washResult.rows[0].org_id, clientId, id,
       JSON.stringify({ status: 'settled' }),
       JSON.stringify({ status: 'disputed', dispute_reason: body.reason })]
    );

    res.json({ ok: true, data: { wash_id: id, status: 'disputed' } });
  } catch (err) {
    next(err);
  }
});

// ─── POST /washes/:id/resolve-dispute — Manager resolution ────

const resolveSchema = z.object({
  resolution: z.enum(['uphold', 'correct', 'reverse']),
  vehicle_class_id: z.string().uuid().nullable().optional(),
  service_id: z.string().uuid().nullable().optional(),
  note: z.string().optional(),
});

router.post('/:id/resolve-dispute', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  const pool = getPool();
  const orgId = getOrgId(req.actor!);
  const managerId = req.actor!.sub;
  const id = String(req.params.id);
  const body = resolveSchema.parse(req.body);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const washResult = await client.query(
      `SELECT * FROM washes WHERE id = $1 AND org_id = $2 FOR UPDATE`,
      [id, orgId]
    );

    if (washResult.rows.length === 0) {
      await client.query('ROLLBACK');
      next(createAppError(404, 'NOT_FOUND', 'Wash not found'));
      return;
    }

    const wash = washResult.rows[0];

    if (wash.status !== 'disputed') {
      await client.query('ROLLBACK');
      next(createAppError(409, 'BAD_STATE', `Wash is ${wash.status}, not disputed`));
      return;
    }

    const before = { status: 'disputed' };

    if (body.resolution === 'uphold') {
      // Back to settled, nothing else changes
      await client.query(
        `UPDATE washes SET status = 'settled', resolved_at = now(), resolved_by = $1, updated_at = now()
         WHERE id = $2`,
        [managerId, id]
      );
    } else if (body.resolution === 'correct') {
      // Run correction logic then set to settled
      const vcId = body.vehicle_class_id || wash.vehicle_class_id;
      const svcId = body.service_id || wash.service_id;

      const priceResult = await resolvePrice(svcId, vcId, wash.branch_id, orgId);
      if (!priceResult) {
        await client.query('ROLLBACK');
        next(createAppError(422, 'NO_PRICE_SET', 'No price for the corrected combination'));
        return;
      }

      const originalAmountUgx = wash.original_amount_ugx || wash.amount_ugx;
      const originalVcId = wash.original_vehicle_class_id || wash.vehicle_class_id;
      const newAmount = wash.is_redemption ? 0 : Number(priceResult.price_ugx);

      await client.query(
        `UPDATE washes SET
          status = 'settled', vehicle_class_id = $1, service_id = $2, price_id = $3,
          amount_ugx = $4, corrected_at = now(), corrected_by = $5,
          original_amount_ugx = $6, original_vehicle_class_id = $7,
          resolved_at = now(), resolved_by = $5, updated_at = now()
         WHERE id = $8`,
        [vcId, svcId, priceResult.price_id, newAmount, managerId, originalAmountUgx, originalVcId, id]
      );
    } else if (body.resolution === 'reverse') {
      // Run reversal logic then set to reversed
      await client.query(
        `UPDATE washes SET status = 'reversed', reversed_at = now(), reversed_by = $1,
          reverse_reason = $2, resolved_at = now(), resolved_by = $1, updated_at = now()
         WHERE id = $3`,
        [managerId, body.note || 'Dispute resolved with reversal', id]
      );

      // Loyalty reversal
      if (wash.client_id) {
        const account = await lockAccount(client, wash.client_id);
        if (account) {
          const config = await getConfig(client, orgId);
          const ledgerEntries = await client.query(
            `SELECT entry_type FROM loyalty_ledger WHERE wash_id = $1 AND client_id = $2`,
            [id, wash.client_id]
          );
          const entryTypes = ledgerEntries.rows.map((r: any) => r.entry_type);

          let washDelta = 0;
          let creditDelta = 0;

          if (entryTypes.includes('redeem')) creditDelta = 1;
          if (entryTypes.includes('earn')) {
            const newCount = account.wash_count - 1;
            if (newCount < 0) {
              if (account.free_wash_credits >= 1) {
                creditDelta -= 1;
                washDelta = -1 + config.washes_required;
              } else {
                washDelta = -account.wash_count;
              }
            } else {
              washDelta = -1;
            }
          }

          const finalWashCount = Math.max(0, account.wash_count + washDelta);
          const finalCredits = account.free_wash_credits + creditDelta;

          await client.query(
            `UPDATE loyalty_accounts SET wash_count = $1, free_wash_credits = $2, updated_at = now()
             WHERE client_id = $3`,
            [finalWashCount, finalCredits, wash.client_id]
          );

          await writeLedgerEntry(client, {
            clientId: wash.client_id,
            washId: id,
            entryType: 'reversal',
            washDelta,
            creditDelta,
            washCountAfter: finalWashCount,
            creditsAfter: finalCredits,
            reason: body.note || 'Dispute resolved with reversal',
            createdBy: managerId,
          });
        }
      }
    }

    // Audit
    const resolvedStatus = body.resolution === 'uphold' ? 'settled' : body.resolution === 'reverse' ? 'reversed' : 'settled';
    const after = { status: resolvedStatus, resolution: body.resolution };
    await auditLog(client, {
      orgId,
      actorType: 'staff',
      actorId: managerId,
      action: 'resolve_dispute',
      entity: 'washes',
      entityId: id,
      before,
      after,
    });

    await client.query('COMMIT');

    res.json({
      ok: true,
      data: {
        wash_id: id,
        status: resolvedStatus,
        resolution: body.resolution,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ─── POST /clients/:id/loyalty/adjust — Orgadmin manual adjust ──

const adjustSchema = z.object({
  wash_delta: z.number().int(),
  credit_delta: z.number().int(),
  reason: z.string().min(1),
});

router.post('/:id/loyalty/adjust', requireRole('orgadmin'), async (req: Request, res: Response, next: NextFunction) => {
  const pool = getPool();
  const orgId = getOrgId(req.actor!);
  const adminId = req.actor!.sub;
  const clientId = String(req.params.id);
  const body = adjustSchema.parse(req.body);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await ensureAccount(client, clientId, orgId);
    const account = await lockAccount(client, clientId);

    if (!account) {
      await client.query('ROLLBACK');
      next(createAppError(404, 'NOT_FOUND', 'Client loyalty account not found'));
      return;
    }

    const newWashCount = account.wash_count + body.wash_delta;
    const newCredits = account.free_wash_credits + body.credit_delta;

    if (newWashCount < 0 || newCredits < 0) {
      await client.query('ROLLBACK');
      next(createAppError(422, 'NEGATIVE_BALANCE', 'Adjustment would result in negative balance', {
        current_wash_count: account.wash_count,
        current_credits: account.free_wash_credits,
      }));
      return;
    }

    await client.query(
      `UPDATE loyalty_accounts
       SET wash_count = $1, free_wash_credits = $2, updated_at = now()
       WHERE client_id = $3`,
      [newWashCount, newCredits, clientId]
    );

    await writeLedgerEntry(client, {
      clientId,
      washId: null,
      entryType: 'manual_adjust',
      washDelta: body.wash_delta,
      creditDelta: body.credit_delta,
      washCountAfter: newWashCount,
      creditsAfter: newCredits,
      reason: body.reason,
      createdBy: adminId,
    });

    // Audit
    await auditLog(client, {
      orgId,
      actorType: 'staff',
      actorId: adminId,
      action: 'loyalty_adjust',
      entity: 'loyalty_accounts',
      entityId: clientId,
      before: { wash_count: account.wash_count, free_wash_credits: account.free_wash_credits },
      after: { wash_count: newWashCount, free_wash_credits: newCredits },
    });

    await client.query('COMMIT');

    res.json({
      ok: true,
      data: {
        client_id: clientId,
        wash_count: newWashCount,
        free_wash_credits: newCredits,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

export default router;
