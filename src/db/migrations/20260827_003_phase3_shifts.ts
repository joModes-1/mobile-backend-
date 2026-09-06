import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE shifts (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id            UUID NOT NULL REFERENCES organizations(id),
      branch_id         UUID NOT NULL REFERENCES branches(id),
      worker_id         UUID NOT NULL REFERENCES staff_users(id),
      status            TEXT NOT NULL DEFAULT 'open',
      opened_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      closed_at         TIMESTAMPTZ,
      expected_cash_ugx BIGINT,
      counted_cash_ugx  BIGINT,
      variance_ugx      BIGINT,
      closed_by         UUID REFERENCES staff_users(id),
      notes             TEXT
    )
  `);
  // Enforce one open shift per worker (worker or manager — anyone with a drawer)
  await knex.raw(`CREATE UNIQUE INDEX one_open_shift_per_worker ON shifts (worker_id) WHERE status <> 'closed'`);
  await knex.raw(`CREATE INDEX ON shifts (branch_id, opened_at DESC)`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS shifts CASCADE`);
}
