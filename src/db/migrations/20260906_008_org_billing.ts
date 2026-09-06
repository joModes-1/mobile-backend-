import type { Knex } from 'knex';

/**
 * SaaS billing for the platform side.
 *
 * The organization is the car wash owner; the platform admin runs the software
 * they pay for. Until now `organizations.plan` was a bare text column with no
 * price, no cycle and no payment history behind it, so a sysadmin could see
 * that an org existed but not whether it was paying.
 *
 * Two tables:
 *   subscription_plans — what a plan costs (a catalogue the sysadmin edits)
 *   org_payments       — money actually received, one row per payment
 *
 * plus the per-org subscription state on `organizations` itself, which is
 * one-to-one with the org and so does not earn its own table.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE subscription_plans (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code          TEXT NOT NULL,
      name          TEXT NOT NULL,
      price_ugx     BIGINT NOT NULL DEFAULT 0,
      billing_cycle TEXT NOT NULL DEFAULT 'monthly',
      max_branches  INT,
      description   TEXT,
      active        BOOLEAN NOT NULL DEFAULT true,
      sort_order    INT NOT NULL DEFAULT 0,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT subscription_plans_cycle_chk
        CHECK (billing_cycle IN ('monthly','quarterly','yearly'))
    )
  `);
  await knex.raw(`CREATE UNIQUE INDEX ON subscription_plans (lower(code))`);

  // Per-org subscription state. `plan` (the old free-text column) stays as the
  // display label; plan_id is the authoritative link once one is assigned.
  await knex.raw(`
    ALTER TABLE organizations
      ADD COLUMN plan_id          UUID REFERENCES subscription_plans(id),
      ADD COLUMN billing_status   TEXT NOT NULL DEFAULT 'trial',
      ADD COLUMN onboarded_at     TIMESTAMPTZ,
      ADD COLUMN trial_ends_at    TIMESTAMPTZ,
      ADD COLUMN next_due_at      TIMESTAMPTZ,
      ADD COLUMN billing_notes    TEXT
  `);
  await knex.raw(`
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_billing_status_chk
      CHECK (billing_status IN ('trial','active','past_due','cancelled'))
  `);

  await knex.raw(`
    CREATE TABLE org_payments (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id         UUID NOT NULL REFERENCES organizations(id),
      plan_id        UUID REFERENCES subscription_plans(id),
      amount_ugx     BIGINT NOT NULL,
      -- The service window this payment buys. Renewal maths reads period_end,
      -- not the payment date, so a late payment still extends from where the
      -- previous period ended rather than from when it happened.
      period_start   DATE NOT NULL,
      period_end     DATE NOT NULL,
      method         TEXT NOT NULL DEFAULT 'cash',
      reference      TEXT,
      note           TEXT,
      recorded_by    UUID REFERENCES platform_admins(id),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT org_payments_amount_chk CHECK (amount_ugx > 0),
      CONSTRAINT org_payments_period_chk CHECK (period_end >= period_start)
    )
  `);
  await knex.raw(`CREATE INDEX ON org_payments (org_id, period_end DESC)`);

  // Existing orgs are already live — treat their creation as their onboarding
  // date so the platform's "onboarded this month" figure is not empty.
  await knex.raw(`UPDATE organizations SET onboarded_at = created_at WHERE onboarded_at IS NULL`);

  // A starting catalogue. Prices are placeholders the sysadmin edits in-app.
  await knex.raw(`
    INSERT INTO subscription_plans (code, name, price_ugx, billing_cycle, max_branches, description, sort_order)
    VALUES
      ('trial',    'Free Trial', 0,       'monthly', 1,    'Evaluation period — one branch, no charge.', 0),
      ('starter',  'Starter',    150000,  'monthly', 2,    'Up to 2 branches.',                          1),
      ('growth',   'Growth',     350000,  'monthly', 5,    'Up to 5 branches, full reporting.',          2),
      ('unlimited','Unlimited',  750000,  'monthly', NULL, 'Unlimited branches.',                        3)
  `);

  // Point every existing org at the plan matching its legacy text value.
  await knex.raw(`
    UPDATE organizations o
    SET plan_id = p.id
    FROM subscription_plans p
    WHERE lower(o.plan) = p.code AND o.plan_id IS NULL
  `);
  await knex.raw(`
    UPDATE organizations o
    SET plan_id = (SELECT id FROM subscription_plans WHERE code = 'trial')
    WHERE o.plan_id IS NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS org_payments`);
  await knex.raw(`ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_billing_status_chk`);
  await knex.raw(`
    ALTER TABLE organizations
      DROP COLUMN IF EXISTS plan_id,
      DROP COLUMN IF EXISTS billing_status,
      DROP COLUMN IF EXISTS onboarded_at,
      DROP COLUMN IF EXISTS trial_ends_at,
      DROP COLUMN IF EXISTS next_due_at,
      DROP COLUMN IF EXISTS billing_notes
  `);
  await knex.raw(`DROP TABLE IF EXISTS subscription_plans`);
}
