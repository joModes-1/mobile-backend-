import type { Knex } from 'knex';

/**
 * Sysadmin (platform admin) accounts move to phone + OTP, same as staff did
 * in 20260921_014. `password_hash` stops being required, and `phone` gets
 * the same normalise-and-uniquify treatment — `/auth/phone/verify` already
 * resolves a platform admin by phone (phoneAuth.ts has always checked
 * `platform_admins` first, ahead of staff and clients), so this migration
 * is what actually makes that path usable rather than removing the only
 * way in.
 *
 * `email` stays NOT NULL: platform_admins.email is still used to notify a
 * newly created admin of their own account (no password to email any more,
 * just a "you've been added" notice), and login by password is what's being
 * removed here, not the email column itself.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE platform_admins ALTER COLUMN password_hash DROP NOT NULL`);

  // Local (0XXXXXXXXX) and bare-subscriber (XXXXXXXXX) forms to E.164 —
  // identical normalisation to the staff migration, so both tables agree
  // on what a "real" phone value looks like.
  await knex.raw(`
    UPDATE platform_admins
       SET phone = '+256' || substring(regexp_replace(phone, '[^0-9]', '', 'g') from 2)
     WHERE phone IS NOT NULL
       AND regexp_replace(phone, '[^0-9]', '', 'g') ~ '^0[0-9]{9}$'
  `);
  await knex.raw(`
    UPDATE platform_admins
       SET phone = '+' || regexp_replace(phone, '[^0-9]', '', 'g')
     WHERE phone IS NOT NULL
       AND regexp_replace(phone, '[^0-9]', '', 'g') ~ '^256[0-9]{9}$'
       AND phone NOT LIKE '+%'
  `);
  await knex.raw(`
    UPDATE platform_admins
       SET phone = '+256' || regexp_replace(phone, '[^0-9]', '', 'g')
     WHERE phone IS NOT NULL
       AND regexp_replace(phone, '[^0-9]', '', 'g') ~ '^[1-9][0-9]{8}$'
  `);
  await knex.raw(`
    UPDATE platform_admins SET phone = NULL
     WHERE phone IS NOT NULL AND phone !~ '^\\+256[0-9]{9}$'
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX platform_admins_phone_uniq
        ON platform_admins (phone)
     WHERE phone IS NOT NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS platform_admins_phone_uniq`);
  // password_hash is intentionally left nullable — see the staff migration's
  // own note on why restoring NOT NULL here would fail on rows created
  // while this was applied.
}
