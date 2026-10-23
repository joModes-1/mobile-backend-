import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';
import { requireRole, getOrgId } from '@/middleware/requireRole';
import { redeem, adjust, getConfig } from './index';

const router = Router();

/**
 * Worker points endpoints.
 *
 * Scoping rule throughout: a worker sees only themselves. Anything that
 * reads or moves someone else's points is manager-and-above, because a
 * staff incentive scheme people can inspect or edit for each other stops
 * being an incentive and starts being an argument.
 */

// ═══════════════════════════════════════════════════════════════
// GET /worker-points/me — the signed-in worker's balance and history
// ═══════════════════════════════════════════════════════════════

router.get('/me', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.actor?.type !== 'staff') {
      next(createAppError(403, 'FORBIDDEN', 'Staff access required'));
      return;
    }
    const pool = getPool();
    const staffId = req.actor.sub;
    const orgId = req.actor.org_id;

    const acct = await pool.query(
      `SELECT points_balance, lifetime_earned, lifetime_redeemed, washes_credited
         FROM worker_points_accounts WHERE staff_id = $1`,
      [staffId]
    );

    // A worker who has not settled anything yet has no row. Report zeros
    // rather than 404 — "no points yet" is a normal state, not an error.
    const account = acct.rows[0] ?? {
      points_balance: 0, lifetime_earned: 0, lifetime_redeemed: 0, washes_credited: 0,
    };

    const history = await pool.query(
      `SELECT l.id, l.entry_type, l.points_delta, l.balance_after, l.reason,
              l.created_at, w.job_no, w.receipt_no, w.amount_ugx
         FROM worker_points_ledger l
         LEFT JOIN washes w ON w.id = l.wash_id
        WHERE l.staff_id = $1
        ORDER BY l.created_at DESC
        LIMIT 50`,
      [staffId]
    );

    const cfgRow = await pool.query(
      `SELECT point_value_ugx, min_redeem_points, active, points_per_wash
         FROM worker_points_configs WHERE org_id = $1`,
      [orgId]
    );
    const cfg = cfgRow.rows[0] ?? null;

    res.json({
      ok: true,
      data: {
        ...account,
        // What the balance is worth, so the app can show money rather than
        // an abstract number nobody can value.
        value_ugx: cfg ? Number(account.points_balance) * Number(cfg.point_value_ugx) : null,
        can_redeem: cfg ? Number(account.points_balance) >= Number(cfg.min_redeem_points) : false,
        min_redeem_points: cfg?.min_redeem_points ?? null,
        // The flat rate, so the app can show what a job is worth before it
        // is started rather than only after it settles.
        points_per_wash: cfg?.points_per_wash ?? null,
        scheme_active: cfg?.active ?? false,
        history: history.rows,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /worker-points/leaderboard — standings for the branch or org
// ═══════════════════════════════════════════════════════════════

router.get('/leaderboard', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.actor?.type !== 'staff') {
      next(createAppError(403, 'FORBIDDEN', 'Staff access required'));
      return;
    }
    const pool = getPool();
    const orgId = req.actor.org_id;

    // A worker sees their own branch; a manager theirs; an org admin can
    // ask for one branch or see the whole org.
    let branchId: string | null = null;
    if (req.actor.role === 'orgadmin') {
      branchId = (req.query.branch_id as string) || null;
    } else {
      branchId = req.actor.branch_id ?? null;
    }

    // period=week|month ranks by points EARNED in that window (Monday-based
    // week, calendar month) — "best this week". period=all (the default,
    // and what this endpoint always returned) ranks by lifetime points.
    const period = String(req.query.period || 'all');
    if (!['week', 'month', 'all'].includes(period)) {
      next(createAppError(400, 'VALIDATION_ERROR', 'period must be week, month or all'));
      return;
    }

    const params: any[] = [orgId];
    let branchClause = '';
    if (branchId) {
      params.push(branchId);
      branchClause = `AND su.branch_id = $${params.length}`;
    }

    // Earn, bonus and reversal rows net out to what was really earned in
    // the window; redemptions spend points but don't undo experience.
    const periodPoints = period === 'all' ? null : `
      COALESCE((SELECT SUM(l.points_delta) FROM worker_points_ledger l
                 WHERE l.staff_id = su.id AND l.entry_type IN ('earn', 'bonus', 'reversal')
                   AND l.created_at >= date_trunc('${period}', CURRENT_DATE)), 0)`;
    const periodWashes = period === 'all' ? null : `
      (SELECT COUNT(*) FROM worker_points_ledger l
        WHERE l.staff_id = su.id AND l.entry_type = 'earn'
          AND l.created_at >= date_trunc('${period}', CURRENT_DATE))`;

    const rows = await pool.query(
      `SELECT su.id, su.full_name, su.username, b.code AS branch_code,
              COALESCE(a.points_balance, 0)  AS points_balance,
              COALESCE(a.lifetime_earned, 0) AS lifetime_earned,
              COALESCE(a.washes_credited, 0) AS washes_credited,
              ${periodPoints ?? 'COALESCE(a.lifetime_earned, 0)'}::int AS points,
              ${periodWashes ?? 'COALESCE(a.washes_credited, 0)'}::int AS washes
         FROM staff_users su
         LEFT JOIN worker_points_accounts a ON a.staff_id = su.id
         LEFT JOIN branches b ON b.id = su.branch_id
        WHERE su.org_id = $1 AND su.status = 'active'
          AND su.role IN ('worker', 'manager') ${branchClause}
        ORDER BY points DESC, su.full_name
        LIMIT 50`,
      params
    );

    const ranked = rows.rows.map((r: any, i: number) => ({ ...r, rank: i + 1 }));
    res.json({
      ok: true,
      data: ranked,
      // The caller's own standing, so a worker outside the top rows still
      // sees where they are. Kept beside `data` so existing readers of the
      // array are unaffected.
      period,
      me: ranked.find((r: any) => r.id === req.actor!.sub) ?? null,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /worker-points/redeem — a worker spends their own points
// ═══════════════════════════════════════════════════════════════

const redeemSchema = z.object({
  points: z.number().int().positive(),
  reason: z.string().max(200).optional(),
});

router.post('/redeem', async (req: Request, res: Response, next: NextFunction) => {
  const pool = getPool();
  const client = await pool.connect();
  try {
    if (req.actor?.type !== 'staff') {
      next(createAppError(403, 'FORBIDDEN', 'Staff access required'));
      return;
    }
    const body = redeemSchema.parse(req.body);

    await client.query('BEGIN');
    const account = await redeem(client, {
      staffId: req.actor.sub,
      orgId: req.actor.org_id!,
      points: body.points,
      reason: body.reason ?? null,
    });
    await client.query('COMMIT');

    res.json({ ok: true, data: account });
  } catch (err: any) {
    await client.query('ROLLBACK');
    if (err?.code === 'INSUFFICIENT_POINTS') {
      next(createAppError(422, 'INSUFFICIENT_POINTS', err.message));
      return;
    }
    if (err?.code === 'BELOW_MINIMUM') {
      next(createAppError(422, 'BELOW_MINIMUM', err.message));
      return;
    }
    next(err);
  } finally {
    client.release();
  }
});

// ═══════════════════════════════════════════════════════════════
// POST /worker-points/:staffId/adjust — manager correction or bonus
// ═══════════════════════════════════════════════════════════════

const adjustSchema = z.object({
  points: z.number().int(),
  // Required, not optional: an unexplained change to someone's earnings is
  // exactly what makes a scheme feel arbitrary.
  reason: z.string().min(3).max(200),
  bonus: z.boolean().optional(),
});

router.post('/:staffId/adjust', requireRole('orgadmin', 'manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const body = adjustSchema.parse(req.body);
      const orgId = getOrgId(req.actor!);
      const staffId = String(req.params.staffId);

      // Confirm the target is in this org — and, for a manager, in their
      // own branch. A UUID in the path is not an authorisation check.
      const target = await client.query(
        `SELECT id, branch_id FROM staff_users WHERE id = $1 AND org_id = $2`,
        [staffId, orgId]
      );
      if (target.rows.length === 0) {
        next(createAppError(404, 'NOT_FOUND', 'Staff member not found'));
        return;
      }
      if (req.actor!.role === 'manager' && target.rows[0].branch_id !== req.actor!.branch_id) {
        next(createAppError(403, 'FORBIDDEN', 'That staff member is at another branch'));
        return;
      }

      await client.query('BEGIN');
      const account = await adjust(client, {
        staffId,
        orgId,
        points: body.points,
        reason: body.reason,
        by: req.actor!.sub,
        bonus: body.bonus,
      });
      await client.query('COMMIT');

      res.json({ ok: true, data: account });
    } catch (err: any) {
      await client.query('ROLLBACK');
      if (err?.code === 'INSUFFICIENT_POINTS') {
        next(createAppError(422, 'INSUFFICIENT_POINTS', err.message));
        return;
      }
      next(err);
    } finally {
      client.release();
    }
  });

// ═══════════════════════════════════════════════════════════════
// GET / PUT /worker-points/config — the org's scheme
// ═══════════════════════════════════════════════════════════════

router.get('/config', requireRole('orgadmin', 'manager'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pool = getPool();
      const client = await pool.connect();
      try {
        const cfg = await getConfig(client, getOrgId(req.actor!));
        res.json({ ok: true, data: cfg });
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  });

const configSchema = z.object({
  points_per_wash: z.number().int().min(0).optional(),
  points_per_amount: z.number().int().min(0).optional(),
  amount_step_ugx: z.number().int().positive().optional(),
  point_value_ugx: z.number().int().min(0).optional(),
  min_amount_ugx: z.number().int().min(0).optional(),
  min_redeem_points: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
});

router.put('/config', requireRole('orgadmin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = configSchema.parse(req.body);
      const orgId = getOrgId(req.actor!);
      const pool = getPool();

      const fields = Object.keys(body);
      if (fields.length === 0) {
        next(createAppError(422, 'NOTHING_TO_UPDATE', 'No settings provided'));
        return;
      }

      const sets = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
      const values = fields.map((f) => (body as any)[f]);

      const updated = await pool.query(
        `INSERT INTO worker_points_configs (org_id) VALUES ($1)
         ON CONFLICT (org_id) DO NOTHING`,
        [orgId]
      );
      void updated;

      const r = await pool.query(
        `UPDATE worker_points_configs SET ${sets}, updated_at = now()
          WHERE org_id = $1 RETURNING *`,
        [orgId, ...values]
      );

      res.json({ ok: true, data: r.rows[0] });
    } catch (err) {
      next(err);
    }
  });

export default router;
