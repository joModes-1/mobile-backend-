import type { Knex } from 'knex';

/**
 * Branch-scoped catalogue.
 *
 * Car types and wash types were org-wide only, so adding one was necessarily
 * an org admin job — a manager who needed a new wash type had to go and ask.
 * This lets a manager create types for their own branch without touching what
 * the other branches see.
 *
 * The model is "org-wide OR one branch", expressed as a nullable branch_id:
 *
 *   branch_id IS NULL  -> shared, every branch sees it (all existing rows)
 *   branch_id = <uuid> -> private to that branch
 *
 * Nullable rather than a separate table because a wash already points at a
 * single vehicle_class_id / service_id row; keeping one table means none of
 * the existing joins that resolve a wash's type name have to change at all.
 *
 * Every "list the catalogue for branch X" query therefore needs
 * `(branch_id IS NULL OR branch_id = X)`, and every write from a manager
 * stamps their own branch_id.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE vehicle_classes ADD COLUMN branch_id UUID REFERENCES branches(id)`);
  await knex.raw(`ALTER TABLE services ADD COLUMN branch_id UUID REFERENCES branches(id)`);

  // Uniqueness has to become per-scope, otherwise two branches can never both
  // have a "Saloon". Postgres treats NULLs as distinct in a unique index, so
  // a single index on (org_id, branch_id, lower(name)) would stop constraining
  // the org-wide rows — the two partial indexes below keep both scopes strict.
  await knex.raw(`DROP INDEX IF EXISTS vehicle_classes_org_id_lower_idx`);
  await knex.raw(`DROP INDEX IF EXISTS services_org_id_lower_idx`);

  // The original indexes were created unnamed, so their generated names are
  // not guaranteed. Find and drop whatever unique index currently covers
  // (org_id, lower(name)) on each table before creating the replacements.
  await knex.raw(`
    DO $$
    DECLARE idx RECORD;
    BEGIN
      FOR idx IN
        SELECT c.relname AS name
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_class t ON t.oid = i.indrelid
        WHERE t.relname IN ('vehicle_classes', 'services')
          AND i.indisunique
          AND NOT i.indisprimary
          AND pg_get_indexdef(i.indexrelid) LIKE '%lower(name)%'
          AND pg_get_indexdef(i.indexrelid) NOT LIKE '%branch_id%'
      LOOP
        EXECUTE format('DROP INDEX IF EXISTS %I', idx.name);
      END LOOP;
    END $$;
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX vehicle_classes_org_shared_name_idx
      ON vehicle_classes (org_id, lower(name)) WHERE branch_id IS NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX vehicle_classes_branch_name_idx
      ON vehicle_classes (org_id, branch_id, lower(name)) WHERE branch_id IS NOT NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX services_org_shared_name_idx
      ON services (org_id, lower(name)) WHERE branch_id IS NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX services_branch_name_idx
      ON services (org_id, branch_id, lower(name)) WHERE branch_id IS NOT NULL
  `);

  // A branch that defines its own services needs its own default, otherwise
  // starting a wash there with no explicit service falls back to an org
  // default that may not even be offered at that branch.
  await knex.raw(`DROP INDEX IF EXISTS one_default_service_per_org`);
  await knex.raw(`
    CREATE UNIQUE INDEX one_default_service_per_org
      ON services (org_id) WHERE is_default AND branch_id IS NULL
  `);
  await knex.raw(`
    CREATE UNIQUE INDEX one_default_service_per_branch
      ON services (org_id, branch_id) WHERE is_default AND branch_id IS NOT NULL
  `);

  // Listing the catalogue for a branch is the hot path on the wash screen.
  await knex.raw(`CREATE INDEX vehicle_classes_scope_idx ON vehicle_classes (org_id, branch_id) WHERE active`);
  await knex.raw(`CREATE INDEX services_scope_idx ON services (org_id, branch_id) WHERE active`);
}

export async function down(knex: Knex): Promise<void> {
  // Branch-specific rows cannot survive losing the column — they would become
  // org-wide types every branch suddenly sees. Remove them, and the prices
  // and washes that reference them, so the rollback leaves a consistent org
  // catalogue rather than silently widening a branch's private types.
  await knex.raw(`
    DELETE FROM prices
    WHERE vehicle_class_id IN (SELECT id FROM vehicle_classes WHERE branch_id IS NOT NULL)
       OR service_id IN (SELECT id FROM services WHERE branch_id IS NOT NULL)
  `);
  await knex.raw(`
    DELETE FROM washes
    WHERE vehicle_class_id IN (SELECT id FROM vehicle_classes WHERE branch_id IS NOT NULL)
       OR service_id IN (SELECT id FROM services WHERE branch_id IS NOT NULL)
  `);
  await knex.raw(`DELETE FROM vehicle_classes WHERE branch_id IS NOT NULL`);
  await knex.raw(`DELETE FROM services WHERE branch_id IS NOT NULL`);

  await knex.raw(`DROP INDEX IF EXISTS vehicle_classes_scope_idx`);
  await knex.raw(`DROP INDEX IF EXISTS services_scope_idx`);
  await knex.raw(`DROP INDEX IF EXISTS one_default_service_per_branch`);
  await knex.raw(`DROP INDEX IF EXISTS one_default_service_per_org`);
  await knex.raw(`DROP INDEX IF EXISTS vehicle_classes_org_shared_name_idx`);
  await knex.raw(`DROP INDEX IF EXISTS vehicle_classes_branch_name_idx`);
  await knex.raw(`DROP INDEX IF EXISTS services_org_shared_name_idx`);
  await knex.raw(`DROP INDEX IF EXISTS services_branch_name_idx`);

  await knex.raw(`ALTER TABLE vehicle_classes DROP COLUMN branch_id`);
  await knex.raw(`ALTER TABLE services DROP COLUMN branch_id`);

  await knex.raw(`CREATE UNIQUE INDEX ON vehicle_classes (org_id, lower(name))`);
  await knex.raw(`CREATE UNIQUE INDEX ON services (org_id, lower(name))`);
  await knex.raw(`CREATE UNIQUE INDEX one_default_service_per_org ON services (org_id) WHERE is_default`);
}
