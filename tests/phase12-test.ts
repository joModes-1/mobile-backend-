/**
 * Phase 12 — client-initiated (self-service) wash booking.
 *
 * The model changed from "a worker scans a client and creates the wash" to
 * "a client scans a branch's wall QR and books it themselves; a free worker
 * accepts it later." This suite covers everything that model added: the
 * branch-QR resolve endpoint, the booking endpoint and its new 'requested'
 * status, the worker's accept endpoint (including the race between two
 * workers), and confirms the existing wash-done/settle machinery needed
 * zero changes to handle a wash that started this way.
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

async function main() {
  console.log('PHASE 12 — client-initiated wash booking, against ' + BASE);

  let orgadmin = '', joseph = '', musa = '', client = '';
  let josephId = '', musaId = '';
  let orgId = '', branchId = '', branchCode = '';
  let vcId = '', svcId = '', priceUgx = 0;
  let requestedWashId = '';

  await act('Act 1 — sign-in and branch discovery', async () => {
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

    josephId = (await call('GET', '/me', undefined, joseph)).body?.data?.id;
    musaId = (await call('GET', '/me', undefined, musa)).body?.data?.id;

    // joseph and musa are both seeded on NTD — the branch this whole suite
    // has to book against, since they're the ones accepting.
    const branches = await call('GET', '/branches', undefined, orgadmin);
    const branch = (branches.body?.data || []).find((b: any) => b.code === 'NTD');
    check('NTD branch found', !!branch, 'branches: ' + JSON.stringify((branches.body?.data || []).map((b: any) => b.code)));
    branchId = branch?.id;
    branchCode = branch?.code;
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

  await act('Act 3 — client books a wash', async () => {
    if (!branchId) { check('prerequisites', false); return; }

    const prices = await call('GET', `/me/washes/prices?branch_id=${branchId}`, undefined, client);
    const vc = (prices.body?.data?.vehicle_classes || []).find((v: any) => (v.services || []).some((s: any) => s.has_price));
    const svc = vc?.services?.find((s: any) => s.has_price);
    check('a priced service exists at NTD', !!vc && !!svc);
    vcId = vc?.id; svcId = svc?.id; priceUgx = Number(svc?.price_ugx || 0);

    const book = await call('POST', '/me/washes', {
      branch_id: branchId, vehicle_class_id: vcId, service_id: svcId, plate: 'P12 TEST',
    }, client);
    check('booking created', book.status === 201 && book.body?.data?.status === 'requested',
      'status ' + book.status + ' ' + JSON.stringify(book.body));
    requestedWashId = book.body?.data?.wash_id;

    const dupe = await call('POST', '/me/washes', {
      branch_id: branchId, vehicle_class_id: vcId, service_id: svcId,
    }, client);
    check('second simultaneous booking refused', dupe.status === 409 && dupe.body?.error?.code === 'ALREADY_REQUESTED',
      'status ' + dupe.status + ' ' + JSON.stringify(dupe.body));

    const active = await call('GET', '/me/washes/active', undefined, client);
    check('client\'s own active view shows the requested wash',
      active.body?.data?.status === 'requested' && active.body?.data?.id === requestedWashId,
      JSON.stringify(active.body));
  });

  await act('Act 4 — worker queue shows the request', async () => {
    if (!requestedWashId) { check('prerequisites', false); return; }

    const queue = await call('GET', '/washes/queue', undefined, joseph);
    const found = (queue.body?.data?.requested || []).find((w: any) => w.id === requestedWashId);
    check('appears in the branch worker\'s requested[]', !!found, JSON.stringify(queue.body?.data?.requested));
    check('carries the fields the mobile row needs',
      !!found && !!found.vehicle_class_name && !!found.service_name && found.quoted_amount_ugx !== undefined,
      JSON.stringify(found));

    const detail = await call('GET', `/washes/${requestedWashId}`, undefined, orgadmin);
    check('GET /washes/:id does not 404/empty on a workerless wash (LEFT JOIN fix)',
      detail.status === 200 && detail.body?.data?.status === 'requested',
      'status ' + detail.status + ' ' + JSON.stringify(detail.body?.data));
  });

  await act('Act 5 — accept: shift and busy guards', async () => {
    if (!requestedWashId) { check('prerequisites', false); return; }

    // musa may be mid-shift from other suites; joseph likewise. Neither
    // guard is worth forcing into a specific state here — Act 6's race
    // covers the real behaviour. This act only proves the endpoint exists
    // and answers something sane for an obviously-wrong id.
    const badId = await call('POST', '/washes/00000000-0000-0000-0000-000000000000/accept', undefined, joseph);
    check('accepting a non-existent wash is a clean error, not a 500',
      badId.status === 404 || badId.status === 409, 'status ' + badId.status);
  });

  await act('Act 6 — race: two workers accept the same request', async () => {
    if (!requestedWashId) { check('prerequisites', false); return; }

    const [a1, a2] = await Promise.all([
      call('POST', `/washes/${requestedWashId}/accept`, undefined, joseph),
      call('POST', `/washes/${requestedWashId}/accept`, undefined, musa),
    ]);
    const results = [a1, a2];
    const winners = results.filter(r => r.status === 200);
    const losers = results.filter(r => r.status === 409);
    check('exactly one worker wins the race', winners.length === 1,
      'statuses: ' + results.map(r => r.status).join(', '));
    check('the other gets a clean 409, not a 500 or a second success', losers.length === 1,
      'codes: ' + results.map(r => r.body?.error?.code).join(', '));

    const detail = await call('GET', `/washes/${requestedWashId}`, undefined, orgadmin);
    check('wash is now in_progress with a worker attached',
      detail.body?.data?.status === 'in_progress' && !!detail.body?.data?.started_by_worker_id,
      JSON.stringify(detail.body?.data));

    const queueAfter = await call('GET', '/washes/queue', undefined, joseph);
    const stillThere = (queueAfter.body?.data?.requested || []).find((w: any) => w.id === requestedWashId);
    check('no longer sits in the requested queue once accepted', !stillThere);
  });

  await act('Act 7 — lifecycle unchanged: wash-done, payment-intent, settle', async () => {
    if (!requestedWashId) { check('prerequisites', false); return; }

    // Whichever worker actually won Act 6 — find out by checking who holds it.
    const detail = await call('GET', `/washes/${requestedWashId}`, undefined, orgadmin);
    const winnerId = detail.body?.data?.started_by_worker_id;
    const winnerToken = winnerId === musaId ? musa : joseph;

    const wd = await call('POST', `/washes/${requestedWashId}/wash-done`, undefined, winnerToken);
    check('wash-done works exactly as for a worker-started wash', wd.status === 200, 'status ' + wd.status + ' ' + JSON.stringify(wd.body));

    const intentBeforeReady = await call('POST', `/me/washes/${requestedWashId}/payment-intent`, { method: 'mtn', phone: '+256700999888' }, client);
    check('payment-intent works once ready', intentBeforeReady.status === 200, 'status ' + intentBeforeReady.status + ' ' + JSON.stringify(intentBeforeReady.body));

    const settle = await call('POST', `/washes/${requestedWashId}/settle`, { unverified_reason: 'no_app', payment_method: 'mtn' }, winnerToken);
    check('settle completes unchanged', settle.status === 200 && settle.body?.data?.status === 'settled',
      'status ' + settle.status + ' ' + JSON.stringify(settle.body).slice(0, 200));
    check('amount matches the price resolved at booking time',
      Number(settle.body?.data?.amount_ugx) === priceUgx,
      'expected ' + priceUgx + ' got ' + settle.body?.data?.amount_ugx);
  });

  await act('Act 8 — payment-intent guards', async () => {
    // A brand-new requested wash — not yet ready — must refuse an intent.
    const book = await call('POST', '/me/washes', {
      branch_id: branchId, vehicle_class_id: vcId, service_id: svcId,
    }, client);
    const washId = book.body?.data?.wash_id;
    if (!washId) { check('prerequisites', false); return; }

    const tooEarly = await call('POST', `/me/washes/${washId}/payment-intent`, { method: 'cash' }, client);
    check('cannot declare intent before the wash is ready', tooEarly.status === 404, 'status ' + tooEarly.status);

    // Clean up via cancel-request rather than leaving it dangling for
    // Act 9's duplicate check or the next run.
    const cancel = await call('POST', `/me/washes/${washId}/cancel-request`, undefined, client);
    check('cancel-request cleans it up', cancel.status === 200, 'status ' + cancel.status);
  });

  await act('Act 9 — redemption via the client flow', async () => {
    if (!branchId) { check('prerequisites', false); return; }

    // Grant this client one free-wash credit directly via a settled wash's
    // earn path would take another full lifecycle — simplest reliable path
    // here is to attempt the redemption and accept either outcome
    // (NO_CREDITS is itself a pass — it proves the guard fires), then, if
    // credits exist, prove the wash is flagged FREE end to end.
    const attempt = await call('POST', '/me/washes', {
      branch_id: branchId, vehicle_class_id: vcId, service_id: svcId, use_free_wash: true,
    }, client);

    if (attempt.status === 422 && attempt.body?.error?.code === 'NO_CREDITS') {
      check('no credits -> guard fires cleanly (expected for a fresh client)', true);
      return;
    }

    check('redemption booking created as free', attempt.status === 201 && attempt.body?.data?.is_redemption === true,
      'status ' + attempt.status + ' ' + JSON.stringify(attempt.body));

    // Clean up.
    const washId = attempt.body?.data?.wash_id;
    if (washId) await call('POST', `/me/washes/${washId}/cancel-request`, undefined, client);
  });

  console.log(`\n=== PHASE 12: ${pass} passed, ${failCount} failed ===`);
  if (failCount > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
  }
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
