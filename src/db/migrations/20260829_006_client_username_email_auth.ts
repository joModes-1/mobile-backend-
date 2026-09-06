import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE clients ADD COLUMN username TEXT`);
  await knex.raw(`ALTER TABLE clients ADD COLUMN email TEXT`);
  await knex.raw(`ALTER TABLE clients ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT false`);
  await knex.raw(`ALTER TABLE clients ALTER COLUMN phone DROP NOT NULL`);

  // Backfill existing rows so the new unique indexes can be created safely.
  await knex.raw(`UPDATE clients SET username = 'client_' || substr(id::text, 1, 8) WHERE username IS NULL`);
  await knex.raw(`UPDATE clients SET email = lower(username) || '@placeholder.local' WHERE email IS NULL`);

  await knex.raw(`ALTER TABLE clients ALTER COLUMN username SET NOT NULL`);
  await knex.raw(`ALTER TABLE clients ALTER COLUMN email SET NOT NULL`);
  await knex.raw(`CREATE UNIQUE INDEX ON clients (org_id, lower(username))`);
  await knex.raw(`CREATE UNIQUE INDEX ON clients (lower(email))`);

  await knex.raw(`ALTER TABLE otp_codes ADD COLUMN email TEXT`);
  await knex.raw(`ALTER TABLE otp_codes ALTER COLUMN phone DROP NOT NULL`);
  await knex.raw(`CREATE INDEX ON otp_codes (email, purpose, created_at DESC)`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE otp_codes DROP COLUMN IF EXISTS email`);
  await knex.raw(`ALTER TABLE clients DROP COLUMN IF EXISTS email_verified`);
  await knex.raw(`ALTER TABLE clients DROP COLUMN IF EXISTS email`);
  await knex.raw(`ALTER TABLE clients DROP COLUMN IF EXISTS username`);
}
