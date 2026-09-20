import { Knex } from 'knex';

/**
 * Worker points — an incentive scheme for staff, separate from customer
 * loyalty.
 *
 * A customer earns stamps toward a free wash. A worker earns points for
 * work done: every wash they settle pays out, weighted by what the job was
 * worth, and those points are redeemed against whatever the organisation
 * decides to offer its staff.
 *
 * The two never mix. They answer different questions, they are redeemed for
 * different things, and an org will want to tune them independently — so
 * they get their own tables rather than overloading loyalty_accounts with a
 * nullable staff_id.
 *
 * Shape deliberately mirrors loyalty_accounts + loyalty_ledger: a cached
 * balance next to an append-only ledger. The ledger is the truth; the
 * balance is what you read. Anything that moves points writes both in one
 * transaction, so `SUM(points_delta)` must always equal `points_balance`.
 * That invariant is what makes the scheme auditable when a worker disputes
 * their total.
 */
export async function up(knex: Knex): Promise<void> {
  // ── Per-org rules ─────────────────────────────────────────────────
  // Points are configurable because what motivates staff at one site is
  // not what motivates them at another, and the rate has to be tunable
  // without a deploy.
  await knex.raw(`
    CREATE TABLE worker_points_configs (
      org_id              UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      -- Points for settling a wash at all, regardless of its value. Keeps a
      -- cheap job worth doing properly.
      points_per_wash     INT NOT NULL DEFAULT 10,
      -- Extra points per this many UGX of wash value, so a bigger job pays
      -- more. Set points_per_amount to 0 to make the scheme flat-rate.
      points_per_amount   INT NOT NULL DEFAULT 1,
      amount_step_ugx     INT NOT NULL DEFAULT 5000,
      -- What a point is worth when redeemed, for the org's own accounting.
      point_value_ugx     INT NOT NULL DEFAULT 100,
      -- Floor for a wash to earn anything, mirroring loyalty's min_amount:
      -- a free or near-free job should not pay out.
      min_amount_ugx      INT NOT NULL DEFAULT 0,
      -- Workers cannot redeem below this, so redemptions are meaningful
      -- rather than a trickle of tiny claims.
      min_redeem_points   INT NOT NULL DEFAULT 500,
      active              BOOLEAN NOT NULL DEFAULT true,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT worker_points_positive_ck CHECK (
        points_per_wash >= 0 AND points_per_amount >= 0
        AND amount_step_ugx > 0 AND point_value_ugx >= 0
        AND min_amount_ugx >= 0 AND min_redeem_points >= 0
      )
    )
  `);

  // ── Cached balance, one row per worker ────────────────────────────
  await knex.raw(`
    CREATE TABLE worker_points_accounts (
      staff_id         UUID PRIMARY KEY REFERENCES staff_users(id) ON DELETE CASCADE,
      org_id           UUID NOT NULL REFERENCES organizations(id),
      points_balance   INT NOT NULL DEFAULT 0,
      lifetime_earned  INT NOT NULL DEFAULT 0,
      lifetime_redeemed INT NOT NULL DEFAULT 0,
      washes_credited  INT NOT NULL DEFAULT 0,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT worker_points_non_negative_ck CHECK (
        points_balance >= 0 AND lifetime_earned >= 0 AND lifetime_redeemed >= 0
      )
    )
  `);
  await knex.raw(`CREATE INDEX ON worker_points_accounts (org_id, points_balance DESC)`);

  // ── Append-only history ───────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE worker_points_ledger (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      staff_id       UUID NOT NULL REFERENCES staff_users(id),
      org_id         UUID NOT NULL REFERENCES organizations(id),
      wash_id        UUID REFERENCES washes(id),
      entry_type     TEXT NOT NULL,
      points_delta   INT NOT NULL,
      balance_after  INT NOT NULL,
      reason         TEXT,
      created_by     UUID REFERENCES staff_users(id),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT worker_points_entry_type_ck CHECK (
        entry_type IN ('earn', 'redeem', 'reversal', 'manual_adjust', 'bonus')
      )
    )
  `);
  await knex.raw(`CREATE INDEX ON worker_points_ledger (staff_id, created_at DESC)`);
  await knex.raw(`CREATE INDEX ON worker_points_ledger (org_id, created_at DESC)`);

  // One earn per wash, and one reversal per wash. Settling the same job
  // twice must not pay twice — the same guard loyalty_ledger uses.
  await knex.raw(`
    CREATE UNIQUE INDEX worker_points_one_entry_per_wash
      ON worker_points_ledger (wash_id, entry_type)
      WHERE wash_id IS NOT NULL
  `);

  // ── Car details the Figma booking flow captures ───────────────────
  // `plate` already exists. Colour is how a worker tells two identical
  // silver saloons apart in the yard, so it belongs next to it.
  await knex.raw(`ALTER TABLE washes ADD COLUMN vehicle_color TEXT`);

  // ── Default config for existing orgs ──────────────────────────────
  // Without a row the scheme is simply off for that org, which would make
  // the feature silently do nothing on an existing database.
  await knex.raw(`
    INSERT INTO worker_points_configs (org_id)
    SELECT id FROM organizations
    ON CONFLICT (org_id) DO NOTHING
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE washes DROP COLUMN IF EXISTS vehicle_color`);
  await knex.raw(`DROP TABLE IF EXISTS worker_points_ledger`);
  await knex.raw(`DROP TABLE IF EXISTS worker_points_accounts`);
  await knex.raw(`DROP TABLE IF EXISTS worker_points_configs`);
}
