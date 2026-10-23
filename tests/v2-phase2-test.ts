/**
 * V2 Phase 2 — worker wallet, commission, cash.
 *
 * Proves, through the HTTP API (plus one direct database reconciliation):
 *   - commission is bp × FULL price for every payment method, into the
 *     wallet of the worker who washed;
 *   - a cash wash leaves the settler owing (cash − their commission);
 *   - a manager confirming cash brings the balance back, partially or fully,
 *     never beyond what is owed;
 *   - mobile money and points-paid washes add commission and owe nothing;
 *   - on a handover the washer gets the commission, the settler owes the cash;
 *   - shift expected cash counts only cash (the old bug counted mobile money);
 *   - reversal undoes, correction moves by the difference;
 *   - scope: who may confirm for whom, across branches and organisations;
 *   - every wallet balance equals the sum of its ledger.
 *
 * Re-runnable: works on balance deltas, uses fresh clients, and restores the
 * branch commission rate it changes.
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

let phoneSeq = 0;
function freshPhone() {
  phoneSeq++;
  return '+2567' + String(Date.now() + phoneSeq * 6007).slice(-8);
}

const RATE_PCT = 10;

async function main() {
  console.log('V2 PHASE 2 — worker wallet, against ' + BASE);

  let orgadmin = '', grace = '', joseph = '', musa = '', shineadmin = '';
  let josephId = '', musaId = '', graceId = '';
  let branchId = '', originalBp = 0;
  let vcId = '', svcId = '', price = 0;
  let vc2Id = '', price2 = 0;

  const tokenFor = (id: string) => (id === josephId ? joseph : id === musaId ? musa : '');
  const commission = (p: number) => Math.floor((p * RATE_PCT * 100) / 10000);

  async function wallet(token: string) {
    return (await call('GET', '/wallet/me', undefined, token)).body?.data;
  }
  async function balanceOf(id: string) {
    return (await wallet(tokenFor(id)))?.balance_ugx as number;
  }
  async function freeWorker(token: string) {
    const q = await call('GET', '/washes/queue', undefined, token);
    for (const w of q.body?.data?.washing || []) {
      await call('POST', `/washes/${w.id}/cancel`, { reason: 'other', note: 'v2-phase2 setup' }, orgadmin);
    }
  }
  /** Books a wash for a fresh client and returns it with the worker it landed on. */
  async function bookAssigned(extra: Record<string, unknown> = {}, clientToken?: string) {
    await freeWorker(joseph);
    await freeWorker(musa);
    const c = clientToken || await signInByPhone(freshPhone());
    const b = await call('POST', '/me/washes', { branch_id: branchId, vehicle_class_id: vcId, service_id: svcId, ...extra }, c);
    const washId = b.body?.data?.wash_id;
    let detail = await call('GET', `/washes/${washId}`, undefined, orgadmin);
    if (detail.body?.data?.status === 'requested') {
      await call('POST', `/washes/${washId}/accept`, undefined, joseph);
      detail = await call('GET', `/washes/${washId}`, undefined, orgadmin);
    }
    const holder = detail.body?.data?.started_by_worker_id;
    if (!tokenFor(holder)) throw new Error('wash went to a worker this suite cannot sign in as');
    return { washId, holder, client: c };
  }
  async function finish(washId: string, token: string, body: Record<string, unknown>) {
    await call('POST', `/washes/${washId}/wash-done`, undefined, token);
    return call('POST', `/washes/${washId}/settle`, { unverified_reason: 'no_app', ...body }, token);
  }
  async function expectedCash(token: string) {
    return Number((await call('GET', '/shifts/current', undefined, token)).body?.data?.expected_cash_ugx ?? NaN);
  }

  await act('Act 1 — setup: staff, NTD at 10%, a priced wash type', async () => {
    orgadmin = await signInAs('orgadmin');
    grace = await signInAs('grace');
    joseph = await signInAs('joseph');
    musa = await signInAs('musa');
    shineadmin = await signInAs('shineadmin');
    josephId = (await call('GET', '/me', undefined, joseph)).body?.data?.id;
    musaId = (await call('GET', '/me', undefined, musa)).body?.data?.id;
    graceId = (await call('GET', '/me', undefined, grace)).body?.data?.id;
    check('tokens acquired', !!josephId && !!musaId && !!graceId && !!shineadmin);

    const branches = await call('GET', '/branches', undefined, orgadmin);
    const ntd = (branches.body?.data || []).find((b: any) => b.code === 'NTD');
    branchId = ntd?.id;
    originalBp = Number(ntd?.worker_commission_bp || 0);
    const set = await call('PATCH', `/branches/${branchId}`, { worker_commission_pct: RATE_PCT }, orgadmin);
    check('NTD commission set to 10%', Number(set.body?.data?.worker_commission_bp) === RATE_PCT * 100);

    for (const t of [joseph, musa, grace]) {
      const open = await call('POST', '/shifts/open', {}, t);
      check('shift open', open.status === 201 || open.body?.error?.code === 'SHIFT_ALREADY_OPEN', JSON.stringify(open.body));
    }

    // A wash type priced for two different car types, so a correction
    // between them really changes the price.
    const probe = await signInByPhone(freshPhone());
    const prices = await call('GET', `/me/washes/prices?branch_id=${branchId}`, undefined, probe);
    const classes = prices.body?.data?.vehicle_classes || [];
    outer: for (const a of classes) {
      for (const s of a.services || []) {
        if (!s.has_price || s.price_ugx < 10000) continue;
        for (const b of classes) {
          const s2 = (b.services || []).find((x: any) => x.id === s.id && x.has_price && x.price_ugx !== s.price_ugx);
          if (b.id !== a.id && s2) {
            vcId = a.id; svcId = s.id; price = Number(s.price_ugx);
            vc2Id = b.id; price2 = Number(s2.price_ugx);
            break outer;
          }
        }
      }
    }
    check('wash type with two different car-type prices found', !!svcId && !!vc2Id, `${price} / ${price2}`);
  });

  await act('Act 2 — cash wash: settler owes cash minus their commission', async () => {
    const { washId, holder } = await bookAssigned();
    const before = await balanceOf(holder);
    const shiftBefore = await expectedCash(tokenFor(holder));
    const s = await finish(washId, tokenFor(holder), { payment_method: 'cash' });
    check('settle reports commission on the full price', s.body?.data?.worker_commission_ugx === commission(price),
      JSON.stringify(s.body?.data).slice(0, 300));
    const after = await balanceOf(holder);
    check('wallet moved by −(price − commission)', after - before === -(price - commission(price)),
      `before ${before} after ${after}`);
    check('settle reports the wallet balance', s.body?.data?.wallet_balance_ugx === after);
    const w = await wallet(tokenFor(holder));
    check('owes_ugx mirrors a negative balance', w.owes_ugx === Math.max(0, -after) && w.available_ugx === Math.max(0, after));
    check('ledger shows commission and cash rows for the wash',
      w.ledger.some((r: any) => r.wash_id === washId && r.kind === 'commission' && r.amount_ugx === commission(price))
        && w.ledger.some((r: any) => r.wash_id === washId && r.kind === 'cash_collected' && r.amount_ugx === -price));
    check('shift expected cash rose by cash − commission',
      (await expectedCash(tokenFor(holder))) - shiftBefore === price - commission(price));
  });

  await act('Act 3 — manager confirms cash: partial, then the rest, never more', async () => {
    const { washId, holder } = await bookAssigned();
    await finish(washId, tokenFor(holder), { payment_method: 'cash' });
    const owed = (await wallet(tokenFor(holder))).owes_ugx;
    check('worker owes something', owed > 0, 'owed ' + owed);

    const tooMuch = await call('POST', `/wallet/${holder}/cash-handover`, { amount_ugx: owed + 1 }, grace);
    check('more than owed is refused', tooMuch.status === 422 && tooMuch.body?.error?.code === 'MORE_THAN_OWED',
      JSON.stringify(tooMuch.body));

    const part = await call('POST', `/wallet/${holder}/cash-handover`, { amount_ugx: 1000, note: 'first part' }, grace);
    check('partial handover accepted', part.status === 200 && part.body?.data?.owes_ugx === owed - 1000, JSON.stringify(part.body));

    const rest = await call('POST', `/wallet/${holder}/cash-handover`, { amount_ugx: owed - 1000 }, grace);
    check('the rest clears the debt', rest.status === 200 && rest.body?.data?.balance_ugx === 0, JSON.stringify(rest.body));

    const nothing = await call('POST', `/wallet/${holder}/cash-handover`, { amount_ugx: 500 }, grace);
    check('nothing owed → 409', nothing.status === 409 && nothing.body?.error?.code === 'NOTHING_OWED');

    const zero = await call('POST', `/wallet/${holder}/cash-handover`, { amount_ugx: 0 }, grace);
    check('zero amount rejected', zero.status === 400);
  });

  await act('Act 4 — mobile money: commission paid in, nothing owed, no cash expected', async () => {
    const { washId, holder } = await bookAssigned();
    const before = await balanceOf(holder);
    const shiftBefore = await expectedCash(tokenFor(holder));
    const s = await finish(washId, tokenFor(holder), { payment_method: 'mtn', payer_phone: '+256770000001' });
    check('settled as mtn with commission', s.status === 200 && s.body?.data?.payment_method === 'mtn'
      && s.body?.data?.worker_commission_ugx === commission(price), JSON.stringify(s.body?.data).slice(0, 300));
    check('wallet rose by the commission', (await balanceOf(holder)) - before === commission(price));
    check('shift expected cash unchanged (mobile money is not cash in hand)',
      (await expectedCash(tokenFor(holder))) === shiftBefore);
  });

  await act('Act 5 — paid with points: commission still on the full price', async () => {
    const c = await signInByPhone(freshPhone());
    const cid = (await call('GET', '/me', undefined, c)).body?.data?.id;
    const pts = await call('GET', '/me/washes/points', undefined, c);
    const pv = Number(pts.body?.data?.point_value_ugx || 0);
    check('points are spendable (point value > 0)', pv > 0, 'point value ' + pv);
    await call('POST', '/settings/client-points/adjust', { client_id: cid, points: Math.ceil(price / pv), reason: 'v2-phase2 fixture' }, orgadmin);

    const { washId, holder } = await bookAssigned({ use_points: true }, c);
    const before = await balanceOf(holder);
    const s = await finish(washId, tokenFor(holder), { payment_method: 'cash' });
    check('settled as a points payment of 0', s.body?.data?.payment_method === 'points' && s.body?.data?.amount_ugx === 0,
      JSON.stringify(s.body?.data).slice(0, 300));
    check('worker still earns commission on the full price', (await balanceOf(holder)) - before === commission(price));
  });

  await act('Act 6 — handover: washer gets the commission, settler owes the cash', async () => {
    const { washId, holder } = await bookAssigned();
    const otherId = holder === josephId ? musaId : josephId;
    const washerBefore = await balanceOf(holder);
    const settlerBefore = await balanceOf(otherId);
    const settlerShift = await expectedCash(tokenFor(otherId));

    await call('POST', `/washes/${washId}/wash-done`, undefined, tokenFor(holder));
    const s = await call('POST', `/washes/${washId}/settle`, {
      unverified_reason: 'no_app', payment_method: 'cash', handover_reason: 'starter_on_break',
    }, tokenFor(otherId));
    check('handover settle succeeds', s.status === 200 && s.body?.data?.is_handover === true, JSON.stringify(s.body).slice(0, 300));
    check('washer +commission', (await balanceOf(holder)) - washerBefore === commission(price));
    check('settler −full cash', (await balanceOf(otherId)) - settlerBefore === -price);
    check('settler\'s shift expects the full cash (the commission is not theirs to keep)',
      (await expectedCash(tokenFor(otherId))) - settlerShift === price);

    const washerEarnings = await call('GET', '/washes/mine/earnings', undefined, tokenFor(holder));
    const settlerEarnings = await call('GET', '/washes/mine/earnings', undefined, tokenFor(otherId));
    check('earnings list the wash for the washer, not the settler',
      (washerEarnings.body?.data?.recent || []).some((w: any) => w.id === washId)
        && !(settlerEarnings.body?.data?.recent || []).some((w: any) => w.id === washId));
  });

  await act('Act 7 — reversal undoes the wash\'s money', async () => {
    const { washId, holder } = await bookAssigned();
    const before = await balanceOf(holder);
    await finish(washId, tokenFor(holder), { payment_method: 'cash' });
    const rev = await call('POST', `/washes/${washId}/reverse`, { reason: 'v2-phase2 reversal' }, orgadmin);
    check('reverse succeeds and reports the wallet change',
      rev.status === 200 && (rev.body?.data?.wallet || []).some((x: any) => x.staff_id === holder && x.amount_ugx === price - commission(price)),
      JSON.stringify(rev.body?.data?.wallet));
    check('balance back where it started', (await balanceOf(holder)) === before);
  });

  await act('Act 8 — correction moves the wallet by the difference', async () => {
    const { washId, holder } = await bookAssigned();
    const before = await balanceOf(holder);
    await finish(washId, tokenFor(holder), { payment_method: 'cash' });
    const corr = await call('POST', `/washes/${washId}/correct`, { vehicle_class_id: vc2Id, reason: 'v2-phase2 wrong car type' }, orgadmin);
    check('correction succeeds', corr.status === 200 && corr.body?.data?.amount_ugx === price2, JSON.stringify(corr.body));
    const detail = await call('GET', `/washes/${washId}`, undefined, orgadmin);
    check('wash commission follows the new price', Number(detail.body?.data?.worker_commission_ugx) === commission(price2),
      'got ' + detail.body?.data?.worker_commission_ugx);
    check('wallet net = −(new price − new commission)',
      (await balanceOf(holder)) - before === -(price2 - commission(price2)),
      `delta ${(await balanceOf(holder)) - before}`);
  });

  await act('Act 9 — scope: who may confirm cash for whom', async () => {
    check('worker cannot confirm cash', (await call('POST', `/wallet/${musaId}/cash-handover`, { amount_ugx: 100 }, joseph)).status === 403);
    check('worker cannot list wallets', (await call('GET', '/wallet', undefined, joseph)).status === 403);
    const own = await call('POST', `/wallet/${graceId}/cash-handover`, { amount_ugx: 100 }, grace);
    check('manager cannot confirm their own cash', own.status === 403 && own.body?.error?.code === 'CANNOT_CONFIRM_OWN');

    const staff = await call('GET', '/staff', undefined, orgadmin);
    const kblWorker = (staff.body?.data || []).find((s: any) => s.role === 'worker' && s.branch_name && s.branch_id !== branchId);
    if (kblWorker) {
      const other = await call('POST', `/wallet/${kblWorker.id}/cash-handover`, { amount_ugx: 100 }, grace);
      check('manager cannot act on another branch\'s worker', other.status === 403 && other.body?.error?.code === 'OUT_OF_SCOPE');
    } else check('another-branch worker exists for the scope test', false);

    const cross = await call('GET', `/wallet/${josephId}/ledger`, undefined, shineadmin);
    check('another organisation cannot see the wallet', cross.status === 404);
  });

  await act('Act 10 — manager list: own branch, most owed first', async () => {
    const list = await call('GET', '/wallet', undefined, grace);
    const rows = list.body?.data?.staff || [];
    check('lists joseph and musa', rows.some((r: any) => r.staff_id === josephId) && rows.some((r: any) => r.staff_id === musaId));
    check('only NTD workers', rows.every((r: any) => r.branch_id === branchId && r.role === 'worker'));
    check('sorted by balance, most owed first', rows.every((r: any, i: number) => i === 0 || rows[i - 1].balance_ugx <= r.balance_ugx));
    check('total owed is the sum', list.body?.data?.total_owed_ugx === rows.reduce((t: number, r: any) => t + r.owes_ugx, 0));
  });

  await act('Act 11 — org admin adjustment, reason required', async () => {
    const before = await balanceOf(josephId);
    check('manager cannot adjust', (await call('POST', `/wallet/${josephId}/adjust`, { amount_ugx: 500, reason: 'nope' }, grace)).status === 403);
    check('reason is required', (await call('POST', `/wallet/${josephId}/adjust`, { amount_ugx: 500 }, orgadmin)).status === 400);
    const up = await call('POST', `/wallet/${josephId}/adjust`, { amount_ugx: 500, reason: 'v2-phase2 test' }, orgadmin);
    check('adjust applies', up.status === 200 && up.body?.data?.balance_ugx === before + 500);
    await call('POST', `/wallet/${josephId}/adjust`, { amount_ugx: -500, reason: 'v2-phase2 undo' }, orgadmin);
    check('undo restores', (await balanceOf(josephId)) === before);
  });

  await act('Act 12 — every wallet balance equals its ledger', async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const r = await pool.query(
        `SELECT count(*) AS accounts,
                count(*) FILTER (WHERE a.balance_ugx <> COALESCE(l.s, 0)) AS mismatched
           FROM wallet_accounts a
           LEFT JOIN (SELECT staff_id, SUM(amount_ugx) s FROM wallet_ledger GROUP BY staff_id) l USING (staff_id)`
      );
      check('no mismatched wallets', Number(r.rows[0].mismatched) === 0 && Number(r.rows[0].accounts) > 0,
        JSON.stringify(r.rows[0]));
      const chain = await pool.query(
        `SELECT count(*) AS broken FROM (
           SELECT balance_after_ugx, amount_ugx,
                  LAG(balance_after_ugx) OVER (PARTITION BY staff_id ORDER BY seq) AS prev
             FROM wallet_ledger) t
          WHERE prev IS NOT NULL AND prev + amount_ugx <> balance_after_ugx`
      );
      check('each ledger row follows from the one before', Number(chain.rows[0].broken) === 0, JSON.stringify(chain.rows[0]));
    } finally {
      await pool.end();
    }
  });

  await act('Act 13 — restore the commission rate', async () => {
    const r = await call('PATCH', `/branches/${branchId}`, { worker_commission_pct: originalBp / 100 }, orgadmin);
    check('rate restored', Number(r.body?.data?.worker_commission_bp) === originalBp);
  });

  console.log(`\n=== V2 PHASE 2: ${pass} passed, ${failCount} failed ===`);
  if (failCount > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
