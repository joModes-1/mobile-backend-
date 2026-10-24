import { PoolClient } from 'pg';

/**
 * Worker wallet — the ONLY module that writes wallet_accounts and
 * wallet_ledger.
 *
 * The balance is what the business owes the worker. It goes negative when a
 * worker is holding cash that belongs to the business, and comes back up
 * when a manager confirms receiving it. Every function takes the caller's
 * PoolClient so money moves inside the same transaction as the event that
 * caused it — a settlement that rolls back takes its commission with it.
 */

export type WalletKind =
  | 'commission' | 'cash_collected' | 'cash_handover' | 'reversal' | 'correction'
  | 'withdrawal' | 'withdrawal_fee' | 'withdrawal_reversal' | 'adjust';

export interface WalletAccount {
  staff_id: string;
  org_id: string;
  balance_ugx: number;
  lifetime_commission_ugx: number;
  lifetime_withdrawn_ugx: number;
}

/** Error in the shape the global error handler reads. */
export class WalletError extends Error {
  constructor(public code: string, message: string, public statusCode = 422, public details?: unknown) {
    super(message);
  }
}

/**
 * Commission on a wash: basis points of the FULL price, rounded down.
 *
 * Full price, not what the client handed over — a worker earns the same
 * whether the client paid cash, mobile money or points, and the business
 * absorbs the points discount and any payment fee. Rounded down so the
 * worker is never credited a shilling the business didn't get.
 */
export function commissionFor(priceUgx: number, bp: number): number {
  if (bp <= 0 || priceUgx <= 0) return 0;
  return Math.floor((priceUgx * bp) / 10000);
}

function toAccount(row: any): WalletAccount {
  return {
    staff_id: row.staff_id,
    org_id: row.org_id,
    balance_ugx: Number(row.balance_ugx),
    lifetime_commission_ugx: Number(row.lifetime_commission_ugx),
    lifetime_withdrawn_ugx: Number(row.lifetime_withdrawn_ugx),
  };
}

async function lockAccount(client: PoolClient, staffId: string, orgId: string): Promise<WalletAccount> {
  await client.query(
    `INSERT INTO wallet_accounts (staff_id, org_id) VALUES ($1, $2) ON CONFLICT (staff_id) DO NOTHING`,
    [staffId, orgId]
  );
  const r = await client.query(
    `SELECT staff_id, org_id, balance_ugx, lifetime_commission_ugx, lifetime_withdrawn_ugx
       FROM wallet_accounts WHERE staff_id = $1 FOR UPDATE`,
    [staffId]
  );
  return toAccount(r.rows[0]);
}

/** Read-only account for screens; no row yet reads as an empty wallet. */
export async function getAccount(client: PoolClient | any, staffId: string, orgId: string): Promise<WalletAccount> {
  const r = await client.query(
    `SELECT staff_id, org_id, balance_ugx, lifetime_commission_ugx, lifetime_withdrawn_ugx
       FROM wallet_accounts WHERE staff_id = $1`,
    [staffId]
  );
  return r.rows[0]
    ? toAccount(r.rows[0])
    : { staff_id: staffId, org_id: orgId, balance_ugx: 0, lifetime_commission_ugx: 0, lifetime_withdrawn_ugx: 0 };
}

/** Writes one ledger row and moves the cached balance with it. */
export async function post(
  client: PoolClient,
  opts: {
    staffId: string; orgId: string; kind: WalletKind; amountUgx: number;
    washId?: string | null; reason?: string | null; createdBy?: string | null;
  }
): Promise<WalletAccount> {
  const account = await lockAccount(client, opts.staffId, opts.orgId);
  const after = account.balance_ugx + opts.amountUgx;

  await client.query(
    `INSERT INTO wallet_ledger (staff_id, org_id, wash_id, kind, amount_ugx, balance_after_ugx, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [opts.staffId, opts.orgId, opts.washId ?? null, opts.kind, opts.amountUgx, after,
     opts.reason ?? null, opts.createdBy ?? null]
  );

  // Lifetime commission follows commission and its undoing; withdrawals
  // are tracked for Phase 6.
  const commissionDelta = opts.kind === 'commission' ? opts.amountUgx : 0;
  const withdrawnDelta =
    opts.kind === 'withdrawal' ? -opts.amountUgx
    : opts.kind === 'withdrawal_reversal' ? -opts.amountUgx
    : 0;

  const r = await client.query(
    `UPDATE wallet_accounts
        SET balance_ugx = $2,
            lifetime_commission_ugx = lifetime_commission_ugx + $3,
            lifetime_withdrawn_ugx = GREATEST(0, lifetime_withdrawn_ugx + $4),
            updated_at = now()
      WHERE staff_id = $1
      RETURNING staff_id, org_id, balance_ugx, lifetime_commission_ugx, lifetime_withdrawn_ugx`,
    [opts.staffId, after, commissionDelta, withdrawnDelta]
  );
  return toAccount(r.rows[0]);
}

/**
 * The money side of a settlement.
 *
 * Commission goes to whoever WASHED the car (the starter). The cash goes
 * against whoever TOOK it (the settler). Usually the same person, so the
 * net is −(cash − commission): they keep their cut out of the notes and owe
 * the rest. On a handover the two land on different wallets, which is
 * exactly right — the settler is the one holding the notes.
 */
export async function recordSettlement(
  client: PoolClient,
  opts: { washId: string; orgId: string; starterId: string; settlerId: string; commissionUgx: number; cashUgx: number }
): Promise<{ starter: WalletAccount | null; settler: WalletAccount | null }> {
  let starter: WalletAccount | null = null;
  let settler: WalletAccount | null = null;
  if (opts.commissionUgx > 0) {
    starter = await post(client, {
      staffId: opts.starterId, orgId: opts.orgId, kind: 'commission', amountUgx: opts.commissionUgx, washId: opts.washId,
    });
  }
  if (opts.cashUgx > 0) {
    settler = await post(client, {
      staffId: opts.settlerId, orgId: opts.orgId, kind: 'cash_collected', amountUgx: -opts.cashUgx, washId: opts.washId,
      reason: 'Cash collected from client',
    });
  }
  if (starter && opts.starterId === opts.settlerId && settler) starter = settler;
  return { starter, settler };
}

/**
 * Undo a reversed wash's money: for every worker it touched, post the
 * opposite of everything the wash moved for them (commission, cash and any
 * corrections). No-op for a worker already reversed.
 */
export async function reverseForWash(
  client: PoolClient,
  opts: { washId: string; reason?: string | null; createdBy?: string | null }
): Promise<Array<{ staff_id: string; amount_ugx: number }>> {
  const nets = await client.query(
    `SELECT staff_id, org_id, SUM(amount_ugx) AS net
       FROM wallet_ledger
      WHERE wash_id = $1 AND kind IN ('commission', 'cash_collected', 'correction')
        AND NOT EXISTS (
          SELECT 1 FROM wallet_ledger r
           WHERE r.wash_id = $1 AND r.kind = 'reversal' AND r.staff_id = wallet_ledger.staff_id)
      GROUP BY staff_id, org_id`,
    [opts.washId]
  );
  const out: Array<{ staff_id: string; amount_ugx: number }> = [];
  for (const row of nets.rows) {
    const net = Number(row.net);
    if (net === 0) continue;
    await post(client, {
      staffId: row.staff_id, orgId: row.org_id, kind: 'reversal', amountUgx: -net, washId: opts.washId,
      reason: opts.reason ?? 'Wash reversed', createdBy: opts.createdBy,
    });
    out.push({ staff_id: row.staff_id, amount_ugx: -net });
  }
  return out;
}

/**
 * A manager corrected a settled wash's price. Commission follows the new
 * price; if it was a cash wash, what the settler owes follows the new cash
 * amount. Posts only the differences.
 */
export async function correctForWash(
  client: PoolClient,
  opts: {
    washId: string; orgId: string; starterId: string; settlerId: string;
    commissionDelta: number; cashDelta: number; reason?: string | null; createdBy?: string | null;
  }
): Promise<void> {
  const deltas = new Map<string, number>();
  if (opts.commissionDelta !== 0) deltas.set(opts.starterId, (deltas.get(opts.starterId) ?? 0) + opts.commissionDelta);
  if (opts.cashDelta !== 0) deltas.set(opts.settlerId, (deltas.get(opts.settlerId) ?? 0) - opts.cashDelta);
  for (const [staffId, amount] of deltas) {
    if (amount === 0) continue;
    await post(client, {
      staffId, orgId: opts.orgId, kind: 'correction', amountUgx: amount, washId: opts.washId,
      reason: opts.reason ?? 'Wash corrected', createdBy: opts.createdBy,
    });
  }
}

/**
 * The cash each worker still holds for the business — one of the two pots
 * their single balance is made of (decided 2026-10-23):
 *
 *   cash     per cash wash they settled, the cash they took less the
 *            commission they kept out of it (never below nothing), less
 *            everything a manager has confirmed receiving;
 *   account  everything else — commission on mobile-money, points and free
 *            washes, a washer's commission on a car someone else settled,
 *            withdrawals, adjustments. Theirs to withdraw, whatever cash
 *            they are holding.
 *
 * balance = account − cash owed, always, so the account is never stored:
 * it is the balance plus what this returns. Worked out from the ledger per
 * wash, so a reversal or correction lands in the pot its wash belongs to.
 */
export async function cashOwedFor(client: PoolClient | any, staffIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>(staffIds.map((id) => [id, 0]));
  if (staffIds.length === 0) return out;
  const r = await client.query(
    `WITH cash_washes AS (
       SELECT DISTINCT staff_id, wash_id FROM wallet_ledger
        WHERE kind = 'cash_collected' AND staff_id = ANY($1::uuid[])
     ),
     per_wash AS (
       SELECT l.staff_id, SUM(l.amount_ugx) AS net
         FROM wallet_ledger l
         JOIN cash_washes c ON c.staff_id = l.staff_id AND c.wash_id = l.wash_id
        GROUP BY l.staff_id, l.wash_id
     ),
     held AS (SELECT staff_id, SUM(LEAST(net, 0)) AS amount FROM per_wash GROUP BY staff_id),
     handed AS (
       SELECT staff_id, SUM(amount_ugx) AS amount FROM wallet_ledger
        WHERE kind = 'cash_handover' AND staff_id = ANY($1::uuid[])
        GROUP BY staff_id
     )
     SELECT s.staff_id, COALESCE(h.amount, 0) + COALESCE(d.amount, 0) AS pot
       FROM unnest($1::uuid[]) AS s(staff_id)
       LEFT JOIN held h ON h.staff_id = s.staff_id
       LEFT JOIN handed d ON d.staff_id = s.staff_id`,
    [staffIds]
  );
  for (const row of r.rows) out.set(row.staff_id, Math.max(0, -Number(row.pot)));
  return out;
}

export async function cashOwed(client: PoolClient | any, staffId: string): Promise<number> {
  return (await cashOwedFor(client, [staffId])).get(staffId) ?? 0;
}

/**
 * A manager confirms receiving cash from a worker. Partial amounts are
 * fine; more than the cash the worker holds is refused — over-confirming
 * would hand the worker a withdrawable balance for money that never existed.
 * The limit is the cash pot, not the net balance: commission sitting in the
 * worker's account does not shrink the cash they have to bring in.
 */
export async function cashHandover(
  client: PoolClient,
  opts: { staffId: string; orgId: string; amountUgx: number; by: string; note?: string | null }
): Promise<WalletAccount> {
  // Lock first: every ledger write for this worker goes through the same row.
  await lockAccount(client, opts.staffId, opts.orgId);
  const owed = await cashOwed(client, opts.staffId);
  if (owed === 0) throw new WalletError('NOTHING_OWED', 'This worker does not owe any cash', 409);
  if (opts.amountUgx > owed) {
    throw new WalletError('MORE_THAN_OWED', `This worker only owes UGX ${owed}`, 422, { owed_ugx: owed });
  }
  return post(client, {
    staffId: opts.staffId, orgId: opts.orgId, kind: 'cash_handover', amountUgx: opts.amountUgx,
    reason: opts.note ?? 'Cash received by manager', createdBy: opts.by,
  });
}
