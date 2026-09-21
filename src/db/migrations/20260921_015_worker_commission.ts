import type { Knex } from 'knex';

/**
 * Worker commission: a worker keeps a percentage of what they collect.
 *
 * Two pieces, and the second is the one that matters for correctness:
 *
 *  - `branches.worker_commission_pct` — the rate, set per branch. Stored as
 *    basis points (250 = 2.5%) rather than a float, because money split by
 *    a binary float eventually disagrees with itself by a shilling and cash
 *    reconciliation is exactly where that gets noticed.
 *
 *  - `washes.worker_commission_ugx` — what the worker actually earned on
 *    that wash, computed and frozen at settlement. It is NOT derived from
 *    the branch rate at read time: the rate changes, and a report run next
 *    month must still show what the worker was owed on the day, not what
 *    the current rate would imply. Every earnings report and the shift's
 *    expected cash read this column, never the percentage.
 *
 * Commission applies only to money the worker physically holds — cash. A
 * mobile-money or free wash earns nothing here, so the column stays 0 for
 * those and the cash they hand over is unaffected.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE branches
      ADD COLUMN worker_commission_bp INT NOT NULL DEFAULT 0
  `);
  await knex.raw(`
    ALTER TABLE branches
      ADD CONSTRAINT branches_commission_range_ck
      CHECK (worker_commission_bp >= 0 AND worker_commission_bp <= 10000)
  `);

  await knex.raw(`
    ALTER TABLE washes
      ADD COLUMN worker_commission_ugx BIGINT NOT NULL DEFAULT 0
  `);
  await knex.raw(`
    ALTER TABLE washes
      ADD CONSTRAINT washes_commission_nonneg_ck
      CHECK (worker_commission_ugx >= 0)
  `);

  // Earnings are read per worker over a date range; settled_by_worker_id is
  // who collected the money and therefore who earned the cut.
  await knex.raw(`
    CREATE INDEX washes_worker_earnings_idx
        ON washes (settled_by_worker_id, settled_at DESC)
     WHERE status = 'settled'
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS washes_worker_earnings_idx`);
  await knex.raw(`ALTER TABLE washes DROP CONSTRAINT IF EXISTS washes_commission_nonneg_ck`);
  await knex.raw(`ALTER TABLE washes DROP COLUMN IF EXISTS worker_commission_ugx`);
  await knex.raw(`ALTER TABLE branches DROP CONSTRAINT IF EXISTS branches_commission_range_ck`);
  await knex.raw(`ALTER TABLE branches DROP COLUMN IF EXISTS worker_commission_bp`);
}
