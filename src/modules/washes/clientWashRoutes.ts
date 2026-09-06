import { Router, Request, Response, NextFunction } from 'express';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';

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
      `SELECT w.id, w.job_no, w.status, w.quoted_amount_ugx, w.started_at,
              w.is_redemption,
              vc.name as vehicle_class_name, svc.name as service_name,
              b.name as branch_name
       FROM washes w
       JOIN vehicle_classes vc ON w.vehicle_class_id = vc.id
       JOIN services svc ON w.service_id = svc.id
       JOIN branches b ON w.branch_id = b.id
       WHERE w.client_id = $1 AND w.status IN ('in_progress', 'ready')
       ORDER BY w.started_at DESC LIMIT 1`,
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
