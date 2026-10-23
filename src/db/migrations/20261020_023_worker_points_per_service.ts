import type { Knex } from 'knex';

/**
 * Worker points come from Settings, per wash type — the same shape as client
 * points.
 *
 * Until now a worker's points came from a formula on the organisation's
 * config (a flat amount per wash plus extra per 5,000 UGX of value). The
 * owner wants it set the same way as client points: in Settings, each wash
 * type says how many points it gives the worker, and the organisation's
 * `point_value_ugx` (already on worker_points_configs) says what a point is
 * worth. `active` on that table stays the scheme's on/off switch.
 *
 * `washes.worker_points_to_award` freezes the number at booking, like the
 * price and the client's points: changing Settings affects new bookings
 * only, so a worker is never surprised at settlement.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE services
      ADD COLUMN worker_points_awarded INT NOT NULL DEFAULT 0 CHECK (worker_points_awarded >= 0)
  `);
  // Carry today's flat rate across so nobody's points stop on the day this
  // ships; the owner then tunes each wash type in Settings.
  await knex.raw(`
    UPDATE services s
       SET worker_points_awarded = COALESCE(c.points_per_wash, 10)
      FROM organizations o
      LEFT JOIN worker_points_configs c ON c.org_id = o.id
     WHERE s.org_id = o.id
  `);

  await knex.raw(`
    ALTER TABLE washes
      ADD COLUMN worker_points_to_award INT CHECK (worker_points_to_award IS NULL OR worker_points_to_award >= 0)
  `);
  // Washes still open get the number their wash type gives now. Settled
  // history is left NULL — it already earned whatever it earned.
  await knex.raw(`
    UPDATE washes w SET worker_points_to_award = s.worker_points_awarded
      FROM services s
     WHERE s.id = w.service_id AND w.status IN ('requested', 'in_progress', 'ready')
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE washes DROP COLUMN IF EXISTS worker_points_to_award`);
  await knex.raw(`ALTER TABLE services DROP COLUMN IF EXISTS worker_points_awarded`);
}
