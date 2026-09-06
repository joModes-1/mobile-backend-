/**
 * purgeTokens — nightly.
 * Delete client_tokens that are consumed or expired and older than 7 days.
 */

import { getPool } from '@/db';

export async function runPurgeTokens(): Promise<void> {
  const pool = getPool();

  try {
    const result = await pool.query(`
      DELETE FROM client_tokens
      WHERE (consumed_at IS NOT NULL OR expires_at < now() - interval '7 days')
        AND created_at < now() - interval '7 days'
    `);

    console.log(`[JOB] purgeTokens: ${result.rowCount} token(s) purged`);
  } catch (err: any) {
    console.error(`[JOB] purgeTokens error: ${err.message}`);
  }
}
