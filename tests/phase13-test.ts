/**
 * Phase 13 — "wash 2 cars for the price of 1" promo.
 *
 * The model (owner's call, Oct 2026): one booking, two cars, at one branch
 * (POST /me/washes/promo). The dearer car is charged at its own price and
 * the other is free; on a tie the first car is charged. Each car is its own
 * wash with its own job number. The offer is taken the moment the pair is
 * booked — one per client — and the free car settles at 0 WITHOUT
 * consuming any loyalty free_wash_credit or stamping an extra wash. Points
 * don't combine with the offer.
 *
 * A client is no longer limited to one car on the go, so a normal booking
 * alongside the pair must go through.
 *
 * Cancelling either car of a pair before the free car is washed hands the
 * offer back, and the other car carries on as an ordinary booking at its
 * own price — so a paid car cancelled turns its free partner into a paid
 * one.
 *
 * Same style as phase12: assertions are recorded rather than thrown, every
 * act is wrapped so one failure does not hide the rest, and re-running the
 * suite should pass twice in a row (each run uses fresh client numbers).
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

/** A client number nobody has used — the offer is one-time per client. */
let phoneSeq = 0;
const freshPhone = () => '+2567' + String(Date.now() + 10 + phoneSeq++).slice(-8);

async function main() {
  console.log('PHASE 13 — two-for-one promo, against ' + BASE);

  let orgadmin = '', joseph = '', musa = '', client = '';
  let josephId = '', musaId = '';
  let branchId = '';
  // Two priced cars at different prices, so "the dearer one is charged" is
  // actually tested rather than satisfied by a tie.
  let cheap: { vehicle_class_id: string; service_id: string; price: number } | null = null;
  let dear: { vehicle_class_id: string; service_id: string; price: number } | null = null;
  let pair: any = null;

  /** Token of whichever worker actually started a wash (handover rule). */
  const workerTokenFor = async (id: string) => {
    const detail = await call('GET', `/washes/${id}`, undefined, orgadmin);
    const starter = detail.body?.data?.started_by_worker_id;
    if (starter === musaId) return musa;
    if (starter === josephId) return joseph;
    return musa;
  };

  /** Accept with whichever worker the fewest-jobs rule allows. */
  const acceptAny = async (id: string) => {
    const a = await call('POST', `/washes/${id}/accept`, undefined, musa);
    if (a.status === 200) return a;
    return call('POST', `/washes/${id}/accept`, undefined, joseph);
  };

  const bookPair = (token: string, cars: any[]) =>
    call('POST', '/me/washes/promo', { branch_id: branchId, cars }, token);

  await act('Act 1 — sign-in and discovery', async () => {
    orgadmin = await signInAs('orgadmin');
    joseph = await signInAs('joseph');
    musa = await signInAs('musa');
    josephId = (await call('GET', '/me', undefined, joseph)).body?.data?.id;
    musaId = (await call('GET', '/me', undefined, musa)).body?.data?.id;
    client = await signInByPhone(freshPhone());
    check('tokens acquired', !!orgadmin && !!musa && !!joseph && !!client);

    const branches = await call('GET', '/branches', undefined, orgadmin);
    const branch = (branches.body?.data || []).find((b: any) => b.code === 'NTD');
    check('NTD branch found', !!branch);
    branchId = branch?.id;

    const prices = await call('GET', `/me/washes/prices?branch_id=${branchId}`, undefined, client);
    const options: { vehicle_class_id: string; service_id: string; price: number }[] = [];
    for (const vc of prices.body?.data?.vehicle_classes || []) {
      for (const s of vc.services || []) {
        if (s.has_price) options.push({ vehicle_class_id: vc.id, service_id: s.id, price: Number(s.price_ugx) });
      }
    }
    options.sort((a, b) => a.price - b.price);
    cheap = options[0] || null;
    dear = options.find((o) => o.price > (cheap?.price ?? 0)) || null;
    check('two priced cars at different prices exist at NTD', !!cheap && !!dear,
      JSON.stringify({ cheap, dear }));

    // Both workers freed: the suite drives whichever one takes each car.
    await ensureFree(joseph, orgadmin);
    await ensureFree(musa, orgadmin);
  });

  await act('Act 2 — before booking: the offer is available', async () => {
    const state = await call('GET', '/me/washes/promo', undefined, client);
    check('promo endpoint 200 for a client', state.status === 200, 'status ' + state.status);
    check('offer is available', state.body?.data?.available === true && state.body?.data?.used === false,
      JSON.stringify(state.body));
  });

  await act('Act 3 — one booking, two cars: the dearer is charged, the other free', async () => {
    if (!cheap || !dear) { check('prerequisites', false); return; }
    // The cheap car listed FIRST, so picking the charged car by price — not
    // by position — is what is being tested.
    const book = await bookPair(client, [
      { vehicle_class_id: cheap.vehicle_class_id, service_id: cheap.service_id, plate: 'P13 CHEAP' },
      { vehicle_class_id: dear.vehicle_class_id, service_id: dear.service_id, plate: 'P13 DEAR' },
    ]);
    pair = book.body?.data;
    check('pair booking succeeds', book.status === 201, 'status ' + book.status + ' ' + JSON.stringify(book.body).slice(0, 300));
    check('two washes, in the order listed', pair?.washes?.length === 2
      && pair.washes[0].plate === 'P13 CHEAP' && pair.washes[1].plate === 'P13 DEAR', JSON.stringify(pair?.washes));
    check('each car has its own job number', !!pair?.washes?.[0]?.job_no && pair.washes[0].job_no !== pair.washes[1].job_no);
    check('the dearer car is the charged one', pair?.paid_wash_id === pair?.washes?.[1]?.wash_id, JSON.stringify(pair));
    check('the cheaper car is free', pair?.washes?.[0]?.is_redemption === true && pair.washes[0].amount_due_ugx === 0,
      JSON.stringify(pair?.washes?.[0]));
    check('the client owes the dearer price only', Number(pair?.amount_due_ugx) === dear.price,
      `owes ${pair?.amount_due_ugx}, dear ${dear.price}`);

    const state = await call('GET', '/me/washes/promo', undefined, client);
    check('the offer is taken the moment it is booked',
      state.body?.data?.used === true && state.body?.data?.available === false, JSON.stringify(state.body));

    const active = await call('GET', '/me/washes/active-list', undefined, client);
    const ids = (active.body?.data || []).map((w: any) => w.id);
    check('both cars are on the client\'s active list',
      ids.includes(pair?.washes?.[0]?.wash_id) && ids.includes(pair?.washes?.[1]?.wash_id), JSON.stringify(ids));
    const freeRow = (active.body?.data || []).find((w: any) => w.id === pair?.free_wash_id);
    check('the free car shows nothing to pay, marked as the offer\'s',
      Number(freeRow?.amount_due_ugx) === 0 && freeRow?.promo_key === 'wash2_price1', JSON.stringify(freeRow));
  });

  await act('Act 4 — the offer cannot be taken twice', async () => {
    if (!cheap || !dear) { check('prerequisites', false); return; }
    const again = await bookPair(client, [
      { vehicle_class_id: cheap.vehicle_class_id, service_id: cheap.service_id },
      { vehicle_class_id: dear.vehicle_class_id, service_id: dear.service_id },
    ]);
    check('second offer booking refused with PROMO_CONFLICT',
      again.status === 409 && again.body?.error?.code === 'PROMO_CONFLICT',
      'status ' + again.status + ' ' + JSON.stringify(again.body));

    const one = await call('POST', '/me/washes/promo', { branch_id: branchId, cars: [{ vehicle_class_id: cheap.vehicle_class_id }] }, client);
    check('an offer booking needs exactly two cars', one.status === 400, 'status ' + one.status);
  });

  await act('Act 5 — another car can be booked while these are on the go', async () => {
    if (!cheap) { check('prerequisites', false); return; }
    const extra = await call('POST', '/me/washes', {
      branch_id: branchId, vehicle_class_id: cheap.vehicle_class_id, service_id: cheap.service_id, plate: 'P13 EXTRA',
    }, client);
    check('a normal booking alongside the pair goes through', extra.status === 201,
      'status ' + extra.status + ' ' + JSON.stringify(extra.body).slice(0, 200));
    check('it is an ordinary paid booking', extra.body?.data?.is_redemption === false, JSON.stringify(extra.body?.data));

    // Out of the way of the rest of the suite.
    const cancel = await call('POST', `/me/washes/${extra.body?.data?.wash_id}/cancel-request`, undefined, client);
    check('and the client can cancel it while it waits', cancel.status === 200, JSON.stringify(cancel.body).slice(0, 200));
  });

  await act('Act 6 — both cars washed: the charged one paid, the free one at 0', async () => {
    if (!pair || !dear) { check('prerequisites', false); return; }
    const loyaltyBefore = await call('GET', '/me/washes/loyalty', undefined, client);
    const creditsBefore = Number(loyaltyBefore.body?.data?.free_wash_credits || 0);
    const washCountBefore = Number(loyaltyBefore.body?.data?.wash_count || 0);

    for (const w of pair.washes) {
      const acc = await acceptAny(w.wash_id);
      check(`car ${w.plate} accepted by a worker`, acc.status === 200, JSON.stringify(acc.body).slice(0, 200));
    }

    const pointsBefore = Number((await call('GET', '/me/washes/points', undefined, client)).body?.data?.balance || 0);

    const paidStarter = await workerTokenFor(pair.paid_wash_id);
    await call('POST', `/washes/${pair.paid_wash_id}/wash-done`, undefined, paidStarter);
    const paidSettle = await call('POST', `/washes/${pair.paid_wash_id}/settle`,
      { payment_method: 'cash', unverified_reason: 'no_app' }, paidStarter);
    check('the charged car settles at its full price',
      paidSettle.status === 200 && Number(paidSettle.body?.data?.amount_ugx) === dear.price,
      'status ' + paidSettle.status + ' amount ' + paidSettle.body?.data?.amount_ugx);

    const pointsAfterPaid = Number((await call('GET', '/me/washes/points', undefined, client)).body?.data?.balance || 0);
    check('the charged car earns its points as usual',
      pointsAfterPaid - pointsBefore === Number(pair.client_points_to_award),
      `before ${pointsBefore} after ${pointsAfterPaid} expected +${pair.client_points_to_award}`);

    const freeStarter = await workerTokenFor(pair.free_wash_id);
    await call('POST', `/washes/${pair.free_wash_id}/wash-done`, undefined, freeStarter);
    const freeSettle = await call('POST', `/washes/${pair.free_wash_id}/settle`, { unverified_reason: 'no_app' }, freeStarter);
    check('the free car settles at 0', freeSettle.status === 200 && Number(freeSettle.body?.data?.amount_ugx) === 0,
      'status ' + freeSettle.status + ' ' + JSON.stringify(freeSettle.body).slice(0, 200));

    const pointsAfterFree = Number((await call('GET', '/me/washes/points', undefined, client)).body?.data?.balance || 0);
    check('the free car earns no points', pointsAfterFree === pointsAfterPaid, `${pointsAfterPaid} → ${pointsAfterFree}`);

    // The free car is the offer, not a loyalty credit.
    const loyaltyAfter = await call('GET', '/me/washes/loyalty', undefined, client);
    check('no free_wash_credit was consumed by the offer',
      Number(loyaltyAfter.body?.data?.free_wash_credits || 0) === creditsBefore,
      `before ${creditsBefore} after ${loyaltyAfter.body?.data?.free_wash_credits}`);
    check('no extra loyalty stamp for the free car',
      Number(loyaltyAfter.body?.data?.wash_count || 0) === washCountBefore,
      `before ${washCountBefore} after ${loyaltyAfter.body?.data?.wash_count}`);

    const state = await call('GET', '/me/washes/promo', undefined, client);
    check('the offer stays used, now fully redeemed',
      state.body?.data?.used === true && state.body?.data?.status === 'used', JSON.stringify(state.body));
  });

  await act('Act 7 — the charged car cancelled: its partner pays, the offer comes back', async () => {
    if (!cheap || !dear) { check('prerequisites', false); return; }
    const fresh = await signInByPhone(freshPhone());
    const book = await bookPair(fresh, [
      { vehicle_class_id: cheap.vehicle_class_id, service_id: cheap.service_id, plate: 'P13 C7A' },
      { vehicle_class_id: dear.vehicle_class_id, service_id: dear.service_id, plate: 'P13 C7B' },
    ]);
    const p = book.body?.data;
    check('pair booked', book.status === 201, JSON.stringify(book.body).slice(0, 200));

    const cancel = await call('POST', `/me/washes/${p?.paid_wash_id}/cancel-request`, undefined, fresh);
    check('charged car cancelled', cancel.status === 200, JSON.stringify(cancel.body).slice(0, 200));

    const active = await call('GET', '/me/washes/active-list', undefined, fresh);
    const left = (active.body?.data || []).find((w: any) => w.id === p?.free_wash_id);
    check('the other car carries on, now at its own price',
      !!left && left.is_redemption === false && Number(left.amount_due_ugx) === cheap.price && left.promo_key === null,
      JSON.stringify(left));

    const state = await call('GET', '/me/washes/promo', undefined, fresh);
    check('the offer is available again', state.body?.data?.available === true, JSON.stringify(state.body));

    await call('POST', `/me/washes/${p?.free_wash_id}/cancel-request`, undefined, fresh);
  });

  await act('Act 8 — the free car cancelled: the charged car carries on, the offer comes back', async () => {
    if (!cheap || !dear) { check('prerequisites', false); return; }
    const fresh = await signInByPhone(freshPhone());
    const book = await bookPair(fresh, [
      { vehicle_class_id: dear.vehicle_class_id, service_id: dear.service_id, plate: 'P13 C8A' },
      { vehicle_class_id: cheap.vehicle_class_id, service_id: cheap.service_id, plate: 'P13 C8B' },
    ]);
    const p = book.body?.data;
    check('pair booked (dearer listed first this time)',
      book.status === 201 && p?.paid_wash_id === p?.washes?.[0]?.wash_id, JSON.stringify(book.body).slice(0, 300));

    // Through the staff route this time — the same unwinding applies.
    const cancel = await call('POST', `/washes/${p?.free_wash_id}/cancel`, { reason: 'other', note: 'phase13 free car' }, orgadmin);
    check('free car cancelled by staff', cancel.status === 200, JSON.stringify(cancel.body).slice(0, 200));

    const active = await call('GET', '/me/washes/active-list', undefined, fresh);
    const left = (active.body?.data || []).find((w: any) => w.id === p?.paid_wash_id);
    check('the charged car carries on at its price',
      !!left && left.is_redemption === false && Number(left.amount_due_ugx) === dear.price, JSON.stringify(left));

    const state = await call('GET', '/me/washes/promo', undefined, fresh);
    check('the offer is available again', state.body?.data?.available === true, JSON.stringify(state.body));

    await call('POST', `/me/washes/${p?.paid_wash_id}/cancel-request`, undefined, fresh);
  });

  console.log(`\n══════ PHASE 13: ${pass} passed, ${failCount} failed ══════`);
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
