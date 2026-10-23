import type { Knex } from 'knex';

/**
 * Worker wallet — the running account between a worker and the business.
 *
 * Positive balance: the business owes the worker (commission earned, ready
 * to withdraw). Negative balance: the worker owes the business (cash they
 * collected from clients and haven't handed in yet). Unlike every other
 * balance in the system it is ALLOWED to go negative — that is the whole
 * point of it.
 *
 * What moves it:
 *  - commission    +  the worker who did the wash earns bp × full price,
 *                     whatever the client paid with
 *  - cash_collected − the worker who took cash from a client now holds the
 *                     business's money
 *  - cash_handover  +  a manager confirms receiving cash from the worker
 *  - reversal       ±  a reversed wash undoes its commission and cash rows
 *  - correction     ±  a corrected price moves both by the difference
 *  - withdrawal / withdrawal_fee / withdrawal_reversal — Phase 6
 *  - adjust         ±  org admin, with a reason
 *
 * Same shape as the points schemes: append-only ledger is the truth, the
 * account row is a cache of it, SUM(amount) per worker = balance.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE wallet_accounts (
      staff_id           UUID PRIMARY KEY REFERENCES staff_users(id) ON DELETE CASCADE,
      org_id             UUID NOT NULL REFERENCES organizations(id),
      balance_ugx        BIGINT NOT NULL DEFAULT 0,
      lifetime_commission_ugx BIGINT NOT NULL DEFAULT 0,
      lifetime_withdrawn_ugx  BIGINT NOT NULL DEFAULT 0,
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(`CREATE INDEX ON wallet_accounts (org_id)`);

  await knex.raw(`
    CREATE TABLE wallet_ledger (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      -- Write order. created_at is the transaction time, identical for the
      -- commission and cash rows a single settlement writes, so it cannot
      -- say which came first; this can.
      seq               BIGSERIAL NOT NULL,
      staff_id          UUID NOT NULL REFERENCES staff_users(id),
      org_id            UUID NOT NULL REFERENCES organizations(id),
      wash_id           UUID REFERENCES washes(id),
      kind              TEXT NOT NULL CHECK (kind IN (
                          'commission', 'cash_collected', 'cash_handover', 'reversal', 'correction',
                          'withdrawal', 'withdrawal_fee', 'withdrawal_reversal', 'adjust')),
      amount_ugx        BIGINT NOT NULL,
      balance_after_ugx BIGINT NOT NULL,
      reason            TEXT,
      created_by        UUID REFERENCES staff_users(id),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(`CREATE INDEX ON wallet_ledger (staff_id, seq DESC)`);
  await knex.raw(`CREATE INDEX ON wallet_ledger (org_id, created_at DESC)`);
  // A settlement retried can't pay commission twice or record the cash
  // twice; a reversal can't run twice for the same worker. Corrections may
  // legitimately happen more than once, so they are not in this index.
  // The rate a wash was settled at, frozen beside the amount it produced.
  // A later price correction re-applies THIS rate to the new price, not
  // whatever the branch's rate has become since.
  await knex.raw(`ALTER TABLE washes ADD COLUMN worker_commission_bp INT`);

  await knex.raw(`
    CREATE UNIQUE INDEX wallet_one_entry_per_wash
      ON wallet_ledger (wash_id, kind, staff_id)
      WHERE wash_id IS NOT NULL AND kind IN ('commission', 'cash_collected', 'reversal')
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE washes DROP COLUMN IF EXISTS worker_commission_bp`);
  await knex.raw(`DROP TABLE IF EXISTS wallet_ledger`);
  await knex.raw(`DROP TABLE IF EXISTS wallet_accounts`);
}
