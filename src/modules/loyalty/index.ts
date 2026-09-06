/**
 * Loyalty module — the ONLY module that writes loyalty_accounts and loyalty_ledger.
 */

import { getPool } from '@/db';

/**
 * Ensure a loyalty account exists for this client/org (create on first interaction).
 */
export async function ensureAccount(
  pool: any,
  clientId: string,
  orgId: string
): Promise<any> {
  const existing = await pool.query(
    `SELECT * FROM loyalty_accounts WHERE client_id = $1`,
    [clientId]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const result = await pool.query(
    `INSERT INTO loyalty_accounts (client_id, org_id)
     VALUES ($1, $2)
     ON CONFLICT (client_id) DO NOTHING
     RETURNING *`,
    [clientId, orgId]
  );
  if (result.rows.length > 0) return result.rows[0];

  // Race: another transaction inserted first
  const retry = await pool.query(
    `SELECT * FROM loyalty_accounts WHERE client_id = $1`,
    [clientId]
  );
  return retry.rows[0];
}

/**
 * Get loyalty config for an org (washes_required, min_amount_ugx).
 * Creates a default config if none exists.
 */
export async function getConfig(pool: any, orgId: string): Promise<any> {
  const existing = await pool.query(
    `SELECT * FROM loyalty_configs WHERE org_id = $1`,
    [orgId]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const result = await pool.query(
    `INSERT INTO loyalty_configs (org_id, washes_required, min_amount_ugx)
     VALUES ($1, 7, 0)
     ON CONFLICT (org_id) DO NOTHING
     RETURNING *`,
    [orgId]
  );
  if (result.rows.length > 0) return result.rows[0];

  const retry = await pool.query(
    `SELECT * FROM loyalty_configs WHERE org_id = $1`,
    [orgId]
  );
  return retry.rows[0];
}

/**
 * Get a loyalty account row locked for update (call inside transaction).
 */
export async function lockAccount(
  pool: any,
  clientId: string
): Promise<any | null> {
  const result = await pool.query(
    `SELECT * FROM loyalty_accounts WHERE client_id = $1 FOR UPDATE`,
    [clientId]
  );
  return result.rows.length > 0 ? result.rows[0] : null;
}

/**
 * Write a ledger entry and update account balance.
 * This must be called inside the same transaction as the wash update.
 */
export async function writeLedgerEntry(
  pool: any,
  params: {
    clientId: string;
    washId: string | null;
    entryType: string;
    washDelta: number;
    creditDelta: number;
    washCountAfter: number;
    creditsAfter: number;
    reason?: string;
    createdBy?: string;
  }
): Promise<void> {
  await pool.query(
    `INSERT INTO loyalty_ledger (client_id, wash_id, entry_type, wash_delta, credit_delta,
       wash_count_after, credits_after, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      params.clientId,
      params.washId,
      params.entryType,
      params.washDelta,
      params.creditDelta,
      params.washCountAfter,
      params.creditsAfter,
      params.reason || null,
      params.createdBy || null,
    ]
  );
}

/**
 * Process loyalty at settlement (called inside a transaction).
 * Handles: earn, reward_granted, redeem.
 * Returns the updated account.
 */
export async function processSettlement(
  pool: any,
  clientId: string,
  orgId: string,
  washId: string,
  isRedemption: boolean,
  earnsPoint: boolean,
  amountUgx: number,
  settlerId: string
): Promise<{ account: any; rewardGranted: boolean }> {
  const config = await getConfig(pool, orgId);
  const account = await lockAccount(pool, clientId);

  if (!account) {
    // Shouldn't happen if ensureAccount was called, but handle gracefully
    throw new Error('Loyalty account not found');
  }

  let rewardGranted = false;

  if (isRedemption) {
    if (account.free_wash_credits < 1) {
      throw { status: 422, code: 'NO_CREDITS', message: 'No free wash credits available' } as any;
    }

    // Consume credit
    const newCredits = account.free_wash_credits - 1;
    const newRedeemed = account.lifetime_redeemed + 1;

    await pool.query(
      `UPDATE loyalty_accounts
       SET free_wash_credits = $1, lifetime_redeemed = $2, updated_at = now()
       WHERE client_id = $3`,
      [newCredits, newRedeemed, clientId]
    );

    await writeLedgerEntry(pool, {
      clientId,
      washId,
      entryType: 'redeem',
      washDelta: 0,
      creditDelta: -1,
      washCountAfter: account.wash_count,
      creditsAfter: newCredits,
      createdBy: settlerId,
    });

    return { account: { ...account, free_wash_credits: newCredits, lifetime_redeemed: newRedeemed }, rewardGranted };
  }

  // Earn path
  if (earnsPoint && amountUgx >= config.min_amount_ugx) {
    const newWashCount = account.wash_count + 1;
    const newLifetime = account.lifetime_washes + 1;

    let finalWashCount = newWashCount;
    let finalCredits = account.free_wash_credits;

    await writeLedgerEntry(pool, {
      clientId,
      washId,
      entryType: 'earn',
      washDelta: 1,
      creditDelta: 0,
      washCountAfter: newWashCount,
      creditsAfter: finalCredits,
      createdBy: settlerId,
    });

    // Check if reward is earned
    if (newWashCount >= config.washes_required) {
      finalWashCount = newWashCount - config.washes_required;
      finalCredits = account.free_wash_credits + 1;
      rewardGranted = true;

      await writeLedgerEntry(pool, {
        clientId,
        washId,
        entryType: 'reward_granted',
        washDelta: 0,
        creditDelta: 1,
        washCountAfter: finalWashCount,
        creditsAfter: finalCredits,
        createdBy: settlerId,
      });
    }

    await pool.query(
      `UPDATE loyalty_accounts
       SET wash_count = $1, lifetime_washes = $2, free_wash_credits = $3, updated_at = now()
       WHERE client_id = $4`,
      [finalWashCount, newLifetime, finalCredits, clientId]
    );

    return { account: { ...account, wash_count: finalWashCount, lifetime_washes: newLifetime, free_wash_credits: finalCredits }, rewardGranted };
  }

  return { account, rewardGranted };
}
