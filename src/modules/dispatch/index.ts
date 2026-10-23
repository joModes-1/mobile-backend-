import { notify } from '@/modules/notify';

/**
 * Dispatch — who may take a booked wash, and who gets it when nobody does.
 *
 * The owner's rule: a worker may take a job only while nobody on site has
 * fewer jobs than them. Everyone gets one; once all have one, a second opens
 * up; then a third. "Jobs" means cars being washed (in_progress). A car that
 * is washed and only waiting for payment does not count — the worker's
 * hands are free.
 *
 * A new booking is open to everyone for `accept_window_seconds` ("first to
 * click gets it"). When the window passes, the job goes to the eligible
 * worker with the most experience — lifetime worker points.
 *
 * Only workers take part. A manager can have a shift too, and if managers
 * counted, one with no cars would stop every worker from taking a second.
 * Managers and org admins may still accept a job themselves; the rule just
 * isn't applied to them, and the timer never assigns to them.
 *
 * "On site" = an open shift at the branch AND the app was in touch within
 * `presence_minutes` (staff_users.last_seen_at, stamped by the auth
 * middleware). Shifts open automatically and never close on their own, so
 * an open shift alone would count someone who went home.
 */

export interface DispatchConfig {
  accept_window_seconds: number;
  presence_minutes: number;
  unassigned_alert_minutes: number;
}

export interface OnSiteWorker {
  worker_id: string;
  shift_id: string;
  active_jobs: number;
  lifetime_points: number;
  opened_at: Date;
}

type Db = { query: (sql: string, params?: any[]) => Promise<any> };

export async function getConfig(db: Db, orgId: string): Promise<DispatchConfig> {
  const r = await db.query(
    `SELECT accept_window_seconds, presence_minutes, unassigned_alert_minutes
       FROM dispatch_configs WHERE org_id = $1`,
    [orgId]
  );
  if (r.rows[0]) return r.rows[0];
  const created = await db.query(
    `INSERT INTO dispatch_configs (org_id) VALUES ($1)
     ON CONFLICT (org_id) DO UPDATE SET org_id = EXCLUDED.org_id
     RETURNING accept_window_seconds, presence_minutes, unassigned_alert_minutes`,
    [orgId]
  );
  return created.rows[0];
}

/** Workers on site at a branch, with how many cars each is washing. */
export async function onSiteWorkers(db: Db, branchId: string, presenceMinutes: number): Promise<OnSiteWorker[]> {
  const r = await db.query(
    `SELECT s.worker_id, s.id AS shift_id, s.opened_at,
            (SELECT COUNT(*) FROM washes w
              WHERE w.started_by_worker_id = s.worker_id AND w.status = 'in_progress')::int AS active_jobs,
            COALESCE(a.lifetime_earned, 0)::int AS lifetime_points
       FROM shifts s
       JOIN staff_users su ON su.id = s.worker_id
       LEFT JOIN worker_points_accounts a ON a.staff_id = s.worker_id
      WHERE s.branch_id = $1 AND s.status = 'open'
        AND su.role = 'worker' AND su.status = 'active'
        AND su.last_seen_at > now() - make_interval(mins => $2)`,
    [branchId, presenceMinutes]
  );
  return r.rows;
}

/**
 * Worker points a worker needs before this job is offered to them.
 *
 * The hook for the owner's "high-level cars only for experienced workers"
 * rule, which is still being decided. Until it is, every job needs 0 — so
 * nothing is restricted, but accept and auto-assign already ask the
 * question, and the rule will be a change to this one function.
 */
export function requiredPointsFor(_wash: { quoted_amount_ugx?: number; vehicle_class_id?: string; service_id?: string; plate?: string | null }): number {
  return 0;
}

/**
 * May this staff member take another job right now?
 * `fewestJobs` is the lowest count among the OTHER workers on site.
 */
export async function acceptCheck(
  db: Db,
  opts: { staffId: string; role: string; branchId: string; orgId: string }
): Promise<{ allowed: boolean; myJobs: number; fewestJobs: number | null }> {
  const mine = await db.query(
    `SELECT COUNT(*)::int AS n FROM washes WHERE started_by_worker_id = $1 AND status = 'in_progress'`,
    [opts.staffId]
  );
  const myJobs: number = mine.rows[0].n;
  if (opts.role !== 'worker') return { allowed: true, myJobs, fewestJobs: null };

  const cfg = await getConfig(db, opts.orgId);
  const others = (await onSiteWorkers(db, opts.branchId, cfg.presence_minutes))
    .filter((w) => w.worker_id !== opts.staffId);
  if (others.length === 0) return { allowed: true, myJobs, fewestJobs: null };
  const fewestJobs = Math.min(...others.map((w) => w.active_jobs));
  return { allowed: myJobs <= fewestJobs, myJobs, fewestJobs };
}

/**
 * The worker the timer should give a job to: among on-site workers with the
 * fewest jobs (and enough points for it), the most experienced; ties go to
 * whoever has been on shift longest.
 */
export function pickWorker(workers: OnSiteWorker[], requiredPoints: number): OnSiteWorker | null {
  const eligible = workers.filter((w) => w.lifetime_points >= requiredPoints);
  if (eligible.length === 0) return null;
  const fewest = Math.min(...eligible.map((w) => w.active_jobs));
  return eligible
    .filter((w) => w.active_jobs === fewest)
    .sort((a, b) => b.lifetime_points - a.lifetime_points
      || new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime())[0];
}

/**
 * Give every job whose accept window has passed to the right worker, and
 * alert managers about jobs that have waited too long with nobody to take
 * them. Idempotent and race-safe: the claim is one conditional UPDATE, so
 * the background tick, a polling client and a worker tapping Accept can all
 * run at once and exactly one wins.
 *
 * Called by the background job every few seconds, and also lazily from the
 * screens that poll (worker queue, client active wash) so a job never waits
 * longer than its window just because the tick hasn't come round yet.
 */
export async function dispatchOverdue(db: Db, opts: { branchId?: string } = {}): Promise<{ assigned: number; alerted: number }> {
  const params: any[] = [];
  let branchClause = '';
  if (opts.branchId) {
    params.push(opts.branchId);
    branchClause = `AND w.branch_id = $1`;
  }

  const due = await db.query(
    `SELECT w.id, w.org_id, w.branch_id, w.job_no, w.client_id, w.requested_at, w.dispatch_alerted_at,
            w.quoted_amount_ugx, w.vehicle_class_id, w.service_id, w.plate,
            vc.name AS vehicle_class_name, s.name AS service_name, b.name AS branch_name,
            dc.accept_window_seconds, dc.presence_minutes, dc.unassigned_alert_minutes,
            EXTRACT(EPOCH FROM (now() - w.requested_at)) AS waited_seconds
       FROM washes w
       JOIN dispatch_configs dc ON dc.org_id = w.org_id
       JOIN vehicle_classes vc ON vc.id = w.vehicle_class_id
       JOIN services s ON s.id = w.service_id
       JOIN branches b ON b.id = w.branch_id
      WHERE w.status = 'requested' AND w.started_by_worker_id IS NULL
        AND w.requested_at <= now() - make_interval(secs => dc.accept_window_seconds)
        ${branchClause}
      ORDER BY w.requested_at ASC`,
    params
  );

  let assigned = 0;
  let alerted = 0;
  for (const wash of due.rows) {
    // Re-read every time: each assignment changes who has the fewest jobs.
    const workers = await onSiteWorkers(db, wash.branch_id, wash.presence_minutes);
    const pick = pickWorker(workers, requiredPointsFor(wash));

    if (pick) {
      const claimed = await db.query(
        `UPDATE washes
            SET status = 'in_progress', started_by_worker_id = $1, started_shift_id = $2,
                started_at = now(), assigned_via = 'auto', updated_at = now()
          WHERE id = $3 AND status = 'requested' AND started_by_worker_id IS NULL
          RETURNING id`,
        [pick.worker_id, pick.shift_id, wash.id]
      );
      if (claimed.rows.length > 0) {
        assigned++;
        notify('staff', pick.worker_id, 'wash_assigned', {
          wash_id: wash.id, job_no: wash.job_no,
          vehicle_class_name: wash.vehicle_class_name, service_name: wash.service_name,
        });
        if (wash.client_id) notify('client', wash.client_id, 'wash_started', { wash_id: wash.id, job_no: wash.job_no });
      }
      continue;
    }

    // Nobody on site can take it. Tell the branch's managers once.
    if (!wash.dispatch_alerted_at && Number(wash.waited_seconds) >= wash.unassigned_alert_minutes * 60) {
      const marked = await db.query(
        `UPDATE washes SET dispatch_alerted_at = now() WHERE id = $1 AND dispatch_alerted_at IS NULL RETURNING id`,
        [wash.id]
      );
      if (marked.rows.length > 0) {
        alerted++;
        const managers = await db.query(
          `SELECT id FROM staff_users
            WHERE org_id = $1 AND status = 'active'
              AND ((role = 'manager' AND branch_id = $2) OR role = 'orgadmin')`,
          [wash.org_id, wash.branch_id]
        );
        for (const m of managers.rows) {
          notify('staff', m.id, 'unassigned_wash', {
            wash_id: wash.id, job_no: wash.job_no, branch_name: wash.branch_name,
            minutes: Math.floor(Number(wash.waited_seconds) / 60),
          });
        }
      }
    }
  }
  return { assigned, alerted };
}
