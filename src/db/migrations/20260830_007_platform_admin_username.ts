import type { Knex } from 'knex';

/**
 * Platform admins (sysadmins) signed in with an email while every other role
 * used a username. This adds a username so the single login box is consistent
 * for all roles. Email is kept — it stays the contact address and still works
 * as a login identifier.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE platform_admins ADD COLUMN username TEXT`);

  // Backfill from the local part of the email so existing admins keep working.
  await knex.raw(`
    UPDATE platform_admins
    SET username = split_part(email, '@', 1)
    WHERE username IS NULL
  `);

  // Two admins could share a local part (a@x.com / a@y.com) — de-duplicate
  // before the unique index goes on, otherwise the migration fails.
  await knex.raw(`
    UPDATE platform_admins p
    SET username = p.username || '_' || substr(p.id::text, 1, 4)
    WHERE EXISTS (
      SELECT 1 FROM platform_admins q
      WHERE lower(q.username) = lower(p.username)
        AND q.id <> p.id
        AND q.created_at < p.created_at
    )
  `);

  await knex.raw(`ALTER TABLE platform_admins ALTER COLUMN username SET NOT NULL`);
  await knex.raw(`CREATE UNIQUE INDEX ON platform_admins (lower(username))`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE platform_admins DROP COLUMN IF EXISTS username`);
}
