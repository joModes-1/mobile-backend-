import type { Knex } from 'knex';

/**
 * Client-initiated washes.
 *
 * Every wash until now was created by the staff member who was about to
 * physically do the work — `started_by_worker_id` was NOT NULL because it
 * was always known at insert time. A client booking their own wash by
 * scanning a branch's wall QR breaks that assumption: the wash has to exist
 * the instant the client confirms (so their app can show "Booked" right
 * away), but no worker has picked it up yet.
 *
 * `status = 'requested'` is the new in-between state. It is not enforced by
 * a CHECK constraint — `washes.status` has never had one; every value in use
 * (`in_progress`, `ready`, `settled`, `cancelled`, `disputed`, `reversed`) is
 * a convention enforced by route logic, and this follows the same pattern.
 *
 * `origin` records how the wash came to exist, permanently — unlike
 * `status`, which moves on, this never changes once set. It exists because
 * plenty of reporting/audit questions ("how many bookings came through
 * self-service this month?") need an answer that survives the wash reaching
 * `in_progress` and losing any other trace of how it started.
 */
export async function up(knex: Knex): Promise<void> {
  // A requested wash has no worker attached yet — that is the whole point,
  // so both columns have to become optional.
  await knex.raw(`ALTER TABLE washes ALTER COLUMN started_by_worker_id DROP NOT NULL`);
  await knex.raw(`ALTER TABLE washes ALTER COLUMN started_shift_id DROP NOT NULL`);

  await knex.raw(`
    ALTER TABLE washes
      ADD COLUMN origin TEXT NOT NULL DEFAULT 'worker'
        CHECK (origin IN ('worker', 'client'))
  `);

  // When the client tapped "book" — distinct from started_at, which now
  // means "when a worker actually began the work" (it gets reset at accept
  // time). Without this, a request sitting unclaimed for 20 minutes has no
  // timestamp of its own to measure that against.
  await knex.raw(`ALTER TABLE washes ADD COLUMN requested_at TIMESTAMPTZ`);
  await knex.raw(`UPDATE washes SET requested_at = started_at WHERE origin = 'client'`);

  // What the client said they'd pay with, at booking time. Informational
  // only — nothing here can actually charge anyone (see payment_method's own
  // migration comment); this just lets a worker's settle screen pre-fill
  // instead of guessing "cash" by default.
  await knex.raw(`
    ALTER TABLE washes
      ADD COLUMN declared_payment_method TEXT
        CHECK (declared_payment_method IS NULL OR declared_payment_method IN ('cash', 'mtn', 'airtel'))
  `);
  await knex.raw(`ALTER TABLE washes ADD COLUMN declared_payment_phone TEXT`);

  // The request queue's read pattern: a branch's own unclaimed requests,
  // oldest first. Partial on the exact predicate the queue query and the
  // accept endpoint's race-safe UPDATE both use.
  await knex.raw(`
    CREATE INDEX request_queue ON washes (branch_id, requested_at)
     WHERE status = 'requested' AND started_by_worker_id IS NULL
  `);

  // dup_check and open_queue (from the phase-4 migration) filter on
  // status IN ('in_progress','ready') — 'requested' is simply not in that
  // list, so both remain correct with no change.
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS request_queue`);
  await knex.raw(`ALTER TABLE washes DROP COLUMN IF EXISTS declared_payment_phone`);
  await knex.raw(`ALTER TABLE washes DROP COLUMN IF EXISTS declared_payment_method`);
  await knex.raw(`ALTER TABLE washes DROP COLUMN IF EXISTS requested_at`);
  await knex.raw(`ALTER TABLE washes DROP COLUMN IF EXISTS origin`);
  await knex.raw(`ALTER TABLE washes ALTER COLUMN started_shift_id SET NOT NULL`);
  await knex.raw(`ALTER TABLE washes ALTER COLUMN started_by_worker_id SET NOT NULL`);
}
