import type { Knex } from 'knex';

/**
 * Online payments (PesaPal collection).
 *
 * One row per attempt to pay a wash through PesaPal. A wash can have several
 * (a failed try, then another); at most one may succeed. The row is the
 * audit trail — what was asked, what PesaPal said — while the washes columns
 * below are the cheap flag every screen reads: "this car is already paid".
 *
 * The wash is still settled by the worker, exactly as before; this only
 * proves the money arrived so the worker is not asked to collect it again.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE payments (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id             UUID NOT NULL REFERENCES organizations(id),
      wash_id            UUID NOT NULL REFERENCES washes(id),
      client_id          UUID REFERENCES clients(id),
      provider           TEXT NOT NULL DEFAULT 'pesapal',
      environment        TEXT NOT NULL CHECK (environment IN ('sandbox', 'live')),
      merchant_reference TEXT NOT NULL UNIQUE,
      order_tracking_id  TEXT,
      amount_ugx         INT  NOT NULL CHECK (amount_ugx > 0),
      payer_phone        TEXT,
      status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
      provider_method    TEXT,
      confirmation_code  TEXT,
      provider_status    TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at            TIMESTAMPTZ
    )
  `);
  await knex.raw(`CREATE INDEX ON payments (wash_id)`);
  await knex.raw(`CREATE UNIQUE INDEX payments_order_tracking_uq ON payments (order_tracking_id) WHERE order_tracking_id IS NOT NULL`);
  // Only one money-in per wash, whatever the number of attempts.
  await knex.raw(`CREATE UNIQUE INDEX payments_one_success_per_wash ON payments (wash_id) WHERE status = 'succeeded'`);

  await knex.raw(`
    ALTER TABLE washes
      ADD COLUMN paid_online_at       TIMESTAMPTZ,
      ADD COLUMN online_payment_ref   TEXT,
      ADD COLUMN online_payment_method TEXT CHECK (online_payment_method IS NULL OR online_payment_method IN ('mtn', 'airtel'))
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE washes DROP COLUMN IF EXISTS paid_online_at, DROP COLUMN IF EXISTS online_payment_ref, DROP COLUMN IF EXISTS online_payment_method`);
  await knex.raw(`DROP TABLE IF EXISTS payments`);
}
