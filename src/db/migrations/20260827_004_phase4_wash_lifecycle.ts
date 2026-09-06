import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // ── 1. washes ────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE washes (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id               UUID NOT NULL REFERENCES organizations(id),
      branch_id            UUID NOT NULL REFERENCES branches(id),

      started_by_worker_id UUID NOT NULL REFERENCES staff_users(id),
      started_shift_id     UUID NOT NULL REFERENCES shifts(id),
      settled_by_worker_id UUID REFERENCES staff_users(id),
      settled_shift_id     UUID REFERENCES shifts(id),

      client_id            UUID REFERENCES clients(id),
      client_attached_at   TIMESTAMPTZ,
      client_attach_method TEXT,
      vehicle_id           UUID,
      plate                TEXT,

      service_id           UUID NOT NULL REFERENCES services(id),
      vehicle_class_id     UUID NOT NULL REFERENCES vehicle_classes(id),

      price_id             UUID REFERENCES prices(id),
      quoted_amount_ugx    BIGINT NOT NULL,
      amount_ugx           BIGINT,
      is_redemption        BOOLEAN NOT NULL DEFAULT false,
      earns_point          BOOLEAN NOT NULL DEFAULT true,

      job_no               TEXT NOT NULL,
      status               TEXT NOT NULL DEFAULT 'in_progress',

      started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      wash_done_at         TIMESTAMPTZ,
      settled_at           TIMESTAMPTZ,
      receipt_no           TEXT,
      start_verified       BOOLEAN NOT NULL DEFAULT false,
      settle_verified      BOOLEAN NOT NULL DEFAULT false,
      unverified_reason    TEXT,
      handover_reason      TEXT,
      handover_note        TEXT,

      cancelled_at         TIMESTAMPTZ,
      cancelled_by         UUID REFERENCES staff_users(id),
      cancel_reason        TEXT,
      cancel_note          TEXT,

      idempotency_key      TEXT,
      notes                TEXT,
      started_date         DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

      CONSTRAINT settled_has_amount_ck CHECK (
        status <> 'settled' OR (amount_ugx IS NOT NULL AND settled_shift_id IS NOT NULL)
      )
    )
  `);

  await knex.raw(`CREATE UNIQUE INDEX ON washes (started_by_worker_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);
  await knex.raw(`CREATE UNIQUE INDEX ON washes (org_id, receipt_no) WHERE receipt_no IS NOT NULL`);
  await knex.raw(`CREATE UNIQUE INDEX ON washes (branch_id, job_no, started_date)`);
  await knex.raw(`CREATE INDEX dup_check ON washes (branch_id, vehicle_class_id, service_id) WHERE status IN ('in_progress','ready')`);
  await knex.raw(`CREATE INDEX ON washes (branch_id, settled_at DESC) WHERE status = 'settled'`);
  await knex.raw(`CREATE INDEX ON washes (settled_shift_id) WHERE status = 'settled'`);
  await knex.raw(`CREATE INDEX ON washes (client_id, started_at DESC)`);
  await knex.raw(`CREATE INDEX open_queue ON washes (started_by_worker_id, status) WHERE status IN ('in_progress','ready')`);
  await knex.raw(`CREATE INDEX ON washes (branch_id, status, wash_done_at) WHERE status = 'ready'`);
  await knex.raw(`CREATE INDEX ON washes (status) WHERE status = 'disputed'`);

  // ── 2. client_tokens ────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE client_tokens (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      purpose     TEXT NOT NULL,
      wash_id     UUID REFERENCES washes(id),
      token_hash  TEXT NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      consumed_by UUID REFERENCES staff_users(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT pay_token_needs_wash_ck CHECK (purpose <> 'pay' OR wash_id IS NOT NULL)
    )
  `);
  await knex.raw(`CREATE UNIQUE INDEX ON client_tokens (token_hash)`);
  await knex.raw(`CREATE INDEX ON client_tokens (client_id, purpose, created_at DESC)`);
  await knex.raw(`CREATE INDEX ON client_tokens (expires_at) WHERE consumed_at IS NULL`);

  // ── 3. branch_counters ──────────────────────────────────────
  await knex.raw(`
    CREATE TABLE branch_counters (
      branch_id        UUID NOT NULL REFERENCES branches(id),
      day              DATE NOT NULL,
      last_job_seq     INT  NOT NULL DEFAULT 0,
      last_receipt_seq INT  NOT NULL DEFAULT 0,
      PRIMARY KEY (branch_id, day)
    )
  `);

  // ── 4. loyalty_configs ──────────────────────────────────────
  await knex.raw(`
    CREATE TABLE loyalty_configs (
      id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id             UUID NOT NULL UNIQUE REFERENCES organizations(id),
      washes_required    INT NOT NULL DEFAULT 7,
      min_amount_ugx     BIGINT NOT NULL DEFAULT 0,
      credit_expiry_days INT,
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  // ── 5. loyalty_accounts ─────────────────────────────────────
  await knex.raw(`
    CREATE TABLE loyalty_accounts (
      client_id         UUID PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
      org_id            UUID NOT NULL REFERENCES organizations(id),
      wash_count        INT NOT NULL DEFAULT 0,
      free_wash_credits INT NOT NULL DEFAULT 0,
      lifetime_washes   INT NOT NULL DEFAULT 0,
      lifetime_redeemed INT NOT NULL DEFAULT 0,
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT non_negative_ck CHECK (wash_count >= 0 AND free_wash_credits >= 0)
    )
  `);

  // ── 6. loyalty_ledger ───────────────────────────────────────
  await knex.raw(`
    CREATE TABLE loyalty_ledger (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_id        UUID NOT NULL REFERENCES clients(id),
      wash_id          UUID REFERENCES washes(id),
      entry_type       TEXT NOT NULL,
      wash_delta       INT NOT NULL DEFAULT 0,
      credit_delta     INT NOT NULL DEFAULT 0,
      wash_count_after INT NOT NULL,
      credits_after    INT NOT NULL,
      reason           TEXT,
      created_by       UUID REFERENCES staff_users(id),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(`CREATE INDEX ON loyalty_ledger (client_id, created_at DESC)`);
  await knex.raw(`CREATE UNIQUE INDEX ON loyalty_ledger (wash_id, entry_type) WHERE wash_id IS NOT NULL`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS loyalty_ledger CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS loyalty_accounts CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS loyalty_configs CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS branch_counters CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS client_tokens CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS washes CASCADE`);
}
