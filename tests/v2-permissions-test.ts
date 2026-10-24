// @ts-nocheck — plain request/response probing; typing it adds nothing.
// V2 permissions — every endpoint × every identity, plus cross-organisation
// and cross-branch probes with real ids. Run against the local backend.
//
// "Allowed" = got past the permission check (any status except 401/403;
// a 400/404/409/422 means the request was let in and then rejected for its
// content). "Blocked" = 401/403. A 500 is always flagged.
//
// Writes use a made-up id or an empty body so they stop at validation /
// not-found and change nothing. Cross-organisation checks use REAL Demo ids
// with Shine Motors' admin, because that is the case that matters.

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { Pool } = require('pg');
const BASE = 'http://localhost:3456/api/v1';
const DUMMY = '00000000-0000-4000-8000-000000000000';

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const b = await res.json().catch(() => null);
  return { status: res.status, code: b?.error?.code, body: b };
}
async function signIn(phone) {
  const s = await call('POST', '/auth/phone/start', { phone });
  return (await call('POST', '/auth/phone/verify', { phone, code: s.body?.data?.otp_code })).body?.data?.access_token;
}

const ROLES = ['anon', 'client', 'worker', 'manager', 'orgadmin', 'sysadmin', 'other'];
const STAFF = ['worker', 'manager', 'orgadmin', 'other'];
const MO = ['manager', 'orgadmin', 'other'];
const O = ['orgadmin', 'other'];
const C = ['client'];
const P = ['sysadmin'];
const AUTH = ['client', 'worker', 'manager', 'orgadmin', 'sysadmin', 'other'];

(async () => {
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
  const demo = await one(`SELECT id FROM organizations WHERE name = 'Demo Car Wash'`);
  const ntd = await one(`SELECT id FROM branches WHERE code = 'NTD'`);
  const kbl = await one(`SELECT id FROM branches WHERE code = 'KBL'`);
  const joseph = await one(`SELECT id FROM staff_users WHERE phone = '+256700200003'`);
  const kblWorker = await one(`SELECT id FROM staff_users WHERE role = 'worker' AND branch_id = $1 LIMIT 1`, [kbl.id]);
  const wash = await one(`SELECT id FROM washes WHERE org_id = $1 AND status = 'settled' ORDER BY settled_at DESC LIMIT 1`, [demo.id]);
  const kblWash = await one(`SELECT id FROM washes WHERE branch_id = $1 LIMIT 1`, [kbl.id]);
  const shift = await one(`SELECT id FROM shifts WHERE worker_id = $1 ORDER BY opened_at DESC LIMIT 1`, [joseph.id]);
  const client = await one(`SELECT id FROM clients WHERE phone = '+256700200099'`);

  const T = {
    anon: undefined,
    client: await signIn('+256700200099'),
    worker: await signIn('+256700200003'),
    manager: await signIn('+256700200002'),
    orgadmin: await signIn('+256700200001'),
    sysadmin: await signIn('+256700200000'),
    other: await signIn('+256700200005'),
  };

  // [method, path, allowed roles, body?]
  const routes = [
    ['GET', '/me', AUTH],
    ['PATCH', '/me', AUTH, {}],
    ['POST', '/me/device', AUTH, {}],
    ['GET', '/me/branches/resolve?code=NTD&org_id=' + demo.id, C],
    ['GET', '/me/branches/nearby?org_id=' + demo.id + '&lat=0.3&lng=32.6', C],
    // client washes
    ['GET', '/me/washes/active', C], ['GET', '/me/washes/history', C], ['GET', '/me/washes/promo', C],
    ['GET', '/me/washes/prices', C], ['POST', '/me/washes', C, {}],
    ['GET', '/me/washes/active-list', C], ['POST', '/me/washes/promo', C, {}],
    ['POST', `/me/washes/${DUMMY}/payment-intent`, C, { method: 'cash' }],
    ['POST', `/me/washes/${DUMMY}/cancel-request`, C],
    ['GET', '/me/washes/loyalty', C], ['GET', '/me/washes/loyalty/ledger', C],
    ['GET', '/me/washes/points', C], ['GET', '/me/washes/points/ledger', C],
    ['POST', '/me/washes/start-token', C], ['POST', `/me/washes/${DUMMY}/pay-token`, C],
    ['POST', `/washes/${DUMMY}/dispute`, C, {}],
    // staff washes
    ['POST', '/washes', STAFF, {}], ['GET', '/washes/queue', STAFF], ['POST', `/washes/${DUMMY}/accept`, STAFF],
    ['POST', `/washes/${DUMMY}/wash-done`, STAFF], ['POST', '/washes/settle-by-token', STAFF, {}],
    ['POST', `/washes/${DUMMY}/settle`, STAFF, { unverified_reason: 'no_app' }],
    ['POST', `/washes/${DUMMY}/cancel`, STAFF, { reason: 'other' }],
    ['POST', `/washes/${DUMMY}/attach-client`, STAFF, {}], ['POST', `/washes/${DUMMY}/apply-free-wash`, STAFF],
    ['GET', '/washes/mine/today', STAFF], ['GET', '/washes/mine/earnings', STAFF],
    ['GET', `/washes/${DUMMY}`, STAFF], ['GET', '/washes', STAFF],
    ['POST', `/washes/${DUMMY}/correct`, MO, {}], ['POST', `/washes/${DUMMY}/reverse`, MO, { reason: 'x' }],
    ['POST', `/washes/${DUMMY}/resolve-dispute`, MO, {}],
    // staff, branches, catalogue, prices
    ['POST', '/staff', MO, {}], ['GET', '/staff', MO], ['GET', `/staff/${DUMMY}`, MO], ['PATCH', `/staff/${DUMMY}`, MO, {}],
    ['POST', `/staff/${DUMMY}/set-pin`, MO, {}], ['POST', `/staff/${DUMMY}/suspend`, MO], ['POST', `/staff/${DUMMY}/activate`, MO],
    ['POST', '/branches', O, {}], ['GET', '/branches', MO], ['GET', `/branches/${DUMMY}`, MO], ['PATCH', `/branches/${DUMMY}`, O, {}],
    ['GET', '/vehicle-classes', MO], ['POST', '/vehicle-classes', MO, {}], ['PATCH', `/vehicle-classes/${DUMMY}`, MO, {}],
    ['GET', '/services', MO], ['POST', '/services', MO, {}], ['PATCH', `/services/${DUMMY}`, MO, {}],
    ['GET', '/prices', MO], ['GET', '/prices/effective', STAFF], ['PUT', '/prices', MO, {}],
    ['PUT', `/prices/branch/${DUMMY}`, MO, {}], ['DELETE', `/prices/branch/${DUMMY}/${DUMMY}`, O] /* managers: own branch only, and the made-up branch isn't theirs */,
    ['POST', '/prices/bulk', MO, {}], ['GET', '/prices/history', MO], ['POST', '/prices/resolve', STAFF, {}],
    // shifts
    ['GET', '/shifts/current', STAFF], ['POST', `/shifts/${DUMMY}/request-close`, STAFF], ['POST', `/shifts/${DUMMY}/reopen`, STAFF],
    ['POST', `/shifts/${DUMMY}/close`, MO, {}], ['GET', '/shifts', MO], ['GET', `/shifts/${DUMMY}`, MO],
    // wallet, points, settings
    ['GET', '/wallet/me', STAFF], ['GET', '/wallet', MO], ['GET', `/wallet/${DUMMY}/ledger`, MO],
    ['POST', `/wallet/${DUMMY}/cash-handover`, MO, { amount_ugx: 1 }], ['POST', `/wallet/${DUMMY}/adjust`, O, { amount_ugx: 1, reason: 'xxx' }],
    ['GET', '/worker-points/me', STAFF], ['GET', '/worker-points/leaderboard', STAFF], ['POST', '/worker-points/redeem', STAFF, {}],
    ['POST', `/worker-points/${DUMMY}/adjust`, MO, {}], ['GET', '/worker-points/config', MO], ['PUT', '/worker-points/config', O, {}],
    ['GET', '/settings/client-points', MO], ['PUT', '/settings/client-points', O, {}],
    ['GET', '/settings/worker-points', MO], ['PUT', '/settings/worker-points', O, {}],
    ['GET', '/settings/dispatch', MO], ['PUT', '/settings/dispatch', O, {}], ['POST', '/settings/client-points/adjust', O, {}],
    // clients, loyalty, audit
    ['GET', '/clients/lookup?phone=0700200099', STAFF], ['GET', '/clients', O], ['POST', '/clients', STAFF, {}],
    ['POST', `/clients/${DUMMY}/loyalty/adjust`, O, {}], ['GET', '/loyalty-config', O], ['PUT', '/loyalty-config', O, {}],
    ['GET', '/audit-logs', O],
    // reports
    ...['daily', 'workers', 'car-type-mix', 'cash-variance', 'handovers', 'unverified', 'cancellations', 'durations',
        'stale', 'exceptions', 'trend', 'cash-position'].map((r) => ['GET', `/reports/${r}`, MO]),
    ['GET', '/reports/branches', O], ['GET', '/reports/price-changes', O], ['GET', '/reports/loyalty', O],
    ['GET', '/reports/platform/stats', P],
    // platform (system admin)
    ['GET', '/platform/orgs', P], ['POST', '/platform/orgs', P, {}], ['GET', `/platform/orgs/${DUMMY}`, P],
    ['PATCH', `/platform/orgs/${DUMMY}`, P, {}], ['POST', `/platform/orgs/${DUMMY}/suspend`, P, {}],
    ['POST', `/platform/orgs/${DUMMY}/activate`, P], ['POST', `/platform/orgs/${DUMMY}/admins`, P, {}],
    ['GET', '/platform/admins', P], ['POST', '/platform/admins', P, {}], ['GET', '/platform/plans', P],
    ['POST', '/platform/plans', P, {}], ['PATCH', `/platform/plans/${DUMMY}`, P, {}],
    ['PUT', `/platform/orgs/${DUMMY}/subscription`, P, {}], ['POST', `/platform/orgs/${DUMMY}/payments`, P, {}],
    ['GET', '/platform/billing/summary', P],
    // issues — every signed-in user
    ['POST', '/issues', AUTH, {}], ['GET', '/issues', AUTH], ['PATCH', `/issues/${DUMMY}`, ['orgadmin', 'other', 'sysadmin'], {}],
  ];

  const problems = [];
  const errors = [];
  let checks = 0;
  for (const [method, path, allowed, body] of routes) {
    for (const role of ROLES) {
      const r = await call(method, path, body, T[role]);
      checks++;
      const blocked = r.status === 401 || r.status === 403;
      const shouldAllow = allowed.includes(role);
      if (r.status >= 500) errors.push(`${role.padEnd(8)} ${method} ${path} → ${r.status} ${r.code || ''}`);
      else if (shouldAllow && blocked) problems.push(`BLOCKED but should be allowed: ${role} ${method} ${path} → ${r.status} ${r.code || ''}`);
      else if (!shouldAllow && !blocked) problems.push(`ALLOWED but should be blocked: ${role} ${method} ${path} → ${r.status} ${r.code || ''}`);
    }
  }

  // ── Cross-organisation and cross-branch: real ids, must never succeed ──
  const leaks = [];
  const cross = [
    ['other', 'GET', `/staff/${joseph.id}`], ['other', 'GET', `/branches/${ntd.id}`], ['other', 'GET', `/washes/${wash.id}`],
    ['other', 'GET', `/shifts/${shift.id}`], ['other', 'GET', `/wallet/${joseph.id}/ledger`],
    ['other', 'POST', `/staff/${joseph.id}/suspend`], ['other', 'PATCH', `/branches/${ntd.id}`, { name: 'HACKED' }],
    ['other', 'POST', `/washes/${wash.id}/reverse`, { reason: 'cross-org probe' }],
    ['other', 'POST', `/worker-points/${joseph.id}/adjust`, { points: 1, reason: 'cross-org probe' }],
    ['other', 'POST', `/clients/${client.id}/loyalty/adjust`, { wash_delta: 1, credit_delta: 0, reason: 'cross-org probe' }],
    ['manager', 'GET', `/staff/${kblWorker.id}`], ['manager', 'GET', `/branches/${kbl.id}`],
    ['manager', 'POST', `/staff/${kblWorker.id}/suspend`],
    ['manager', 'GET', `/wallet/${kblWorker.id}/ledger`],
    ['manager', 'POST', `/worker-points/${kblWorker.id}/adjust`, { points: 1, reason: 'cross-branch probe' }],
    ['worker', 'GET', `/washes/${kblWash.id}`],
  ];
  for (const [role, method, path, body] of cross) {
    const r = await call(method, path, body, T[role]);
    checks++;
    const ok = r.status === 401 || r.status === 403 || r.status === 404;
    const leakedData = method === 'GET' && r.status === 200 && JSON.stringify(r.body?.data || '').length > 30;
    if (!ok) leaks.push(`${role} ${method} ${path} → ${r.status} ${r.code || ''}${leakedData ? '  (returned data)' : ''}`);
  }

  console.log(`\n${checks} checks over ${routes.length} endpoints × ${ROLES.length} identities + ${cross.length} cross-tenant probes\n`);
  console.log(`Role problems: ${problems.length}`); problems.forEach((p) => console.log('  ' + p));
  console.log(`\nServer errors (500): ${errors.length}`); errors.forEach((p) => console.log('  ' + p));
  console.log(`\nCross-organisation / cross-branch: ${leaks.length} not refused`); leaks.forEach((p) => console.log('  ' + p));
  await db.end();
  const failed = problems.length + errors.length + leaks.length;
  console.log(`
=== V2 PERMISSIONS: ${checks - failed} passed, ${failed} failed ===`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
