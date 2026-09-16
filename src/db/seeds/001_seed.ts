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

  const sysadminId = await ensure(
    'platform_admins',
    { sql: 'lower(username) = lower(?)', params: [sysadminUsername] },
    {
      columns: 'full_name, username, email, password_hash, must_change_password',
      values: '?, ?, ?, ?, true',
      params: ['System Administrator', sysadminUsername, sysadminEmail, await argon2.hash(sysadminPassword)],
    },
    `sysadmin: ${sysadminUsername} / ${sysadminPassword}`
  );

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
  /** Staff are unique per (org, username). Password only set on creation. */
  async function ensureStaff(
    username: string, fullName: string, role: string,
    branchId: string | null, email: string, password: string, createdBy: string | null
  ): Promise<string> {
    return ensure(
      'staff_users',
      { sql: 'org_id = ? AND lower(username) = lower(?)', params: [orgId, username] },
      {
        columns: 'org_id, branch_id, role, full_name, username, email, password_hash, must_change_password, created_by',
        values: '?, ?, ?, ?, ?, ?, ?, true, ?',
        params: [orgId, branchId, role, fullName, username, email, await argon2.hash(password), createdBy],
      },
      `${role}: ${username} / ${password}`
    );
  }

  const orgadminId = await ensureStaff('orgadmin', 'Org Admin', 'orgadmin', null, 'admin@democarwash.com', 'Orgadmin123!', null);
  const managerId = await ensureStaff('grace', 'Grace N.', 'manager', branch1Id, 'grace@democarwash.com', 'Manager123!', orgadminId);
  await ensureStaff('joseph', 'Joseph K.', 'worker', branch1Id, 'joseph@democarwash.com', 'Worker123!', managerId);
  await ensureStaff('musa', 'Musa K.', 'worker', branch1Id, 'musa@democarwash.com', 'Worker123!', managerId);

  // ── Client ────────────────────────────────────────────────────────
  function memberCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = 'MC-';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  await ensure(
    'clients',
    { sql: 'org_id = ? AND lower(username) = lower(?)', params: [orgId, 'peter_o'] },
    {
      columns: 'org_id, full_name, phone, member_code, phone_verified, username, email, email_verified, password_hash',
      values: '?, ?, ?, ?, true, ?, ?, true, ?',
      params: [orgId, 'Peter O.', '+256700123456', memberCode(), 'peter_o', 'peter.o@example.com', await argon2.hash('Client123!')],
    },
    'client: peter_o / Client123!'
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
    { name: 'Full wash', is_default: true, earns_point: true },
    { name: 'Half wash', is_default: false, earns_point: true },
    { name: 'Interior only', is_default: false, earns_point: true },
    { name: 'Engine', is_default: false, earns_point: false },
  ];
  const svcIds: Record<string, string> = {};
  for (const svc of services) {
    svcIds[svc.name] = await ensure(
      'services',
      { sql: 'org_id = ? AND lower(name) = lower(?) AND branch_id IS NULL', params: [orgId, svc.name] },
      {
        columns: 'org_id, name, is_default, earns_point',
        values: '?, ?, ?, ?',
        params: [orgId, svc.name, svc.is_default && !orgHasDefault, svc.earns_point],
      },
      `service: ${svc.name}`
    );
  }

  // ── Prices ────────────────────────────────────────────────────────
  const priceMatrix: Record<string, Record<string, number>> = {
    'Full wash':     { Saloon: 20000, SUV: 30000, Pickup: 35000, Van: 25000, Truck: 35000 },
    'Half wash':     { Saloon: 12000, SUV: 15000, Van: 15000, Truck: 20000 },
    'Interior only': { Saloon: 15000, SUV: 18000, Pickup: 20000, Van: 18000, Truck: 22000 },
    'Engine':        { Saloon: 8000,  SUV: 10000, Pickup: 12000, Van: 10000, Truck: 15000 },
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
    ['Full wash', 'Saloon', 25000],
    ['Full wash', 'SUV', 35000],
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

  await ensure(
    'staff_users',
    { sql: 'org_id = ? AND lower(username) = lower(?)', params: [org2Id, 'shineadmin'] },
    {
      columns: 'org_id, branch_id, role, full_name, username, email, password_hash, must_change_password, created_by',
      values: '?, NULL, ?, ?, ?, ?, ?, true, NULL',
      params: [org2Id, 'orgadmin', 'Shine Admin', 'shineadmin', 'shineadmin@shinemotors.com', await argon2.hash('Orgadmin123!')],
    },
    'orgadmin: shineadmin / Orgadmin123!'
  );

  await ensure(
    'staff_users',
    { sql: 'org_id = ? AND lower(username) = lower(?)', params: [org2Id, 'shine_worker'] },
    {
      columns: 'org_id, branch_id, role, full_name, username, email, password_hash, must_change_password, created_by',
      values: '?, ?, ?, ?, ?, ?, ?, true, NULL',
      params: [org2Id, org2BranchId, 'worker', 'Shine Worker', 'shine_worker', 'shineworker@shinemotors.com', await argon2.hash('Worker123!')],
    },
    'worker: shine_worker / Worker123!'
  );

  console.log(`\n  Seed complete — ${created} created, ${skipped} already present.`);
  if (created === 0) console.log('  Nothing to do: the fixture was already in place.');
}
