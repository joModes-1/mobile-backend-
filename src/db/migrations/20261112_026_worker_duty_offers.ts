import type { Knex } from 'knex';

/**
 * The worker home's "You're on duty" switch, and the record of job offers.
 *
 *  - `staff_users.on_duty`: a worker who switches off is no longer counted as
 *    on site, so they are not offered new cars, do not hold up other workers
 *    under the fewest-jobs rule, and are skipped by the auto-assign timer.
 *    Cars they are already washing stay theirs. Defaults to on, so nothing
 *    changes for anyone until they flip it.
 *
 *  - `dispatch_offers`: one row per (job, worker) the first time that worker's
 *    app was offered the job, and when they took it. It is what lets the
 *    worker's home say "Offers taken today 5 of 6" and "Average time to take
 *    11 seconds". Offers are only recorded for workers who could take the job
 *    at that moment (on duty).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE staff_users ADD COLUMN on_duty BOOLEAN NOT NULL DEFAULT true`);

  await knex.raw(`
    CREATE TABLE dispatch_offers (
      wash_id       UUID NOT NULL REFERENCES washes(id) ON DELETE CASCADE,
      staff_id      UUID NOT NULL REFERENCES staff_users(id),
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      taken_at      TIMESTAMPTZ,
      PRIMARY KEY (wash_id, staff_id)
    )
  `);
  await knex.raw(`CREATE INDEX ON dispatch_offers (staff_id, first_seen_at)`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS dispatch_offers`);
  await knex.raw(`ALTER TABLE staff_users DROP COLUMN IF EXISTS on_duty`);
}
