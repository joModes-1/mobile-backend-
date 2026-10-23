/**
 * V2 Phase 1 — client points (replaces the stamp card).
 *
 * Proves, through the HTTP API only:
 *   - settings: who can read/write, validation, per-wash-type points;
 *   - earning: frozen at booking, awarded at settlement, not when switched off;
 *   - spending: partial cover (client pays the rest), full cover (nothing owed,
 *     payment_method 'points', no new points earned);
 *   - refunds: client cancel and staff cancel give the points back;
 *   - reversal: refunds what was spent, takes back what was earned;
 *   - concurrency: two simultaneous bookings cannot spend the same points;
 *   - tenancy: one organisation's adjustment never touches another's balance;
 *   - integrity: the ledger always sums to the balance.
 *
 * Re-runnable: fresh clients every run, and the org's points settings are
 * captured first and restored at the end.
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
  try { await fn(); }
  catch (e: any) { failCount++; failures.push(name + ' threw: ' + e.message); console.log('  ✗ ACT THREW: ' + e.message); }
}

async function call(method: string, path: string, body?: any, token?: string) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let parsed: any = null;
  try { parsed = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: parsed };
}

let phoneSeq = 0;
function freshPhone() {
  phoneSeq++;
  return '+2567' + String(Date.now() + phoneSeq * 7919).slice(-8);
}

const POINT_VALUE = 100;   // UGX per point during this suite
const EARN = 50;           // points the test wash type awards

async function main() {
  console.log('V2 PHASE 1 — client points, against ' + BASE);

  let orgadmin = '', grace = '', joseph = '', musa = '', shineadmin = '';
  let josephId = '', musaId = '';
  let branchId = '', vcId = '', svcId = '', price = 0;
  let original: any = null;

  const tokenFor = (workerId: string) => (workerId === josephId ? joseph : workerId === musaId ? musa : '');

  /** Cancels anything a worker has in progress, so the next booking can be assigned to them. */
  async function freeWorker(token: string) {
    const q = await call('GET', '/washes/queue', undefined, token);
    for (const w of q.body?.data?.washing || []) {
      await call('POST', `/washes/${w.id}/cancel`, { reason: 'other', note: 'v2-phase1 setup' }, orgadmin);
    }
  }

  async function book(clientToken: string, extra: Record<string, unknown> = {}) {
    return call('POST', '/me/washes', { branch_id: branchId, vehicle_class_id: vcId, service_id: svcId, ...extra }, clientToken);
  }

  /** Takes a booked wash through accept (if needed) → wash-done → cash settle. */
  async function runToSettled(washId: string) {
    let detail = await call('GET', `/washes/${washId}`, undefined, orgadmin);
    if (detail.body?.data?.status === 'requested') {
      await freeWorker(joseph);
      await call('POST', `/washes/${washId}/accept`, undefined, joseph);
      detail = await call('GET', `/washes/${washId}`, undefined, orgadmin);
    }
    const token = tokenFor(detail.body?.data?.started_by_worker_id);
    if (!token) throw new Error('wash assigned to a worker this suite cannot sign in as: ' + detail.body?.data?.started_by_worker_id);
    await call('POST', `/washes/${washId}/wash-done`, undefined, token);
    return call('POST', `/washes/${washId}/settle`, { unverified_reason: 'no_app', payment_method: 'cash' }, token);
  }

  async function points(clientToken: string) {
    return (await call('GET', '/me/washes/points', undefined, clientToken)).body?.data;
  }

  async function clientId(clientToken: string) {
    return (await call('GET', '/me', undefined, clientToken)).body?.data?.id;
  }

  async function setBalance(clientToken: string, target: number) {
    const now = (await points(clientToken))?.balance ?? 0;
    if (now === target) return;
    await call('POST', '/settings/client-points/adjust', {
      client_id: await clientId(clientToken), points: target - now, reason: 'v2-phase1 fixture',
    }, orgadmin);
  }

  await act('Act 1 — sign-in, branch and wash type, workers ready', async () => {
    orgadmin = await signInAs('orgadmin');
    grace = await signInAs('grace');
    joseph = await signInAs('joseph');
    musa = await signInAs('musa');
    shineadmin = await signInAs('shineadmin');
    josephId = (await call('GET', '/me', undefined, joseph)).body?.data?.id;
    musaId = (await call('GET', '/me', undefined, musa)).body?.data?.id;
    check('staff tokens acquired', !!orgadmin && !!grace && !!joseph && !!musa && !!shineadmin);

    const branches = await call('GET', '/branches', undefined, orgadmin);
    branchId = (branches.body?.data || []).find((b: any) => b.code === 'NTD')?.id;
    check('NTD branch found', !!branchId);

    // Both workers need an open shift to be assigned work (409 = already open).
    for (const t of [joseph, musa]) {
      const open = await call('POST', '/shifts/open', {}, t);
      check('worker shift open', open.status === 201 || open.body?.error?.code === 'SHIFT_ALREADY_OPEN',
        'status ' + open.status + ' ' + JSON.stringify(open.body));
      await freeWorker(t);
    }

    const probe = await signInByPhone(freshPhone());
    const prices = await call('GET', `/me/washes/prices?branch_id=${branchId}`, undefined, probe);
    // A wash type that costs well over 10,000 so partial cover is meaningful.
    for (const vc of prices.body?.data?.vehicle_classes || []) {
      const svc = (vc.services || []).find((s: any) => s.has_price && s.price_ugx >= 10000);
      if (svc) { vcId = vc.id; svcId = svc.id; price = Number(svc.price_ugx); break; }
    }
    check('a priced wash type ≥ 10,000 UGX exists at NTD', !!svcId && price >= 10000, 'price ' + price);
  });

  await act('Act 2 — settings: access, validation, saving', async () => {
    const got = await call('GET', '/settings/client-points', undefined, orgadmin);
    check('org admin reads settings', got.status === 200 && Array.isArray(got.body?.data?.services), 'status ' + got.status);
    original = got.body?.data;

    check('manager can read settings', (await call('GET', '/settings/client-points', undefined, grace)).status === 200);
    check('worker cannot read settings', (await call('GET', '/settings/client-points', undefined, joseph)).status === 403);
    check('manager cannot change settings',
      (await call('PUT', '/settings/client-points', { point_value_ugx: 1 }, grace)).status === 403);

    const zeroEarn = await call('PUT', '/settings/client-points', {
      services: [{ id: svcId, earns_point: true, client_points_awarded: 0 }],
    }, orgadmin);
    check('earning 0 points is rejected', zeroEarn.status === 400, 'status ' + zeroEarn.status);

    const negative = await call('PUT', '/settings/client-points', { point_value_ugx: -5 }, orgadmin);
    check('negative point value is rejected', negative.status === 400, 'status ' + negative.status);

    const saved = await call('PUT', '/settings/client-points', {
      enabled: true, point_value_ugx: POINT_VALUE,
      services: [{ id: svcId, earns_point: true, client_points_awarded: EARN }],
    }, orgadmin);
    const row = (saved.body?.data?.services || []).find((s: any) => s.id === svcId);
    check('settings saved', saved.status === 200 && saved.body?.data?.point_value_ugx === POINT_VALUE
      && row?.client_points_awarded === EARN, JSON.stringify(saved.body).slice(0, 300));

    const probe = await signInByPhone(freshPhone());
    const prices = await call('GET', `/me/washes/prices?branch_id=${branchId}`, undefined, probe);
    const shown = (prices.body?.data?.vehicle_classes || []).find((v: any) => v.id === vcId)
      ?.services?.find((s: any) => s.id === svcId);
    check('booking screen shows "earns N points"', shown?.client_points_awarded === EARN, JSON.stringify(shown));
  });

  await act('Act 3 — earning: frozen at booking, awarded at settlement', async () => {
    const c = await signInByPhone(freshPhone());
    const start = await points(c);
    check('new client starts at 0 points', start?.balance === 0 && start?.point_value_ugx === POINT_VALUE, JSON.stringify(start));

    const b = await book(c);
    check('booking freezes the points to award and owes the full price',
      b.status === 201 && b.body?.data?.client_points_to_award === EARN && b.body?.data?.amount_due_ugx === price,
      JSON.stringify(b.body));

    const s = await runToSettled(b.body?.data?.wash_id);
    check('settle reports the points earned', s.status === 200 && s.body?.data?.client_points?.earned === EARN,
      JSON.stringify(s.body).slice(0, 300));
    check('cash settle charges the full price', s.body?.data?.amount_ugx === price && s.body?.data?.payment_method === 'cash');

    const after = await points(c);
    check('balance and worth updated', after?.balance === EARN && after?.worth_ugx === EARN * POINT_VALUE, JSON.stringify(after));

    const ledger = await call('GET', '/me/washes/points/ledger', undefined, c);
    check('ledger shows one earn row', (ledger.body?.data || []).filter((r: any) => r.entry_type === 'earn').length === 1);
  });

  await act('Act 4 — switching earning off affects new bookings only', async () => {
    const c = await signInByPhone(freshPhone());
    const b1 = await book(c);
    // Turned off AFTER booking: the frozen number still applies.
    await call('PUT', '/settings/client-points', { services: [{ id: svcId, earns_point: false, client_points_awarded: EARN }] }, orgadmin);
    const s1 = await runToSettled(b1.body?.data?.wash_id);
    check('wash booked while earning was on still earns', s1.body?.data?.client_points?.earned === EARN, JSON.stringify(s1.body?.data?.client_points));

    const b2 = await book(c);
    check('booking while off freezes 0 points', b2.body?.data?.client_points_to_award === 0, JSON.stringify(b2.body?.data));
    const s2 = await runToSettled(b2.body?.data?.wash_id);
    check('wash booked while off earns nothing', s2.status === 200 && s2.body?.data?.client_points === null, JSON.stringify(s2.body?.data?.client_points));
    check('balance only reflects the first wash', (await points(c))?.balance === EARN);

    await call('PUT', '/settings/client-points', { services: [{ id: svcId, earns_point: true, client_points_awarded: EARN }] }, orgadmin);
  });

  await act('Act 5 — partial cover: points pay part, client pays the rest', async () => {
    const c = await signInByPhone(freshPhone());
    const have = Math.floor(price / (2 * POINT_VALUE));   // worth about half the price
    await setBalance(c, have);
    check('fixture balance set', (await points(c))?.balance === have);

    const b = await book(c, { use_points: true });
    const due = price - have * POINT_VALUE;
    check('all points used, the rest is owed',
      b.status === 201 && b.body?.data?.points_used === have && b.body?.data?.points_value_ugx === have * POINT_VALUE
        && b.body?.data?.amount_due_ugx === due, JSON.stringify(b.body));
    check('points are deducted at booking', (await points(c))?.balance === 0);

    const active = await call('GET', '/me/washes/active', undefined, c);
    check('active wash shows the amount due', Number(active.body?.data?.amount_due_ugx) === due, JSON.stringify(active.body?.data));

    const s = await runToSettled(b.body?.data?.wash_id);
    check('settlement takes only the remainder in cash', s.body?.data?.amount_ugx === due && s.body?.data?.payment_method === 'cash',
      JSON.stringify(s.body?.data).slice(0, 300));
    check('a partly points-paid wash still earns', s.body?.data?.client_points?.earned === EARN);
    check('balance is the new earn only', (await points(c))?.balance === EARN);
  });

  await act('Act 6 — full cover: nothing owed, no new points', async () => {
    const c = await signInByPhone(freshPhone());
    const needed = Math.ceil(price / POINT_VALUE);
    await setBalance(c, needed + 7);

    const b = await book(c, { use_points: true });
    check('only the points needed are spent', b.body?.data?.points_used === needed && b.body?.data?.amount_due_ugx === 0,
      JSON.stringify(b.body?.data));
    check('the spare points stay', (await points(c))?.balance === 7);

    const s = await runToSettled(b.body?.data?.wash_id);
    check('settled as a points payment of 0 UGX',
      s.status === 200 && s.body?.data?.amount_ugx === 0 && s.body?.data?.payment_method === 'points',
      JSON.stringify(s.body?.data).slice(0, 300));
    check('a fully points-paid wash earns nothing', s.body?.data?.client_points === null);
    check('balance unchanged by settlement', (await points(c))?.balance === 7);
  });

  await act('Act 7 — client cancels a waiting booking: points come back', async () => {
    // Occupy both workers so the booking stays unassigned and cancellable.
    const fillers: string[] = [];
    for (let i = 0; i < 2; i++) {
      const f = await signInByPhone(freshPhone());
      const fb = await book(f);
      if (fb.body?.data?.wash_id) fillers.push(fb.body.data.wash_id);
    }
    const c = await signInByPhone(freshPhone());
    await setBalance(c, 30);
    const b = await book(c, { use_points: true });
    check('booking waits for a worker', b.body?.data?.status === 'requested', JSON.stringify(b.body?.data));
    check('points deducted while waiting', (await points(c))?.balance === 0);

    const cancel = await call('POST', `/me/washes/${b.body?.data?.wash_id}/cancel-request`, undefined, c);
    check('client cancel refunds the points', cancel.status === 200 && cancel.body?.data?.points_refunded === 30, JSON.stringify(cancel.body));
    check('balance restored', (await points(c))?.balance === 30);

    const again = await call('POST', `/me/washes/${b.body?.data?.wash_id}/cancel-request`, undefined, c);
    check('cancelling twice cannot refund twice', again.status === 409 && (await points(c))?.balance === 30);

    for (const id of fillers) await call('POST', `/washes/${id}/cancel`, { reason: 'other', note: 'v2-phase1 cleanup' }, orgadmin);
  });

  await act('Act 8 — staff cancels a wash in progress: points come back', async () => {
    await freeWorker(joseph);
    const c = await signInByPhone(freshPhone());
    await setBalance(c, 40);
    const b = await book(c, { use_points: true });
    const cancel = await call('POST', `/washes/${b.body?.data?.wash_id}/cancel`, { reason: 'client_left' }, orgadmin);
    check('staff cancel refunds the points', cancel.status === 200 && cancel.body?.data?.points_refunded === 40, JSON.stringify(cancel.body));
    check('balance restored', (await points(c))?.balance === 40);
  });

  await act('Act 9 — reversal refunds what was spent and takes back what was earned', async () => {
    const c = await signInByPhone(freshPhone());
    await setBalance(c, 20);
    const b = await book(c, { use_points: true });
    const s = await runToSettled(b.body?.data?.wash_id);
    check('settled with partial points and earned', s.body?.data?.client_points?.earned === EARN);
    check('balance before reversal = earn only', (await points(c))?.balance === EARN);

    const rev = await call('POST', `/washes/${b.body?.data?.wash_id}/reverse`, { reason: 'v2-phase1 reversal test' }, orgadmin);
    check('reverse succeeds', rev.status === 200, JSON.stringify(rev.body).slice(0, 300));
    check('reversal reports refund and take-back',
      rev.body?.data?.client_points?.refunded === 20 && rev.body?.data?.client_points?.takenBack === EARN,
      JSON.stringify(rev.body?.data?.client_points));
    check('balance back to the original 20', (await points(c))?.balance === 20);
  });

  await act('Act 10 — two simultaneous bookings cannot spend the same points', async () => {
    await freeWorker(joseph);
    await freeWorker(musa);
    const c = await signInByPhone(freshPhone());
    await setBalance(c, 60);
    const [a, b] = await Promise.all([book(c, { use_points: true }), book(c, { use_points: true })]);
    const ok = [a, b].filter((r) => r.status === 201);
    check('exactly one booking succeeds', ok.length === 1, `statuses ${a.status} ${b.status} ${JSON.stringify([a.body, b.body]).slice(0, 300)}`);
    check('points spent exactly once', ok[0]?.body?.data?.points_used === 60 && (await points(c))?.balance === 0);
    if (ok[0]) await call('POST', `/washes/${ok[0].body.data.wash_id}/cancel`, { reason: 'other', note: 'cleanup' }, orgadmin);
    check('cleanup refund', (await points(c))?.balance === 60);
  });

  await act('Act 11 — one organisation cannot touch another\'s points', async () => {
    const c = await signInByPhone(freshPhone());
    await setBalance(c, 15);
    const shine = await call('POST', '/settings/client-points/adjust', {
      client_id: await clientId(c), points: 999, reason: 'other org grant',
    }, shineadmin);
    check('Shine Motors can grant in its own scheme', shine.status === 200 && shine.body?.data?.balance === 999,
      JSON.stringify(shine.body));
    check('the Demo balance is untouched', (await points(c))?.balance === 15);

    const shineSettings = await call('GET', '/settings/client-points', undefined, shineadmin);
    const leaked = (shineSettings.body?.data?.services || []).some((s: any) => s.id === svcId);
    check('Shine settings do not list Demo wash types', shineSettings.status === 200 && !leaked);
    const cross = await call('PUT', '/settings/client-points', {
      services: [{ id: svcId, earns_point: true, client_points_awarded: 1 }],
    }, shineadmin);
    check('Shine cannot edit a Demo wash type', cross.status === 404, 'status ' + cross.status);
  });

  await act('Act 12 — the ledger always sums to the balance', async () => {
    const c = await signInByPhone(freshPhone());
    await setBalance(c, 25);
    const b = await book(c, { use_points: true });
    await runToSettled(b.body?.data?.wash_id);
    const ledger = (await call('GET', '/me/washes/points/ledger', undefined, c)).body?.data || [];
    const sum = ledger.reduce((t: number, r: any) => t + Number(r.points_delta), 0);
    const bal = (await points(c))?.balance;
    check('sum of ledger = balance', sum === bal, `sum ${sum} balance ${bal}`);
    check('newest ledger row carries the balance after it', ledger[0]?.balance_after === bal);
  });

  await act('Act 13 — restore settings', async () => {
    if (!original) { check('original settings captured', false); return; }
    const orig = original.services.find((s: any) => s.id === svcId);
    const r = await call('PUT', '/settings/client-points', {
      enabled: original.enabled, point_value_ugx: original.point_value_ugx,
      // "Earns, but 0 points" (a type created before points existed) can't
      // be saved back as-is; switched off it behaves identically.
      services: orig ? [{
        id: svcId,
        earns_point: orig.earns_point && orig.client_points_awarded > 0,
        client_points_awarded: orig.client_points_awarded,
      }] : [],
    }, orgadmin);
    check('settings restored', r.status === 200, JSON.stringify(r.body).slice(0, 200));
  });

  console.log(`\n=== V2 PHASE 1: ${pass} passed, ${failCount} failed ===`);
  if (failCount > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
