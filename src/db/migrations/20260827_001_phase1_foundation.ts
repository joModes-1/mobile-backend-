import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // 1. Platform admins
  await knex.raw(`
    CREATE TABLE platform_admins (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      full_name            TEXT NOT NULL,
      email                TEXT NOT NULL,
      phone                TEXT,
      password_hash        TEXT NOT NULL,
      must_change_password BOOLEAN NOT NULL DEFAULT true,
      status               TEXT NOT NULL DEFAULT 'active',
      last_login_at        TIMESTAMPTZ,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(`CREATE UNIQUE INDEX ON platform_admins (lower(email))`);

  // 2. Organizations
  await knex.raw(`
    CREATE TABLE organizations (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name           TEXT NOT NULL,
      slug           TEXT NOT NULL,
      phone          TEXT,
      contact_name   TEXT,
      plan           TEXT NOT NULL DEFAULT 'trial',
      status         TEXT NOT NULL DEFAULT 'active',
      suspended_at   TIMESTAMPTZ,
      suspend_reason TEXT,
      created_by     UUID REFERENCES platform_admins(id),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(`CREATE UNIQUE INDEX ON organizations (lower(slug))`);

  // 3. Branches
  await knex.raw(`
    CREATE TABLE branches (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id     UUID NOT NULL REFERENCES organizations(id),
      name       TEXT NOT NULL,
      code       TEXT NOT NULL,
      address    TEXT,
      phone      TEXT,
      latitude   NUMERIC(9,6),
      longitude  NUMERIC(9,6),
      ready_alert_minutes INT NOT NULL DEFAULT 120,
      status     TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(`CREATE INDEX ON branches (org_id)`);
  await knex.raw(`CREATE UNIQUE INDEX ON branches (org_id, upper(code))`);

  // 4. Staff users
  await knex.raw(`
    CREATE TABLE staff_users (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id               UUID NOT NULL REFERENCES organizations(id),
      branch_id            UUID REFERENCES branches(id),
      role                 TEXT NOT NULL,
      full_name            TEXT NOT NULL,
      username             TEXT NOT NULL,
      phone                TEXT,
      email                TEXT,
      password_hash        TEXT NOT NULL,
      pin_hash             TEXT,
      must_change_password BOOLEAN NOT NULL DEFAULT true,
      status               TEXT NOT NULL DEFAULT 'active',
      created_by           UUID REFERENCES staff_users(id),
      last_login_at        TIMESTAMPTZ,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT staff_role_branch_ck CHECK (
        (role = 'orgadmin' AND branch_id IS NULL) OR (role <> 'orgadmin' AND branch_id IS NOT NULL)
      )
    )
  `);
  await knex.raw(`CREATE UNIQUE INDEX ON staff_users (org_id, lower(username))`);
  await knex.raw(`CREATE INDEX ON staff_users (branch_id, role)`);

  // 5. Clients
  await knex.raw(`
    CREATE TABLE clients (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id         UUID NOT NULL REFERENCES organizations(id),
      full_name      TEXT NOT NULL,
      phone          TEXT NOT NULL,
      member_code    TEXT NOT NULL,
      password_hash  TEXT,
      phone_verified BOOLEAN NOT NULL DEFAULT false,
      status         TEXT NOT NULL DEFAULT 'active',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(`CREATE UNIQUE INDEX ON clients (org_id, phone)`);
  await knex.raw(`CREATE UNIQUE INDEX ON clients (member_code)`);

  // 6. Refresh tokens
  await knex.raw(`
    CREATE TABLE refresh_tokens (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_type TEXT NOT NULL,
      owner_id   UUID NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(`CREATE INDEX ON refresh_tokens (owner_type, owner_id)`);

  // 7. OTP codes
  await knex.raw(`
    CREATE TABLE otp_codes (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      phone       TEXT NOT NULL,
      code_hash   TEXT NOT NULL,
      purpose     TEXT NOT NULL,
      attempts    INT NOT NULL DEFAULT 0,
      expires_at  TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(`CREATE INDEX ON otp_codes (phone, purpose, created_at DESC)`);

  // 8. Devices
  await knex.raw(`
    CREATE TABLE devices (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      owner_type   TEXT NOT NULL,
      owner_id     UUID NOT NULL,
      push_token   TEXT NOT NULL,
      platform     TEXT NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(`CREATE UNIQUE INDEX ON devices (push_token)`);

  // 9. Audit logs
  await knex.raw(`
    CREATE TABLE audit_logs (
      id         BIGSERIAL PRIMARY KEY,
      org_id     UUID,
      actor_type TEXT,
      actor_id   UUID,
      action     TEXT NOT NULL,
      entity     TEXT,
      entity_id  UUID,
      "before"   JSONB,
      "after"    JSONB,
      ip         TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(`CREATE INDEX ON audit_logs (org_id, created_at DESC)`);
  await knex.raw(`CREATE INDEX ON audit_logs (entity, entity_id)`);
  await knex.raw(`CREATE INDEX ON audit_logs (org_id, action, created_at DESC)`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS audit_logs CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS devices CASCADE`);
  await knex.raw(`    DROP TABLE IF EXISTS otp_codes CASCADE`);
  await knex.raw(`    DROP TABLE IF EXISTS refresh_tokens CASCADE`);
  await knex.raw(`    DROP TABLE IF EXISTS clients CASCADE`);
  await knex.raw(`    DROP TABLE IF EXISTS staff_users CASCADE`);
  await knex.raw(`    DROP TABLE IF EXISTS branches CASCADE`);
  await knex.raw(`    DROP TABLE IF EXISTS organizations CASCADE`);
  await knex.raw(`    DROP TABLE IF EXISTS platform_admins CASCADE`);
}
