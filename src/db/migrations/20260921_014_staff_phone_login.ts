import type { Knex } from 'knex';

/**
 * Staff sign in by phone + OTP, so `staff_users.phone` becomes the thing
 * that identifies them — and `password_hash` stops being required.
 *
 * Three changes, each needed for that to actually hold:
 *
 *  - `password_hash` was NOT NULL, which made a password mandatory at
 *    creation. Phone-only staff have none, so the column has to allow NULL.
 *    Existing hashes are left alone: staff created before this can still
 *    use username/password, and nothing forces them off it.
 *
 *  - Existing phones are normalised to E.164 (+256XXXXXXXXX). Phone login
 *    normalises what the user types before looking it up, so a row stored
 *    as "0709011288" could never be matched by anyone typing that same
 *    number — it was effectively a phone that does not work.
 *
 *  - A UNIQUE index on phone, so one number resolves to exactly one staff
 *    account. Without it two rows could share a number and the login query
 *    would silently pick whichever Postgres returned first. Partial (WHERE
 *    phone IS NOT NULL) because staff predating phone login legitimately
 *    have none, and several NULLs must stay allowed.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE staff_users ALTER COLUMN password_hash DROP NOT NULL`);

  // Local (0XXXXXXXXX) and bare-subscriber (XXXXXXXXX) forms to E.164.
  await knex.raw(`
    UPDATE staff_users
       SET phone = '+256' || substring(regexp_replace(phone, '[^0-9]', '', 'g') from 2)
     WHERE phone IS NOT NULL
       AND regexp_replace(phone, '[^0-9]', '', 'g') ~ '^0[0-9]{9}$'
  `);
  await knex.raw(`
    UPDATE staff_users
       SET phone = '+' || regexp_replace(phone, '[^0-9]', '', 'g')
     WHERE phone IS NOT NULL
       AND regexp_replace(phone, '[^0-9]', '', 'g') ~ '^256[0-9]{9}$'
       AND phone NOT LIKE '+%'
  `);
  await knex.raw(`
    UPDATE staff_users
       SET phone = '+256' || regexp_replace(phone, '[^0-9]', '', 'g')
     WHERE phone IS NOT NULL
       AND regexp_replace(phone, '[^0-9]', '', 'g') ~ '^[1-9][0-9]{8}$'
  `);

  // Anything still not E.164 was never a usable Ugandan number; blank it
  // rather than let it sit there looking like a working login.
  await knex.raw(`
    UPDATE staff_users SET phone = NULL
     WHERE phone IS NOT NULL AND phone !~ '^\\+256[0-9]{9}$'
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX staff_users_phone_uniq
        ON staff_users (phone)
     WHERE phone IS NOT NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS staff_users_phone_uniq`);
  // password_hash is intentionally left nullable: rows created while this
  // migration was applied have no password, and restoring NOT NULL would
  // fail on them.
}
