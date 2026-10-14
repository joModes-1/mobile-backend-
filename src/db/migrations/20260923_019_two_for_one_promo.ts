import type { Knex } from 'knex';

/**
 * "Wash 2 cars for the price of 1" — the home screen's promo card, for real.
 *
 * The mechanic the user picked (out of the options that were costed): the
 * client grabs the offer, books and PAYS for one wash at full price, and
 * their NEXT wash is free. The "second car" is the client's next visit, not
 * a second vehicle on one booking.
 *
 * Shape deliberately mirrors the free-wash credit mechanism it sits beside:
 *
 *  - `promo_key` on washes marks which washes belong to the offer. Wash #1
 *    (the paid one) gets it at booking; the free wash gets it too, so the
 *    app can tell a promo-free wash apart from a credit-free wash in copy
 *    ("your promo reward", not "your free credit").
 *  - `promo_redemptions` is the one-time ledger: one row per client, the
 *    UNIQUE constraint on client_id is what actually enforces "once per
 *    client" — a second grab can never insert. `status='armed'` means paid
 *    and waiting for the free wash; `status='used'` means the free wash
 *    settled and the offer is spent.
 *
 * The free wash itself reuses the existing `washes.is_redemption` flag —
 * settlement already treats that as "costs nothing, payment_method='free'".
 * What it must NOT do is go through processSettlement's redemption branch,
 * which decrements free_wash_credits: a promo reward is not a credit (see
 * redeemPromo() in the loyalty module for the branch that handles it).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE washes
      ADD COLUMN promo_key TEXT
  `);

  await knex.raw(`
    CREATE TABLE promo_redemptions (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id       UUID NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
      org_id          UUID NOT NULL REFERENCES organizations(id),
      promo_key       TEXT NOT NULL DEFAULT 'wash2_price1',
      started_wash_id UUID REFERENCES washes(id),
      free_wash_id    UUID REFERENCES washes(id),
      status          TEXT NOT NULL DEFAULT 'armed' CHECK (status IN ('armed', 'used')),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      used_at         TIMESTAMPTZ
    )
  `);

  // The settle path joins promo_redemptions by the wash being settled; the
  // home screen reads by client. One index each.
  await knex.raw(`CREATE INDEX promo_redemptions_started_wash_idx ON promo_redemptions (started_wash_id)`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS promo_redemptions`);
  await knex.raw(`ALTER TABLE washes DROP COLUMN IF EXISTS promo_key`);
}
