/**
 * V2 Phase 3 — job dispatch, worker points, leaderboard.
 *
 * Proves:
 *   - settings: who may read/change the accept window, validation;
 *   - the fewest-jobs rule: 1 each, then 2 each, then 3 — and a manager's
 *     open shift never blocks workers;
 *   - presence: a worker whose app went quiet is not counted as on site;
 *   - race-safety of accept;
 *   - the timer: nothing is assigned before the window, then the job goes
 *     to the most experienced worker among those with the fewest jobs;
 *   - nobody on site: the job waits and managers are alerted once;
 *   - worker points go to the washer, on every wash, at the full price;
 *   - leaderboard by week/month with the caller's own rank.
 *
 * Uses the database directly for three things the API rightly can't do:
 * making a worker's app look quiet, ageing a booking, and reading the alert
 * marker. Restores every setting it changes.
 */

import dotenv from 'dotenv';
import path from 'path';
import { Pool } from 'pg';
import { signInAs, signInByPhone } from './helpers/auth';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let phoneSeq = 0;
function freshPhone() {
  phoneSeq++;
  return '+2567' + String(Date.now() + phoneSeq * 4813).slice(-8);
}

async function main() {
  console.log('V2 PHASE 3 — dispatch, worker points, leaderboard, against ' + BASE);
  const db = new Pool({ connectionString: process.env.DATABASE_URL });

  let orgadmin = '', grace = '', joseph = '', musa = '';
  let josephId = '', musaId = '';
  let branchId = '', vcId = '', svcId = '', price = 0;
  let originalDispatch: any = null;
  let originalWorkerPointsActive: boolean | null = null;
  const open: string[] = [];   // washes this suite leaves behind, cancelled at the end

  const tokenFor = (id: string) => (id === josephId ? joseph : id === musaId ? musa : '');

  async function cancelAllActive() {
    for (const t of [joseph, musa]) {
      const q = await call('GET', '/washes/queue', undefined, t);
      for (const w of [...(q.body?.data?.washing || []), ...(q.body?.data?.requested || [])]) {
        await call('POST', `/washes/${w.id}/cancel`, { reason: 'other', note: 'v2-phase3 cleanup' }, orgadmin);
      }
    }
  }
  async function book(extra: Record<string, unknown> = {}, clientToken?: string) {
    const c = clientToken || await signInByPhone(freshPhone());
    const b = await call('POST', '/me/washes', { branch_id: branchId, vehicle_class_id: vcId, service_id: svcId, ...extra }, c);
    if (b.body?.data?.wash_id) open.push(b.body.data.wash_id);
    return { id: b.body?.data?.wash_id as string, body: b.body, status: b.status, client: c };
  }
  async function detail(id: string) {
    return (await call('GET', `/washes/${id}`, undefined, orgadmin)).body?.data;
  }
  async function lifetime(token: string) {
    return Number((await call('GET', '/worker-points/me', undefined, token)).body?.data?.lifetime_earned || 0);
  }
  async function markPresent(...ids: string[]) {
    await db.query(`UPDATE staff_users SET last_seen_at = now() WHERE id = ANY($1)`, [ids]);
  }
  async function markAway(...ids: string[]) {
    await db.query(`UPDATE staff_users SET last_seen_at = now() - interval '1 day' WHERE id = ANY($1)`, [ids]);
  }

  await act('Act 1 — setup', async () => {
    orgadmin = await signInAs('orgadmin');
    grace = await signInAs('grace');
    joseph = await signInAs('joseph');
    musa = await signInAs('musa');
    josephId = (await call('GET', '/me', undefined, joseph)).body?.data?.id;
    musaId = (await call('GET', '/me', undefined, musa)).body?.data?.id;
    branchId = ((await call('GET', '/branches', undefined, orgadmin)).body?.data || []).find((b: any) => b.code === 'NTD')?.id;
    check('staff and NTD found', !!josephId && !!musaId && !!branchId);

    // grace's shift is opened on purpose: a manager with no cars on site
    // must never stop workers from taking a second.
    for (const t of [joseph, musa, grace]) {
      const o = await call('POST', '/shifts/open', {}, t);
      check('shift open', o.status === 201 || o.body?.error?.code === 'SHIFT_ALREADY_OPEN');
    }
    await markPresent(josephId, musaId);
    await cancelAllActive();

    const probe = await signInByPhone(freshPhone());
    const prices = await call('GET', `/me/washes/prices?branch_id=${branchId}`, undefined, probe);
    for (const vc of prices.body?.data?.vehicle_classes || []) {
      const s = (vc.services || []).find((x: any) => x.has_price);
      if (s) { vcId = vc.id; svcId = s.id; price = Number(s.price_ugx); break; }
    }
    check('priced wash type found', !!svcId);

    const cfg = await call('GET', '/worker-points/config', undefined, orgadmin);
    originalWorkerPointsActive = cfg.body?.data?.active ?? null;
    if (originalWorkerPointsActive === false) await call('PUT', '/worker-points/config', { active: true }, orgadmin);
  });

  await act('Act 2 — dispatch settings', async () => {
    const got = await call('GET', '/settings/dispatch', undefined, orgadmin);
    originalDispatch = got.body?.data;
    check('org admin reads dispatch settings', got.status === 200 && typeof originalDispatch?.accept_window_seconds === 'number');
    check('manager can read', (await call('GET', '/settings/dispatch', undefined, grace)).status === 200);
    check('worker cannot read', (await call('GET', '/settings/dispatch', undefined, joseph)).status === 403);
    check('manager cannot change', (await call('PUT', '/settings/dispatch', { accept_window_seconds: 30 }, grace)).status === 403);
    check('window under 5 s rejected', (await call('PUT', '/settings/dispatch', { accept_window_seconds: 2 }, orgadmin)).status === 400);
    const set = await call('PUT', '/settings/dispatch', { accept_window_seconds: 60, presence_minutes: 20, unassigned_alert_minutes: 10 }, orgadmin);
    check('settings saved', set.status === 200 && set.body?.data?.accept_window_seconds === 60, JSON.stringify(set.body));
  });

  await act('Act 3 — fewest jobs first: 1 each, then 2 each, then 3', async () => {
    const order: Array<{ who: string; token: string; expect: number }> = [
      // [joseph 0, musa 0] → joseph takes one
      { who: 'joseph', token: joseph, expect: 200 },
      // [1, 0] → joseph must wait, musa takes it
      { who: 'joseph', token: joseph, expect: 409 },
      { who: 'musa', token: musa, expect: 200 },
      // [1, 1] → a second car opens up for anyone (grace's empty shift doesn't count)
      { who: 'joseph', token: joseph, expect: 200 },
      // [2, 1] → joseph waits again
      { who: 'joseph', token: joseph, expect: 409 },
      { who: 'musa', token: musa, expect: 200 },
      // [2, 2] → third car opens up
      { who: 'joseph', token: joseph, expect: 200 },
    ];
    let pending: string | null = null;
    for (const step of order) {
      if (!pending) pending = (await book()).id;
      const r = await call('POST', `/washes/${pending}/accept`, undefined, step.token);
      const ok = r.status === step.expect && (step.expect === 200 || r.body?.error?.code === 'WORKER_BUSY');
      check(`${step.who} accept → ${step.expect}`, ok, `got ${r.status} ${JSON.stringify(r.body?.error || r.body?.data)}`);
      if (r.status === 200) pending = null;
    }
    const q = await call('GET', '/washes/queue', undefined, musa);
    check('queue reports musa\'s count and the fewest on site',
      q.body?.data?.dispatch?.my_jobs === 2 && q.body?.data?.dispatch?.fewest_jobs_on_site === 3,
      JSON.stringify(q.body?.data?.dispatch));
    await cancelAllActive();
  });

  await act('Act 4 — a worker whose app went quiet is not counted', async () => {
    const first = await book();
    await call('POST', `/washes/${first.id}/accept`, undefined, joseph);
    // joseph has 1, musa 0 — but musa's app hasn't been in touch for a day.
    await markAway(musaId);
    const second = await book();
    const r = await call('POST', `/washes/${second.id}/accept`, undefined, joseph);
    check('joseph may take a second car when musa is not on site', r.status === 200, JSON.stringify(r.body));
    await markPresent(musaId);
    await cancelAllActive();
  });

  await act('Act 5 — two simultaneous accepts: exactly one wins', async () => {
    const w = await book();
    const [a, b] = await Promise.all([
      call('POST', `/washes/${w.id}/accept`, undefined, joseph),
      call('POST', `/washes/${w.id}/accept`, undefined, musa),
    ]);
    const statuses = [a.status, b.status].sort();
    const loser = a.status === 200 ? b : a;
    check('one 200, one ALREADY_CLAIMED', statuses[0] === 200 && statuses[1] === 409 && loser.body?.error?.code === 'ALREADY_CLAIMED',
      JSON.stringify([a.body, b.body]).slice(0, 300));
    check('accepted jobs are marked as accepted', (await detail(w.id))?.assigned_via === 'accept');
    await cancelAllActive();
  });

  await act('Act 6 — the timer gives the job to the most experienced free worker', async () => {
    // Make sure the two differ in experience so the pick is deterministic.
    let jp = await lifetime(joseph);
    const mp = await lifetime(musa);
    if (jp <= mp) {
      await call('POST', `/worker-points/${josephId}/adjust`, { points: mp - jp + 10, reason: 'v2-phase3 experience', bonus: true }, orgadmin);
      jp = await lifetime(joseph);
    }
    check('joseph is the more experienced', jp > mp, `joseph ${jp} musa ${mp}`);

    await call('PUT', '/settings/dispatch', { accept_window_seconds: 5 }, orgadmin);
    const w = await book();
    check('booking says when it will be auto-assigned', !!w.body?.data?.auto_assign_at);
    const early = await call('GET', '/me/washes/active', undefined, w.client);
    check('nothing assigned before the window ends', early.body?.data?.status === 'requested', JSON.stringify(early.body?.data));

    await sleep(6500);
    const after = await call('GET', '/me/washes/active', undefined, w.client);
    const d = await detail(w.id);
    check('assigned once the window ends', after.body?.data?.status === 'in_progress', JSON.stringify(after.body?.data));
    check('to the most experienced worker', d?.started_by_worker_id === josephId, 'got ' + d?.started_by_worker_id);
    check('marked as auto-assigned', d?.assigned_via === 'auto');

    // Now joseph has a car and musa none: fewest jobs beats experience.
    const w2 = await book();
    await sleep(6500);
    await call('GET', '/me/washes/active', undefined, w2.client);
    check('the next job goes to the worker with fewer cars, despite fewer points',
      (await detail(w2.id))?.started_by_worker_id === musaId);
    await cancelAllActive();
  });

  await act('Act 7 — nobody on site: the job waits and managers are alerted once', async () => {
    await markAway(josephId, musaId);
    const w = await book();
    // Age the booking past the alert threshold (10 minutes).
    await db.query(`UPDATE washes SET requested_at = now() - interval '11 minutes' WHERE id = $1`, [w.id]);
    const r1 = await call('GET', '/me/washes/active', undefined, w.client);
    const a1 = (await db.query(`SELECT dispatch_alerted_at, status FROM washes WHERE id = $1`, [w.id])).rows[0];
    check('still waiting — nobody to give it to', r1.body?.data?.status === 'requested' && a1.status === 'requested');
    check('managers alerted', !!a1.dispatch_alerted_at);
    await sleep(1100);
    await call('GET', '/me/washes/active', undefined, w.client);
    const a2 = (await db.query(`SELECT dispatch_alerted_at FROM washes WHERE id = $1`, [w.id])).rows[0];
    check('alerted only once', new Date(a2.dispatch_alerted_at).getTime() === new Date(a1.dispatch_alerted_at).getTime());
    await markPresent(josephId, musaId);
    await call('PUT', '/settings/dispatch', { accept_window_seconds: 60 }, orgadmin);
    await call('POST', `/me/washes/${w.id}/cancel-request`, undefined, w.client);
  });

  await act('Act 8 — worker points: to the washer, on every wash, at the full price', async () => {
    await cancelAllActive();
    // A wash paid entirely with points still earns the worker points.
    const c = await signInByPhone(freshPhone());
    const cid = (await call('GET', '/me', undefined, c)).body?.data?.id;
    const pv = Number((await call('GET', '/me/washes/points', undefined, c)).body?.data?.point_value_ugx || 0);
    await call('POST', '/settings/client-points/adjust', { client_id: cid, points: Math.ceil(price / Math.max(pv, 1)), reason: 'v2-phase3 fixture' }, orgadmin);
    const w = await book({ use_points: true }, c);
    await call('POST', `/washes/${w.id}/accept`, undefined, joseph);
    const before = await lifetime(joseph);
    await call('POST', `/washes/${w.id}/wash-done`, undefined, joseph);
    const s = await call('POST', `/washes/${w.id}/settle`, { unverified_reason: 'no_app', payment_method: 'cash' }, joseph);
    check('points-paid wash settled at 0', s.body?.data?.payment_method === 'points', JSON.stringify(s.body?.data).slice(0, 200));
    check('worker still earned points', (s.body?.data?.worker_points?.earned || 0) > 0 && (await lifetime(joseph)) > before,
      JSON.stringify(s.body?.data?.worker_points));

    // Handover: the washer earns, not the settler.
    const h = await book();
    await call('POST', `/washes/${h.id}/accept`, undefined, joseph);
    await call('POST', `/washes/${h.id}/wash-done`, undefined, joseph);
    const jBefore = await lifetime(joseph);
    const mBefore = await lifetime(musa);
    const hs = await call('POST', `/washes/${h.id}/settle`, {
      unverified_reason: 'no_app', payment_method: 'cash', handover_reason: 'starter_on_break',
    }, musa);
    check('handover settled', hs.status === 200, JSON.stringify(hs.body).slice(0, 200));
    check('points credited to the washer', hs.body?.data?.worker_points?.staff_id === josephId
      && (await lifetime(joseph)) > jBefore && (await lifetime(musa)) === mBefore);
  });

  await act('Act 9 — leaderboard by week and month', async () => {
    const week = await call('GET', '/worker-points/leaderboard?period=week', undefined, joseph);
    const rows = week.body?.data || [];
    check('weekly leaderboard responds', week.status === 200 && week.body?.period === 'week' && rows.length > 0);
    check('sorted by points, highest first', rows.every((r: any, i: number) => i === 0 || rows[i - 1].points >= r.points));
    check('ranks are 1..n', rows.every((r: any, i: number) => r.rank === i + 1));
    check('only the caller\'s branch', rows.every((r: any) => r.branch_code === 'NTD'));
    check('the caller\'s own standing is included', week.body?.me?.id === josephId && week.body?.me?.points > 0,
      JSON.stringify(week.body?.me));
    const month = await call('GET', '/worker-points/leaderboard?period=month', undefined, joseph);
    check('monthly points ≥ weekly points for the same worker',
      (month.body?.me?.points ?? -1) >= (week.body?.me?.points ?? 0));
    check('a bad period is rejected', (await call('GET', '/worker-points/leaderboard?period=year', undefined, joseph)).status === 400);
  });

  await act('Act 9b — cancelling a waiting booking, and cancel scope', async () => {
    const shineadmin = await signInAs('shineadmin');
    const w = await book();
    const cross = await call('POST', `/washes/${w.id}/cancel`, { reason: 'other' }, shineadmin);
    check('another organisation cannot cancel it (reads as not found)', cross.status === 404, 'status ' + cross.status);
    const mine = await call('POST', `/washes/${w.id}/cancel`, { reason: 'client_left' }, grace);
    check('the branch manager can cancel a booking still waiting for a worker',
      mine.status === 200 && mine.body?.data?.status === 'cancelled', JSON.stringify(mine.body));
  });

  await act('Act 10 — restore', async () => {
    await cancelAllActive();
    if (originalDispatch) {
      const r = await call('PUT', '/settings/dispatch', {
        accept_window_seconds: originalDispatch.accept_window_seconds,
        presence_minutes: originalDispatch.presence_minutes,
        unassigned_alert_minutes: originalDispatch.unassigned_alert_minutes,
      }, orgadmin);
      check('dispatch settings restored', r.status === 200);
    }
    if (originalWorkerPointsActive === false) await call('PUT', '/worker-points/config', { active: false }, orgadmin);
    await markPresent(josephId, musaId);
  });

  await db.end();
  console.log(`\n=== V2 PHASE 3: ${pass} passed, ${failCount} failed ===`);
  if (failCount > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
