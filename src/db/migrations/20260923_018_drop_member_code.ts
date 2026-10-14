import type { Knex } from 'knex';

/**
 * The client "member code" is removed entirely.
 *
 * It existed for the old worker-scans-the-customer flow: a client showed a
 * QR (or read out their `MC-XXXXXXXX` code) and a worker attached the wash
 * to their account with it. That flow is gone — the client now scans the
 * branch's static wall QR and books their own wash — so nothing generates,
 * looks up or displays a member code any more.
 *
 * Dropping the column also drops the unnamed unique index Postgres created
 * for it in 20260827_001_phase1_foundation.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE clients DROP COLUMN IF EXISTS member_code`);
}

export async function down(knex: Knex): Promise<void> {
  // Nullable on the way back: rows created while the column was gone have no
  // value to restore, and NOT NULL would fail on every one of them.
  await knex.raw(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS member_code TEXT`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS clients_member_code_index ON clients (member_code)`);
}
