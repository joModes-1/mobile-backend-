/**
 * Demo data for the org admin screens (Home, Live jobs, Cash, Reports), so
 * the charts and lists look like a busy car wash: 30 days of washes across
 * five branches, today up to the current hour, cars on the go right now,
 * cash held and handed in, and a few variances and payments to check.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/seed-demo.ts
 *
 * The picture is a healthy business — most shifts balance, cash is handed
 * in, cars move — with just one of each problem to test with: a stuck car,
 * someone holding cash overnight, a short shift, a dispute, a payment taken
 * without the app. The test client numbers get washes of their own, and
 * client and worker points are earned through the points modules, so every
 * test login (org admin, manager, worker, client) has something to show.
 *
 * Runs against localhost only, unless given --remote (for the hosted test
 * server; it also tidies that org's stale test cars and old unhanded cash).
 * Everything it writes is tagged, and a re-run removes the previous demo
 * data first, so it can be run again any day to bring "today" up to date.
 * Money moves through the wallet module itself, so cash owed and handovers
 * add up exactly as the app computes them.
 */
import 'dotenv/config';
import { PoolClient } from 'pg';
import { getPool } from '../src/db';
import { post, recordSettlement, cashOwedFor } from '../src/modules/wallet';
import { awardForSettlement as awardClientPoints } from '../src/modules/clientPoints';
import { awardForSettlement as awardWorkerPoints } from '../src/modules/workerPoints';

const TAG = 'demo-seed';
const ORG_ADMIN_PHONE = '+256700200001';
/** Test client logins: each gets a run of its own washes and points. */
const TEST_CLIENT_PHONES = ['+256700123456', '+256700200099'];

const url = process.env.DATABASE_URL || '';
if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url) && !process.argv.includes('--remote')) {
  console.error('Refusing to seed: DATABASE_URL is not a local database. Pass --remote to seed a hosted test database on purpose.');
  process.exit(1);
}

// ── Branches and how busy each is on an ordinary weekday ──
const NEW_BRANCHES = [
  { code: 'KRK', name: 'Kireka', address: 'Kireka Road, Kampala', manager: 'John B.', workers: ['Peter O.', 'Esther N.', 'Brian K.', 'Ivan M.'] },
  { code: 'BGL', name: 'Bugolobi', address: 'Bugolobi Flats Road, Kampala', manager: 'Ruth K.', workers: ['Grace L.', 'Samuel W.', 'Diana A.'] },
  { code: 'NJR', name: 'Najjera', address: 'Najjera Link Road, Kampala', manager: 'Paul S.', workers: ['David M.', 'Irene A.', 'Moses T.'] },
];
const DAILY: Record<string, number> = { NTD: 30, KBL: 22, KRK: 21, BGL: 16, NJR: 11 };
// Washes started per hour, 07:00–18:00: a morning peak, a lunch dip, an evening run.
const HOUR_WEIGHT = [2, 5, 8, 10, 9, 6, 6, 8, 9, 8, 5, 3];
const FIRST_HOUR = 7;

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const minutes = (n: number) => n * 60_000;
function weightedHour(maxHour = 23) {
  const hours = HOUR_WEIGHT.map((w, i) => ({ h: FIRST_HOUR + i, w })).filter((x) => x.h <= maxHour);
  const total = hours.reduce((t, x) => t + x.w, 0);
  let r = Math.random() * total;
  for (const x of hours) { if ((r -= x.w) <= 0) return x.h; }
  return hours[hours.length - 1].h;
}
const L = 'ABCDEFGHJKLMNPRSTUVWXYZ';
const plate = () => `U${pick(['A', 'B'])}${pick(L.split(''))} ${Math.floor(rnd(100, 999))}${pick(L.split(''))}`;
const COLORS = ['White', 'Silver', 'Grey', 'Black', 'Blue', 'Red'];
const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function at(day: Date, hour: number, minute: number) {
  const d = new Date(day);
  d.setHours(hour, minute, Math.floor(rnd(0, 59)), 0);
  return d;
}

async function main() {
  const pool = getPool();
  const c: PoolClient = await pool.connect();
  const q = async (sql: string, args: any[] = []) => (await c.query(sql, args)).rows;
  try {
    await c.query('BEGIN');
    const org = (await q(`SELECT org_id FROM staff_users WHERE phone = $1`, [ORG_ADMIN_PHONE]))[0]?.org_id;
    if (!org) throw new Error('Org admin not found — run the normal seed first.');
    const admin = (await q(`SELECT id FROM staff_users WHERE phone = $1`, [ORG_ADMIN_PHONE]))[0].id;

    // ── 1. Remove the previous demo run ──
    const prev = await q(
      `SELECT staff_id, SUM(amount_ugx) AS amt FROM wallet_ledger
        WHERE reason LIKE $1 OR wash_id IN (SELECT id FROM washes WHERE notes = $2)
        GROUP BY staff_id`,
      [`${TAG}%`, TAG]
    );
    for (const r of prev) {
      await q(`UPDATE wallet_accounts SET balance_ugx = balance_ugx - $2, updated_at = now() WHERE staff_id = $1`, [r.staff_id, r.amt]);
    }
    await q(`DELETE FROM wallet_ledger WHERE reason LIKE $1 OR wash_id IN (SELECT id FROM washes WHERE notes = $2)`, [`${TAG}%`, TAG]);
    // Points earned on the previous run's washes: take them back off the accounts, then drop them.
    await q(
      `UPDATE client_points_accounts a SET
         balance = GREATEST(0, a.balance - x.pts), lifetime_earned = GREATEST(0, a.lifetime_earned - x.pts), updated_at = now()
       FROM (SELECT client_id, org_id, SUM(points_delta) AS pts FROM client_points_ledger
              WHERE wash_id IN (SELECT id FROM washes WHERE notes = $1) GROUP BY client_id, org_id) x
       WHERE a.client_id = x.client_id AND a.org_id = x.org_id`,
      [TAG]
    );
    await q(`DELETE FROM client_points_ledger WHERE wash_id IN (SELECT id FROM washes WHERE notes = $1)`, [TAG]);
    await q(
      `UPDATE worker_points_accounts a SET
         points_balance = GREATEST(0, a.points_balance - x.pts), lifetime_earned = GREATEST(0, a.lifetime_earned - x.pts),
         washes_credited = GREATEST(0, a.washes_credited - x.n), updated_at = now()
       FROM (SELECT staff_id, SUM(points_delta) AS pts, COUNT(*) AS n FROM worker_points_ledger
              WHERE wash_id IN (SELECT id FROM washes WHERE notes = $1) GROUP BY staff_id) x
       WHERE a.staff_id = x.staff_id`,
      [TAG]
    );
    await q(`DELETE FROM worker_points_ledger WHERE wash_id IN (SELECT id FROM washes WHERE notes = $1)`, [TAG]);
    // Reviews hold the washes by key; the table only exists once migration 025 has run.
    if ((await q(`SELECT to_regclass('exception_reviews') AS t`))[0].t) {
      await q(`DELETE FROM exception_reviews WHERE wash_id IN (SELECT id FROM washes WHERE notes = $1)`, [TAG]);
    }
    await q(`DELETE FROM washes WHERE notes = $1`, [TAG]);
    await q(`DELETE FROM shifts WHERE notes = $1`, [TAG]);

    // ── 2. Demo branches and their people ──
    let phoneSeq = 0;
    for (const b of NEW_BRANCHES) {
      let branch = (await q(`SELECT id FROM branches WHERE org_id = $1 AND code = $2`, [org, b.code]))[0];
      if (!branch) {
        branch = (await q(
          `INSERT INTO branches (org_id, name, code, address, status, ready_alert_minutes) VALUES ($1,$2,$3,$4,'active',120) RETURNING id`,
          [org, b.name, b.code, b.address]
        ))[0];
      }
      const people = [{ name: b.manager, role: 'manager' }, ...b.workers.map((w) => ({ name: w, role: 'worker' }))];
      for (const p of people) {
        phoneSeq++;
        const username = `demo_${b.code.toLowerCase()}_${p.name.toLowerCase().replace(/[^a-z]/g, '')}`;
        await q(
          `INSERT INTO staff_users (org_id, branch_id, role, full_name, username, phone, status, must_change_password)
           SELECT $1,$2,$3,$4,$5,$6,'active',false
           WHERE NOT EXISTS (SELECT 1 FROM staff_users WHERE username = $5)`,
          [org, branch.id, p.role, p.name, username, `+2567002101${String(phoneSeq).padStart(2, '0')}`]
        );
      }
    }

    const branches = await q(
      `SELECT id, code, name FROM branches WHERE org_id = $1 AND code = ANY($2::text[])`,
      [org, Object.keys(DAILY)]
    );
    // A branch with nobody to wash (a fresh test database) gets two demo workers.
    for (const b of branches) {
      const has = (await q(`SELECT 1 FROM staff_users WHERE branch_id = $1 AND role = 'worker' AND status = 'active' LIMIT 1`, [b.id]))[0];
      if (has) continue;
      for (const name of ['Allan K.', 'Sarah N.']) {
        phoneSeq++;
        await q(
          `INSERT INTO staff_users (org_id, branch_id, role, full_name, username, phone, status, must_change_password)
           SELECT $1,$2,'worker',$3,$4,$5,'active',false
           WHERE NOT EXISTS (SELECT 1 FROM staff_users WHERE username = $4)`,
          [org, b.id, name, `demo_${b.code.toLowerCase()}_${name.toLowerCase().replace(/[^a-z]/g, '')}`, `+2567002101${String(phoneSeq).padStart(2, '0')}`]
        );
      }
    }

    const workersBy = new Map<string, any[]>();
    for (const b of branches) {
      workersBy.set(b.id, await q(
        `SELECT id, full_name FROM staff_users WHERE branch_id = $1 AND role = 'worker' AND status = 'active'
           AND full_name NOT ILIKE '%test%' ORDER BY full_name`,
        [b.id]
      ));
    }
    const prices = await q(
      `SELECT p.id, p.service_id, p.vehicle_class_id, p.price_ugx,
              s.client_points_awarded, s.worker_points_awarded
         FROM prices p
         JOIN services s ON s.id = p.service_id AND s.active
         JOIN vehicle_classes vc ON vc.id = p.vehicle_class_id AND vc.active
        WHERE p.org_id = $1 AND p.branch_id IS NULL AND p.active AND p.price_ugx > 0`,
      [org]
    );
    if (prices.length === 0) throw new Error('No prices set for this organisation.');
    const clients = (await q(`SELECT id FROM clients WHERE org_id = $1 LIMIT 400`, [org])).map((r) => r.id);
    const testClients = (await q(`SELECT id FROM clients WHERE org_id = $1 AND phone = ANY($2::text[])`, [org, TEST_CLIENT_PHONES])).map((r) => r.id);
    // Most washes have a known customer; the test logins get a regular share.
    const clientFor = () => {
      if (Math.random() >= 0.68 || clients.length === 0) return null;
      if (testClients.length && Math.random() < 0.015) return pick(testClients);
      return pick(clients);
    };

    // ── 3. Old test cars still "on the go" for days: clear them ──
    await q(
      `UPDATE washes SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'Cleared for the demo', updated_at = now()
        WHERE org_id = $1 AND status IN ('requested','in_progress','ready') AND COALESCE(started_at, created_at) < now() - interval '6 hours'`,
      [org]
    );

    // ── 4. Old test cash nobody handed in: hand it in, five days ago ──
    const staffIds = (await q(`SELECT id FROM staff_users WHERE org_id = $1 AND role IN ('worker','manager')`, [org])).map((r) => r.id);
    const owed = await cashOwedFor(c, staffIds);
    for (const [id, amt] of owed) {
      if (amt <= 0) continue;
      await post(c, { staffId: id, orgId: org, kind: 'cash_handover', amountUgx: amt, reason: `${TAG}: old test cash handed in`, createdBy: admin });
      await q(`UPDATE wallet_ledger SET created_at = now() - interval '5 days' WHERE staff_id = $1 AND reason = $2`, [id, `${TAG}: old test cash handed in`]);
    }

    // ── 5. Washes ──
    const shiftFor = new Map<string, string>();
    async function shift(branchId: string, workerId: string, day: Date, open: boolean) {
      const key = `${workerId}:${isoDate(day)}`;
      if (shiftFor.has(key)) return shiftFor.get(key)!;
      // One open shift per worker: today reuses the one they already have.
      const already = open ? (await q(`SELECT id FROM shifts WHERE worker_id = $1 AND status = 'open'`, [workerId]))[0] : null;
      if (already) { shiftFor.set(key, already.id); return already.id; }
      const row = (await q(
        `INSERT INTO shifts (org_id, branch_id, worker_id, status, opened_at, closed_at, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [org, branchId, workerId, open ? 'open' : 'closed', at(day, 7, Math.floor(rnd(0, 25))), open ? null : at(day, 19, 5), TAG]
      ))[0];
      shiftFor.set(key, row.id);
      return row.id;
    }

    let count = 0;
    const now = new Date();
    const cashToday: { washId: string; workerId: string; amount: number }[] = [];
    // The last two days' cash, so workers have a handover history: most hand
    // in each evening, and two are still holding yesterday's.
    const cashRecent: { d: number; washId: string; workerId: string; amount: number; at: Date }[] = [];
    const jobSeq = new Map<string, number>();
    const nextJob = (code: string, day: Date) => {
      const k = `${code}:${isoDate(day)}`;
      const n = (jobSeq.get(k) || 900) + 1;
      jobSeq.set(k, n);
      return `${code}-${n}`;
    };

    async function insertWash(o: {
      branch: any; worker: any | null; day: Date; startedAt: Date | null; status: string; createdAt?: Date;
      washDoneAt?: Date | null; settledAt?: Date | null; method?: string | null; shiftId?: string | null;
      unverified?: boolean; dispute?: string | null; origin?: string;
    }) {
      const p = pick(prices);
      const free = o.method === 'free';
      const amount = o.status === 'settled' || o.status === 'disputed' ? (free ? 0 : Number(p.price_ugx)) : null;
      const online = o.method === 'mtn' || o.method === 'airtel';
      const clientId = clientFor();
      const row = (await q(
        `INSERT INTO washes (
           org_id, branch_id, started_by_worker_id, started_shift_id, settled_by_worker_id, settled_shift_id, client_id,
           plate, vehicle_color, service_id, vehicle_class_id, price_id, quoted_amount_ugx, amount_ugx, is_redemption, job_no, status,
           started_at, wash_done_at, settled_at, start_verified, settle_verified, unverified_reason, notes, started_date,
           created_at, requested_at, payment_method, worker_commission_ugx, origin, disputed_at, dispute_reason,
           online_payment_method, paid_online_at, cancelled_at, cancel_reason
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,true,$21,$22,$23,$24,$25,$26,$27,0,$28,$29,$30,$31,$32,$33,$34)
         RETURNING id, amount_ugx`,
        [
          org, o.branch.id, o.worker?.id ?? null, o.shiftId ?? null,
          o.status === 'settled' || o.status === 'disputed' ? o.worker?.id : null,
          o.status === 'settled' || o.status === 'disputed' ? o.shiftId : null,
          clientId,
          plate(), pick(COLORS), p.service_id, p.vehicle_class_id, p.id, Number(p.price_ugx), amount, free,
          nextJob(o.branch.code, o.day), o.status,
          o.startedAt, o.washDoneAt ?? null, o.settledAt ?? null,
          !o.unverified, o.unverified ? 'no_app' : null,
          TAG, isoDate(o.day), o.createdAt ?? o.startedAt, o.createdAt ?? o.startedAt,
          o.status === 'settled' || o.status === 'disputed' ? o.method : null,
          o.origin ?? (Math.random() < 0.55 ? 'client' : 'worker'),
          o.dispute ? o.settledAt : null, o.dispute ?? null,
          online && o.status === 'settled' ? o.method : null, online && o.status === 'settled' ? o.settledAt : null,
          o.status === 'cancelled' ? o.startedAt : null, o.status === 'cancelled' ? pick(['Customer left', 'Wrong car type picked', 'Booked twice']) : null,
        ]
      ))[0];
      count++;
      // Points, as a real settlement earns them: the worker for the work, the customer unless it was free.
      if (o.status === 'settled' && o.worker) {
        await awardWorkerPoints(c, { staffId: o.worker.id, orgId: org, washId: row.id, points: Number(p.worker_points_awarded || 0) });
        if (clientId) {
          await awardClientPoints(c, {
            clientId, orgId: org, washId: row.id, points: Number(p.client_points_awarded || 0), fullyCoveredByPoints: free,
          });
        }
      }
      return row;
    }

    const method = () => {
      const r = Math.random();
      return r < 0.6 ? 'cash' : r < 0.78 ? 'mtn' : r < 0.93 ? 'airtel' : 'free';
    };

    for (let d = 29; d >= 0; d--) {
      const day = new Date(now);
      day.setDate(now.getDate() - d);
      day.setHours(0, 0, 0, 0);
      const isToday = d === 0;
      const wd = day.getDay();
      const dayFactor = wd === 6 ? 1.35 : wd === 0 ? 1.15 : wd === 1 ? 0.85 : 1;
      // Today only up to the hour that has finished.
      const lastHour = isToday ? now.getHours() - 1 : 23;
      if (lastHour < FIRST_HOUR) continue;
      const shareOfDay = isToday
        ? HOUR_WEIGHT.filter((_, i) => FIRST_HOUR + i <= lastHour).reduce((t, w) => t + w, 0) / HOUR_WEIGHT.reduce((t, w) => t + w, 0)
        : 1;

      for (const b of branches) {
        const workers = workersBy.get(b.id) || [];
        if (workers.length === 0) continue;
        const n = Math.round(DAILY[b.code] * dayFactor * rnd(0.82, 1.18) * shareOfDay);
        const cashBy = new Map<string, number>();
        for (let i = 0; i < n; i++) {
          const worker = pick(workers);
          const start = at(day, weightedHour(lastHour), Math.floor(rnd(0, 59)));
          const done = new Date(start.getTime() + minutes(rnd(14, 38)));
          const settled = new Date(done.getTime() + minutes(rnd(2, 12)));
          const shiftId = await shift(b.id, worker.id, day, isToday);
          const r = Math.random();
          // The odd cancellation; a dispute or a payment without the app only now and then this week.
          if (r < 0.01) { await insertWash({ branch: b, worker, day, startedAt: start, status: 'cancelled', shiftId }); continue; }
          if (d <= 2 && r < 0.0115) {
            await insertWash({ branch: b, worker, day, startedAt: start, washDoneAt: done, settledAt: settled, status: 'disputed', method: 'cash', shiftId, dispute: pick(['Customer says it was paid by mobile money', 'Charged for SUV, car is a saloon']) });
            continue;
          }
          const m = method();
          const row = await insertWash({ branch: b, worker, day, startedAt: start, washDoneAt: done, settledAt: settled, status: 'settled', method: m, shiftId, unverified: d <= 6 && r > 0.996 });
          if (m === 'cash') {
            cashBy.set(worker.id, (cashBy.get(worker.id) || 0) + Number(row.amount_ugx));
            if (isToday) cashToday.push({ washId: row.id, workerId: worker.id, amount: Number(row.amount_ugx) });
            else if (d <= 2) cashRecent.push({ d, washId: row.id, workerId: worker.id, amount: Number(row.amount_ugx), at: settled });
          }
        }
        // Close past shifts: expected = cash taken. Nearly all balance; now and then a small difference.
        if (!isToday) {
          for (const [workerId, expected] of cashBy) {
            const sid = shiftFor.get(`${workerId}:${isoDate(day)}`);
            let variance = 0;
            if (d <= 6 && Math.random() < 0.04) variance = pick([-5000, -2000, 2000, 5000]);
            await q(
              `UPDATE shifts SET expected_cash_ugx = $2, counted_cash_ugx = $3, variance_ugx = $4, closed_by = $5 WHERE id = $1`,
              [sid, expected, expected + variance, variance, admin]
            );
          }
        }
      }
    }

    // Always one dispute to test with: yesterday afternoon at the first branch.
    {
      const b = branches.find((x) => x.code === 'NTD') || branches[0];
      const worker = pick(workersBy.get(b.id) || []);
      if (worker) {
        const day = new Date(now);
        day.setDate(now.getDate() - 1);
        day.setHours(0, 0, 0, 0);
        const start = at(day, 15, 20);
        await insertWash({
          branch: b, worker, day, startedAt: start,
          washDoneAt: new Date(start.getTime() + minutes(26)), settledAt: new Date(start.getTime() + minutes(31)),
          status: 'disputed', method: 'cash', shiftId: await shift(b.id, worker.id, day, false),
          dispute: 'Charged for SUV, car is a saloon',
        });
      }
    }

    // ── 6a. The last two days' cash, handed in each evening ──
    const keepers = new Set<string>();
    for (const day of [2, 1]) {
      const rows = cashRecent.filter((x) => x.d === day);
      for (const x of rows) {
        await recordSettlement(c, { washId: x.washId, orgId: org, starterId: x.workerId, settlerId: x.workerId, commissionUgx: 0, cashUgx: x.amount });
        await q(`UPDATE wallet_ledger SET created_at = $2 WHERE wash_id = $1`, [x.washId, x.at]);
      }
      const byWorker = new Map<string, number>();
      rows.forEach((x) => byWorker.set(x.workerId, (byWorker.get(x.workerId) || 0) + x.amount));
      // One person keeps yesterday's cash: the 'holds cash since…' alert, once.
      if (day === 1) [...byWorker.entries()].filter(([, a]) => a >= 40000).slice(0, 1).forEach(([id]) => keepers.add(id));
      const evening = new Date(now);
      evening.setDate(now.getDate() - day);
      let i = 0;
      for (const [id, amt] of byWorker) {
        if (keepers.has(id)) continue;
        const reason = `${TAG}: evening handover ${day}-${i++}`;
        await post(c, { staffId: id, orgId: org, kind: 'cash_handover', amountUgx: amt, reason, createdBy: admin });
        await q(`UPDATE wallet_ledger SET created_at = $2 WHERE staff_id = $1 AND reason = $3`, [id, at(evening, 18, Math.floor(rnd(15, 55))), reason]);
      }
    }

    // ── 6b. Today's cash through the wallet, then a few handovers ──
    for (const t of cashToday) {
      await recordSettlement(c, { washId: t.washId, orgId: org, starterId: t.workerId, settlerId: t.workerId, commissionUgx: 0, cashUgx: t.amount });
    }
    const holders = [...new Set(cashToday.map((t) => t.workerId))];
    const todayOwed = await cashOwedFor(c, holders);
    // Most people hand in at least once by mid-day.
    const handTimes = ['10:20', '10:45', '11:15', '11:40', '12:10', '12:40', '13:05', '13:30', '14:20', '15:10', '16:05', '17:00'];
    let h = 0;
    for (const id of holders) {
      const amt = todayOwed.get(id) || 0;
      if (amt < 20000 || h >= handTimes.length || Math.random() < 0.2) continue;
      const [hh, mm] = handTimes[h].split(':').map(Number);
      const when = at(now, hh, mm);
      if (when > now) continue;
      const part = Math.round((amt * rnd(0.6, 1)) / 1000) * 1000;
      const reason = `${TAG}: handed to manager ${h}`;
      await post(c, { staffId: id, orgId: org, kind: 'cash_handover', amountUgx: part, reason, createdBy: admin });
      await q(`UPDATE wallet_ledger SET created_at = $2 WHERE staff_id = $1 AND reason = $3`, [id, when, reason]);
      h++;
    }

    // ── 7. Cars on the go right now ──
    const live = async (b: any, startedMinsAgo: number, status: string, doneMinsAgo?: number) => {
      const worker = pick(workersBy.get(b.id) || []);
      if (!worker) return;
      const sid = await shift(b.id, worker.id, now, true);
      await insertWash({
        branch: b, worker: status === 'requested' ? null : worker, day: now, status,
        startedAt: new Date(now.getTime() - minutes(startedMinsAgo)),
        createdAt: new Date(now.getTime() - minutes(startedMinsAgo)),
        washDoneAt: doneMinsAgo !== undefined ? new Date(now.getTime() - minutes(doneMinsAgo)) : null,
        shiftId: status === 'requested' ? null : sid, origin: 'client',
      });
    };
    const B = (code: string) => branches.find((x) => x.code === code);
    for (const [code, ago] of [['NTD', 18], ['BGL', 9], ['NJR', 22], ['KRK', 4], ['KBL', 12], ['NTD', 6], ['KRK', 15]] as const) await live(B(code), ago, 'in_progress');
    await live(B('NTD'), 52, 'in_progress'); // the one stuck car
    await live(B('KBL'), 40, 'ready', 18);
    await live(B('BGL'), 30, 'ready', 6);
    await live(B('NJR'), 7, 'requested');
    await live(B('KBL'), 3, 'requested');

    // Points rows carry the time the wash was paid, so history reads true.
    await q(`UPDATE client_points_ledger l SET created_at = w.settled_at FROM washes w WHERE l.wash_id = w.id AND w.notes = $1 AND w.settled_at IS NOT NULL`, [TAG]);
    await q(`UPDATE worker_points_ledger l SET created_at = w.settled_at FROM washes w WHERE l.wash_id = w.id AND w.notes = $1 AND w.settled_at IS NOT NULL`, [TAG]);

    await c.query('COMMIT');
    console.log(`Seeded ${count} washes across ${branches.length} branches, ${cashToday.length} cash washes today, ${h} handovers today.`);
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
