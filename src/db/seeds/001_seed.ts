import { Knex } from 'knex';
import argon2 from 'argon2';

export async function seed(knex: Knex): Promise<void> {
  // Reads real process env vars — Render (and every other host) injects
  // config this way, not as a checked-in .env file. The previous version
  // parsed ../../../.env directly off disk, which does not exist on a
  // hosted deploy and would have silently fallen through to the hardcoded
  // admin@carwash.com / admin123 defaults below instead of the credentials
  // actually set in the hosting dashboard.
  const env = process.env;

  // This wipes every organization, staff user, wash and client in the
  // database. It is meant to run exactly once, against an empty database,
  // as a manual step — never as part of an automated deploy or migration
  // step, and never again once real data exists.
  if (env.NODE_ENV === 'production' && env.ALLOW_PROD_SEED !== 'true') {
    throw new Error(
      'Refusing to run the destructive seed in production. If this is genuinely a fresh ' +
      'database with no real data yet, set ALLOW_PROD_SEED=true for this one run and unset it after.'
    );
  }

  // Clean existing data (order matters for foreign keys)
  await knex.raw('DELETE FROM loyalty_ledger');
  await knex.raw('DELETE FROM loyalty_accounts');
  await knex.raw('DELETE FROM loyalty_configs');
  await knex.raw('DELETE FROM client_tokens');
  await knex.raw('DELETE FROM washes');
  await knex.raw('DELETE FROM branch_counters');
  await knex.raw('DELETE FROM shifts');
  await knex.raw('DELETE FROM audit_logs');
  await knex.raw('DELETE FROM devices');
  await knex.raw('DELETE FROM otp_codes');
  await knex.raw('DELETE FROM refresh_tokens');
  await knex.raw('DELETE FROM prices');
  await knex.raw('DELETE FROM services');
  await knex.raw('DELETE FROM vehicle_classes');
  await knex.raw('DELETE FROM clients');
  await knex.raw('DELETE FROM staff_users CASCADE');
  await knex.raw('DELETE FROM branches');
  await knex.raw('DELETE FROM organizations');
  await knex.raw('DELETE FROM platform_admins CASCADE');

  const sysadminEmail = env.SEED_SYSADMIN_EMAIL || 'admin@carwash.com';
  const sysadminUsername = env.SEED_SYSADMIN_USERNAME || 'sysadmin';
  const sysadminPassword = env.SEED_SYSADMIN_PASSWORD || 'admin123';
  const sysadminHash = await argon2.hash(sysadminPassword);

  // 1. Create sysadmin
  const sysadminResult = await knex.raw(
    `INSERT INTO platform_admins (full_name, username, email, password_hash, must_change_password)
     VALUES (?, ?, ?, ?, true) RETURNING id`,
    ['System Administrator', sysadminUsername, sysadminEmail, sysadminHash]
  );
  const sysadminId = sysadminResult.rows[0].id;
  console.log(`  ✓ Created sysadmin: ${sysadminUsername} / ${sysadminPassword}`);

  // 2. Create demo org
  const orgResult = await knex.raw(
    `INSERT INTO organizations (name, slug, phone, contact_name, created_by)
     VALUES (?, ?, ?, ?, ?) RETURNING id`,
    ['Demo Car Wash', 'demo', '+256700000000', 'Demo Owner', sysadminId]
  );
  const orgId = orgResult.rows[0].id;
  console.log(`  ✓ Created org: Demo Car Wash`);

  // 3. Create two branches
  const branch1Result = await knex.raw(
    `INSERT INTO branches (org_id, name, code, address, phone)
     VALUES (?, ?, ?, ?, ?) RETURNING id`,
    [orgId, 'Ntinda Bay', 'NTD', '123 Ntinda Road, Kampala', '+256700000001']
  );
  const branch1Id = branch1Result.rows[0].id;

  const branch2Result = await knex.raw(
    `INSERT INTO branches (org_id, name, code, address, phone)
     VALUES (?, ?, ?, ?, ?) RETURNING id`,
    [orgId, 'Kabalagala Bay', 'KBL', '456 Kabalagala Road, Kampala', '+256700000002']
  );
  const branch2Id = branch2Result.rows[0].id;
  console.log(`  ✓ Created branches: Ntinda Bay (NTD), Kabalagala Bay (KBL)`);

  // 4. Create orgadmin
  const orgadminHash = await argon2.hash('Orgadmin123!');
  const orgadminResult = await knex.raw(
    `INSERT INTO staff_users (org_id, branch_id, role, full_name, username, email, password_hash, must_change_password, created_by)
     VALUES (?, NULL, 'orgadmin', ?, ?, ?, ?, true, NULL) RETURNING id`,
    [orgId, 'Org Admin', 'orgadmin', 'admin@democarwash.com', orgadminHash]
  );
  const orgadminId = orgadminResult.rows[0].id;
  console.log(`  ✓ Created orgadmin: orgadmin / Orgadmin123!`);

  // 5. Create manager (branch 1)
  const managerHash = await argon2.hash('Manager123!');
  const managerResult = await knex.raw(
    `INSERT INTO staff_users (org_id, branch_id, role, full_name, username, email, password_hash, must_change_password, created_by)
     VALUES (?, ?, 'manager', ?, ?, ?, ?, true, ?) RETURNING id`,
    [orgId, branch1Id, 'Grace N.', 'grace', 'grace@democarwash.com', managerHash, orgadminId]
  );
  const managerId = managerResult.rows[0].id;
  console.log(`  ✓ Created manager: grace / Manager123! (Ntinda Bay)`);

  // 6. Create two workers (branch 1)
  const worker1Hash = await argon2.hash('Worker123!');
  await knex.raw(
    `INSERT INTO staff_users (org_id, branch_id, role, full_name, username, email, password_hash, must_change_password, created_by)
     VALUES (?, ?, 'worker', ?, ?, ?, ?, true, ?)`,
    [orgId, branch1Id, 'Joseph K.', 'joseph', 'joseph@democarwash.com', worker1Hash, managerId]
  );

  const worker2Hash = await argon2.hash('Worker123!');
  await knex.raw(
    `INSERT INTO staff_users (org_id, branch_id, role, full_name, username, email, password_hash, must_change_password, created_by)
     VALUES (?, ?, 'worker', ?, ?, ?, ?, true, ?)`,
    [orgId, branch1Id, 'Musa K.', 'musa', 'musa@democarwash.com', worker2Hash, managerId]
  );
  console.log(`  ✓ Created workers: joseph / Worker123!, musa / Worker123! (Ntinda Bay)`);

  // 7. Create one client
  const memberCode = 'MC-' + Math.random().toString(36).substring(2, 8).toUpperCase();
  const clientPasswordHash = await argon2.hash('Client123!');
  await knex.raw(
    `INSERT INTO clients (org_id, full_name, phone, member_code, phone_verified, username, email, email_verified, password_hash)
     VALUES (?, ?, ?, ?, true, ?, ?, true, ?)`,
    [orgId, 'Peter O.', '+256700123456', memberCode, 'peter_o', 'peter.o@example.com', clientPasswordHash]
  );
  console.log(`  ✓ Created client: peter_o / Client123! (member code: ${memberCode})`);

  // 8. Create vehicle classes
  const vehicleClasses = [
    { name: 'Saloon', sort_order: 1 },
    { name: 'SUV', sort_order: 2 },
    { name: 'Pickup', sort_order: 3 },
    { name: 'Van', sort_order: 4 },
    { name: 'Truck', sort_order: 5 },
  ];
  const vcIds: Record<string, string> = {};
  for (const vc of vehicleClasses) {
    const r = await knex.raw(
      `INSERT INTO vehicle_classes (org_id, name, sort_order) VALUES (?, ?, ?) RETURNING id`,
      [orgId, vc.name, vc.sort_order]
    );
    vcIds[vc.name] = r.rows[0].id;
  }
  console.log(`  ✓ Created ${vehicleClasses.length} vehicle classes`);

  // 9. Create services
  const services = [
    { name: 'Full wash', is_default: true, earns_point: true },
    { name: 'Half wash', is_default: false, earns_point: true },
    { name: 'Interior only', is_default: false, earns_point: true },
    { name: 'Engine', is_default: false, earns_point: false },
  ];
  const svcIds: Record<string, string> = {};
  for (const svc of services) {
    const r = await knex.raw(
      `INSERT INTO services (org_id, name, is_default, earns_point) VALUES (?, ?, ?, ?) RETURNING id`,
      [orgId, svc.name, svc.is_default, svc.earns_point]
    );
    svcIds[svc.name] = r.rows[0].id;
  }
  console.log(`  ✓ Created ${services.length} services`);

  // 10. Create org-wide price matrix
  const priceMatrix: Record<string, Record<string, number>> = {
    'Full wash':     { Saloon: 20000, SUV: 30000, Pickup: 35000, Van: 25000, Truck: 35000 },
    'Half wash':     { Saloon: 12000, SUV: 15000, Van: 15000, Truck: 20000 },
    'Interior only': { Saloon: 15000, SUV: 18000, Pickup: 20000, Van: 18000, Truck: 22000 },
    'Engine':        { Saloon: 8000,  SUV: 10000, Pickup: 12000, Van: 10000, Truck: 15000 },
  };
  let priceCount = 0;
  for (const [svcName, vcPrices] of Object.entries(priceMatrix)) {
    for (const [vcName, price] of Object.entries(vcPrices)) {
      await knex.raw(
        `INSERT INTO prices (org_id, service_id, vehicle_class_id, price_ugx, updated_by)
         VALUES (?, ?, ?, ?, ?)`,
        [orgId, svcIds[svcName], vcIds[vcName], price, orgadminId]
      );
      priceCount++;
    }
  }
  console.log(`  ✓ Created ${priceCount} org-wide prices`);

  // 11. Create branch overrides for Ntinda
  let overrideCount = 0;
  // Saloon Full: 25,000
  await knex.raw(
    `INSERT INTO prices (org_id, service_id, vehicle_class_id, branch_id, price_ugx, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [orgId, svcIds['Full wash'], vcIds['Saloon'], branch1Id, 25000, managerId]
  );
  overrideCount++;
  // SUV Full: 35,000
  await knex.raw(
    `INSERT INTO prices (org_id, service_id, vehicle_class_id, branch_id, price_ugx, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [orgId, svcIds['Full wash'], vcIds['SUV'], branch1Id, 35000, managerId]
  );
  overrideCount++;
  console.log(`  ✓ Created ${overrideCount} branch overrides for Ntinda Bay`);

  // 12. Create loyalty config
  await knex.raw(
    `INSERT INTO loyalty_configs (org_id, washes_required, min_amount_ugx)
     VALUES (?, 7, 10000)
     ON CONFLICT (org_id) DO NOTHING`,
    [orgId]
  );
  console.log(`  ✓ Created loyalty config (7 washes = 1 free)`);

  // 13. Create second org for tenant isolation testing
  const org2Result = await knex.raw(
    `INSERT INTO organizations (name, slug, phone, contact_name, created_by)
     VALUES (?, ?, ?, ?, ?) RETURNING id`,
    ['Shine Motors', 'shine', '+256700000099', 'Shine Owner', sysadminId]
  );
  const org2Id = org2Result.rows[0].id;
  console.log(`  ✓ Created org: Shine Motors`);

  const org2Branch = await knex.raw(
    `INSERT INTO branches (org_id, name, code, address, phone)
     VALUES (?, ?, ?, ?, ?) RETURNING id`,
    [org2Id, 'Main Bay', 'SHN', '789 Shine Road, Kampala', '+256700000098']
  );
  console.log(`  ✓ Created branch: Main Bay (SHN)`);

  const org2AdminHash = await argon2.hash('Orgadmin123!');
  await knex.raw(
    `INSERT INTO staff_users (org_id, branch_id, role, full_name, username, email, password_hash, must_change_password, created_by)
     VALUES (?, NULL, 'orgadmin', ?, ?, ?, ?, true, NULL)`,
    [org2Id, 'Shine Admin', 'shineadmin', 'shineadmin@shinemotors.com', org2AdminHash]
  );
  console.log(`  ✓ Created org2 admin: shineadmin / Orgadmin123!`);

  const org2WorkerHash = await argon2.hash('Worker123!');
  await knex.raw(
    `INSERT INTO staff_users (org_id, branch_id, role, full_name, username, email, password_hash, must_change_password, created_by)
     VALUES (?, ?, 'worker', ?, ?, ?, ?, true, NULL)`,
    [org2Id, org2Branch.rows[0].id, 'Shine Worker', 'shine_worker', 'shineworker@shinemotors.com', org2WorkerHash]
  );
  console.log(`  ✓ Created org2 worker: shine_worker / Worker123!`);

  console.log('\n  Seed complete!');
  console.log(`  Sysadmin: ${sysadminUsername} / ${sysadminPassword}`);
  console.log(`  All staff passwords must be changed on first login.`);
}
