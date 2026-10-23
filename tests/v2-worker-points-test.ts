/**
 * V2 — worker points from Settings, per wash type.
 *
 * Proves:
 *   - settings access and validation (org admin writes, manager reads);
 *   - a wash freezes its wash type's worker points at booking;
 *   - changing Settings affects new bookings only;
 *   - the washer earns exactly the frozen number, and the balance's worth
 *     follows the Settings point value;
 *   - switching the scheme off stops new awards;
 *   - two shift-opens at the same moment never produce a server error.
 *
 * Restores every setting it changes.
 */

import { signInAs, signInByPhone } from './helpers/auth';

const BASE = process.env.TEST_BASE || 'http://localhost:3456/api/v1';
let pass = 0;
let failCount = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { failCount++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
async function act(name: string, fn: () => Promise<void>) {
  console.log('\n── ' + name + ' ──');
  try { await fn(); } catch (e: any) { failCount++; failures.push(name + ' threw: ' + e.message); console.log('  ✗ ACT THREW: ' + e.message); }
}
async function call(method: string, p: string, body?: any, token?: string) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let parsed: any = null;
  try { parsed = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: parsed };
}
let seq = 0;
const freshPhone = () => '+2567' + String(Date.now() + ++seq * 3571).slice(-8);

async function main() {
  console.log('V2 — worker points from Settings, against ' + BASE);
  let orgadmin = '', grace = '', joseph = '';
  let branchId = '', vcId = '', svcId = '';
  let original: any = null;

  async function workerPoints() {
    return (await call('GET', '/worker-points/me', undefined, joseph)).body?.data;
  }
  async function bookAndAccept() {
    const c = await signInByPhone(freshPhone());
    const b = await call('POST', '/me/washes', { branch_id: branchId, vehicle_class_id: vcId, service_id: svcId }, c);
    const id = b.body?.data?.wash_id;
    const q = await call('GET', '/washes/queue', undefined, joseph);
    for (const w of q.body?.data?.washing || []) if (w.id !== id) await call('POST', `/washes/${w.id}/cancel`, { reason: 'other' }, orgadmin);
    await call('POST', `/washes/${id}/accept`, undefined, joseph);
    return id as string;
  }
  async function finish(id: string) {
    await call('POST', `/washes/${id}/wash-done`, undefined, joseph);
    return call('POST', `/washes/${id}/settle`, { unverified_reason: 'no_app', payment_method: 'cash' }, joseph);
  }

  await act('Act 1 — setup', async () => {
    orgadmin = await signInAs('orgadmin');
    grace = await signInAs('grace');
    joseph = await signInAs('joseph');
    branchId = ((await call('GET', '/branches', undefined, orgadmin)).body?.data || []).find((b: any) => b.code === 'NTD')?.id;
    await call('POST', '/shifts/open', {}, joseph);
    const probe = await signInByPhone(freshPhone());
    const prices = await call('GET', `/me/washes/prices?branch_id=${branchId}`, undefined, probe);
    for (const vc of prices.body?.data?.vehicle_classes || []) {
      const s = (vc.services || []).find((x: any) => x.has_price);
      if (s) { vcId = vc.id; svcId = s.id; break; }
    }
    check('NTD and a priced wash type found', !!branchId && !!svcId);
  });

  await act('Act 2 — settings access and validation', async () => {
    const got = await call('GET', '/settings/worker-points', undefined, orgadmin);
    original = got.body?.data;
    check('org admin reads worker-points settings',
      got.status === 200 && typeof original?.point_value_ugx === 'number' && Array.isArray(original?.services));
    check('every wash type lists its worker points', original.services.every((s: any) => typeof s.worker_points_awarded === 'number'));
    check('manager can read', (await call('GET', '/settings/worker-points', undefined, grace)).status === 200);
    check('worker cannot read', (await call('GET', '/settings/worker-points', undefined, joseph)).status === 403);
    check('manager cannot change', (await call('PUT', '/settings/worker-points', { point_value_ugx: 1 }, grace)).status === 403);
    check('negative points rejected',
      (await call('PUT', '/settings/worker-points', { services: [{ id: svcId, worker_points_awarded: -1 }] }, orgadmin)).status === 400);
    const set = await call('PUT', '/settings/worker-points', {
      enabled: true, point_value_ugx: 250, services: [{ id: svcId, worker_points_awarded: 40 }],
    }, orgadmin);
    check('saved', set.status === 200 && set.body?.data?.point_value_ugx === 250
      && set.body.data.services.find((s: any) => s.id === svcId)?.worker_points_awarded === 40, JSON.stringify(set.body).slice(0, 200));
  });

  await act('Act 3 — frozen at booking, earned by the washer, worth from Settings', async () => {
    const id = await bookAndAccept();
    const q = await call('GET', '/washes/queue', undefined, joseph);
    const row = (q.body?.data?.washing || []).find((w: any) => w.id === id);
    check('the worker\'s queue shows the points this car earns', row?.worker_points_to_award === 40, JSON.stringify(row?.worker_points_to_award));

    // Change Settings AFTER booking: the frozen 40 still applies.
    await call('PUT', '/settings/worker-points', { services: [{ id: svcId, worker_points_awarded: 70 }] }, orgadmin);
    const before = await workerPoints();
    const s = await finish(id);
    check('earned exactly the number frozen at booking', s.body?.data?.worker_points?.earned === 40, JSON.stringify(s.body?.data?.worker_points));
    const after = await workerPoints();
    check('balance rose by 40', Number(after.points_balance) - Number(before.points_balance) === 40);
    check('worth = balance × Settings point value', Number(after.value_ugx) === Number(after.points_balance) * 250,
      `${after.value_ugx} vs ${after.points_balance}×250`);

    const id2 = await bookAndAccept();
    const s2 = await finish(id2);
    check('a booking made after the change earns the new number', s2.body?.data?.worker_points?.earned === 70,
      JSON.stringify(s2.body?.data?.worker_points));
  });

  await act('Act 4 — scheme switched off: no new points', async () => {
    await call('PUT', '/settings/worker-points', { enabled: false }, orgadmin);
    const id = await bookAndAccept();
    const s = await finish(id);
    check('settles with no worker points', s.status === 200 && s.body?.data?.worker_points === null, JSON.stringify(s.body?.data?.worker_points));
    await call('PUT', '/settings/worker-points', { enabled: true }, orgadmin);
  });

  await act('Act 5 — two shift-opens at once never give a server error', async () => {
    // A brand-new worker with no shift, opening twice at the same moment.
    const uname = 'wp' + String(Date.now()).slice(-6);
    const phone = '+25677' + String(Date.now()).slice(-7);
    const created = await call('POST', '/staff', { full_name: 'WP Test ' + uname, username: uname, phone, role: 'worker', branch_id: branchId }, grace);
    const t = await signInByPhone(phone);
    const [a, b] = await Promise.all([call('POST', '/shifts/open', {}, t), call('POST', '/shifts/open', {}, t)]);
    const statuses = [a.status, b.status].sort();
    check('one opens it, the other is told it is already open', statuses[0] === 201 && statuses[1] === 409
      && [a, b].some((r) => r.body?.error?.code === 'SHIFT_ALREADY_OPEN'), `${a.status} ${b.status}`);
    // Tidy: close the shift and suspend the test worker.
    const shiftId = (a.status === 201 ? a : b).body?.data?.id;
    await call('POST', `/shifts/${shiftId}/request-close`, {}, t);
    await call('POST', `/shifts/${shiftId}/close`, { counted_cash_ugx: 0 }, grace);
    await call('POST', `/staff/${created.body?.data?.staff_id}/suspend`, {}, grace);
  });

  await act('Act 6 — restore', async () => {
    if (!original) return;
    const orig = original.services.find((s: any) => s.id === svcId);
    const r = await call('PUT', '/settings/worker-points', {
      enabled: original.enabled, point_value_ugx: original.point_value_ugx,
      services: orig ? [{ id: svcId, worker_points_awarded: orig.worker_points_awarded }] : [],
    }, orgadmin);
    check('settings restored', r.status === 200);
  });

  console.log(`\n=== V2 WORKER POINTS: ${pass} passed, ${failCount} failed ===`);
  if (failCount > 0) { console.log('\nFailures:'); failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
