import type { Knex } from 'knex';

/**
 * Exception reviews.
 *
 * Exceptions are not stored — they are read off the wash (cancelled,
 * disputed, reversed, paid without the app, handed over). This records that
 * an admin or manager has looked at one: "reviewed" (checked, fine) or
 * "dismissed" (not worth acting on). A reviewed exception leaves the to-review
 * list and stops raising an alert on Home.
 *
 * Keyed on the wash AND its exception type: if the same wash later turns
 * into a different exception (an unconfirmed payment that is then disputed),
 * the new one needs its own review.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE exception_reviews (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id         UUID NOT NULL REFERENCES organizations(id),
      wash_id        UUID NOT NULL REFERENCES washes(id),
      exception_type TEXT NOT NULL,
      outcome        TEXT NOT NULL CHECK (outcome IN ('reviewed', 'dismissed')),
      reviewed_by    UUID REFERENCES staff_users(id),
      reviewed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (wash_id, exception_type)
    )
  `);
  await knex.raw(`CREATE INDEX ON exception_reviews (org_id, reviewed_at)`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS exception_reviews`);
}
