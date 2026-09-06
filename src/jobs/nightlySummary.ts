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
    const managers = await pool.query(`
      SELECT su.id as manager_id, su.full_name, b.name as branch_name,
             (SELECT COUNT(*) FROM washes WHERE branch_id = b.id AND status = 'settled' AND started_at::date = $2) AS washes,
             (SELECT COALESCE(SUM(amount_ugx), 0) FROM washes WHERE branch_id = b.id AND status = 'settled' AND started_at::date = $2) AS gross,
             (SELECT COALESCE(SUM(ABS(variance_ugx)), 0) FROM shifts WHERE branch_id = b.id AND status = 'closed' AND opened_at::date = $2) AS variance
      FROM staff_users su
      JOIN branches b ON su.branch_id = b.id
      WHERE su.role = 'manager' AND su.status = 'active'
    `, [yesterday]);

    for (const mgr of managers.rows) {
      const message = `📊 ${mgr.branch_name} — ${yesterday}\n` +
        `Washes: ${mgr.washes} | Gross: UGX ${Number(mgr.gross).toLocaleString()} | Variance: UGX ${Number(mgr.variance).toLocaleString()}`;

      await notify('staff', mgr.manager_id, 'wash_started', {
        wash_id: '',
        vehicle_class: 'Daily Summary',
        service_name: message,
        branch_name: mgr.branch_name,
        amount_ugx: 0,
      });
    }

    console.log(`[JOB] nightlySummary: sent to ${managers.rows.length} manager(s)`);
  } catch (err: any) {
    console.error(`[JOB] nightlySummary error: ${err.message}`);
  }
}
