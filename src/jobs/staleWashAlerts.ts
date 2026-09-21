/**
 * staleWashAlerts — every 15 minutes.
 * Find ready washes older than ready_alert_minutes, notify branch manager.
 * Track alerted washes to avoid re-alerting.
 */

import { getPool } from '@/db';
import { notify } from '@/modules/notify';

const alertedWashes = new Set<string>();

export async function runStaleWashAlerts(): Promise<void> {
  const pool = getPool();

  try {
    const result = await pool.query(`
      SELECT w.id, w.job_no, w.wash_done_at, w.branch_id,
             b.name as branch_name, b.ready_alert_minutes
      FROM washes w
      JOIN branches b ON w.branch_id = b.id
      WHERE w.status = 'ready' AND w.wash_done_at IS NOT NULL
        AND EXTRACT(EPOCH FROM (now() - w.wash_done_at)) / 60 > b.ready_alert_minutes
        AND w.id <> ALL(COALESCE($1::uuid[], ARRAY[]::uuid[]))
    `, [alertedWashes.size > 0 ? Array.from(alertedWashes) : null]);

    for (const wash of result.rows) {
      // Find the branch manager
      const mgrResult = await pool.query(
        `SELECT id FROM staff_users WHERE branch_id = $1 AND role = 'manager' AND status = 'active' LIMIT 1`,
        [wash.branch_id]
      );

      for (const mgr of mgrResult.rows) {
        await notify('staff', mgr.id, 'stale_wash', {
          wash_id: wash.id,
          job_no: wash.job_no,
          minutes: wash.ready_alert_minutes,
          branch_name: wash.branch_name,
        });
      }

      alertedWashes.add(wash.id);
    }

    // Clean up old entries (older than 24h) to prevent memory leak
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    for (const id of alertedWashes) {
      const check = await pool.query(`SELECT started_at FROM washes WHERE id = $1`, [id]);
      if (check.rows.length === 0 || new Date(check.rows[0].started_at) < cutoff) {
        alertedWashes.delete(id);
      }
    }

    console.log(`[JOB] staleWashAlerts: ${result.rows.length} stale wash(es) alerted`);
  } catch (err: any) {
    console.error(`[JOB] staleWashAlerts error: ${err.message}`);
  }
}
