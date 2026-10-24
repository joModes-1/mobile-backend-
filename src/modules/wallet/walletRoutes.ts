import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';
import { requireRole, getOrgId } from '@/middleware/requireRole';
import { getAccount, cashHandover, post, cashOwed, cashOwedFor } from '@/modules/wallet';

/**
 * Worker wallet endpoints.
 *
 *   GET  /wallet/me                     any staff — own balance, what they owe, history
 *   GET  /wallet                        manager (own branch) / org admin — everyone's balance
 *   GET  /wallet/:staffId/ledger        manager / org admin, scoped
 *   POST /wallet/:staffId/cash-handover manager / org admin — confirm cash received
 *   POST /wallet/:staffId/adjust        org admin — correction with a reason
 */
const router = Router();

/**
 * One balance, shown as its two pots (see cashOwedFor):
 *   owes_ugx      cash the worker still has to hand in;
 *   account_ugx   their account — balance + cash owed; can be negative
 *                 (e.g. commission reversed after it was withdrawn);
 *   available_ugx what they may withdraw: the account, whatever cash they hold.
 */
function walletView(
  acct: { balance_ugx: number; lifetime_commission_ugx: number; lifetime_withdrawn_ugx: number },
  owedUgx: number
) {
  const account = acct.balance_ugx + owedUgx;
  return {
    balance_ugx: acct.balance_ugx,
    owes_ugx: owedUgx,
    account_ugx: account,
    available_ugx: Math.max(0, account),
    lifetime_commission_ugx: acct.lifetime_commission_ugx,
    lifetime_withdrawn_ugx: acct.lifetime_withdrawn_ugx,
  };
}

async function ledgerFor(staffId: string, limit = 50) {
  const r = await getPool().query(
    `SELECT l.id, l.kind, l.amount_ugx, l.balance_after_ugx, l.reason, l.created_at,
            l.wash_id, w.job_no, w.payment_method, su.full_name AS created_by_name,
            s.name AS service_name, vc.name AS vehicle_class_name
       FROM wallet_ledger l
       LEFT JOIN washes w ON w.id = l.wash_id
       LEFT JOIN services s ON s.id = w.service_id
       LEFT JOIN vehicle_classes vc ON vc.id = w.vehicle_class_id
       LEFT JOIN staff_users su ON su.id = l.created_by
      WHERE l.staff_id = $1
      ORDER BY l.seq DESC
      LIMIT $2`,
    [staffId, limit]
  );
  return r.rows.map((row: any) => ({
    ...row,
    amount_ugx: Number(row.amount_ugx),
    balance_after_ugx: Number(row.balance_after_ugx),
  }));
}

/**
 * Loads the staff member a manager/admin is acting on and enforces scope:
 * same organisation always; a manager only for workers in their own
 * branch; nobody for themselves (a manager confirming their own cash is
 * the one thing this control exists to prevent — that goes to an org admin).
 */
async function loadTarget(req: Request, next: NextFunction, opts: { allowSelf?: boolean } = {}) {
  const staffId = String(req.params.staffId);
  if (!/^[0-9a-f-]{36}$/i.test(staffId)) {
    next(createAppError(400, 'VALIDATION_ERROR', 'Invalid staff id'));
    return null;
  }
  const orgId = getOrgId(req.actor!);
  const r = await getPool().query(
    `SELECT id, org_id, branch_id, role, full_name FROM staff_users WHERE id = $1 AND org_id = $2`,
    [staffId, orgId]
  );
  const target = r.rows[0];
  if (!target) {
    next(createAppError(404, 'STAFF_NOT_FOUND', 'Staff member not found'));
    return null;
  }
  if (!opts.allowSelf && target.id === req.actor!.sub) {
    next(createAppError(403, 'CANNOT_CONFIRM_OWN', 'Someone above you has to confirm your own cash'));
    return null;
  }
  if (req.actor!.role === 'manager' && target.id !== req.actor!.sub
      && (target.branch_id !== req.actor!.branch_id || target.role !== 'worker')) {
    next(createAppError(403, 'OUT_OF_SCOPE', 'Managers can only act on workers in their own branch'));
    return null;
  }
  return target as { id: string; org_id: string; branch_id: string | null; role: string; full_name: string };
}

// GET /wallet/me
router.get('/me', requireRole('orgadmin', 'manager', 'worker'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const staffId = req.actor!.sub;
    const acct = await getAccount(pool, staffId, getOrgId(req.actor!));

    // Commission by period, split by where it went — the same rule as the
    // two pots (cashOwedFor):
    //   cash     kept out of the notes: on a cash wash the worker washed AND
    //            settled, as much of the commission as the cash covers;
    //   account  everything else — mobile money, points, free washes, a
    //            car someone else took the cash for, and any commission the
    //            cash didn't cover.
    // From the washes themselves (their current commission and cash, after
    // any correction), so a reversed wash drops out of every figure.
    const periods = await pool.query(
      `WITH earned AS (
         SELECT w.settled_at,
                w.worker_commission_ugx AS commission,
                CASE WHEN w.payment_method = 'cash' AND w.settled_by_worker_id = w.started_by_worker_id
                     THEN LEAST(w.worker_commission_ugx, GREATEST(w.amount_ugx, 0)) ELSE 0 END AS kept
           FROM washes w
          WHERE w.started_by_worker_id = $1
            AND w.status IN ('settled', 'disputed')
            AND w.worker_commission_ugx > 0
            AND w.settled_at >= LEAST(date_trunc('week', CURRENT_DATE), date_trunc('month', CURRENT_DATE))
       )
       SELECT
         COALESCE(SUM(kept) FILTER (WHERE settled_at >= CURRENT_DATE), 0) AS today_cash,
         COALESCE(SUM(commission - kept) FILTER (WHERE settled_at >= CURRENT_DATE), 0) AS today_account,
         COALESCE(SUM(kept) FILTER (WHERE settled_at >= date_trunc('week', CURRENT_DATE)), 0) AS week_cash,
         COALESCE(SUM(commission - kept) FILTER (WHERE settled_at >= date_trunc('week', CURRENT_DATE)), 0) AS week_account,
         COALESCE(SUM(kept) FILTER (WHERE settled_at >= date_trunc('month', CURRENT_DATE)), 0) AS month_cash,
         COALESCE(SUM(commission - kept) FILTER (WHERE settled_at >= date_trunc('month', CURRENT_DATE)), 0) AS month_account
       FROM earned`,
      [staffId]
    );
    const p = periods.rows[0];
    const split = (period: 'today' | 'week' | 'month') => ({
      account_ugx: Number(p[`${period}_account`]),
      cash_ugx: Number(p[`${period}_cash`]),
    });
    const today = split('today');
    const week = split('week');
    const month = split('month');
    res.json({
      ok: true,
      data: {
        ...walletView(acct, await cashOwed(pool, staffId)),
        commission: {
          today_ugx: today.account_ugx + today.cash_ugx,
          week_ugx: week.account_ugx + week.cash_ugx,
          month_ugx: month.account_ugx + month.cash_ugx,
          today, week, month,
        },
        ledger: await ledgerFor(staffId),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /wallet — balances for the people this caller manages
router.get('/', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req.actor!);
    const params: any[] = [orgId];
    let scope = '';
    if (req.actor!.role === 'manager') {
      params.push(req.actor!.branch_id);
      scope = `AND su.branch_id = $2 AND su.role = 'worker'`;
    } else if (req.query.branch_id) {
      params.push(String(req.query.branch_id));
      scope = `AND su.branch_id = $2`;
    }
    const r = await getPool().query(
      `SELECT su.id AS staff_id, su.full_name, su.role, su.branch_id, b.name AS branch_name,
              COALESCE(wa.balance_ugx, 0) AS balance_ugx,
              COALESCE(wa.lifetime_commission_ugx, 0) AS lifetime_commission_ugx,
              COALESCE(wa.lifetime_withdrawn_ugx, 0) AS lifetime_withdrawn_ugx,
              wa.updated_at,
              -- Cash a manager confirmed receiving from them today, for the
              -- Cash Handover screen's "handed in today" list.
              COALESCE((SELECT SUM(l.amount_ugx) FROM wallet_ledger l
                         WHERE l.staff_id = su.id AND l.kind = 'cash_handover'
                           AND l.created_at >= CURRENT_DATE), 0) AS handed_in_today_ugx,
              (SELECT MAX(l.created_at) FROM wallet_ledger l
                WHERE l.staff_id = su.id AND l.kind = 'cash_handover') AS last_handover_at
         FROM staff_users su
         LEFT JOIN wallet_accounts wa ON wa.staff_id = su.id
         LEFT JOIN branches b ON b.id = su.branch_id
        WHERE su.org_id = $1 AND su.role IN ('worker', 'manager') ${scope}
        ORDER BY su.full_name`,
      params
    );
    const owed = await cashOwedFor(getPool(), r.rows.map((row: any) => row.staff_id));
    const rows = r.rows.map((row: any) => ({
      staff_id: row.staff_id, full_name: row.full_name, role: row.role,
      branch_id: row.branch_id, branch_name: row.branch_name, updated_at: row.updated_at,
      handed_in_today_ugx: Number(row.handed_in_today_ugx),
      last_handover_at: row.last_handover_at,
      ...walletView({
        balance_ugx: Number(row.balance_ugx),
        lifetime_commission_ugx: Number(row.lifetime_commission_ugx),
        lifetime_withdrawn_ugx: Number(row.lifetime_withdrawn_ugx),
      }, owed.get(row.staff_id) ?? 0),
    }));
    // Most cash to collect first; the order from the query (by name) breaks ties.
    rows.sort((a: any, b: any) => b.owes_ugx - a.owes_ugx);
    res.json({
      ok: true,
      data: {
        total_owed_ugx: rows.reduce((t: number, x: any) => t + x.owes_ugx, 0),
        handed_in_today_ugx: rows.reduce((t: number, x: any) => t + x.handed_in_today_ugx, 0),
        staff: rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /wallet/:staffId/ledger
router.get('/:staffId/ledger', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const target = await loadTarget(req, next, { allowSelf: true });
    if (!target) return;
    const acct = await getAccount(getPool(), target.id, target.org_id);
    const owed = await cashOwed(getPool(), target.id);
    res.json({ ok: true, data: { staff_id: target.id, full_name: target.full_name, ...walletView(acct, owed), ledger: await ledgerFor(target.id, 200) } });
  } catch (err) {
    next(err);
  }
});

const handoverSchema = z.object({
  amount_ugx: z.number().int().positive(),
  note: z.string().max(500).optional(),
});

// POST /wallet/:staffId/cash-handover — "I received this cash from them"
router.post('/:staffId/cash-handover', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  let body: z.infer<typeof handoverSchema>;
  try {
    body = handoverSchema.parse(req.body);
  } catch (err: any) {
    next(createAppError(400, 'VALIDATION_ERROR', 'Request validation failed', err.errors));
    return;
  }
  const target = await loadTarget(req, next);
  if (!target) return;

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const acct = await cashHandover(client, {
      staffId: target.id, orgId: target.org_id, amountUgx: body.amount_ugx, by: req.actor!.sub, note: body.note,
    });
    await client.query(
      `INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity, entity_id, "after")
       VALUES ($1, 'staff', $2, 'wallet.cash_handover', 'staff_users', $3, $4)`,
      [target.org_id, req.actor!.sub, target.id, JSON.stringify({ amount_ugx: body.amount_ugx, balance_after_ugx: acct.balance_ugx })]
    );
    const owed = await cashOwed(client, target.id);
    await client.query('COMMIT');
    res.json({ ok: true, data: { staff_id: target.id, full_name: target.full_name, ...walletView(acct, owed) } });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

const adjustSchema = z.object({
  amount_ugx: z.number().int().refine((n) => n !== 0, 'amount must not be 0'),
  reason: z.string().min(3).max(500),
});

// POST /wallet/:staffId/adjust — org admin only, reason mandatory, audit-logged
router.post('/:staffId/adjust', requireRole('orgadmin'), async (req: Request, res: Response, next: NextFunction) => {
  let body: z.infer<typeof adjustSchema>;
  try {
    body = adjustSchema.parse(req.body);
  } catch (err: any) {
    next(createAppError(400, 'VALIDATION_ERROR', 'Request validation failed', err.errors));
    return;
  }
  const target = await loadTarget(req, next);
  if (!target) return;

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const acct = await post(client, {
      staffId: target.id, orgId: target.org_id, kind: 'adjust', amountUgx: body.amount_ugx,
      reason: body.reason, createdBy: req.actor!.sub,
    });
    await client.query(
      `INSERT INTO audit_logs (org_id, actor_type, actor_id, action, entity, entity_id, "after")
       VALUES ($1, 'staff', $2, 'wallet.adjusted', 'staff_users', $3, $4)`,
      [target.org_id, req.actor!.sub, target.id, JSON.stringify(body)]
    );
    const owed = await cashOwed(client, target.id);
    await client.query('COMMIT');
    res.json({ ok: true, data: { staff_id: target.id, ...walletView(acct, owed) } });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

export default router;
