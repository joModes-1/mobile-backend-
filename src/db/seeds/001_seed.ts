import { Knex } from 'knex';
import argon2 from 'argon2';

/**
 * Idempotent seed: adds what is missing, never removes anything.
 *
 * This used to DELETE every table before inserting, which made it a
 * reset-to-zero tool that could not be run twice — the second run wiped
 * whatever real testing data had built up. Now each row is looked up by its
 * natural key first and only inserted when absent, so running it against a
 * populated database tops up the fixture and leaves everything else alone.
 *
 * Passwords are only set when an account is created. An existing user keeps
 * the password they already have, so re-seeding never silently resets
 * someone's credentials back to the default.
 *
 * Note on lookups: the unique indexes here are expression indexes
 * (lower(slug), upper(code), lower(username)), which ON CONFLICT cannot
 * target. Hence explicit select-then-insert rather than an upsert.
 */
export async function seed(knex: Knex): Promise<void> {
  // Reads real process env vars — Render (and every other host) injects
  // config this way, not as a checked-in .env file.
  const env = process.env;

  let created = 0;
  let skipped = 0;
  const note = (didCreate: boolean, label: string) => {
    if (didCreate) { created++; console.log(`  + ${label}`); }
    else { skipped++; }
  };

  /** Returns the id of an existing row matched by `where`, or inserts one. */
  async function ensure(
    table: string,
    where: { sql: string; params: any[] },
    insert: { columns: string; values: string; params: any[] },
    label: string
  ): Promise<string> {
    const found = await knex.raw(
      `SELECT id FROM ${table} WHERE ${where.sql} LIMIT 1`,
      where.params
    );
    if (found.rows.length > 0) { note(false, label); return found.rows[0].id; }

    const inserted = await knex.raw(
      `INSERT INTO ${table} (${insert.columns}) VALUES (${insert.values}) RETURNING id`,
      insert.params
    );
    note(true, label);
    return inserted.rows[0].id;
  }

  // ── Platform admin ────────────────────────────────────────────────
  const sysadminEmail = env.SEED_SYSADMIN_EMAIL || 'admin@carwash.com';
  const sysadminUsername = env.SEED_SYSADMIN_USERNAME || 'sysadmin';
  const sysadminPassword = env.SEED_SYSADMIN_PASSWORD || 'admin123';

  const sysadminPhone = '+256700200000';
  const sysadminId = await ensure(
    'platform_admins',
    { sql: 'lower(username) = lower(?)', params: [sysadminUsername] },
    {
      columns: 'full_name, username, email, phone, password_hash, must_change_password',
      values: '?, ?, ?, ?, ?, true',
      params: ['System Administrator', sysadminUsername, sysadminEmail, sysadminPhone, await argon2.hash(sysadminPassword)],
    },
    `sysadmin: ${sysadminUsername} / ${sysadminPassword} / ${sysadminPhone}`
  );
  // Backfilled the same way as staff phones — an account that already
  // existed before this seeder added the phone-login flow still needs one.
  await knex.raw(`UPDATE platform_admins SET phone = ? WHERE id = ?`, [sysadminPhone, sysadminId]);

  // ── Org A: Demo Car Wash ──────────────────────────────────────────
  const orgId = await ensure(
    'organizations',
    { sql: 'lower(slug) = lower(?)', params: ['demo'] },
    {
      columns: 'name, slug, phone, contact_name, created_by',
      values: '?, ?, ?, ?, ?',
      params: ['Demo Car Wash', 'demo', '+256700000000', 'Demo Owner', sysadminId],
    },
    'org: Demo Car Wash'
  );

  const branch1Id = await ensure(
    'branches',
    { sql: 'org_id = ? AND upper(code) = upper(?)', params: [orgId, 'NTD'] },
    {
      columns: 'org_id, name, code, address, phone',
      values: '?, ?, ?, ?, ?',
      params: [orgId, 'Ntinda Bay', 'NTD', '123 Ntinda Road, Kampala', '+256700000001'],
    },
    'branch: Ntinda Bay (NTD)'
  );

  const branch2Id = await ensure(
    'branches',
    { sql: 'org_id = ? AND upper(code) = upper(?)', params: [orgId, 'KBL'] },
    {
      columns: 'org_id, name, code, address, phone',
      values: '?, ?, ?, ?, ?',
      params: [orgId, 'Kabalagala Bay', 'KBL', '456 Kabalagala Road, Kampala', '+256700000002'],
    },
    'branch: Kabalagala Bay (KBL)'
  );

  // ── Staff ─────────────────────────────────────────────────────────
  /**
   * Staff are unique per (org, username). Password only set on creation.
   *
   * Phone is backfilled unconditionally, even for an account that already
   * existed — the phone-login flow needs one on every staff row to be
   * testable, and a phone number carries no password-reset implication the
   * way silently changing a password would, so updating it on every run is
   * safe.
   */
  async function ensureStaff(
    username: string, fullName: string, role: string,
    branchId: string | null, email: string, password: string,
    createdBy: string | null, phone: string
  ): Promise<string> {
    const id = await ensure(
      'staff_users',
      { sql: 'org_id = ? AND lower(username) = lower(?)', params: [orgId, username] },
      {
        columns: 'org_id, branch_id, role, full_name, username, email, phone, password_hash, must_change_password, created_by',
        values: '?, ?, ?, ?, ?, ?, ?, ?, true, ?',
        params: [orgId, branchId, role, fullName, username, email, phone, await argon2.hash(password), createdBy],
      },
      `${role}: ${username} / ${password} / ${phone}`
    );
    await knex.raw(`UPDATE staff_users SET phone = ? WHERE id = ?`, [phone, id]);
    return id;
  }

  const orgadminId = await ensureStaff('orgadmin', 'Org Admin', 'orgadmin', null, 'admin@democarwash.com', 'Orgadmin123!', null, '+256700200001');
  const managerId = await ensureStaff('grace', 'Grace N.', 'manager', branch1Id, 'grace@democarwash.com', 'Manager123!', orgadminId, '+256700200002');
  await ensureStaff('joseph', 'Joseph K.', 'worker', branch1Id, 'joseph@democarwash.com', 'Worker123!', managerId, '+256700200003');
  await ensureStaff('musa', 'Musa K.', 'worker', branch1Id, 'musa@democarwash.com', 'Worker123!', managerId, '+256700200004');

  // ── Client ────────────────────────────────────────────────────────
  await ensure(
    'clients',
    { sql: 'org_id = ? AND lower(username) = lower(?)', params: [orgId, 'peter_o'] },
    {
      columns: 'org_id, full_name, phone, phone_verified, username, email, email_verified, password_hash',
      values: '?, ?, ?, true, ?, ?, true, ?',
      params: [orgId, 'Peter O.', '+256700200099', 'peter_o', 'peter.o@example.com', await argon2.hash('Client123!')],
    },
    'client: peter_o / Client123! / +256700200099'
  );

  // ── Catalogue ─────────────────────────────────────────────────────
  const vehicleClasses = [
    { name: 'Saloon', sort_order: 1 },
    { name: 'SUV', sort_order: 2 },
    { name: 'Pickup', sort_order: 3 },
    { name: 'Van', sort_order: 4 },
    { name: 'Truck', sort_order: 5 },
  ];
  const vcIds: Record<string, string> = {};
  for (const vc of vehicleClasses) {
    vcIds[vc.name] = await ensure(
      'vehicle_classes',
      { sql: 'org_id = ? AND lower(name) = lower(?) AND branch_id IS NULL', params: [orgId, vc.name] },
      {
        columns: 'org_id, name, sort_order',
        values: '?, ?, ?',
        params: [orgId, vc.name, vc.sort_order],
      },
      `vehicle class: ${vc.name}`
    );
  }

  // Only one service per org may carry is_default (partial unique index), so
  // a new default is only claimed when the org has none yet.
  const existingDefault = await knex.raw(
    `SELECT id FROM services WHERE org_id = ? AND is_default LIMIT 1`, [orgId]
  );
  const orgHasDefault = existingDefault.rows.length > 0;

  const services = [
    { name: 'Bikes', is_default: true, earns_point: true },
    { name: 'Heavy vehicle', is_default: false, earns_point: true },
    { name: 'Interior detailing', is_default: false, earns_point: true },
    { name: 'Engine wash', is_default: false, earns_point: false },
  ];
  const svcIds: Record<string, string> = {};
  for (const svc of services) {
    svcIds[svc.name] = await ensure(
      'services',
      { sql: 'org_id = ? AND lower(name) = lower(?) AND branch_id IS NULL', params: [orgId, svc.name] },
      {
        // Wash types that earn points start at 10 (worth 1,000 UGX at the
        // default 100 per point); the owner tunes both in Settings.
        // and every wash type gives the worker 10 points to start with.
        columns: 'org_id, name, is_default, earns_point, client_points_awarded, worker_points_awarded',
        values: '?, ?, ?, ?, ?, ?',
        params: [orgId, svc.name, svc.is_default && !orgHasDefault, svc.earns_point, svc.earns_point ? 10 : 0, 10],
      },
      `service: ${svc.name}`
    );
  }

  // ── Prices ────────────────────────────────────────────────────────
  const priceMatrix: Record<string, Record<string, number>> = {
    'Bikes':      { Saloon: 20000, SUV: 30000, Pickup: 35000, Van: 25000, Truck: 35000 },
    'Heavy vehicle': { Saloon: 12000, SUV: 15000, Van: 15000, Truck: 20000 },
    'Interior detailing': { Saloon: 15000, SUV: 18000, Pickup: 20000, Van: 18000, Truck: 22000 },
    'Engine wash':         { Saloon: 8000,  SUV: 10000, Pickup: 12000, Van: 10000, Truck: 15000 },
  };
  for (const [svcName, vcPrices] of Object.entries(priceMatrix)) {
    for (const [vcName, price] of Object.entries(vcPrices)) {
      await ensure(
        'prices',
        {
          sql: 'org_id = ? AND service_id = ? AND vehicle_class_id = ? AND branch_id IS NULL',
          params: [orgId, svcIds[svcName], vcIds[vcName]],
        },
        {
          columns: 'org_id, service_id, vehicle_class_id, price_ugx, updated_by',
          values: '?, ?, ?, ?, ?',
          params: [orgId, svcIds[svcName], vcIds[vcName], price, orgadminId],
        },
        `price: ${vcName} ${svcName} = ${price}`
      );
    }
  }

  // Ntinda-specific overrides
  const overrides: Array<[string, string, number]> = [
    ['Bikes', 'Saloon', 25000],
    ['Bikes', 'SUV', 35000],
  ];
  for (const [svcName, vcName, price] of overrides) {
    await ensure(
      'prices',
      {
        sql: 'org_id = ? AND service_id = ? AND vehicle_class_id = ? AND branch_id = ?',
        params: [orgId, svcIds[svcName], vcIds[vcName], branch1Id],
      },
      {
        columns: 'org_id, service_id, vehicle_class_id, branch_id, price_ugx, updated_by',
        values: '?, ?, ?, ?, ?, ?',
        params: [orgId, svcIds[svcName], vcIds[vcName], branch1Id, price, managerId],
      },
      `override (NTD): ${vcName} ${svcName} = ${price}`
    );
  }

  // ── Loyalty config ────────────────────────────────────────────────
  const loyaltyBefore = await knex.raw(`SELECT org_id FROM loyalty_configs WHERE org_id = ?`, [orgId]);
  await knex.raw(
    `INSERT INTO loyalty_configs (org_id, washes_required, min_amount_ugx)
     VALUES (?, 7, 10000) ON CONFLICT (org_id) DO NOTHING`,
    [orgId]
  );
  note(loyaltyBefore.rows.length === 0, 'loyalty config (7 washes = 1 free)');

  // ── Org B: Shine Motors (tenant isolation fixture) ────────────────
  const org2Id = await ensure(
    'organizations',
    { sql: 'lower(slug) = lower(?)', params: ['shine'] },
    {
      columns: 'name, slug, phone, contact_name, created_by',
      values: '?, ?, ?, ?, ?',
      params: ['Shine Motors', 'shine', '+256700000099', 'Shine Owner', sysadminId],
    },
    'org: Shine Motors'
  );

  const org2BranchId = await ensure(
    'branches',
    { sql: 'org_id = ? AND upper(code) = upper(?)', params: [org2Id, 'SHN'] },
    {
      columns: 'org_id, name, code, address, phone',
      values: '?, ?, ?, ?, ?',
      params: [org2Id, 'Main Bay', 'SHN', '789 Shine Road, Kampala', '+256700000098'],
    },
    'branch: Main Bay (SHN)'
  );

  const shineAdminId = await ensure(
    'staff_users',
    { sql: 'org_id = ? AND lower(username) = lower(?)', params: [org2Id, 'shineadmin'] },
    {
      columns: 'org_id, branch_id, role, full_name, username, email, phone, password_hash, must_change_password, created_by',
      values: '?, NULL, ?, ?, ?, ?, ?, ?, true, NULL',
      params: [org2Id, 'orgadmin', 'Shine Admin', 'shineadmin', 'shineadmin@shinemotors.com', '+256700200005', await argon2.hash('Orgadmin123!')],
    },
    'orgadmin: shineadmin / Orgadmin123! / +256700200005'
  );
  await knex.raw(`UPDATE staff_users SET phone = ? WHERE id = ?`, ['+256700200005', shineAdminId]);

  // ── Branch coordinates (for the nearby-branch picker) ────────────
  // Backfill-only: an existing branch keeps whatever coordinates it
  // already has (including a deliberate correction made via the app),
  // exactly like the phone backfill above. Real Kampala-area points,
  // far enough apart that the /me/branches/nearby distance ordering is
  // testable — the numbers are the point, not precise door positions.
  const branchCoords: Array<{ code: string; lat: number; lng: number }> = [
    { code: 'NTD', lat: 0.348232, lng: 32.618631 }, // Ntinda
    { code: 'KBL', lat: 0.296201, lng: 32.609217 }, // Kabalagala
    { code: 'SHN', lat: 0.332460, lng: 32.570000 }, // near Kasangati road
  ];
  for (const { code, lat, lng } of branchCoords) {
    await knex.raw(
      `UPDATE branches SET latitude = ?, longitude = ?
        WHERE upper(code) = upper(?)
          AND latitude IS NULL AND longitude IS NULL`,
      [lat, lng, code]
    );
  }
  console.log('  branch coordinates: backfilled any that were missing.');

  const shineWorkerId = await ensure(
    'staff_users',
    { sql: 'org_id = ? AND lower(username) = lower(?)', params: [org2Id, 'shine_worker'] },
    {
      columns: 'org_id, branch_id, role, full_name, username, email, phone, password_hash, must_change_password, created_by',
      values: '?, ?, ?, ?, ?, ?, ?, ?, true, NULL',
      params: [org2Id, org2BranchId, 'worker', 'Shine Worker', 'shine_worker', 'shineworker@shinemotors.com', '+256700200006', await argon2.hash('Worker123!')],
    },
    'worker: shine_worker / Worker123! / +256700200006'
  );
  await knex.raw(`UPDATE staff_users SET phone = ? WHERE id = ?`, ['+256700200006', shineWorkerId]);

  console.log(`\n  Seed complete — ${created} created, ${skipped} already present.`);
  if (created === 0) console.log('  Nothing to do: the fixture was already in place.');
}
