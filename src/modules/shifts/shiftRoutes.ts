import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';
import { requireRole, getOrgId } from '@/middleware/requireRole';

const router = Router();

/**
 * computeExpectedCash — stub for now, Phase 4 wires this to washes table.
 * Returns the sum of settled washes' amounts on this shift.
 */
async function computeExpectedCash(pool: any, shiftId: string): Promise<number> {
  const r = await pool.query(
    `SELECT COALESCE(SUM(amount_ugx), 0) as total FROM washes WHERE settled_shift_id = $1 AND status = 'settled'`,
    [shiftId]
  );
  return Number(r.rows[0].total);
}

// --- POST /shifts/open ---

/**
 * POST /shifts/open
 * Worker or manager opens a shift for their branch
 */
router.post('/open', requireRole('orgadmin', 'manager', 'worker'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req.actor!);
    const pool = getPool();

    // Branch comes from JWT, never from request body
    const branchId = req.actor!.branch_id;
    if (!branchId) {
      next(createAppError(400, 'NO_BRANCH', 'Orgadmin cannot open a shift. Use a staff account with a branch.'));
      return;
    }

    // Verify caller is worker or manager (not orgadmin)
    if (req.actor!.role === 'orgadmin') {
      next(createAppError(403, 'FORBIDDEN', 'Orgadmins cannot open shifts'));
      return;
    }

    // Check if there's already an open shift for this worker
    const existing = await pool.query(
      `SELECT id FROM shifts WHERE worker_id = $1 AND status <> 'closed'`,
      [req.actor!.sub]
    );

    if (existing.rows.length > 0) {
      next(createAppError(409, 'SHIFT_ALREADY_OPEN', 'You already have an open shift'));
      return;
    }

    // Open the shift
    const result = await pool.query(
      `INSERT INTO shifts (org_id, branch_id, worker_id, status)
       VALUES ($1, $2, $3, 'open') RETURNING *`,
      [orgId, branchId, req.actor!.sub]
    );

    res.status(201).json({ ok: true, data: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// --- GET /shifts/current ---

/**
 * GET /shifts/current
 * Returns the caller's open shift with live totals
 */
router.get('/current', requireRole('orgadmin', 'manager', 'worker'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();

    const result = await pool.query(
      `SELECT * FROM shifts WHERE worker_id = $1 AND status <> 'closed' ORDER BY opened_at DESC LIMIT 1`,
      [req.actor!.sub]
    );

    if (result.rows.length === 0) {
      next(createAppError(404, 'NO_OPEN_SHIFT', 'No open shift found'));
      return;
    }

    const shift = result.rows[0];

    // Compute live totals (stub: returns 0 until Phase 4)
    const expectedCash = await computeExpectedCash(pool, shift.id);

    res.json({
      ok: true,
      data: {
        ...shift,
        expected_cash_ugx: expectedCash,
      },
    });
  } catch (err) {
    next(err);
  }
});

// --- POST /shifts/:id/request-close ---

/**
 * POST /shifts/:id/request-close
 * Worker requests close of own shift → pending_close
 */
router.post('/:id/request-close', requireRole('orgadmin', 'manager', 'worker'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { id } = req.params;

    // Must be own shift
    const shiftResult = await pool.query(
      `SELECT id, status, worker_id FROM shifts WHERE id = $1 AND org_id = $2`,
      [id, getOrgId(req.actor!)]
    );

    if (shiftResult.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Shift not found'));
      return;
    }

    const shift = shiftResult.rows[0];

    if (shift.worker_id !== req.actor!.sub) {
      next(createAppError(403, 'FORBIDDEN', 'Can only request close for your own shift'));
      return;
    }

    if (shift.status !== 'open') {
      next(createAppError(409, 'BAD_STATE', `Shift is ${shift.status}, not open`));
      return;
    }

    // Cannot request close if holder has in_progress washes
    const inProgress = await pool.query(
      `SELECT COUNT(*) as cnt FROM washes WHERE started_by_worker_id = $1 AND status = 'in_progress'`,
      [shift.worker_id]
    );
    if (parseInt(inProgress.rows[0].cnt) > 0) {
      next(createAppError(409, 'IN_PROGRESS_WASHES', 'Cannot close shift with in-progress washes'));
      return;
    }

    await pool.query(
      `UPDATE shifts SET status = 'pending_close' WHERE id = $1`,
      [id]
    );

    res.json({ ok: true, data: { message: 'Close requested. Awaiting manager review.' } });
  } catch (err) {
    next(err);
  }
});

// --- POST /shifts/:id/reopen ---

/**
 * POST /shifts/:id/reopen
 * Return a pending_close shift to 'open'.
 *
 * Workers no longer end their own day — the manager records the cash handover
 * instead. A shift left in pending_close cannot take washes and blocks a new
 * one from opening, which would strand the worker. This lets them carry on;
 * the cash total is unaffected because it is derived from settled washes.
 */
router.post('/:id/reopen', requireRole('orgadmin', 'manager', 'worker'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { id } = req.params;

    const shiftResult = await pool.query(
      `SELECT id, status, worker_id FROM shifts WHERE id = $1 AND org_id = $2`,
      [id, getOrgId(req.actor!)]
    );

    if (shiftResult.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Shift not found'));
      return;
    }

    const shift = shiftResult.rows[0];

    // A worker may only reopen their own day; managers can unblock anyone.
    if (req.actor!.role === 'worker' && shift.worker_id !== req.actor!.sub) {
      next(createAppError(403, 'FORBIDDEN', 'Can only reopen your own shift'));
      return;
    }

    // Never resurrect a closed day — the cash has already been counted.
    if (shift.status !== 'pending_close') {
      next(createAppError(409, 'BAD_STATE', `Shift is ${shift.status}, not pending_close`));
      return;
    }

    await pool.query(`UPDATE shifts SET status = 'open' WHERE id = $1`, [id]);

    res.json({ ok: true, data: { id, status: 'open' } });
  } catch (err) {
    next(err);
  }
});

// --- POST /shifts/:id/close ---

const closeSchema = z.object({
  counted_cash_ugx: z.number().int().min(0),
  notes: z.string().optional(),
});

/**
 * POST /shifts/:id/close
 * Manager or orgadmin closes a shift with counted cash
 */
router.post('/:id/close', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = closeSchema.parse(req.body);
    const orgId = getOrgId(req.actor!);
    const pool = getPool();
    const { id } = req.params;

    // Get the shift
    const shiftResult = await pool.query(
      `SELECT * FROM shifts WHERE id = $1 AND org_id = $2`,
      [id, orgId]
    );

    if (shiftResult.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Shift not found'));
      return;
    }

    const shift = shiftResult.rows[0];

    // Manager cannot close their own shift
    if (req.actor!.role === 'manager' && shift.worker_id === req.actor!.sub) {
      next(createAppError(403, 'CANNOT_CLOSE_OWN', 'Manager cannot close their own shift. An orgadmin must close it.'));
      return;
    }

    // Manager can only close shifts in their own branch
    if (req.actor!.role === 'manager' && shift.branch_id !== req.actor!.branch_id) {
      next(createAppError(403, 'FORBIDDEN', 'Can only close shifts in your own branch'));
      return;
    }

    if (shift.status === 'closed') {
      next(createAppError(409, 'ALREADY_CLOSED', 'Shift is already closed'));
      return;
    }

    if (shift.status !== 'pending_close' && shift.status !== 'open') {
      next(createAppError(409, 'BAD_STATE', `Shift status is ${shift.status}`));
      return;
    }

    // Cannot close if holder has in_progress washes
    const inProgress = await pool.query(
      `SELECT COUNT(*) as cnt FROM washes WHERE started_by_worker_id = $1 AND status = 'in_progress'`,
      [shift.worker_id]
    );
    if (parseInt(inProgress.rows[0].cnt) > 0) {
      next(createAppError(409, 'IN_PROGRESS_WASHES', 'Cannot close shift with in-progress washes'));
      return;
    }

    // Compute expected cash from settled washes
    const expectedCash = await computeExpectedCash(pool, shift.id);
    const variance = data.counted_cash_ugx - expectedCash;

    // Close the shift
    await pool.query(
      `UPDATE shifts SET
        status = 'closed',
        closed_at = now(),
        expected_cash_ugx = $1,
        counted_cash_ugx = $2,
        variance_ugx = $3,
        closed_by = $4,
        notes = $5
       WHERE id = $6`,
      [expectedCash, data.counted_cash_ugx, variance, req.actor!.sub, data.notes || null, id]
    );

    res.json({
      ok: true,
      data: {
        id,
        status: 'closed',
        expected_cash_ugx: expectedCash,
        counted_cash_ugx: data.counted_cash_ugx,
        variance_ugx: variance,
        closed_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

// --- GET /shifts ---

/**
 * GET /shifts
 * List shifts with filters. Manager locked to own branch.
 */
router.get('/', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req.actor!);
    const pool = getPool();

    // live_expected_cash_ugx is computed from settled washes rather than read
    // from the column, because an open shift's stored value is still 0 — the
    // manager needs to know what to collect before the shift is closed.
    let query = `
      SELECT s.*, su.full_name as worker_name, b.name as branch_name,
        COALESCE((
          SELECT SUM(w.amount_ugx) FROM washes w
          WHERE w.settled_shift_id = s.id AND w.status = 'settled'
        ), 0) AS live_expected_cash_ugx,
        COALESCE((
          SELECT COUNT(*) FROM washes w
          WHERE w.settled_shift_id = s.id AND w.status = 'settled'
        ), 0) AS settled_count
      FROM shifts s
      JOIN staff_users su ON s.worker_id = su.id
      JOIN branches b ON s.branch_id = b.id
      WHERE s.org_id = $1
    `;
    const params: any[] = [orgId];
    let paramIndex = 2;

    // Manager locked to own branch
    if (req.actor!.role === 'manager') {
      query += ` AND s.branch_id = $${paramIndex++}`;
      params.push(req.actor!.branch_id);
    }

    // Filters
    const { branch_id, worker_id, from, to, has_variance } = req.query;

    if (branch_id && req.actor!.role === 'orgadmin') {
      query += ` AND s.branch_id = $${paramIndex++}`;
      params.push(branch_id);
    }

    if (worker_id) {
      query += ` AND s.worker_id = $${paramIndex++}`;
      params.push(worker_id);
    }

    // A shift is no longer opened and closed within one day — a worker's day
    // now rolls over automatically and the same shift row can stay open for
    // a week until a manager records the handover. So "shifts opened today"
    // is the wrong question: a worker who opened on Monday and washed 10
    // cars today would be invisible to a from/to=today filter on opened_at.
    // Match a shift into a date range if EITHER it is still awaiting a
    // handover (open or pending_close, regardless of when it was opened) OR
    // it actually has settled cash from within that range.
    if (from || to) {
      const dateParams: string[] = [];
      if (from) { dateParams.push(`$${paramIndex}`); params.push(from); }
      const fromIdx = from ? paramIndex++ : null;
      if (to) { dateParams.push(`$${paramIndex}`); params.push(to); }
      const toIdx = to ? paramIndex++ : null;

      const range = (col: string) =>
        [
          fromIdx ? `${col} >= $${fromIdx}::date` : null,
          toIdx ? `${col} <= $${toIdx}::date` : null,
        ]
          .filter(Boolean)
          .join(' AND ');

      query += ` AND (
        s.status <> 'closed'
        OR EXISTS (
          SELECT 1 FROM washes w
          WHERE w.settled_shift_id = s.id AND w.status = 'settled'
            AND ${range('w.settled_at::date')}
        )
      )`;
    }

    if (has_variance === 'true') {
      query += ` AND s.variance_ugx IS NOT NULL AND s.variance_ugx <> 0`;
    }

    query += ' ORDER BY s.opened_at DESC LIMIT 50';

    const result = await pool.query(query, params);
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// --- GET /shifts/:id ---

/**
 * GET /shifts/:id
 * Shift detail (includes settled wash list — Phase 4)
 */
router.get('/:id', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orgId = getOrgId(req.actor!);
    const pool = getPool();
    const { id } = req.params;

    const result = await pool.query(
      `SELECT s.*, su.full_name as worker_name, b.name as branch_name,
              cb.full_name as closed_by_name
       FROM shifts s
       JOIN staff_users su ON s.worker_id = su.id
       JOIN branches b ON s.branch_id = b.id
       LEFT JOIN staff_users cb ON s.closed_by = cb.id
       WHERE s.id = $1 AND s.org_id = $2`,
      [id, orgId]
    );

    if (result.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Shift not found'));
      return;
    }

    // Manager can only see shifts in their own branch
    if (req.actor!.role === 'manager' && result.rows[0].branch_id !== req.actor!.branch_id) {
      next(createAppError(403, 'FORBIDDEN', 'Cannot access shifts outside your branch'));
      return;
    }

    // Washes will be added in Phase 4
    const shift = result.rows[0];
    shift.washes = [];

    res.json({ ok: true, data: shift });
  } catch (err) {
    next(err);
  }
});

export default router;
