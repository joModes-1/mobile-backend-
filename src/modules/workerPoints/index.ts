import { PoolClient } from 'pg';

/**
 * Worker points — the staff incentive scheme.
 *
 * Customer loyalty rewards buying washes; this rewards doing them. A worker
 * earns points for every wash they settle, weighted by what the job was
 * worth, and redeems them against whatever the organisation offers staff.
 *
 * Every function here takes a `PoolClient` rather than opening its own
 * connection, because awarding points has to happen inside the settlement
 * transaction. If the wash rolls back the points must roll back with it —
 * paying a worker for a job that did not survive its own transaction is
 * exactly the kind of drift that makes a balance impossible to audit.
 *
 * The ledger is the record; the account row is a cache of it. Everything
 * that moves points writes both, so `SUM(points_delta)` for a worker must
 * always equal their `points_balance`.
 */

export interface WorkerPointsConfig {
  points_per_wash: number;
  points_per_amount: number;
  amount_step_ugx: number;
  point_value_ugx: number;
  min_amount_ugx: number;
  min_redeem_points: number;
  active: boolean;
}

export interface WorkerPointsAccount {
  staff_id: string;
  org_id: string;
  points_balance: number;
  lifetime_earned: number;
  lifetime_redeemed: number;
  washes_credited: number;
}

/**
 * Reads an org's scheme, creating it from defaults if absent.
 *
 * Created on demand rather than relying on the migration's backfill: that
 * only covered orgs existing at migration time, so every organisation
 * onboarded afterwards would have had no config and silently earned nobody
 * anything. A missing row means "not set up yet", never "switched off" —
 * switching off is what `active` is for.
 */
export async function getConfig(
  client: PoolClient,
  orgId: string
): Promise<WorkerPointsConfig | null> {
  const cols = `points_per_wash, points_per_amount, amount_step_ugx, point_value_ugx,
                min_amount_ugx, min_redeem_points, active`;

  const r = await client.query(
    `SELECT ${cols} FROM worker_points_configs WHERE org_id = $1`,
    [orgId]
  );
  if (r.rows[0]) return r.rows[0];

  const created = await client.query(
    `INSERT INTO worker_points_configs (org_id) VALUES ($1)
     ON CONFLICT (org_id) DO UPDATE SET org_id = EXCLUDED.org_id
     RETURNING ${cols}`,
    [orgId]
  );
  return created.rows[0] ?? null;
}

/** Creates the account row on first use so callers never handle a missing one. */
export async function ensureAccount(
  client: PoolClient,
  staffId: string,
  orgId: string
): Promise<void> {
  await client.query(
    `INSERT INTO worker_points_accounts (staff_id, org_id)
     VALUES ($1, $2) ON CONFLICT (staff_id) DO NOTHING`,
    [staffId, orgId]
  );
}

/** Writes one ledger row and moves the cached balance with it. */
async function post(
  client: PoolClient,
  opts: {
    staffId: string;
    orgId: string;
    washId?: string | null;
    entryType: 'earn' | 'redeem' | 'reversal' | 'manual_adjust' | 'bonus';
    delta: number;
    reason?: string | null;
    createdBy?: string | null;
    countsAsWash?: boolean;
  }
): Promise<WorkerPointsAccount> {
  await ensureAccount(client, opts.staffId, opts.orgId);

  // Lock the row: two washes settled at the same moment must not both read
  // the same starting balance and write the same balance_after.
  const cur = await client.query(
    `SELECT points_balance FROM worker_points_accounts
      WHERE staff_id = $1 FOR UPDATE`,
    [opts.staffId]
  );
  const before: number = cur.rows[0]?.points_balance ?? 0;
  const after = before + opts.delta;

  // A redemption cannot take a worker below zero. The CHECK constraint on
  // the table would reject it anyway; this gives a usable error instead of
  // a raw constraint violation.
  if (after < 0) {
    const err = new Error('Not enough points') as Error & { code?: string };
    err.code = 'INSUFFICIENT_POINTS';
    throw err;
  }

  await client.query(
    `INSERT INTO worker_points_ledger
       (staff_id, org_id, wash_id, entry_type, points_delta, balance_after, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [opts.staffId, opts.orgId, opts.washId ?? null, opts.entryType,
     opts.delta, after, opts.reason ?? null, opts.createdBy ?? null]
  );

  const earned = opts.delta > 0 ? opts.delta : 0;
  const redeemed = opts.entryType === 'redeem' ? Math.abs(opts.delta) : 0;

  const updated = await client.query(
    `UPDATE worker_points_accounts
        SET points_balance    = $2,
            lifetime_earned   = lifetime_earned + $3,
            lifetime_redeemed = lifetime_redeemed + $4,
            washes_credited   = washes_credited + $5,
            updated_at        = now()
      WHERE staff_id = $1
      RETURNING staff_id, org_id, points_balance, lifetime_earned,
                lifetime_redeemed, washes_credited`,
    [opts.staffId, after, earned, redeemed, opts.countsAsWash ? 1 : 0]
  );
  return updated.rows[0];
}

/**
 * Award points for a settled wash. Call inside the settlement transaction,
 * after the wash row is updated.
 *
 * Returns null when nothing was awarded — no config, scheme switched off,
 * a redemption, or below the minimum — so the caller can tell "earned
 * nothing" from "earned zero".
 */
export async function awardForSettlement(
  client: PoolClient,
  opts: {
    staffId: string;
    orgId: string;
    washId: string;
    /**
     * The points frozen onto the wash at booking — its wash type's
     * `worker_points_awarded` from Settings. Earned on every wash (paid with
     * points, a free promo, a credit): points are experience, and the work
     * was the same.
     */
    points: number;
  }
): Promise<{ points: number; account: WorkerPointsAccount } | null> {
  const cfg = await getConfig(client, opts.orgId);
  if (!cfg || !cfg.active) return null;

  const points = opts.points;
  if (points <= 0) return null;

  // The unique index on (wash_id, entry_type) is what actually guarantees
  // one payout per wash. Catching its violation here turns a retry into a
  // no-op rather than failing the settlement that triggered it.
  try {
    const account = await post(client, {
      staffId: opts.staffId,
      orgId: opts.orgId,
      washId: opts.washId,
      entryType: 'earn',
      delta: points,
      reason: null,
      countsAsWash: true,
    });
    return { points, account };
  } catch (e: any) {
    if (e?.code === '23505') return null;   // already awarded
    throw e;
  }
}

/**
 * Take points back when a settled wash is reversed. The job did not happen,
 * so it should not sit in anyone's total.
 *
 * Deliberately clamps at zero rather than pushing a worker negative: a
 * reversal long after the points were spent is the org's problem to absorb,
 * not a debt to collect from someone's next shift.
 */
export async function reverseForWash(
  client: PoolClient,
  opts: { orgId: string; washId: string; reversedBy?: string | null }
): Promise<void> {
  const earn = await client.query(
    `SELECT staff_id, points_delta FROM worker_points_ledger
      WHERE wash_id = $1 AND entry_type = 'earn'`,
    [opts.washId]
  );
  if (earn.rows.length === 0) return;

  const { staff_id, points_delta } = earn.rows[0];

  const cur = await client.query(
    `SELECT points_balance FROM worker_points_accounts WHERE staff_id = $1`,
    [staff_id]
  );
  const balance: number = cur.rows[0]?.points_balance ?? 0;
  const take = Math.min(points_delta, balance);
  if (take <= 0) return;

  try {
    await post(client, {
      staffId: staff_id,
      orgId: opts.orgId,
      washId: opts.washId,
      entryType: 'reversal',
      delta: -take,
      reason: 'Wash reversed',
      createdBy: opts.reversedBy ?? null,
      countsAsWash: false,
    });
  } catch (e: any) {
    if (e?.code === '23505') return;   // already reversed
    throw e;
  }
}

/** Spend points. Throws INSUFFICIENT_POINTS or BELOW_MINIMUM. */
export async function redeem(
  client: PoolClient,
  opts: {
    staffId: string;
    orgId: string;
    points: number;
    reason?: string | null;
    approvedBy?: string | null;
  }
): Promise<WorkerPointsAccount> {
  const cfg = await getConfig(client, opts.orgId);
  if (cfg && opts.points < cfg.min_redeem_points) {
    const err = new Error(
      `Redeem at least ${cfg.min_redeem_points} points`
    ) as Error & { code?: string };
    err.code = 'BELOW_MINIMUM';
    throw err;
  }
  return post(client, {
    staffId: opts.staffId,
    orgId: opts.orgId,
    entryType: 'redeem',
    delta: -Math.abs(opts.points),
    reason: opts.reason ?? null,
    createdBy: opts.approvedBy ?? null,
  });
}

/** A manual correction or a discretionary bonus, always attributed. */
export async function adjust(
  client: PoolClient,
  opts: {
    staffId: string;
    orgId: string;
    points: number;
    reason: string;
    by: string;
    bonus?: boolean;
  }
): Promise<WorkerPointsAccount> {
  return post(client, {
    staffId: opts.staffId,
    orgId: opts.orgId,
    entryType: opts.bonus ? 'bonus' : 'manual_adjust',
    delta: opts.points,
    reason: opts.reason,
    createdBy: opts.by,
  });
}
