import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // 1. Vehicle classes
  await knex.raw(`
    CREATE TABLE vehicle_classes (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id     UUID NOT NULL REFERENCES organizations(id),
      name       TEXT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      active     BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(`CREATE UNIQUE INDEX ON vehicle_classes (org_id, lower(name))`);

  // 2. Services
  await knex.raw(`
    CREATE TABLE services (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id      UUID NOT NULL REFERENCES organizations(id),
      name        TEXT NOT NULL,
      description TEXT,
      is_default  BOOLEAN NOT NULL DEFAULT false,
      earns_point BOOLEAN NOT NULL DEFAULT true,
      active      BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(`CREATE UNIQUE INDEX ON services (org_id, lower(name))`);
  await knex.raw(`CREATE UNIQUE INDEX one_default_service_per_org ON services (org_id) WHERE is_default`);

  // 3. Prices
  await knex.raw(`
    CREATE TABLE prices (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id           UUID NOT NULL REFERENCES organizations(id),
      service_id       UUID NOT NULL REFERENCES services(id),
      vehicle_class_id UUID NOT NULL REFERENCES vehicle_classes(id),
      branch_id        UUID REFERENCES branches(id),
      price_ugx        BIGINT NOT NULL CHECK (price_ugx >= 0),
      active           BOOLEAN NOT NULL DEFAULT true,
      updated_by       UUID REFERENCES staff_users(id),
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX ON prices (
      service_id, vehicle_class_id,
      COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
    )
  `);
  await knex.raw(`CREATE INDEX ON prices (org_id, branch_id) WHERE active`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS prices CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS services CASCADE`);
  await knex.raw(`DROP TABLE IF EXISTS vehicle_classes CASCADE`);
}
