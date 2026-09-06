/**
 * expireCredits — nightly.
 * Expire free wash credits older than the window (if configured).
 * Writes a manual_adjust ledger entry with reason 'credit_expired'.
 */

import { getPool } from '@/db';
import { writeLedgerEntry } from '@/modules/loyalty';

export async function runExpireCredits(): Promise<void> {
  const pool = getPool();

  try {
    // Find orgs with credit expiry configured
    const orgs = await pool.query(`
      SELECT org_id, credit_expiry_days FROM loyalty_configs WHERE credit_expiry_days IS NOT NULL
    `);

    for (const config of orgs.rows) {
      const { org_id, credit_expiry_days } = config;

      // Find clients with credits and washes older than expiry window
      const expiredClients = await pool.query(`
        SELECT la.client_id, la.free_wash_credits,
               MAX(w.settled_at) as last_wash_date
        FROM loyalty_accounts la
        JOIN washes w ON w.client_id = la.client_id AND w.status = 'settled'
        WHERE la.org_id = $1 AND la.free_wash_credits > 0
        GROUP BY la.client_id, la.free_wash_credits
        HAVING MAX(w.settled_at) < now() - interval '1 day' * $2
      `, [org_id, credit_expiry_days]);

      for (const client of expiredClients.rows) {
        const { client_id, free_wash_credits } = client;

        // Get current account
        const acct = await pool.query(`SELECT * FROM loyalty_accounts WHERE client_id = $1`, [client_id]);
        if (acct.rows.length === 0) continue;

        const account = acct.rows[0];
        const creditsToExpire = account.free_wash_credits;

        if (creditsToExpire <= 0) continue;

        // Zero out credits
        await pool.query(
          `UPDATE loyalty_accounts SET free_wash_credits = 0, updated_at = now() WHERE client_id = $1`,
          [client_id]
        );

        // Write ledger entry
        await writeLedgerEntry(pool, {
          clientId: client_id,
          washId: null,
          entryType: 'manual_adjust',
          washDelta: 0,
          creditDelta: -creditsToExpire,
          washCountAfter: account.wash_count,
          creditsAfter: 0,
          reason: `credit_expired: ${creditsToExpire} credit(s) expired after ${credit_expiry_days} days`,
        });

        console.log(`[JOB] expireCredits: ${creditsToExpire} credit(s) expired for client ${client_id}`);
      }
    }

    console.log(`[JOB] expireCredits: processed ${orgs.rows.length} org(s)`);
  } catch (err: any) {
    console.error(`[JOB] expireCredits error: ${err.message}`);
  }
}
