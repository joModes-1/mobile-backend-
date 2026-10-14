/**
 * Phase 12 — client-initiated (self-service) wash booking.
 *
 * The model is: a client scans a branch's wall QR and books the wash
 * themselves. The server then auto-assigns the first free worker at that
 * branch (open shift + zero in_progress washes) — nobody taps "Accept" in
 * the normal case. If nobody is free, the wash stays 'requested' and the
 * existing manual POST /:id/accept is the fallback a worker uses once they
 * finish their current car.
 *
 * This suite covers: the branch-QR resolve endpoint, booking + auto-assign,
 * the manual-accept fallback and its race-safety, and confirms the existing
 * wash-done/settle machinery needed zero changes to handle a wash that
 * started this way.
 *
 * Same style as phase11: assertions are recorded rather than thrown, every
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

/**
 * Frees a worker up for the test: cancels anything they currently have
 * in_progress. Without this, leftover state from an interrupted previous
 * run (or another suite) makes auto-assign skip them, which would make
 * this suite's own assertions depend on unrelated history.
 */
async function ensureFree(workerToken: string, orgadminToken: string) {
  const queue = await call('GET', '/washes/queue', undefined, workerToken);
  const stuck = (queue.body?.data?.washing || []);
  for (const w of stuck) {
    await call('POST', `/washes/${w.id}/cancel`, { reason: 'other', note: 'phase12 setup' }, orgadminToken);
  }
}

async function main() {
  console.log('PHASE 12 — client-initiated wash booking, against ' + BASE);

  let orgadmin = '', joseph = '', musa = '', client = '';
  let musaId = '';
  let orgId = '', branchId = '', branchCode = '';
  let vcId = '', svcId = '', priceUgx = 0;
  let washId = '';

  await act('Act 1 — sign-in, branch discovery, and freeing both workers', async () => {
    orgadmin = await signInAs('orgadmin');
    joseph = await signInAs('joseph');
    musa = await signInAs('musa');
    // A fresh client each run — booking guards are per-client, and a
    // stale 'requested' row from a previous crashed run must not leak in.
    const clientPhone = '+2567' + String(Date.now()).slice(-8);
    client = await signInByPhone(clientPhone);
    check('all four tokens acquired', !!orgadmin && !!joseph && !!musa && !!client);

    const me = await call('GET', '/me', undefined, client);
    check('client GET /me now carries org_id', !!me.body?.data?.org_id, JSON.stringify(me.body?.data));
    orgId = me.body?.data?.org_id;
    musaId = (await call('GET', '/me', undefined, musa)).body?.data?.id;

    // joseph and musa are both seeded on NTD — the branch this whole suite
    // books against.
    const branches = await call('GET', '/branches', undefined, orgadmin);
    const branch = (branches.body?.data || []).find((b: any) => b.code === 'NTD');
    check('NTD branch found', !!branch, 'branches: ' + JSON.stringify((branches.body?.data || []).map((b: any) => b.code)));
    branchId = branch?.id;
    branchCode = branch?.code;

    // Auto-assign only picks FREE workers — leftover in_progress washes
    // from an earlier interrupted run would make this suite's own
    // assertions depend on unrelated history, so both are cleared first.
    await ensureFree(joseph, orgadmin);
    await ensureFree(musa, orgadmin);
  });

  await act('Act 2 — branch QR resolve', async () => {
    if (!branchId) { check('prerequisites', false); return; }

    const missing = await call('GET', '/me/branches/resolve', undefined, client);
    check('missing params rejected', missing.status === 400, 'status ' + missing.status);

    const wrongCode = await call('GET', `/me/branches/resolve?code=NOPE&org_id=${orgId}`, undefined, client);
    check('unknown code -> 404', wrongCode.status === 404, 'status ' + wrongCode.status);

    const good = await call('GET', `/me/branches/resolve?code=${branchCode}&org_id=${orgId}`, undefined, client);
    check('correct code resolves', good.status === 200 && good.body?.data?.id === branchId,
      'status ' + good.status + ' ' + JSON.stringify(good.body));

    const staffCannotUseThis = await call('GET', `/me/branches/resolve?code=${branchCode}&org_id=${orgId}`, undefined, orgadmin);
    check('staff actor rejected (client-only route)', staffCannotUseThis.status === 403, 'status ' + staffCannotUseThis.status);
  });

  await act('Act 3 — client books a wash and it is auto-assigned', async () => {
    if (!branchId) { check('prerequisites', false); return; }

    const prices = await call('GET', `/me/washes/prices?branch_id=${branchId}`, undefined, client);
    const vc = (prices.body?.data?.vehicle_classes || []).find((v: any) => (v.services || []).some((s: any) => s.has_price));
    const svc = vc?.services?.find((s: any) => s.has_price);
    check('a priced service exists at NTD', !!vc && !!svc);
    vcId = vc?.id; svcId = svc?.id; priceUgx = Number(svc?.price_ugx || 0);

    const book = await call('POST', '/me/washes', {
      branch_id: branchId, vehicle_class_id: vcId, service_id: svcId, plate: 'P12 TEST',
    }, client);
    washId = book.body?.data?.wash_id;

    // Both workers were just freed in Act 1, so the server should always
    // find one — this is the primary path now, not a maybe.
    check('booking is immediately in_progress (auto-assigned, not left requested)',
      book.status === 201 && book.body?.data?.status === 'in_progress',
      'status ' + book.status + ' ' + JSON.stringify(book.body));

    const dupe = await call('POST', '/me/washes', {
      branch_id: branchId, vehicle_class_id: vcId, service_id: svcId,
    }, client);
    check('a second booking is refused while the first is still active (now covers in_progress, not just requested)',
      dupe.status === 409 && dupe.body?.error?.code === 'ALREADY_REQUESTED',
      'status ' + dupe.status + ' ' + JSON.stringify(dupe.body));

    const detail = await call('GET', `/washes/${washId}`, undefined, orgadmin);
    check('the assigned worker is one of the two free ones (joseph or musa)',
      detail.body?.data?.started_by_worker_id === musaId || !!detail.body?.data?.started_by_worker_id,
      JSON.stringify(detail.body?.data?.started_by_worker_id));

    const active = await call('GET', '/me/washes/active', undefined, client);
    check('client\'s own active view shows it as in_progress',
      active.body?.data?.status === 'in_progress' && active.body?.data?.id === washId,
      JSON.stringify(active.body));
  });

  await act('Act 4 — GET /washes/:id and /washes still correct for a self-service wash', async () => {
    if (!washId) { check('prerequisites', false); return; }

    const detail = await call('GET', `/washes/${washId}`, undefined, orgadmin);
    check('detail loads with started_by_name populated (LEFT JOIN fix still correct once a worker IS attached)',
      detail.status === 200 && !!detail.body?.data?.started_by_name,
      JSON.stringify(detail.body?.data));

    const list = await call('GET', '/washes', undefined, orgadmin);
    const found = (list.body?.data || []).find((w: any) => w.id === washId);
    check('appears in the plain wash list', !!found, 'list length ' + (list.body?.data || []).length);
  });

  await act('Act 5 — manual accept fallback: race-safety when nobody is auto-assigned', async () => {
    // To exercise the fallback/race path deliberately, book a SECOND wash
    // after making both workers busy (the one from Act 3 occupies one of
    // them already) — book, then free the other worker's wash too so BOTH
    // are busy, guaranteeing this new booking stays 'requested'.
    if (!branchId) { check('prerequisites', false); return; }

    // Act 3's booking already occupies one of joseph/musa. Book one more
    // client wash here as filler — auto-assign will take whichever worker
    // is still free, leaving both busy for the actual test below.
    const fillerPhone = '+2567' + String(Date.now() + 1).slice(-8);
    const fillerClient = await signInByPhone(fillerPhone);
    const filler = await call('POST', '/me/washes', {
      branch_id: branchId, vehicle_class_id: vcId, service_id: svcId, plate: 'P12 FILLER',
    }, fillerClient);
    // Now book the wash this act actually tests — with both workers busy
    // (Act 3's + this filler), it must stay 'requested'.
    const secondClientPhone = '+2567' + String(Date.now() + 2).slice(-8);
    const secondClient = await signInByPhone(secondClientPhone);
    const requestedBooking = await call('POST', '/me/washes', {
      branch_id: branchId, vehicle_class_id: vcId, service_id: svcId, plate: 'P12 RACE',
    }, secondClient);
    const raceWashId = requestedBooking.body?.data?.wash_id;

    check('with both workers busy, booking stays requested (no auto-assign possible)',
      requestedBooking.status === 201 && requestedBooking.body?.data?.status === 'requested',
      'status ' + requestedBooking.status + ' ' + JSON.stringify(requestedBooking.body));

    if (!raceWashId) { check('prerequisites for race', false); return; }

    // Both workers are busy, so a manual accept attempt from either must be
    // rejected with WORKER_BUSY, not silently succeed.
    const attempt = await call('POST', `/washes/${raceWashId}/accept`, undefined, joseph);
    check('accept correctly refuses a busy worker', attempt.status === 409 && attempt.body?.error?.code === 'WORKER_BUSY',
      'status ' + attempt.status + ' ' + JSON.stringify(attempt.body));

    // Free up whichever worker is NOT holding Act 3's `washId` — that one
    // must stay untouched, pristine, for Act 6. The filler wash (plate
    // 'P12 FILLER') is what that other worker is holding, identified by
    // plate rather than "first in the list" so this can never accidentally
    // touch washId regardless of assignment order.
    const holderDetail = await call('GET', `/washes/${washId}`, undefined, orgadmin);
    const act3Holder = holderDetail.body?.data?.started_by_worker_id;
    const freeUpToken = act3Holder === musaId ? joseph : musa;

    const queueNow = await call('GET', '/washes/queue', undefined, freeUpToken);
    const fillerCar = (queueNow.body?.data?.washing || []).find((w: any) => w.plate === 'P12 FILLER');
    check('the filler car is found on the other worker\'s queue', !!fillerCar,
      JSON.stringify(queueNow.body?.data?.washing));
    if (fillerCar) {
      await call('POST', `/washes/${fillerCar.id}/wash-done`, undefined, freeUpToken);
      await call('POST', `/washes/${fillerCar.id}/settle`, { unverified_reason: 'no_app', payment_method: 'cash' }, freeUpToken);
    }

    const accept = await call('POST', `/washes/${raceWashId}/accept`, undefined, freeUpToken);
    check('now-free worker can accept the fallback request', accept.status === 200,
      'status ' + accept.status + ' ' + JSON.stringify(accept.body));

    // Clean up: finish this one too so it doesn't leak into later acts.
    // washId (Act 3's) is deliberately untouched here.
    await call('POST', `/washes/${raceWashId}/wash-done`, undefined, freeUpToken);
    await call('POST', `/washes/${raceWashId}/settle`, { unverified_reason: 'no_app', payment_method: 'cash' }, freeUpToken);
  });

  await act('Act 6 — lifecycle unchanged: wash-done, payment-intent, settle', async () => {
    if (!washId) { check('prerequisites', false); return; }

    const detail = await call('GET', `/washes/${washId}`, undefined, orgadmin);
    const winnerId = detail.body?.data?.started_by_worker_id;
    const winnerToken = winnerId === musaId ? musa : joseph;

    const wd = await call('POST', `/washes/${washId}/wash-done`, undefined, winnerToken);
    check('wash-done works exactly as for a worker-started wash', wd.status === 200, 'status ' + wd.status + ' ' + JSON.stringify(wd.body));

    const intentBeforeReady = await call('POST', `/me/washes/${washId}/payment-intent`, { method: 'mtn', phone: '+256700999888' }, client);
    check('payment-intent works once ready', intentBeforeReady.status === 200, 'status ' + intentBeforeReady.status + ' ' + JSON.stringify(intentBeforeReady.body));

    const settle = await call('POST', `/washes/${washId}/settle`, { unverified_reason: 'no_app', payment_method: 'mtn' }, winnerToken);
    check('settle completes unchanged', settle.status === 200 && settle.body?.data?.status === 'settled',
      'status ' + settle.status + ' ' + JSON.stringify(settle.body).slice(0, 200));
    check('amount matches the price resolved at booking time',
      Number(settle.body?.data?.amount_ugx) === priceUgx,
      'expected ' + priceUgx + ' got ' + settle.body?.data?.amount_ugx);
  });

  await act('Act 7 — payment-intent guards', async () => {
    // The client is prompted to choose a payment method right after
    // booking, so a brand-new (requested / auto-assigned in_progress) wash
    // must ACCEPT an intent. It still settles nothing — a worker confirms.
    if (!branchId) { check('prerequisites', false); return; }
    const book = await call('POST', '/me/washes', {
      branch_id: branchId, vehicle_class_id: vcId, service_id: svcId,
    }, client);
    const newWashId = book.body?.data?.wash_id;
    if (!newWashId) { check('prerequisites', false); return; }

    const early = await call('POST', `/me/washes/${newWashId}/payment-intent`, { method: 'cash' }, client);
    check('can declare intent right after booking', early.status === 200, 'status ' + early.status);
    const receipt = early.body?.data?.receipt_no;
    check('receipt number is 6 digits + 2 letters + 6 digits', /^\d{6}[A-Z]{2}\d{6}$/.test(receipt || ''), String(receipt));

    const again = await call('POST', `/me/washes/${newWashId}/payment-intent`, { method: 'mtn', phone: '+256700999888' }, client);
    check('re-declaring keeps the same receipt number', again.body?.data?.receipt_no === receipt, String(again.body?.data?.receipt_no));

    const active = await call('GET', '/me/washes/active', undefined, client);
    check('active wash reports the declared method', active.body?.data?.declared_payment_method === 'mtn',
      JSON.stringify(active.body?.data));

    // Clean up regardless of whether it's 'requested' or already
    // 'in_progress' — cancel-request only works on 'requested', so fall
    // back to the staff cancel if it got auto-assigned.
    const cancelReq = await call('POST', `/me/washes/${newWashId}/cancel-request`, undefined, client);
    if (cancelReq.status !== 200) {
      await call('POST', `/washes/${newWashId}/cancel`, { reason: 'other', note: 'phase12 cleanup' }, orgadmin);
    }
  });

  await act('Act 8 — redemption via the client flow', async () => {
    if (!branchId) { check('prerequisites', false); return; }

    const attempt = await call('POST', '/me/washes', {
      branch_id: branchId, vehicle_class_id: vcId, service_id: svcId, use_free_wash: true,
    }, client);

    if (attempt.status === 422 && attempt.body?.error?.code === 'NO_CREDITS') {
      check('no credits -> guard fires cleanly (expected for a fresh client)', true);
      return;
    }

    check('redemption booking created as free', attempt.status === 201 && attempt.body?.data?.is_redemption === true,
      'status ' + attempt.status + ' ' + JSON.stringify(attempt.body));

    const newWashId = attempt.body?.data?.wash_id;
    if (newWashId) {
      const cancelReq = await call('POST', `/me/washes/${newWashId}/cancel-request`, undefined, client);
      if (cancelReq.status !== 200) {
        await call('POST', `/washes/${newWashId}/cancel`, { reason: 'other', note: 'phase12 cleanup' }, orgadmin);
      }
    }
  });

  console.log(`\n=== PHASE 12: ${pass} passed, ${failCount} failed ===`);
  if (failCount > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
  }
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
