import type { Knex } from 'knex';

/**
 * Job dispatch — how a booked wash finds its worker.
 *
 * The rule the owner set: a worker may take a job only while nobody on site
 * has fewer jobs than them. Everyone gets one, then a second opens up once
 * all have one, then a third. A new job is offered to everyone for a short
 * window ("first to click gets it"); if nobody takes it, it is given to the
 * eligible worker with the most experience (lifetime worker points).
 *
 *  - `staff_users.last_seen_at` is what "on site" means. Shifts open
 *    automatically when the app opens and never close by themselves, so an
 *    open shift alone would count a worker who went home hours ago — and
 *    one absent worker with no jobs would stop everyone else from ever
 *    taking a second car. On site = open shift AND the app has talked to
 *    the server recently.
 *  - `dispatch_configs` holds the owner's knobs per organisation.
 *  - `washes.assigned_via` records whether a worker accepted the job or the
 *    timer gave it to them; `dispatch_alerted_at` stops a waiting job from
 *    alerting managers more than once.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE staff_users ADD COLUMN last_seen_at TIMESTAMPTZ`);

  await knex.raw(`
    CREATE TABLE dispatch_configs (
      org_id                   UUID PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      -- How long a new job is open to "first to click" before auto-assign.
      accept_window_seconds    INT NOT NULL DEFAULT 60 CHECK (accept_window_seconds BETWEEN 5 AND 3600),
      -- How recently a worker's app must have been in touch to count as on site.
      presence_minutes         INT NOT NULL DEFAULT 20 CHECK (presence_minutes BETWEEN 1 AND 1440),
      -- A job still waiting this long (nobody on site) alerts the managers.
      unassigned_alert_minutes INT NOT NULL DEFAULT 10 CHECK (unassigned_alert_minutes BETWEEN 1 AND 1440),
      updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await knex.raw(`INSERT INTO dispatch_configs (org_id) SELECT id FROM organizations ON CONFLICT DO NOTHING`);

  await knex.raw(`
    ALTER TABLE washes
      ADD COLUMN assigned_via TEXT CHECK (assigned_via IS NULL OR assigned_via IN ('accept', 'auto')),
      ADD COLUMN dispatch_alerted_at TIMESTAMPTZ
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE washes DROP COLUMN IF EXISTS assigned_via, DROP COLUMN IF EXISTS dispatch_alerted_at`);
  await knex.raw(`DROP TABLE IF EXISTS dispatch_configs`);
  await knex.raw(`ALTER TABLE staff_users DROP COLUMN IF EXISTS last_seen_at`);
}
