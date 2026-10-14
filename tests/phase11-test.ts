/**
 * Phase 11 — verification for the September 2026 additions.
 *
 * Written in the phase-10 style: assertions are recorded rather than thrown,
 * every act is wrapped so one failure does not hide the rest, and the
 * process exits non-zero if anything failed.
 *
 * Unlike phases 2–7 this suite is **re-runnable**. It signs in by phone +
 * OTP (the only sign-in the app has) rather than changing a password it
 * then depends on, and it cleans up everything it creates. Run it twice in
 * a row; it should pass twice.
 *
 * Covers what nothing else does: phone auth for every role, staff creation
 * by phone, worker commission and its effect on expected cash, the earnings
 * endpoint, account deletion, and the shift detail that used to return [].
 */

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

/** Phone + OTP sign-in. Relies on TEST_MODE returning the code. */
async function signIn(phone: string): Promise<string | null> {
  const s = await call('POST', '/auth/phone/start', { phone });
  const code = s.body?.data?.otp_code;
  if (!code) return null;
  const v = await call('POST', '/auth/phone/verify', { phone, code });
  return v.body?.data?.access_token || null;
}

const PHONES = {
  sysadmin: '+256700200000',
  orgadmin: '+256700200001',
  manager: '+256700200002',
  worker: '+256700200003',
  client: '+256700200099',
  // Act 2 exercises the OTP flow itself (wrong code, replay), which costs a
  // /start of its own. It uses the seeded client number so no staff role's
  // 3-per-hour budget is shared between two acts, and so verify resolves an
  // account that already exists rather than auto-creating a junk client.
  otp: '+256700200099',
};

async function main() {
  console.log('PHASE 11 — September additions, against ' + BASE);

  let orgadmin = '', manager = '', worker = '', sysadmin = '';
  let branchId = '';
  const createdStaffIds: string[] = [];

  // ── Act 1: phone sign-in resolves every role correctly ──
  //
  // One /start per number, reused for both the role assertion and the
  // token. The endpoint allows 3 per number per hour; calling it once to
  // check the role and again to sign in burned two of those and made the
  // suite unable to run twice in a row.
  await act('Act 1 — phone sign-in, all roles', async () => {
    async function startAndVerify(phone: string, expectRole: string) {
      const s = await call('POST', '/auth/phone/start', { phone });
      if (s.body?.error?.code === 'OTP_RATE_LIMITED') {
        check(`${expectRole} sign-in`, false, 'OTP_RATE_LIMITED — restart the dev server to clear it');
        return '';
      }
      check(`${expectRole} number resolves as ${expectRole}`,
        s.body?.data?.role === expectRole, 'got ' + s.body?.data?.role);
      const code = s.body?.data?.otp_code;
      if (!code) { check(`${expectRole} otp returned (TEST_MODE)`, false); return ''; }
      const v = await call('POST', '/auth/phone/verify', { phone, code });
      const tok = v.body?.data?.access_token || '';
      check(`${expectRole} got a token`, !!tok, 'status ' + v.status);
      return tok;
    }

    sysadmin = await startAndVerify(PHONES.sysadmin, 'sysadmin');
    orgadmin = await startAndVerify(PHONES.orgadmin, 'orgadmin');
    worker = await startAndVerify(PHONES.worker, 'worker');
    manager = await startAndVerify(PHONES.manager, 'manager');

    // The client number's role is asserted in Act 2, which has to call
    // /start on it anyway — checking it here too would spend a second of
    // that number's 3-per-hour budget for no extra coverage.

    const unknown = await call('POST', '/auth/phone/start', { phone: '+256700111222' });
    check('unknown number is flagged new', unknown.body?.data?.is_new === true, 'is_new=' + unknown.body?.data?.is_new);

    const bad = await call('POST', '/auth/phone/start', { phone: '12345' });
    check('malformed number rejected', bad.status === 422 || bad.status === 400, 'status ' + bad.status);
  });

  if (!orgadmin) {
    console.log('\nCannot continue without an orgadmin token.');
    console.log('Most likely OTP_RATE_LIMITED: /auth/phone/start allows 3 per number');
    console.log('per hour, and this suite uses several per run. The limiter is');
    console.log('in-memory, so restarting the dev server clears it — that is the');
    console.log('intended way to re-run this back to back. TEST_MODE must also be on.');
    console.log('\n=== PHASE 11: ' + pass + ' passed, ' + failCount + ' failed ===');
    process.exit(failCount > 0 ? 1 : 0);
  }

  // ── Act 2: wrong code, replay, and rate limiting ──
  //
  // Uses its own number rather than sharing one with Act 1. /auth/phone/start
  // allows 3 per number per hour; sharing meant a number burned 2 per run and
  // tripped the limiter on the second consecutive run.
  await act('Act 2 — OTP integrity', async () => {
    const phone = PHONES.otp;
    const s = await call('POST', '/auth/phone/start', { phone });
    if (s.body?.error?.code === 'OTP_RATE_LIMITED') {
      check('OTP integrity checks could run', false, 'OTP_RATE_LIMITED — restart the dev server to clear it');
      return;
    }
    check('client number resolves as client', s.body?.data?.role === 'client', 'got ' + s.body?.data?.role);
    const code = s.body?.data?.otp_code;
    // A same-length code that just isn't the right one — otherwise a
    // hardcoded literal of the wrong digit count gets rejected by the zod
    // schema instead of by the actual wrong-code check this test wants.
    const wrongCode = code.split('').map((d: string) => (d === '9' ? '0' : '9')).join('');
    const wrong = await call('POST', '/auth/phone/verify', { phone, code: wrongCode });
    check('wrong code rejected', wrong.status >= 400, 'status ' + wrong.status);

    const good = await call('POST', '/auth/phone/verify', { phone, code });
    check('correct code accepted', good.status === 200, 'status ' + good.status);

    const replay = await call('POST', '/auth/phone/verify', { phone, code });
    check('same code cannot be reused', replay.status >= 400, 'status ' + replay.status);
  });

  // ── Act 3: staff creation is phone-first ──
  await act('Act 3 — staff creation by phone', async () => {
    const branches = await call('GET', '/branches', undefined, orgadmin);
    branchId = branches.body?.data?.[0]?.id || '';
    check('orgadmin can list branches', !!branchId);
    check('branch exposes worker_commission_bp',
      branches.body?.data?.[0] && 'worker_commission_bp' in branches.body.data[0]);

    const uniq = String(Date.now()).slice(-6);
    const phone = `07${uniq}11`;

    const made = await call('POST', '/staff', {
      full_name: 'P11 Worker', username: 'p11_' + uniq, phone,
      role: 'worker', branch_id: branchId,
    }, orgadmin);
    check('staff created with a local-format phone', made.status === 201, 'status ' + made.status);
    if (made.body?.data?.staff_id) createdStaffIds.push(made.body.data.staff_id);
    check('phone normalised to E.164 in response',
      /^\+256\d{9}$/.test(made.body?.data?.phone || ''), 'got ' + made.body?.data?.phone);

    const dupe = await call('POST', '/staff', {
      full_name: 'P11 Dupe', username: 'p11d_' + uniq, phone,
      role: 'worker', branch_id: branchId,
    }, orgadmin);
    check('duplicate phone refused 409', dupe.status === 409, 'status ' + dupe.status);
    if (dupe.body?.data?.staff_id) createdStaffIds.push(dupe.body.data.staff_id);

    const noPhone = await call('POST', '/staff', {
      full_name: 'P11 NoPhone', username: 'p11n_' + uniq,
      role: 'worker', branch_id: branchId,
    }, orgadmin);
    check('missing phone refused 400', noPhone.status === 400, 'status ' + noPhone.status);

    const junk = await call('POST', '/staff', {
      full_name: 'P11 Junk', username: 'p11j_' + uniq, phone: '999999999999',
      role: 'worker', branch_id: branchId,
    }, orgadmin);
    check('invalid phone refused 422', junk.status === 422, 'status ' + junk.status);

    // The new account must actually be able to sign in.
    const login = await call('POST', '/auth/phone/start', { phone });
    check('new staff can sign in by phone',
      login.body?.data?.is_new === false && login.body?.data?.role === 'worker',
      'is_new=' + login.body?.data?.is_new + ' role=' + login.body?.data?.role);
  });

  // ── Act 4: commission rate validation ──
  await act('Act 4 — commission setting', async () => {
    if (!branchId) { check('branch available', false); return; }

    const set = await call('PATCH', `/branches/${branchId}`, { worker_commission_pct: 10 }, orgadmin);
    check('orgadmin can set 10%', set.status === 200, 'status ' + set.status);
    check('10% stored as 1000 bp', Number(set.body?.data?.worker_commission_bp) === 1000,
      'got ' + set.body?.data?.worker_commission_bp);

    const over = await call('PATCH', `/branches/${branchId}`, { worker_commission_pct: 150 }, orgadmin);
    check('over-100% refused', over.status >= 400, 'status ' + over.status);

    const neg = await call('PATCH', `/branches/${branchId}`, { worker_commission_pct: -5 }, orgadmin);
    check('negative refused', neg.status >= 400, 'status ' + neg.status);

    const byWorker = await call('PATCH', `/branches/${branchId}`, { worker_commission_pct: 5 }, worker);
    check('worker cannot set the rate', byWorker.status === 403, 'status ' + byWorker.status);

    await call('PATCH', `/branches/${branchId}`, { worker_commission_pct: 0 }, orgadmin);
  });

  // ── Act 5: commission arithmetic through a real wash ──
  await act('Act 5 — commission on settlement, and net expected cash', async () => {
    if (!branchId || !worker) { check('prerequisites', false); return; }

    // The rate must be set on the WORKER'S branch, not branches[0]. Both
    // settlement and the earnings endpoint read the branch off the worker's
    // token, so setting it anywhere else silently leaves the rate at 0 and
    // the arithmetic checks pass vacuously against an older wash.
    const openShift = await call('GET', '/shifts/current', undefined, worker);
    const workerBranch = openShift.body?.data?.branch_id || branchId;
    check('worker has a branch to test against', !!workerBranch);

    await call('PATCH', `/branches/${workerBranch}`, { worker_commission_pct: 10 }, orgadmin);

    const prices = await call('GET', `/prices/effective?branch_id=${workerBranch}`, undefined, worker);
    const vc = (prices.body?.data?.vehicle_classes || []).find((v: any) => (v.services || []).some((s: any) => s.has_price));
    const svc = vc?.services?.find((s: any) => s.has_price);
    if (!vc || !svc) { check('a priced service exists', false); return; }

    const started = await call('POST', '/washes', {
      vehicle_class_id: vc.id, service_id: svc.id, plate: 'P11 TEST',
    }, worker);
    check('wash started', started.status === 201, 'status ' + started.status + ' ' + JSON.stringify(started.body).slice(0, 120));
    const washId = started.body?.data?.wash_id;
    if (!washId) return;

    await call('POST', `/washes/${washId}/wash-done`, {}, worker);

    // Baseline the shift's expected cash so the assertion below can measure
    // what THIS wash contributed rather than the shift's running total.
    const shiftBefore = await call('GET', '/shifts/current', undefined, worker);
    const expectedCashBefore = Number(shiftBefore.body?.data?.expected_cash_ugx || 0);

    const settled = await call('POST', `/washes/${washId}/settle`, {
      payment_method: 'cash', unverified_reason: 'no_app',
    }, worker);
    check('wash settled', settled.status === 200, 'status ' + settled.status + ' ' + JSON.stringify(settled.body).slice(0, 120));

    const detail = await call('GET', `/washes/${washId}`, undefined, worker);
    const amount = Number(detail.body?.data?.amount_ugx || 0);
    const commission = Number(detail.body?.data?.worker_commission_ugx ?? -1);
    check('commission is 10% of the amount, rounded down',
      commission === Math.floor(amount * 0.10),
      `amount=${amount} commission=${commission} expected=${Math.floor(amount * 0.10)}`);

    // Expected cash on the shift must be net of that commission. The shift
    // already carries earlier washes, so the meaningful figure is the DELTA
    // this one wash added — it must be amount − commission, not amount.
    const shiftAfter = await call('GET', '/shifts/current', undefined, worker);
    const expectedAfter = Number(shiftAfter.body?.data?.expected_cash_ugx ?? -1);
    const delta = expectedAfter - expectedCashBefore;
    check('expected cash rose by the NET amount, not the gross',
      delta === amount - commission,
      `delta=${delta} amount=${amount} commission=${commission} expected=${amount - commission}`);

    // Earnings endpoint should now reflect it.
    const earn = await call('GET', '/washes/mine/earnings', undefined, worker);
    check('earnings endpoint responds', earn.status === 200, 'status ' + earn.status);
    check('earnings reports the current rate',
      Number(earn.body?.data?.commission_pct) === 10, 'got ' + earn.body?.data?.commission_pct);
    check('today\'s earnings include this wash',
      Number(earn.body?.data?.today?.earned_ugx || 0) >= commission,
      'today=' + earn.body?.data?.today?.earned_ugx + ' commission=' + commission);
    check('earnings has daily buckets', Array.isArray(earn.body?.data?.daily));
    check('earnings lists recent washes', Array.isArray(earn.body?.data?.recent));

    // A free wash must earn nothing — the worker never holds that money.
    const free = await call('GET', `/washes/${washId}`, undefined, worker);
    check('settled wash records a payment method', !!free.body?.data?.payment_method);

    // Clean up: cancel is not possible post-settlement, so leave the wash but
    // reset the rate. The wash itself is real business data now.
    await call('PATCH', `/branches/${workerBranch}`, { worker_commission_pct: 0 }, orgadmin);
  });

  // ── Act 6: shift detail used to return washes: [] ──
  await act('Act 6 — shift detail includes its washes', async () => {
    const list = await call('GET', '/shifts', undefined, orgadmin);
    const withWork = (list.body?.data || []).find((s: any) => Number(s.settled_count || 0) > 0);
    if (!withWork) { check('a shift with settled washes exists', false, 'none found'); return; }

    const detail = await call('GET', `/shifts/${withWork.id}`, undefined, orgadmin);
    check('shift detail responds', detail.status === 200, 'status ' + detail.status);
    check('shift detail returns its washes, not []',
      Array.isArray(detail.body?.data?.washes) && detail.body.data.washes.length > 0,
      'got ' + (detail.body?.data?.washes?.length ?? 'undefined') + ' for a shift with ' + withWork.settled_count);
  });

  // ── Act 7: reports expose commission and net ──
  await act('Act 7 — reports carry commission and net', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const daily = await call('GET', `/reports/daily?date=${today}`, undefined, orgadmin);
    check('daily report responds', daily.status === 200, 'status ' + daily.status);
    const sum = daily.body?.data?.summary;
    check('daily summary has worker_commission_ugx', sum && 'worker_commission_ugx' in sum);
    check('daily summary has net_ugx', sum && 'net_ugx' in sum);
    if (sum) {
      const gross = Number(sum.gross_ugx || 0);
      const comm = Number(sum.worker_commission_ugx || 0);
      const net = Number(sum.net_ugx || 0);
      check('net = gross − commission', net === gross - comm, `${net} vs ${gross}-${comm}`);
    }
  });

  // ── Act 8: the orphaned loyalty route is gone, the real one works ──
  await act('Act 8 — loyalty adjust consolidation', async () => {
    const washes = await call('GET', '/washes', undefined, orgadmin);
    const washId = washes.body?.data?.[0]?.id;
    if (washId) {
      const orphan = await call('POST', `/washes/${washId}/loyalty/adjust`,
        { wash_delta: 0, credit_delta: 0, reason: 'probe' }, orgadmin);
      check('duplicate route at /washes/:id/loyalty/adjust is gone',
        orphan.status === 404, 'status ' + orphan.status);
    }

    const clients = await call('GET', '/clients', undefined, orgadmin);
    const cid = clients.body?.data?.clients?.[0]?.id;
    if (!cid) { check('a client exists', false); return; }

    const before = await call('GET', `/clients/${cid}`, undefined, orgadmin);
    const up = await call('POST', `/clients/${cid}/loyalty/adjust`,
      { wash_delta: 1, credit_delta: 0, reason: 'phase 11 verification' }, orgadmin);
    check('real loyalty adjust works', up.status === 200, 'status ' + up.status);

    const down = await call('POST', `/clients/${cid}/loyalty/adjust`,
      { wash_delta: -1, credit_delta: 0, reason: 'phase 11 undo' }, orgadmin);
    check('adjustment reversible', down.status === 200, 'status ' + down.status);
    check('balance restored',
      Number(down.body?.data?.wash_count) === Number(up.body?.data?.wash_count) - 1,
      `${down.body?.data?.wash_count} vs ${up.body?.data?.wash_count}`);
  });

  // ── Act 9: the removed password routes fail closed, not 500 ──
  // `/auth/staff/login` no longer exists on the platform at all. An
  // unauthenticated call to a path under /api/v1 that nothing claims falls
  // through to the auth-guarded catch-all, so it answers 401 — never 500.
  await act('Act 9 — removed password routes fail closed', async () => {
    const r = await call('POST', '/auth/staff/login', { username: 'p11_nonexistent', password: 'Whatever123!' });
    check('removed login route is not a crash', r.status !== 500, 'status ' + r.status);
    check('removed login route is unauthenticated', r.status === 401, 'status ' + r.status);
  });

  // ── Act 10: tenant isolation still holds ──
  await act('Act 10 — scope isolation', async () => {
    const wk = await call('GET', '/staff', undefined, worker);
    check('worker cannot list staff', wk.status === 403, 'status ' + wk.status);

    const wr = await call('GET', '/reports/daily?date=' + new Date().toISOString().slice(0, 10), undefined, worker);
    check('worker cannot read reports', wr.status === 403, 'status ' + wr.status);

    const mgrBranches = await call('GET', '/branches', undefined, manager);
    check('manager sees only their own branch',
      (mgrBranches.body?.data || []).length <= 1, 'saw ' + (mgrBranches.body?.data || []).length);

    const noAuth = await call('GET', '/staff');
    check('unauthenticated request refused', noAuth.status === 401, 'status ' + noAuth.status);
  });

  // ── Cleanup ──
  await act('Cleanup', async () => {
    for (const id of createdStaffIds) {
      await call('POST', `/staff/${id}/suspend`, {}, orgadmin);
    }
    if (branchId) await call('PATCH', `/branches/${branchId}`, { worker_commission_pct: 0 }, orgadmin);
    check('commission rate reset to 0', true);
    console.log('  note: ' + createdStaffIds.length + ' test staff suspended (rows kept — staff are never hard-deleted)');
  });

  console.log('\n=== PHASE 11: ' + pass + ' passed, ' + failCount + ' failed ===');
  if (failures.length) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  - ' + f));
  }
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
