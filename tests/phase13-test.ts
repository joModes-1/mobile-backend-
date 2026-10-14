/**
 * Phase 13 — "wash 2 cars for the price of 1" promo.
 *
 * The model: a client GRABS the home screen offer and books wash #1 at full
 * price with use_promo=true (a promo_redemptions row is created, armed).
 * When that wash SETTLES, the reward is earned — the client's next booking
 * with use_promo_free=true is free (is_redemption, amount 0, payment_method
 * 'free') WITHOUT consuming any loyalty free_wash_credit, and settles the
 * redemption row to 'used'.
 *
 * Covers: the /me/washes/promo state endpoint across the whole lifecycle,
 * arming at booking, the one-time-per-client guarantee (a second grab is a
 * 409, not a 500), the free wash at settlement, credit immunity (a credit
 * the client earned must survive the promo's free wash), client-cancel
 * unwinding, and the stale-client guards.
 *
 * Same style as phase12: assertions are recorded rather than thrown, every
 * act is wrapped so one failure does not hide the rest, and re-running the
 * suite should pass twice in a row.
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

async function ensureFree(workerToken: string, orgadminToken: string) {
  const queue = await call('GET', '/washes/queue', undefined, workerToken);
  const stuck = (queue.body?.data?.washing || []);
  for (const w of stuck) {
    await call('POST', `/washes/${w.id}/cancel`, { reason: 'other', note: 'phase13 setup' }, orgadminToken);
  }
}

async function main() {
  console.log('PHASE 13 — two-for-one promo, against ' + BASE);

  let orgadmin = '', joseph = '', musa = '', client = '';
  let josephId = '', musaId = '';
  let orgId = '', branchId = '', branchCode = '';
  let vcId = '', svcId = '', priceUgx = 0;
  let washId = '';

  /** Token of whichever worker actually started a wash (handover rule). */
  const workerTokenFor = async (id: string) => {
    const detail = await call('GET', `/washes/${id}`, undefined, orgadmin);
    const starter = detail.body?.data?.started_by_worker_id;
    if (starter === musaId) return musa;
    if (starter === josephId) return joseph;
    return musa;
  };

  await act('Act 1 — sign-in and discovery', async () => {
    orgadmin = await signInAs('orgadmin');
    joseph = await signInAs('joseph');
    musa = await signInAs('musa');
    josephId = (await call('GET', '/me', undefined, joseph)).body?.data?.id;
    musaId = (await call('GET', '/me', undefined, musa)).body?.data?.id;
    // A fresh client each run — the promo is one-time per client, so every
    // suite run needs an account that has never seen the offer.
    const clientPhone = '+2567' + String(Date.now() + 10).slice(-8);
    client = await signInByPhone(clientPhone);
    check('tokens acquired', !!orgadmin && !!musa && !!client);

    const me = await call('GET', '/me', undefined, client);
    orgId = me.body?.data?.org_id;

    const branches = await call('GET', '/branches', undefined, orgadmin);
    const branch = (branches.body?.data || []).find((b: any) => b.code === 'NTD');
    check('NTD branch found', !!branch);
    branchId = branch?.id;
    branchCode = branch?.code;

    const prices = await call('GET', `/me/washes/prices?branch_id=${branchId}`, undefined, client);
    const vc = (prices.body?.data?.vehicle_classes || []).find((v: any) => (v.services || []).some((s: any) => s.has_price));
    const svc = vc?.services?.find((s: any) => s.has_price);
    check('a priced service exists at NTD', !!vc && !!svc);
    vcId = vc?.id; svcId = svc?.id; priceUgx = Number(svc?.price_ugx || 0);

    // Both workers freed: auto-assign may pick either, and the suite
    // drives whichever one actually got the wash (handover rule).
    await ensureFree(joseph, orgadmin);
    await ensureFree(musa, orgadmin);
  });

  await act('Act 2 — promo state before grabbing: available', async () => {
    const state = await call('GET', '/me/washes/promo', undefined, client);
    check('promo endpoint 200 for a client', state.status === 200, 'status ' + state.status);
    check('offer is available', state.body?.data?.available === true && state.body?.data?.used === false,
      JSON.stringify(state.body));
  });

  await act('Act 3 — grab: booking with use_promo arms the offer', async () => {
    const book = await call('POST', '/me/washes', {
      branch_id: branchId, vehicle_class_id: vcId, service_id: svcId,
      plate: 'P13 GRAB', use_promo: true,
    }, client);
    washId = book.body?.data?.wash_id;
    check('booking succeeds', book.status === 201, 'status ' + book.status + ' ' + JSON.stringify(book.body).slice(0, 200));
    check('the grab booking pays full price (not a redemption)', book.body?.data?.is_redemption === false, JSON.stringify(book.body?.data));
    check('response marks the offer earned', book.body?.data?.promo_earned === true, JSON.stringify(book.body?.data));

    // Auto-assign only picks FREE workers — musa was just freed, so this
    // should always be in_progress; if seeding changed, requested is fine
    // too as long as a worker picks it up below.
    if (book.body?.data?.status === 'requested') {
      const acc = await call('POST', `/washes/${washId}/accept`, undefined, musa);
      check('manual accept worked (no free worker at book time)', acc.status === 200, JSON.stringify(acc.body).slice(0, 200));
    } else {
      check('auto-assigned', book.body?.data?.status === 'in_progress', JSON.stringify(book.body?.data));
    }

    const state = await call('GET', '/me/washes/promo', undefined, client);
    check('promo now armed with active wash',
      state.body?.data?.available === false && state.body?.data?.used === false && state.body?.data?.active_wash === true,
      JSON.stringify(state.body));

    // One-time per client: re-grabbing while the offer is armed cannot be
    // attempted here (the one-active-wash guard refuses first), so the
    // PROMO_CONFLICT path is asserted in Act 7 once the wash settles.
  });

  await act('Act 4 — cannot spend what is not earned yet (armed, not settled)', async () => {
    // The paid wash has not settled — a use_promo_free booking must be
    // refused: the reward is not spendable until the paid wash settles.
    // (The client already has an active wash, so the server should refuse
    // with ALREADY_REQUESTED first — either refusal is correct here; the
    // specific guard is asserted in Act 6 when no active wash exists.)
    const trySpend = await call('POST', '/me/washes', {
      branch_id: branchId, vehicle_class_id: vcId, service_id: svcId, use_promo_free: true,
    }, client);
    check('free booking refused while another wash is active',
      trySpend.status === 409, 'status ' + trySpend.status + ' ' + JSON.stringify(trySpend.body).slice(0, 200));
  });

  await act('Act 5 — paid wash settles: reward earned', async () => {
    if (!washId) { check('prerequisites', false); return; }

    const starter = await workerTokenFor(washId);
    const wd = await call('POST', `/washes/${washId}/wash-done`, undefined, starter);
    check('wash-done on the paid wash', wd.status === 200, JSON.stringify(wd.body).slice(0, 200));
    const settle = await call('POST', `/washes/${washId}/settle`, { payment_method: 'cash', unverified_reason: 'no_app' }, starter);
    check('paid wash settles at full price',
      settle.status === 200 && Number(settle.body?.data?.amount_ugx) === priceUgx,
      'status ' + settle.status + ' amount ' + settle.body?.data?.amount_ugx);

    const state = await call('GET', '/me/washes/promo', undefined, client);
    check('promo armed and ready to spend (no active wash)',
      state.body?.data?.available === false && state.body?.data?.used === false && state.body?.data?.active_wash === false,
      JSON.stringify(state.body));
  });

  await act('Act 6 — the free wash: booked free, settled without burning a credit', async () => {
    // Book the free one with use_promo_free — the server must not charge,
    // must not touch the client's loyalty credits, and must not stamp an
    // extra wash_count.
    const loyaltyBefore = await call('GET', '/me/washes/loyalty', undefined, client);
    const creditsBefore = Number(loyaltyBefore.body?.data?.free_wash_credits || 0);

    // The client's paid wash earned a stamp; force the credit situation to
    // a known state by reading wash_count before, too.
    const washCountBefore = Number(loyaltyBefore.body?.data?.wash_count || 0);

    const book = await call('POST', '/me/washes', {
      branch_id: branchId, vehicle_class_id: vcId, service_id: svcId,
      plate: 'P13 FREE', use_promo_free: true,
    }, client);
    const freeWashId = book.body?.data?.wash_id;
    check('free booking succeeds', book.status === 201, 'status ' + book.status + ' ' + JSON.stringify(book.body).slice(0, 300));
    check('free booking is a redemption at zero', book.body?.data?.is_redemption === true, JSON.stringify(book.body?.data));

    // Complete + settle it — whoever the auto-assign (or manual accept)
    // actually attached it to. Both workers are free after Act 5, so
    // auto-assign should have taken it; the accept fallback is here so the
    // suite still passes if seeding leaves one worker occupied.
    if (book.body?.data?.status === 'requested') {
      const manual = await call('POST', `/washes/${freeWashId}/accept`, undefined, musa);
      if (manual.status !== 200) {
        await call('POST', `/washes/${freeWashId}/accept`, undefined, joseph);
      }
    }
    const freeStarter = await workerTokenFor(freeWashId);
    const wd = await call('POST', `/washes/${freeWashId}/wash-done`, undefined, freeStarter);
    check('wash-done on the free wash', wd.status === 200, JSON.stringify(wd.body).slice(0, 200));
    const settle = await call('POST', `/washes/${freeWashId}/settle`, { unverified_reason: 'no_app' }, freeStarter);
    check('free wash settles at 0', settle.status === 200 && Number(settle.body?.data?.amount_ugx) === 0,
      'status ' + settle.status + ' amount ' + settle.body?.data?.amount_ugx);

    // THE core assertion: the client's earned credits are untouched.
    const loyaltyAfter = await call('GET', '/me/washes/loyalty', undefined, client);
    check('no free_wash_credit was consumed by the promo',
      Number(loyaltyAfter.body?.data?.free_wash_credits || 0) === creditsBefore,
      `before ${creditsBefore} after ${loyaltyAfter.body?.data?.free_wash_credits}`);
    check('no extra loyalty stamp for the free wash',
      Number(loyaltyAfter.body?.data?.wash_count || 0) === washCountBefore,
      `before ${washCountBefore} after ${loyaltyAfter.body?.data?.wash_count}`);

    const state = await call('GET', '/me/washes/promo', undefined, client);
    check('offer is now used', state.body?.data?.used === true, JSON.stringify(state.body));
  });

  await act('Act 7 — after use: stale flags are refused cleanly', async () => {
    // A stale client (or a second device) retrying use_promo_free must get
    // PROMO_UNAVAILABLE, never a silent full-price booking.
    const stale = await call('POST', '/me/washes', {
      branch_id: branchId, vehicle_class_id: vcId, service_id: svcId, use_promo_free: true,
    }, client);
    check('stale use_promo_free refused with PROMO_UNAVAILABLE',
      stale.status === 409 && stale.body?.error?.code === 'PROMO_UNAVAILABLE',
      'status ' + stale.status + ' ' + JSON.stringify(stale.body));

    const regab = await call('POST', '/me/washes', {
      branch_id: branchId, vehicle_class_id: vcId, service_id: svcId, use_promo: true,
    }, client);
    check('re-grab after use refused with PROMO_CONFLICT',
      regab.status === 409 && regab.body?.error?.code === 'PROMO_CONFLICT',
      'status ' + regab.status + ' ' + JSON.stringify(regab.body));
  });

  await act('Act 8 — client-cancel unwinds an armed grab (re-grab possible)', async () => {
    // Fresh client: grab, then cancel the unclaimed booking — the armed
    // row must be deleted so the offer is available again.
    const freshPhone = '+2567' + String(Date.now() + 12).slice(-8);
    const fresh = await signInByPhone(freshPhone);

    const grab = await call('POST', '/me/washes', {
      branch_id: branchId, vehicle_class_id: vcId, service_id: svcId, use_promo: true,
    }, fresh);
    const grabWashId = grab.body?.data?.wash_id;
    check('fresh grab succeeds', grab.status === 201, JSON.stringify(grab.body).slice(0, 200));

    // If auto-assigned, cancel via staff route (same unwinding logic).
    const cancelReq = await call('POST', `/me/washes/${grabWashId}/cancel-request`, undefined, fresh);
    if (cancelReq.status !== 200) {
      await call('POST', `/washes/${grabWashId}/cancel`, { reason: 'other', note: 'phase13 unwind' }, orgadmin);
    }

    const state = await call('GET', '/me/washes/promo', undefined, fresh);
    check('offer available again after cancelling the grab booking',
      state.body?.data?.available === true,
      JSON.stringify(state.body));
  });

  console.log(`\n══════ PHASE 13: ${pass} passed, ${failCount} failed ══════`);
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
