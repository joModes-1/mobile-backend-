import { Knex } from 'knex';

/**
 * How a wash was paid for.
 *
 * Until now a settled wash recorded an amount and nothing about how the
 * money arrived, so everything was implicitly cash. That was fine while
 * cash was the only option; it stops being fine the moment a worker can
 * take mobile money, because "UGX 300,000 taken today" then says nothing
 * about how much of it is actually in the drawer.
 *
 * That distinction matters for cash reconciliation specifically: a shift's
 * expected cash should only count money the worker is physically holding.
 * Mobile money went straight to the business.
 *
 * `payer_phone` is the number the payment was requested from, kept for
 * matching against a statement when a customer disputes a charge.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE washes
      ADD COLUMN payment_method TEXT,
      ADD COLUMN payer_phone    TEXT,
      ADD COLUMN payment_ref    TEXT
  `);

  await knex.raw(`
    ALTER TABLE washes
      ADD CONSTRAINT washes_payment_method_ck
      CHECK (payment_method IS NULL OR payment_method IN ('cash', 'mtn', 'airtel', 'free'))
  `);

  // Every wash settled before this migration was cash — that was the only
  // way to pay. Backfilling says so explicitly rather than leaving a null
  // that later reads as "unknown".
  await knex.raw(`
    UPDATE washes
       SET payment_method = CASE WHEN is_redemption THEN 'free' ELSE 'cash' END
     WHERE status = 'settled' AND payment_method IS NULL
  `);

  await knex.raw(`CREATE INDEX ON washes (org_id, payment_method)`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE washes DROP CONSTRAINT IF EXISTS washes_payment_method_ck`);
  await knex.raw(`
    ALTER TABLE washes
      DROP COLUMN IF EXISTS payment_method,
      DROP COLUMN IF EXISTS payer_phone,
      DROP COLUMN IF EXISTS payment_ref
  `);
}
