import { Router, Request, Response, NextFunction } from 'express';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';
import { requireRole, getOrgId } from '@/middleware/requireRole';

const router = Router();

// ─── Helper: role-scoped branch filter ───────────────────────

function branchFilter(actor: any): { sql: string; params: any[]; idx: number } {
  if (actor.role === 'manager') {
    return { sql: ` AND w.branch_id = $${actor._idx++}`, params: [actor.branch_id], idx: actor._idx };
  }
  if (actor.role === 'orgadmin') {
    return { sql: '', params: [], idx: actor._idx };
  }
  // worker
  return { sql: ` AND (w.started_by_worker_id = $${actor._idx} OR w.settled_by_worker_id = $${actor._idx})`, params: [actor.sub], idx: actor._idx };
}

// ═══════════════════════════════════════════════════════════════
// GET /reports/daily?branch_id&date
// ═══════════════════════════════════════════════════════════════

router.get('/daily', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const orgId = getOrgId(req.actor!);
    const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);
    let pIdx = 1;
    const params: any[] = [orgId];
    let branchClause = '';

    if (req.actor!.role === 'manager') {
      branchClause = ` AND w.branch_id = $${++pIdx}`;
      params.push(req.actor!.branch_id);
    } else if (req.query.branch_id) {
      branchClause = ` AND w.branch_id = $${++pIdx}`;
      params.push(req.query.branch_id);
    }

    params.push(date);

    // Summary
    const summary = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('settled','reversed')) AS total_washes,
        COUNT(*) FILTER (WHERE status = 'settled') AS settled_washes,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_washes,
        COUNT(*) FILTER (WHERE status = 'reversed') AS reversed_washes,
        COALESCE(SUM(amount_ugx) FILTER (WHERE status = 'settled'), 0) AS gross_ugx,
        COUNT(*) FILTER (WHERE status = 'settled' AND is_redemption) AS redemption_count,
        COALESCE(SUM(quoted_amount_ugx) FILTER (WHERE status = 'settled' AND is_redemption), 0) AS redemption_value_ugx,
        COUNT(*) FILTER (WHERE status = 'settled' AND client_id IS NULL) AS walkin_count,
        COUNT(*) FILTER (WHERE status = 'settled' AND handover_reason IS NOT NULL) AS handover_count
      FROM washes w
      WHERE w.org_id = $1 ${branchClause} AND w.started_at::date = $${++pIdx}
    `, params);

    // By car type
    const byCarType = await pool.query(`
      SELECT vc.name AS vehicle_class_name,
        COUNT(*) FILTER (WHERE w.status = 'settled') AS settled,
        COALESCE(SUM(w.amount_ugx) FILTER (WHERE w.status = 'settled'), 0) AS gross_ugx
      FROM washes w
      JOIN vehicle_classes vc ON w.vehicle_class_id = vc.id
      WHERE w.org_id = $1 ${branchClause} AND w.started_at::date = $${pIdx}
      GROUP BY vc.name ORDER BY gross_ugx DESC
    `, params);

    // By service
    const byService = await pool.query(`
      SELECT s.name AS service_name,
        COUNT(*) FILTER (WHERE w.status = 'settled') AS settled,
        COALESCE(SUM(w.amount_ugx) FILTER (WHERE w.status = 'settled'), 0) AS gross_ugx
      FROM washes w
      JOIN services s ON w.service_id = s.id
      WHERE w.org_id = $1 ${branchClause} AND w.started_at::date = $${pIdx}
      GROUP BY s.name ORDER BY gross_ugx DESC
    `, params);

    // By worker
    const byWorker = await pool.query(`
      SELECT su.full_name AS worker_name,
        COUNT(*) FILTER (WHERE w.status = 'settled' AND w.started_by_worker_id = su.id) AS started,
        COUNT(*) FILTER (WHERE w.status = 'settled' AND w.settled_by_worker_id = su.id) AS settled,
        COALESCE(SUM(w.amount_ugx) FILTER (WHERE w.status = 'settled' AND w.settled_by_worker_id = su.id), 0) AS cash_taken_ugx
      FROM washes w
      JOIN staff_users su ON (w.started_by_worker_id = su.id OR w.settled_by_worker_id = su.id)
      WHERE w.org_id = $1 ${branchClause} AND w.started_at::date = $${pIdx}
      GROUP BY su.id, su.full_name
    `, params);

    res.json({
      ok: true,
      data: {
        date,
        summary: summary.rows[0],
        by_car_type: byCarType.rows,
        by_service: byService.rows,
        by_worker: byWorker.rows,
      },
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// GET /reports/workers?from&to&branch_id
// ═══════════════════════════════════════════════════════════════

router.get('/workers', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const orgId = getOrgId(req.actor!);
    const from = req.query.from as string || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to as string || new Date().toISOString().slice(0, 10);
    let pIdx = 3;
    const params: any[] = [orgId, from, to];
    let branchClause = '';
    // Restricts which STAFF appear at all, independent of the wash filter
    // below — see note at the join.
    let staffBranchClause = '';

    if (req.actor!.role === 'manager') {
      branchClause = ` AND w.branch_id = $${++pIdx}`;
      staffBranchClause = ` AND su.branch_id = $${pIdx}`;
      params.push(req.actor!.branch_id);
    } else if (req.query.branch_id) {
      branchClause = ` AND w.branch_id = $${++pIdx}`;
      staffBranchClause = ` AND su.branch_id = $${pIdx}`;
      params.push(req.query.branch_id);
    }

    const result = await pool.query(`
      SELECT su.id, su.full_name,
        COUNT(*) FILTER (WHERE w.started_by_worker_id = su.id) AS washes_started,
        COUNT(*) FILTER (WHERE w.settled_by_worker_id = su.id AND w.status = 'settled') AS washes_settled,
        COALESCE(SUM(w.amount_ugx) FILTER (WHERE w.settled_by_worker_id = su.id AND w.status = 'settled'), 0) AS cash_taken_ugx,
        COUNT(*) FILTER (WHERE w.settled_by_worker_id = su.id AND w.status = 'settled' AND w.handover_reason IS NOT NULL) AS handovers_received,
        COUNT(*) FILTER (WHERE w.started_by_worker_id = su.id AND w.status = 'settled' AND w.settled_by_worker_id <> su.id) AS handovers_given,
        COUNT(*) FILTER (WHERE w.settled_by_worker_id = su.id AND w.status = 'settled' AND w.settle_verified = false) AS unverified_count,
        COUNT(*) FILTER (WHERE w.started_by_worker_id = su.id AND w.status = 'cancelled') AS cancellations,
        COUNT(*) FILTER (WHERE w.corrected_by = su.id) AS corrections_made,
        COUNT(*) FILTER (WHERE w.settled_by_worker_id = su.id AND w.status = 'reversed') AS reversals
      FROM staff_users su
      -- LEFT JOIN, not JOIN: a worker with zero washes must still show 0s for
      -- their OWN branch, but the join used to be keyed on org_id only, which
      -- pulled in every worker across every branch in the org (a manager at
      -- one branch saw staff from every other branch, all rows zero — this
      -- was a cross-branch data leak, not just a display nuisance).
      LEFT JOIN washes w
        ON w.org_id = su.org_id
        AND w.started_at::date BETWEEN $2 AND $3
        ${branchClause}
      WHERE su.org_id = $1 AND su.role IN ('worker','manager') ${staffBranchClause}
      GROUP BY su.id, su.full_name
      ORDER BY washes_started DESC
    `, params);

    res.json({ ok: true, data: result.rows });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// GET /reports/car-type-mix?from&to&branch_id
// ═══════════════════════════════════════════════════════════════

router.get('/car-type-mix', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const orgId = getOrgId(req.actor!);
    const from = req.query.from as string || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to as string || new Date().toISOString().slice(0, 10);
    let pIdx = 3;
    const params: any[] = [orgId, from, to];
    let branchClause = '';

    if (req.actor!.role === 'manager') {
      branchClause = ` AND w.branch_id = $${++pIdx}`;
      params.push(req.actor!.branch_id);
    } else if (req.query.branch_id) {
      branchClause = ` AND w.branch_id = $${++pIdx}`;
      params.push(req.query.branch_id);
    }

    // Branch average
    const branchTotal = await pool.query(`
      SELECT COUNT(*) as total FROM washes w
      WHERE w.org_id = $1 AND w.status = 'settled' AND w.started_at::date BETWEEN $2 AND $3 ${branchClause}
    `, params);

    const branchMix = await pool.query(`
      SELECT vc.name, COUNT(*)::float / NULLIF(${branchTotal.rows[0]?.total || 1}, 0) as pct
      FROM washes w
      JOIN vehicle_classes vc ON w.vehicle_class_id = vc.id
      WHERE w.org_id = $1 AND w.status = 'settled' AND w.started_at::date BETWEEN $2 AND $3 ${branchClause}
      GROUP BY vc.name
    `, params);

    // Per worker
    const workerMix = await pool.query(`
      SELECT su.full_name, vc.name as vehicle_class_name,
        COUNT(*)::float / NULLIF(COUNT(*) OVER (PARTITION BY su.id), 0) as pct
      FROM washes w
      JOIN staff_users su ON w.started_by_worker_id = su.id
      JOIN vehicle_classes vc ON w.vehicle_class_id = vc.id
      WHERE w.org_id = $1 AND w.status = 'settled' AND w.started_at::date BETWEEN $2 AND $3 ${branchClause}
      GROUP BY su.full_name, vc.name, su.id
      ORDER BY su.full_name, vc.name
    `, params);

    // Compute deviation per worker
    const branchMap: Record<string, number> = {};
    for (const row of branchMix.rows) branchMap[row.name] = parseFloat(row.pct);

    const workerGroups: Record<string, Record<string, number>> = {};
    for (const row of workerMix.rows) {
      if (!workerGroups[row.full_name]) workerGroups[row.full_name] = {};
      workerGroups[row.full_name][row.vehicle_class_name] = parseFloat(row.pct);
    }

    const deviations = Object.entries(workerGroups).map(([name, mix]) => {
      let deviation = 0;
      for (const [vc, pct] of Object.entries(mix)) {
        deviation += Math.abs(pct - (branchMap[vc] || 0));
      }
      return { worker_name: name, deviation: Math.round(deviation * 1000) / 1000, mix };
    });

    deviations.sort((a, b) => b.deviation - a.deviation);

    res.json({
      ok: true,
      data: {
        branch_average: branchMix.rows,
        workers: deviations,
        caveat: 'A high deviation score means the worker\'s car-type distribution differs from the bay average. This warrants investigation but is not proof of misclassification — mix legitimately varies by location and shift.',
      },
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// GET /reports/cash-variance?from&to
// ═══════════════════════════════════════════════════════════════

router.get('/cash-variance', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const orgId = getOrgId(req.actor!);
    const from = req.query.from as string || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to as string || new Date().toISOString().slice(0, 10);
    let pIdx = 3;
    const params: any[] = [orgId, from, to];
    let branchClause = '';

    if (req.actor!.role === 'manager') {
      branchClause = ` AND s.branch_id = $${++pIdx}`;
      params.push(req.actor!.branch_id);
    }

    const result = await pool.query(`
      SELECT s.id, s.opened_at::date as date, s.worker_id, su.full_name as worker_name,
             b.name as branch_name, s.expected_cash_ugx, s.counted_cash_ugx, s.variance_ugx,
             CASE WHEN s.variance_ugx > 0 THEN 'surplus' ELSE 'shortfall' END as variance_type
      FROM shifts s
      JOIN staff_users su ON s.worker_id = su.id
      JOIN branches b ON s.branch_id = b.id
      WHERE s.org_id = $1 AND s.status = 'closed' AND s.variance_ugx <> 0
        AND s.opened_at::date BETWEEN $2 AND $3 ${branchClause}
      ORDER BY ABS(s.variance_ugx) DESC
    `, params);

    const summary = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE variance_ugx > 0) AS surplus_count,
        COUNT(*) FILTER (WHERE variance_ugx < 0) AS shortfall_count,
        COALESCE(SUM(variance_ugx) FILTER (WHERE variance_ugx > 0), 0) AS total_surplus,
        COALESCE(SUM(variance_ugx) FILTER (WHERE variance_ugx < 0), 0) AS total_shortfall
      FROM shifts s
      WHERE s.org_id = $1 AND s.status = 'closed' AND s.variance_ugx <> 0
        AND s.opened_at::date BETWEEN $2 AND $3 ${branchClause}
    `, params);

    res.json({
      ok: true,
      data: {
        summary: summary.rows[0],
        shifts: result.rows,
      },
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// GET /reports/handovers?from&to&branch_id
// ═══════════════════════════════════════════════════════════════

router.get('/handovers', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const orgId = getOrgId(req.actor!);
    const from = req.query.from as string || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to as string || new Date().toISOString().slice(0, 10);
    let pIdx = 3;
    const params: any[] = [orgId, from, to];
    let branchClause = '';

    if (req.actor!.role === 'manager') {
      branchClause = ` AND w.branch_id = $${++pIdx}`;
      params.push(req.actor!.branch_id);
    } else if (req.query.branch_id) {
      branchClause = ` AND w.branch_id = $${++pIdx}`;
      params.push(req.query.branch_id);
    }

    const handovers = await pool.query(`
      SELECT w.id, w.job_no, w.amount_ugx, w.handover_reason, w.settled_at,
             sw.full_name AS starter_name, stw.full_name AS settler_name
      FROM washes w
      JOIN staff_users sw ON w.started_by_worker_id = sw.id
      JOIN staff_users stw ON w.settled_by_worker_id = stw.id
      WHERE w.org_id = $1 AND w.status = 'settled' AND w.handover_reason IS NOT NULL
        AND w.started_at::date BETWEEN $2 AND $3 ${branchClause}
      ORDER BY w.settled_at DESC
    `, params);

    // Rate per worker
    const rates = await pool.query(`
      SELECT su.full_name,
        COUNT(*) FILTER (WHERE w.settled_by_worker_id = su.id AND w.handover_reason IS NOT NULL) AS received,
        COUNT(*) FILTER (WHERE w.started_by_worker_id = su.id AND w.settled_by_worker_id <> su.id) AS given
      FROM washes w
      JOIN staff_users su ON su.org_id = w.org_id AND su.role IN ('worker','manager')
      WHERE w.org_id = $1 AND w.status = 'settled' AND w.started_at::date BETWEEN $2 AND $3 ${branchClause}
      GROUP BY su.id, su.full_name
    `, params);

    res.json({
      ok: true,
      data: {
        handovers: handovers.rows,
        rates: rates.rows,
      },
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// GET /reports/unverified?from&to&branch_id
// ═══════════════════════════════════════════════════════════════

router.get('/unverified', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const orgId = getOrgId(req.actor!);
    const from = req.query.from as string || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to as string || new Date().toISOString().slice(0, 10);
    let pIdx = 3;
    const params: any[] = [orgId, from, to];
    let branchClause = '';

    if (req.actor!.role === 'manager') {
      branchClause = ` AND w.branch_id = $${++pIdx}`;
      params.push(req.actor!.branch_id);
    } else if (req.query.branch_id) {
      branchClause = ` AND w.branch_id = $${++pIdx}`;
      params.push(req.query.branch_id);
    }

    const result = await pool.query(`
      -- Redemptions are excluded from every "unverified" count: a free wash
      -- collects no money, so there is no payment to verify and flagging it
      -- would inflate the worker's exception rate unfairly.
      SELECT su.full_name,
        COUNT(*) FILTER (WHERE w.settle_verified = false AND w.is_redemption = false) AS unverified_count,
        COUNT(*) FILTER (WHERE w.settle_verified = false AND w.is_redemption = false AND w.unverified_reason = 'dead_phone') AS dead_phone,
        COUNT(*) FILTER (WHERE w.settle_verified = false AND w.is_redemption = false AND w.unverified_reason = 'no_app') AS no_app,
        COUNT(*) FILTER (WHERE w.settle_verified = false AND w.is_redemption = false AND w.unverified_reason = 'app_error') AS app_error,
        COUNT(*) AS total_settled,
        ROUND(COUNT(*) FILTER (WHERE w.settle_verified = false AND w.is_redemption = false)::numeric / NULLIF(COUNT(*), 0) * 100, 1) AS rate_pct
      FROM washes w
      JOIN staff_users su ON w.settled_by_worker_id = su.id
      WHERE w.org_id = $1 AND w.status = 'settled' AND w.started_at::date BETWEEN $2 AND $3 ${branchClause}
      GROUP BY su.id, su.full_name
      ORDER BY rate_pct DESC NULLS LAST
    `, params);

    res.json({ ok: true, data: result.rows });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// GET /reports/cancellations?from&to&branch_id
// ═══════════════════════════════════════════════════════════════

router.get('/cancellations', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const orgId = getOrgId(req.actor!);
    const from = req.query.from as string || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to as string || new Date().toISOString().slice(0, 10);
    let pIdx = 3;
    const params: any[] = [orgId, from, to];
    let branchClause = '';

    if (req.actor!.role === 'manager') {
      branchClause = ` AND w.branch_id = $${++pIdx}`;
      params.push(req.actor!.branch_id);
    } else if (req.query.branch_id) {
      branchClause = ` AND w.branch_id = $${++pIdx}`;
      params.push(req.query.branch_id);
    }

    const result = await pool.query(`
      SELECT su.full_name, w.cancel_reason,
        COUNT(*) AS count,
        ROUND(COUNT(*)::numeric / NULLIF(COUNT(*) OVER (PARTITION BY su.id), 0) * 100, 1) AS rate_pct
      FROM washes w
      JOIN staff_users su ON w.started_by_worker_id = su.id
      WHERE w.org_id = $1 AND w.status = 'cancelled' AND w.started_at::date BETWEEN $2 AND $3 ${branchClause}
      GROUP BY su.full_name, w.cancel_reason, su.id
      ORDER BY su.full_name, count DESC
    `, params);

    res.json({ ok: true, data: result.rows });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// GET /reports/durations?from&to&branch_id
// ═══════════════════════════════════════════════════════════════

router.get('/durations', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const orgId = getOrgId(req.actor!);
    const from = req.query.from as string || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to as string || new Date().toISOString().slice(0, 10);
    let pIdx = 3;
    const params: any[] = [orgId, from, to];
    let branchClause = '';

    if (req.actor!.role === 'manager') {
      branchClause = ` AND w.branch_id = $${++pIdx}`;
      params.push(req.actor!.branch_id);
    } else if (req.query.branch_id) {
      branchClause = ` AND w.branch_id = $${++pIdx}`;
      params.push(req.query.branch_id);
    }

    const result = await pool.query(`
      SELECT svc.name AS service_name, vc.name AS vehicle_class_name,
        ROUND(AVG(EXTRACT(EPOCH FROM (w.wash_done_at - w.started_at)) / 60)::numeric, 1) AS avg_wash_minutes,
        ROUND(AVG(EXTRACT(EPOCH FROM (w.settled_at - w.wash_done_at)) / 60)::numeric, 1) AS avg_collection_minutes,
        COUNT(*) AS count
      FROM washes w
      JOIN services svc ON w.service_id = svc.id
      JOIN vehicle_classes vc ON w.vehicle_class_id = vc.id
      WHERE w.org_id = $1 AND w.status = 'settled' AND w.wash_done_at IS NOT NULL
        AND w.started_at::date BETWEEN $2 AND $3 ${branchClause}
      GROUP BY svc.name, vc.name
      ORDER BY count DESC
    `, params);

    res.json({ ok: true, data: result.rows });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// GET /reports/stale?branch_id
// ═══════════════════════════════════════════════════════════════

router.get('/stale', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const orgId = getOrgId(req.actor!);
    let pIdx = 1;
    const params: any[] = [orgId];
    let branchClause = '';

    if (req.actor!.role === 'manager') {
      branchClause = ` AND w.branch_id = $${++pIdx}`;
      params.push(req.actor!.branch_id);
    } else if (req.query.branch_id) {
      branchClause = ` AND w.branch_id = $${++pIdx}`;
      params.push(req.query.branch_id);
    }

    // Ready washes past ready_alert_minutes
    const staleReady = await pool.query(`
      SELECT w.id, w.job_no, w.plate, w.started_at, w.wash_done_at,
        EXTRACT(EPOCH FROM (now() - w.wash_done_at)) / 60 AS minutes_ready,
        vc.name AS vehicle_class_name, b.name AS branch_name,
        b.ready_alert_minutes
      FROM washes w
      JOIN vehicle_classes vc ON w.vehicle_class_id = vc.id
      JOIN branches b ON w.branch_id = b.id
      WHERE w.org_id = $1 AND w.status = 'ready' AND w.wash_done_at IS NOT NULL
        AND EXTRACT(EPOCH FROM (now() - w.wash_done_at)) / 60 > b.ready_alert_minutes ${branchClause}
      ORDER BY w.wash_done_at ASC
    `, params);

    // In-progress washes open unusually long (>30 min)
    const longProgress = await pool.query(`
      SELECT w.id, w.job_no, w.plate, w.started_at,
        EXTRACT(EPOCH FROM (now() - w.started_at)) / 60 AS minutes_open,
        vc.name AS vehicle_class_name, b.name AS branch_name
      FROM washes w
      JOIN vehicle_classes vc ON w.vehicle_class_id = vc.id
      JOIN branches b ON w.branch_id = b.id
      WHERE w.org_id = $1 AND w.status = 'in_progress'
        AND EXTRACT(EPOCH FROM (now() - w.started_at)) / 60 > 30 ${branchClause}
      ORDER BY w.started_at ASC
    `, params);

    res.json({
      ok: true,
      data: {
        stale_ready: staleReady.rows,
        long_in_progress: longProgress.rows,
      },
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// GET /reports/exceptions?from&to
// ═══════════════════════════════════════════════════════════════

router.get('/exceptions', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const orgId = getOrgId(req.actor!);
    const from = req.query.from as string || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to as string || new Date().toISOString().slice(0, 10);
    let pIdx = 3;
    const params: any[] = [orgId, from, to];
    let branchClause = '';

    if (req.actor!.role === 'manager') {
      branchClause = ` AND w.branch_id = $${++pIdx}`;
      params.push(req.actor!.branch_id);
    }

    // All exception types in one query
    const result = await pool.query(`
      SELECT w.id, w.job_no, w.status, w.amount_ugx, w.started_at,
        w.cancel_reason, w.dispute_reason, w.reverse_reason, w.handover_reason,
        w.unverified_reason, w.corrected_at, w.reversed_at, w.disputed_at,
        w.cancelled_at,
        CASE
          WHEN w.status = 'cancelled' THEN 'cancellation'
          WHEN w.status = 'reversed' THEN 'reversal'
          WHEN w.status = 'disputed' THEN 'dispute'
          WHEN w.corrected_at IS NOT NULL THEN 'correction'
          WHEN w.handover_reason IS NOT NULL THEN 'handover'
          WHEN w.settle_verified = false THEN 'unverified'
        END AS exception_type,
        sw.full_name AS starter_name, stw.full_name AS settler_name,
        vc.name AS vehicle_class_name, b.name AS branch_name
      FROM washes w
      JOIN staff_users sw ON w.started_by_worker_id = sw.id
      LEFT JOIN staff_users stw ON w.settled_by_worker_id = stw.id
      JOIN vehicle_classes vc ON w.vehicle_class_id = vc.id
      JOIN branches b ON w.branch_id = b.id
      WHERE w.org_id = $1
        AND w.started_at::date BETWEEN $2 AND $3 ${branchClause}
        AND (
          w.status IN ('cancelled', 'reversed', 'disputed')
          OR w.corrected_at IS NOT NULL
          OR w.handover_reason IS NOT NULL
          OR w.settle_verified = false
        )
      ORDER BY w.started_at DESC
    `, params);

    res.json({ ok: true, data: result.rows });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// GET /reports/branches?from&to — orgadmin only
// ═══════════════════════════════════════════════════════════════

router.get('/branches', requireRole('orgadmin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const orgId = getOrgId(req.actor!);
    const from = req.query.from as string || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to as string || new Date().toISOString().slice(0, 10);

    // Driven FROM branches, not FROM washes: a branch that took no money in
    // the period is still a branch the org admin owns and must see (a quiet
    // branch is itself the signal). The old `FROM washes JOIN branches` made
    // idle branches vanish entirely — the dashboard showed one branch while
    // the Branches screen listed two.
    const result = await pool.query(`
      SELECT b.id AS branch_id, b.name AS branch_name, b.code, b.status AS branch_status,
        COUNT(w.id) FILTER (WHERE w.status = 'settled') AS washes,
        COALESCE(SUM(w.amount_ugx) FILTER (WHERE w.status = 'settled'), 0) AS gross_ugx,
        COALESCE(ROUND(AVG(w.amount_ugx) FILTER (WHERE w.status = 'settled')::numeric, 0), 0) AS avg_ticket,
        (SELECT COALESCE(SUM(ABS(s2.variance_ugx)), 0) FROM shifts s2 WHERE s2.branch_id = b.id AND s2.status = 'closed' AND s2.opened_at::date BETWEEN $2 AND $3) AS total_variance,
        COUNT(w.id) FILTER (WHERE w.status = 'cancelled') AS cancellations,
        COUNT(w.id) FILTER (WHERE w.corrected_at IS NOT NULL) AS corrections,
        COUNT(w.id) FILTER (WHERE w.status = 'disputed') AS disputes,
        COUNT(w.id) FILTER (WHERE w.status = 'reversed') AS reversals,
        (SELECT COUNT(*) FROM staff_users su WHERE su.branch_id = b.id AND su.status = 'active') AS staff_count
      FROM branches b
      LEFT JOIN washes w
        ON w.branch_id = b.id
        AND w.org_id = b.org_id
        AND w.started_at::date BETWEEN $2 AND $3
      WHERE b.org_id = $1
      GROUP BY b.id, b.name, b.code, b.status
      ORDER BY gross_ugx DESC, b.name
    `, [orgId, from, to]);

    res.json({ ok: true, data: result.rows });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// GET /reports/trend?days=14&branch_id — one row per calendar day
//
// The org admin's "how are we doing" question is about direction, not a
// single day's total. Every day in the window is emitted, including zero
// days, so a gap in trading reads as a gap rather than being silently
// closed up by the chart.
// ═══════════════════════════════════════════════════════════════

router.get('/trend', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const orgId = getOrgId(req.actor!);
    const days = Math.min(Math.max(parseInt(String(req.query.days || '14'), 10) || 14, 2), 90);

    let pIdx = 2;
    const params: any[] = [orgId, days];
    let branchClause = '';

    if (req.actor!.role === 'manager') {
      branchClause = ` AND w.branch_id = $${++pIdx}`;
      params.push(req.actor!.branch_id);
    } else if (req.query.branch_id) {
      branchClause = ` AND w.branch_id = $${++pIdx}`;
      params.push(req.query.branch_id);
    }

    const result = await pool.query(`
      WITH span AS (
        SELECT generate_series(
          (now() AT TIME ZONE 'UTC')::date - ($2::int - 1),
          (now() AT TIME ZONE 'UTC')::date,
          '1 day'::interval
        )::date AS day
      )
      SELECT
        span.day::text AS day,
        COUNT(w.id) FILTER (WHERE w.status = 'settled') AS washes,
        COALESCE(SUM(w.amount_ugx) FILTER (WHERE w.status = 'settled'), 0) AS gross_ugx,
        COUNT(w.id) FILTER (WHERE w.status = 'settled' AND w.is_redemption) AS free_washes,
        COUNT(DISTINCT w.client_id) FILTER (WHERE w.status = 'settled' AND w.client_id IS NOT NULL) AS members_served
      FROM span
      LEFT JOIN washes w
        ON w.started_at::date = span.day
        AND w.org_id = $1
        ${branchClause}
      GROUP BY span.day
      ORDER BY span.day
    `, params);

    res.json({ ok: true, data: result.rows });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// GET /reports/cash-position — who is holding money right now, org-wide
//
// The handover screen answers "collect from whom"; this answers the org
// admin's different question: "how much of my money is sitting in someone's
// pocket, and for how long has it been there?" `hours_held` drives the
// overdue flag — cash that has been out for more than a day is the risk.
// ═══════════════════════════════════════════════════════════════

router.get('/cash-position', requireRole('orgadmin', 'manager'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const orgId = getOrgId(req.actor!);
    let pIdx = 1;
    const params: any[] = [orgId];
    let branchClause = '';

    if (req.actor!.role === 'manager') {
      branchClause = ` AND s.branch_id = $${++pIdx}`;
      params.push(req.actor!.branch_id);
    } else if (req.query.branch_id) {
      branchClause = ` AND s.branch_id = $${++pIdx}`;
      params.push(req.query.branch_id);
    }

    const holding = await pool.query(`
      SELECT s.id, s.status, s.opened_at,
        su.full_name AS worker_name,
        b.id AS branch_id, b.name AS branch_name, b.code AS branch_code,
        COALESCE((
          SELECT SUM(w.amount_ugx) FROM washes w
          WHERE w.settled_shift_id = s.id AND w.status = 'settled'
        ), 0) AS held_ugx,
        COALESCE((
          SELECT COUNT(*) FROM washes w
          WHERE w.settled_shift_id = s.id AND w.status = 'settled'
        ), 0) AS settled_count,
        FLOOR(EXTRACT(EPOCH FROM (now() - s.opened_at)) / 3600)::int AS hours_held
      FROM shifts s
      JOIN staff_users su ON s.worker_id = su.id
      JOIN branches b ON s.branch_id = b.id
      WHERE s.org_id = $1 AND s.status <> 'closed' ${branchClause}
      ORDER BY held_ugx DESC, s.opened_at
    `, params);

    // Today's collections, so the screen can show both sides of the ledger.
    const collected = await pool.query(`
      SELECT b.name AS branch_name,
        COUNT(*) AS handovers,
        COALESCE(SUM(s.counted_cash_ugx), 0) AS collected_ugx,
        COALESCE(SUM(s.variance_ugx), 0) AS variance_ugx
      FROM shifts s
      JOIN branches b ON s.branch_id = b.id
      WHERE s.org_id = $1 AND s.status = 'closed'
        AND s.closed_at::date = (now() AT TIME ZONE 'UTC')::date ${branchClause}
      GROUP BY b.id, b.name
      ORDER BY collected_ugx DESC
    `, params);

    res.json({ ok: true, data: { holding: holding.rows, collected_today: collected.rows } });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// GET /reports/price-changes?from&to
// ═══════════════════════════════════════════════════════════════

router.get('/price-changes', requireRole('orgadmin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const orgId = getOrgId(req.actor!);
    const from = req.query.from as string || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to as string || new Date().toISOString().slice(0, 10);

    const result = await pool.query(`
      SELECT al.created_at, al.actor_id, su.full_name AS actor_name,
             al.before, al.after
      FROM audit_logs al
      LEFT JOIN staff_users su ON al.actor_id = su.id
      WHERE al.org_id = $1 AND al.action = 'price.update'
        AND al.created_at::date BETWEEN $2 AND $3
      ORDER BY al.created_at DESC
    `, [orgId, from, to]);

    res.json({ ok: true, data: result.rows });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// GET /reports/loyalty?from&to
// ═══════════════════════════════════════════════════════════════

router.get('/loyalty', requireRole('orgadmin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const orgId = getOrgId(req.actor!);
    const from = req.query.from as string || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const to = req.query.to as string || new Date().toISOString().slice(0, 10);

    // Clients near reward (5/7 and 6/7)
    const nearReward = await pool.query(`
      SELECT c.id, c.full_name, la.wash_count, la.free_wash_credits,
             lc.washes_required
      FROM loyalty_accounts la
      JOIN clients c ON la.client_id = c.id
      JOIN loyalty_configs lc ON lc.org_id = la.org_id
      WHERE la.org_id = $1 AND la.wash_count >= (lc.washes_required - 2) AND la.free_wash_credits = 0
      ORDER BY la.wash_count DESC
    `, [orgId]);

    // Stats
    const stats = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE entry_type = 'reward_granted') AS credits_granted,
        COUNT(*) FILTER (WHERE entry_type = 'redeem') AS credits_redeemed,
        COALESCE(SUM(w.amount_ugx) FILTER (WHERE entry_type = 'redeem'), 0) AS redemption_value_ugx,
        (SELECT COUNT(*) FROM loyalty_accounts WHERE org_id = $1 AND free_wash_credits > 0) AS clients_with_credits,
        (SELECT COALESCE(SUM(free_wash_credits), 0) FROM loyalty_accounts WHERE org_id = $1) AS outstanding_credits
      FROM loyalty_ledger ll
      JOIN washes w ON ll.wash_id = w.id
      WHERE w.org_id = $1 AND ll.created_at::date BETWEEN $2 AND $3
    `, [orgId, from, to]);

    // Average wash price for liability calc
    const avgPrice = await pool.query(`
      SELECT COALESCE(AVG(amount_ugx), 0) AS avg_price
      FROM washes WHERE org_id = $1 AND status = 'settled' AND amount_ugx > 0
    `, [orgId]);

    const outstanding = parseInt(stats.rows[0]?.outstanding_credits || 0);
    const avgWashPrice = Number(avgPrice.rows[0]?.avg_price || 0);

    res.json({
      ok: true,
      data: {
        near_reward: nearReward.rows,
        stats: stats.rows[0],
        unredeemed_liability_ugx: outstanding * avgWashPrice,
        avg_wash_price_ugx: avgWashPrice,
      },
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════
// GET /platform/stats — sysadmin only
// ═══════════════════════════════════════════════════════════════

router.get('/platform/stats', async (req: Request, res: Response, next: NextFunction) => {
    if (!req.actor || req.actor.type !== 'platform') {
      next(createAppError(403, 'FORBIDDEN', 'Platform admin access required'));
      return;
    }
  try {
    const pool = getPool();
    const result = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM organizations) AS total_orgs,
        (SELECT COUNT(*) FROM organizations WHERE status = 'active') AS active_orgs,
        (SELECT COUNT(*) FROM branches WHERE status = 'active') AS active_branches,
        (SELECT COUNT(*) FROM washes WHERE status = 'settled' AND started_at >= date_trunc('month', now())) AS washes_this_month,
        (SELECT COALESCE(SUM(amount_ugx), 0) FROM washes WHERE status = 'settled' AND started_at >= date_trunc('month', now())) AS gross_this_month
    `);

    res.json({ ok: true, data: result.rows[0] });
  } catch (err) { next(err); }
});

export default router;
