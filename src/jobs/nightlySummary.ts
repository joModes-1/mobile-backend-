/**
 * nightlySummary — 6am daily.
 * Push each manager their branch's previous-day one-liner.
 */

import { getPool } from '@/db';
import { notify } from '@/modules/notify';

export async function runNightlySummary(): Promise<void> {
  const pool = getPool();

  try {
    // Get yesterday's date
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    // Get managers with their branch summaries
    // Every placeholder is $1: this referenced $2 while passing a single
    // parameter, so Postgres rejected it with "could not determine data type
    // of parameter $1" on every run — the job has never actually sent a
    // summary. The catch below swallowed it, so it failed silently.
    const managers = await pool.query(`
      SELECT su.id as manager_id, su.full_name, b.id as branch_id, b.name as branch_name,
             (SELECT COUNT(*) FROM washes WHERE branch_id = b.id AND status = 'settled' AND started_at::date = $1) AS washes,
             (SELECT COALESCE(SUM(amount_ugx), 0) FROM washes WHERE branch_id = b.id AND status = 'settled' AND started_at::date = $1) AS gross,
             (SELECT COALESCE(SUM(ABS(variance_ugx)), 0) FROM shifts WHERE branch_id = b.id AND status = 'closed' AND opened_at::date = $1) AS variance
      FROM staff_users su
      JOIN branches b ON su.branch_id = b.id
      WHERE su.role = 'manager' AND su.status = 'active'
    `, [yesterday]);

    for (const mgr of managers.rows) {
      await notify('staff', mgr.manager_id, 'daily_summary', {
        date: yesterday,
        branch_id: mgr.branch_id,
        branch_name: mgr.branch_name,
        washes: Number(mgr.washes),
        gross_ugx: Number(mgr.gross),
        variance_ugx: Number(mgr.variance),
      });
    }

    console.log(`[JOB] nightlySummary: sent to ${managers.rows.length} manager(s)`);
  } catch (err: any) {
    console.error(`[JOB] nightlySummary error: ${err.message}`);
  }
}
