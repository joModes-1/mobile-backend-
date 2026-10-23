import type { Knex } from 'knex';

/**
 * Client points — replaces the "7 washes = 1 free wash" stamp card.
 *
 * The owner decides everything from Settings:
 *  - per wash type, whether it earns points (`services.earns_point`, which
 *    already existed as the on/off switch) and how many
 *    (`services.client_points_awarded`, new);
 *  - per organisation, what one point is worth in shillings
 *    (`client_points_configs.point_value_ugx`).
 *
 * A client spends points at booking ("Use my points"). They are deducted in
 * the booking transaction itself, so the same points can never pay for two
 * washes, and handed back if the wash is cancelled.
 *
 * Shape mirrors worker points and the old loyalty tables: a cached balance
 * beside an append-only ledger. The ledger is the truth — SUM(points_delta)
 * per account must always equal `balance`.
 *
 * Accounts are keyed by (client, org), not client alone. A client can walk
 * into any organisation's branch, and points one car wash gave away must not
 * be spendable at another company's — that would be one tenant paying for
 * another's loyalty scheme.
 *
 * The stamp-card tables stay. Credits a client already holds can still be
 * spent; nothing new is stamped (see settleWash).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE client_points_configs (
      org_id          UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      enabled         BOOLEAN NOT NULL DEFAULT true,
      -- What one point is worth when spent. 0 means points can be earned
      -- but not spent yet, which is how an owner can start the scheme
      -- before deciding the value.
      point_value_ugx INT NOT NULL DEFAULT 100 CHECK (point_value_ugx >= 0),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(`
    INSERT INTO client_points_configs (org_id)
    SELECT id FROM organizations
    ON CONFLICT (org_id) DO NOTHING
  `);

  await knex.raw(`
    ALTER TABLE services
      ADD COLUMN client_points_awarded INT NOT NULL DEFAULT 0
        CHECK (client_points_awarded >= 0)
  `);
  // Wash types that were already earning a stamp keep earning something, so
  // switching models doesn't silently stop rewarding anyone. The owner tunes
  // the number in Settings.
  await knex.raw(`UPDATE services SET client_points_awarded = 10 WHERE earns_point`);

  await knex.raw(`
    CREATE TABLE client_points_accounts (
      client_id         UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      org_id            UUID NOT NULL REFERENCES organizations(id),
      balance           INT NOT NULL DEFAULT 0,
      lifetime_earned   INT NOT NULL DEFAULT 0,
      lifetime_redeemed INT NOT NULL DEFAULT 0,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (client_id, org_id),
      CONSTRAINT client_points_non_negative_ck CHECK (
        balance >= 0 AND lifetime_earned >= 0 AND lifetime_redeemed >= 0
      )
    )
  `);

  await knex.raw(`
    CREATE TABLE client_points_ledger (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      -- Write order; created_at is shared by rows written in one
      -- transaction (a reversal's refund and take-back, for instance).
      seq           BIGSERIAL NOT NULL,
      client_id     UUID NOT NULL REFERENCES clients(id),
      org_id        UUID NOT NULL REFERENCES organizations(id),
      wash_id       UUID REFERENCES washes(id),
      entry_type    TEXT NOT NULL CHECK (entry_type IN ('earn', 'redeem', 'refund', 'reversal', 'adjust')),
      points_delta  INT NOT NULL,
      balance_after INT NOT NULL,
      reason        TEXT,
      created_by    UUID,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(`CREATE INDEX ON client_points_ledger (client_id, org_id, seq DESC)`);
  // One of each per wash: a retried settle can't earn twice, a retried
  // cancel can't refund twice.
  await knex.raw(`
    CREATE UNIQUE INDEX client_points_one_entry_per_wash
      ON client_points_ledger (wash_id, entry_type)
      WHERE wash_id IS NOT NULL
  `);

  // Frozen onto the wash at booking, like the price. A settings change
  // affects new bookings only — a client is never surprised at settlement.
  await knex.raw(`
    ALTER TABLE washes
      ADD COLUMN client_points_to_award INT NOT NULL DEFAULT 0 CHECK (client_points_to_award >= 0),
      ADD COLUMN points_used            INT NOT NULL DEFAULT 0 CHECK (points_used >= 0),
      ADD COLUMN points_value_ugx       BIGINT NOT NULL DEFAULT 0 CHECK (points_value_ugx >= 0),
      ADD COLUMN point_value_ugx        INT
  `);

  // A wash paid entirely with points is its own payment method: no money
  // moved, but unlike 'free' (a credit or promo) the client did spend
  // something of value.
  await knex.raw(`ALTER TABLE washes DROP CONSTRAINT IF EXISTS washes_payment_method_ck`);
  await knex.raw(`
    ALTER TABLE washes
      ADD CONSTRAINT washes_payment_method_ck
      CHECK (payment_method IS NULL OR payment_method IN ('cash', 'mtn', 'airtel', 'free', 'points'))
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE washes DROP CONSTRAINT IF EXISTS washes_payment_method_ck`);
  await knex.raw(`UPDATE washes SET payment_method = 'free' WHERE payment_method = 'points'`);
  await knex.raw(`
    ALTER TABLE washes
      ADD CONSTRAINT washes_payment_method_ck
      CHECK (payment_method IS NULL OR payment_method IN ('cash', 'mtn', 'airtel', 'free'))
  `);
  await knex.raw(`
    ALTER TABLE washes
      DROP COLUMN IF EXISTS client_points_to_award,
      DROP COLUMN IF EXISTS points_used,
      DROP COLUMN IF EXISTS points_value_ugx,
      DROP COLUMN IF EXISTS point_value_ugx
  `);
  await knex.raw(`DROP TABLE IF EXISTS client_points_ledger`);
  await knex.raw(`DROP TABLE IF EXISTS client_points_accounts`);
  await knex.raw(`ALTER TABLE services DROP COLUMN IF EXISTS client_points_awarded`);
  await knex.raw(`DROP TABLE IF EXISTS client_points_configs`);
}
