import { PoolClient } from 'pg';

/**
 * Client points — the customer reward scheme that replaced the stamp card.
 *
 * The ONLY module that writes client_points_accounts and
 * client_points_ledger. Every function takes a PoolClient rather than opening
 * its own connection, because points always move inside someone else's
 * transaction: a booking, a settlement, a cancellation. If that rolls back,
 * the points must roll back with it.
 *
 * The ledger is the record; the account row is a cache of it. Everything
 * that moves points writes both, so SUM(points_delta) for an account always
 * equals its balance.
 */

export interface ClientPointsConfig {
  enabled: boolean;
  point_value_ugx: number;
}

export interface ClientPointsAccount {
  client_id: string;
  org_id: string;
  balance: number;
  lifetime_earned: number;
  lifetime_redeemed: number;
}

type EntryType = 'earn' | 'redeem' | 'refund' | 'reversal' | 'adjust';

/**
 * Error with an API code. Carries `statusCode` and `code` in the shape the
 * global error handler reads, so a route can simply pass it to next().
 */
export class PointsError extends Error {
  constructor(public code: string, message: string, public statusCode = 422) {
    super(message);
  }
}

/**
 * An org's scheme, created from defaults if absent. A missing row means
 * "not set up yet", never "switched off" — that is what `enabled` is for —
 * so an organisation onboarded after the migration still works.
 */
export async function getConfig(client: PoolClient, orgId: string): Promise<ClientPointsConfig> {
  const r = await client.query(
    `SELECT enabled, point_value_ugx FROM client_points_configs WHERE org_id = $1`,
    [orgId]
  );
  if (r.rows[0]) return r.rows[0];

  const created = await client.query(
    `INSERT INTO client_points_configs (org_id) VALUES ($1)
     ON CONFLICT (org_id) DO UPDATE SET org_id = EXCLUDED.org_id
     RETURNING enabled, point_value_ugx`,
    [orgId]
  );
  return created.rows[0];
}

async function ensureAccount(client: PoolClient, clientId: string, orgId: string): Promise<void> {
  await client.query(
    `INSERT INTO client_points_accounts (client_id, org_id)
     VALUES ($1, $2) ON CONFLICT (client_id, org_id) DO NOTHING`,
    [clientId, orgId]
  );
}

/** Locks and returns the account row, creating it on first use. */
async function lockAccount(client: PoolClient, clientId: string, orgId: string): Promise<ClientPointsAccount> {
  await ensureAccount(client, clientId, orgId);
  const r = await client.query(
    `SELECT client_id, org_id, balance, lifetime_earned, lifetime_redeemed
       FROM client_points_accounts
      WHERE client_id = $1 AND org_id = $2
      FOR UPDATE`,
    [clientId, orgId]
  );
  return r.rows[0];
}

/** Read-only balance for screens. No row yet reads as zero. */
export async function getAccount(client: PoolClient, clientId: string, orgId: string): Promise<ClientPointsAccount> {
  const r = await client.query(
    `SELECT client_id, org_id, balance, lifetime_earned, lifetime_redeemed
       FROM client_points_accounts WHERE client_id = $1 AND org_id = $2`,
    [clientId, orgId]
  );
  return r.rows[0] ?? { client_id: clientId, org_id: orgId, balance: 0, lifetime_earned: 0, lifetime_redeemed: 0 };
}

/** Writes one ledger row and moves the cached balance with it. Caller holds the row lock. */
async function post(
  client: PoolClient,
  account: ClientPointsAccount,
  opts: { washId?: string | null; entryType: EntryType; delta: number; reason?: string | null; createdBy?: string | null }
): Promise<ClientPointsAccount> {
  const after = account.balance + opts.delta;
  if (after < 0) throw new PointsError('INSUFFICIENT_POINTS', 'Not enough points');

  await client.query(
    `INSERT INTO client_points_ledger
       (client_id, org_id, wash_id, entry_type, points_delta, balance_after, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [account.client_id, account.org_id, opts.washId ?? null, opts.entryType,
     opts.delta, after, opts.reason ?? null, opts.createdBy ?? null]
  );

  // lifetime_redeemed tracks points actually spent on washes, so a refund
  // of a redemption takes it back down; lifetime_earned likewise for a
  // reversed earn. Manual adjustments touch neither.
  const earned = opts.entryType === 'earn' ? opts.delta : opts.entryType === 'reversal' ? opts.delta : 0;
  const redeemed = opts.entryType === 'redeem' ? -opts.delta : opts.entryType === 'refund' ? -opts.delta : 0;

  const updated = await client.query(
    `UPDATE client_points_accounts
        SET balance = $3,
            lifetime_earned = GREATEST(0, lifetime_earned + $4),
            lifetime_redeemed = GREATEST(0, lifetime_redeemed + $5),
            updated_at = now()
      WHERE client_id = $1 AND org_id = $2
      RETURNING client_id, org_id, balance, lifetime_earned, lifetime_redeemed`,
    [account.client_id, account.org_id, after, earned, redeemed]
  );
  return updated.rows[0];
}

/**
 * Works out how many points a booking will spend, and locks the account so
 * nothing else can spend them before applyRedemption runs in the same
 * transaction. Two bookings racing for the same points serialise on that
 * lock; the second sees the reduced balance.
 *
 * Spends only what the price needs, never more: points worth 30,000 against
 * a 25,000 wash use 250 points (at 100 each) and the rest stay. When the
 * points are worth less than the price they are all used and the client pays
 * the difference. Rounds up to whole points, so the cover is capped at the
 * price rather than overshooting it.
 */
export async function planRedemption(
  client: PoolClient,
  opts: { clientId: string; orgId: string; priceUgx: number }
): Promise<{ pointsUsed: number; valueUgx: number; pointValueUgx: number }> {
  const cfg = await getConfig(client, opts.orgId);
  if (!cfg.enabled) throw new PointsError('POINTS_DISABLED', 'Points are not available here');
  if (cfg.point_value_ugx <= 0) throw new PointsError('POINTS_NOT_SPENDABLE', 'Points cannot be spent yet');

  const account = await lockAccount(client, opts.clientId, opts.orgId);
  if (account.balance <= 0) throw new PointsError('NO_POINTS', 'You have no points to use');

  const pointsNeeded = Math.ceil(opts.priceUgx / cfg.point_value_ugx);
  const pointsUsed = Math.min(account.balance, pointsNeeded);
  const valueUgx = Math.min(opts.priceUgx, pointsUsed * cfg.point_value_ugx);
  return { pointsUsed, valueUgx, pointValueUgx: cfg.point_value_ugx };
}

/** Deducts the planned points against the wash just inserted. */
export async function applyRedemption(
  client: PoolClient,
  opts: { clientId: string; orgId: string; washId: string; pointsUsed: number }
): Promise<ClientPointsAccount> {
  const account = await lockAccount(client, opts.clientId, opts.orgId);
  return post(client, account, { washId: opts.washId, entryType: 'redeem', delta: -opts.pointsUsed });
}

/**
 * Award the points frozen onto a wash at booking. Called inside the
 * settlement transaction. Returns null when nothing was awarded.
 *
 * A wash paid entirely with points earns nothing — otherwise points would
 * keep paying for washes that generate more points.
 */
export async function awardForSettlement(
  client: PoolClient,
  opts: { clientId: string; orgId: string; washId: string; points: number; fullyCoveredByPoints: boolean; createdBy?: string | null }
): Promise<{ points: number; account: ClientPointsAccount } | null> {
  if (opts.points <= 0 || opts.fullyCoveredByPoints) return null;
  const cfg = await getConfig(client, opts.orgId);
  if (!cfg.enabled) return null;

  const account = await lockAccount(client, opts.clientId, opts.orgId);
  try {
    // A savepoint, because a unique violation aborts the whole transaction
    // otherwise — and this runs inside the settlement.
    await client.query('SAVEPOINT client_points_earn');
    const updated = await post(client, account, {
      washId: opts.washId, entryType: 'earn', delta: opts.points, createdBy: opts.createdBy,
    });
    await client.query('RELEASE SAVEPOINT client_points_earn');
    return { points: opts.points, account: updated };
  } catch (e: any) {
    if (e?.code === '23505') {
      await client.query('ROLLBACK TO SAVEPOINT client_points_earn');
      return null; // already earned
    }
    throw e;
  }
}

async function entryFor(client: PoolClient, washId: string, entryType: EntryType) {
  const r = await client.query(
    `SELECT client_id, org_id, points_delta FROM client_points_ledger WHERE wash_id = $1 AND entry_type = $2`,
    [washId, entryType]
  );
  return r.rows[0] as { client_id: string; org_id: string; points_delta: number } | undefined;
}

/**
 * Give back the points a wash spent. Used when a wash is cancelled or
 * reversed: the client paid with points for a wash they did not get.
 * No-op if nothing was spent or it was already refunded.
 */
export async function refundForWash(
  client: PoolClient,
  opts: { washId: string; reason?: string | null; createdBy?: string | null }
): Promise<number> {
  const redeem = await entryFor(client, opts.washId, 'redeem');
  if (!redeem) return 0;
  if (await entryFor(client, opts.washId, 'refund')) return 0;

  const account = await lockAccount(client, redeem.client_id, redeem.org_id);
  const points = -redeem.points_delta;
  await post(client, account, {
    washId: opts.washId, entryType: 'refund', delta: points, reason: opts.reason, createdBy: opts.createdBy,
  });
  return points;
}

/**
 * Undo a settled wash that should not have happened: refund what it spent,
 * take back what it earned. Taking back is clamped at the current balance —
 * if the client already spent those points, the business absorbs it rather
 * than pushing a customer negative. The ledger keeps the full story.
 */
export async function reverseForWash(
  client: PoolClient,
  opts: { washId: string; reason?: string | null; createdBy?: string | null }
): Promise<{ refunded: number; takenBack: number }> {
  const refunded = await refundForWash(client, opts);

  let takenBack = 0;
  const earn = await entryFor(client, opts.washId, 'earn');
  if (earn && !(await entryFor(client, opts.washId, 'reversal'))) {
    const account = await lockAccount(client, earn.client_id, earn.org_id);
    takenBack = Math.min(earn.points_delta, account.balance);
    const shortfall = earn.points_delta - takenBack;
    await post(client, account, {
      washId: opts.washId,
      entryType: 'reversal',
      delta: -takenBack,
      reason: shortfall > 0
        ? `${opts.reason ?? 'Wash reversed'} (${shortfall} points already spent)`
        : opts.reason ?? 'Wash reversed',
      createdBy: opts.createdBy,
    });
  }
  return { refunded, takenBack };
}

/** A manual correction by an org admin, always with a reason. */
export async function adjust(
  client: PoolClient,
  opts: { clientId: string; orgId: string; points: number; reason: string; by: string }
): Promise<ClientPointsAccount> {
  const account = await lockAccount(client, opts.clientId, opts.orgId);
  return post(client, account, { entryType: 'adjust', delta: opts.points, reason: opts.reason, createdBy: opts.by });
}
