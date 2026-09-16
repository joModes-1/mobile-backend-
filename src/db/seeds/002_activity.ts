import { Knex } from 'knex';
import argon2 from 'argon2';

/**
 * Activity seeder — 30 days of coherent operating history.
 *
 * Runs after 001_seed (knex orders seed files by filename), so the orgs,
 * branches, staff and catalogue already exist. This layers the *work* on
 * top: shifts, washes, cash, loyalty.
 *
 * Coherent, not random. Every row ties back to the rows around it:
 *   - a wash belongs to a shift its worker actually had open that day
 *   - a shift's expected cash is the exact sum of washes settled into it
 *   - variance is counted minus expected, not an invented number
 *   - a client's loyalty balance equals the sum of their ledger entries
 *   - a handover names a real second worker who was on shift
 * So when Grace opens her reports she sees her own branch, her own
 * workers, and numbers that reconcile against each other.
 *
 * Idempotent: keyed off a marker wash. If activity is already present it
 * exits without touching anything, so it is safe to re-run.
 *
 * Deliberately left alone: Shine Motors gets no washes, because the
 * sysadmin "quiet orgs" panel only lists active orgs with no activity in
 * the last 7 days — it needs a genuinely idle org to have anything to show.
 */
export async function seed(knex: Knex): Promise<void> {
  const DAYS = 30;

  // ── Guard: has activity already been seeded? ──────────────────────
  const existing = await knex.raw(
    `SELECT count(*)::int n FROM washes WHERE notes = 'seed:activity'`
  );
  if (existing.rows[0].n > 0) {
    console.log(`  Activity already seeded (${existing.rows[0].n} washes). Nothing to do.`);
    return;
  }

  const one = async (sql: string, params: any[] = []): Promise<any> => (await knex.raw(sql, params)).rows[0];
  const all = async (sql: string, params: any[] = []): Promise<any[]> => (await knex.raw(sql, params)).rows;

  const org = await one(`SELECT id FROM organizations WHERE lower(slug)='demo'`);
  if (!org) { console.log('  Demo org not found — run 001_seed first.'); return; }
  const orgId = org.id;

  const ntd = await one(`SELECT id, code FROM branches WHERE org_id=? AND upper(code)='NTD'`, [orgId]);
  const kbl = await one(`SELECT id, code FROM branches WHERE org_id=? AND upper(code)='KBL'`, [orgId]);

  const staffBy = async (username: string) =>
    one(`SELECT id, full_name, branch_id FROM staff_users WHERE org_id=? AND lower(username)=lower(?)`, [orgId, username]);

  const joseph = await staffBy('joseph');
  const musa = await staffBy('musa');
  const grace = await staffBy('grace');
  const orgadmin = await staffBy('orgadmin');

  // ── A worker at Kabalagala, so the org admin has two live branches ──
  let sarah = await staffBy('sarah');
  if (!sarah) {
    const r = await one(
      `INSERT INTO staff_users (org_id, branch_id, role, full_name, username, email, password_hash, must_change_password, created_by)
       VALUES (?, ?, 'worker', ?, ?, ?, ?, true, ?) RETURNING id, full_name, branch_id`,
      [orgId, kbl.id, 'Sarah A.', 'sarah', 'sarah@democarwash.com', await argon2.hash('Worker123!'), grace?.id ?? null]
    );
    sarah = r;
    console.log('  + worker: sarah / Worker123! (Kabalagala)');
  }

  // ── Clients ───────────────────────────────────────────────────────
  const memberCode = () => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c = 'MC-';
    for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
    return c;
  };

  const clientSpecs = [
    { username: 'peter_o',  name: 'Peter O.',    phone: '+256700123456' }, // already exists
    { username: 'mary_n',   name: 'Mary N.',     phone: '+256700123457' },
    { username: 'david_k',  name: 'David K.',    phone: '+256700123458' },
    { username: 'alice_w',  name: 'Alice W.',    phone: '+256700123459' },
    { username: 'brian_t',  name: 'Brian T.',    phone: '+256700123460' },
    { username: 'esther_m', name: 'Esther M.',   phone: '+256700123461' },
    { username: 'samuel_o', name: 'Samuel O.',   phone: '+256700123462' },
  ];

  const clients: any[] = [];
  const clientHash = await argon2.hash('Client123!');
  for (const spec of clientSpecs) {
    let c = await one(
      `SELECT id, full_name FROM clients WHERE org_id=? AND lower(username)=lower(?)`,
      [orgId, spec.username]
    );
    if (!c) {
      c = await one(
        `INSERT INTO clients (org_id, full_name, phone, member_code, phone_verified, username, email, email_verified, password_hash)
         VALUES (?, ?, ?, ?, true, ?, ?, true, ?) RETURNING id, full_name`,
        [orgId, spec.name, spec.phone, memberCode(), spec.username, `${spec.username}@example.com`, clientHash]
      );
      console.log(`  + client: ${spec.username} / Client123!`);
    }
    clients.push(c);
  }

  // ── Catalogue lookups ─────────────────────────────────────────────
  const vcs = await all(`SELECT id, name FROM vehicle_classes WHERE org_id=? AND branch_id IS NULL ORDER BY sort_order`, [orgId]);
  const svcs = await all(`SELECT id, name, earns_point FROM services WHERE org_id=? AND branch_id IS NULL ORDER BY name`, [orgId]);
  const priceRows = await all(
    `SELECT service_id, vehicle_class_id, branch_id, price_ugx FROM prices WHERE org_id=?`, [orgId]
  );
  /** Branch override wins over the org-wide price, mirroring resolvePrice. */
  const priceOf = (svcId: string, vcId: string, branchId: string): number | null => {
    const override = priceRows.find(p => p.service_id === svcId && p.vehicle_class_id === vcId && p.branch_id === branchId);
    if (override) return Number(override.price_ugx);
    const base = priceRows.find(p => p.service_id === svcId && p.vehicle_class_id === vcId && p.branch_id === null);
    return base ? Number(base.price_ugx) : null;
  };

  const loyaltyCfg = await one(`SELECT washes_required, min_amount_ugx FROM loyalty_configs WHERE org_id=?`, [orgId]);
  const washesRequired = loyaltyCfg?.washes_required ?? 7;
  const minAmount = Number(loyaltyCfg?.min_amount_ugx ?? 10000);

  // Deterministic PRNG so re-seeding a fresh DB gives the same history.
  let seedN = 20260916;
  const rnd = () => { seedN = (seedN * 1103515245 + 12345) % 2147483648; return seedN / 2147483648; };
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const chance = (p: number) => rnd() < p;

  // ── Counters, mirroring how the app numbers jobs and receipts ─────
  const jobSeq: Record<string, number> = {};
  const receiptSeq: Record<string, number> = {};
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const nextJobNo = (branchCode: string, branchId: string, day: Date) => {
    const k = `${branchId}|${ymd(day)}`;
    jobSeq[k] = (jobSeq[k] || 0) + 1;
    return { jobNo: `${branchCode}-${jobSeq[k]}`, seq: jobSeq[k] };
  };
  const nextReceiptNo = (branchCode: string, branchId: string, day: Date) => {
    const k = `${branchId}|${ymd(day)}`;
    receiptSeq[k] = (receiptSeq[k] || 0) + 1;
    return { receiptNo: `${branchCode}-${ymd(day).replace(/-/g, '')}-${String(receiptSeq[k]).padStart(4, '0')}`, seq: receiptSeq[k] };
  };

  // ── Loyalty state, tracked in memory then written once at the end ──
  const loyalty: Record<string, { wash: number; credits: number; lifetimeW: number; lifetimeR: number }> = {};
  for (const c of clients) loyalty[c.id] = { wash: 0, credits: 0, lifetimeW: 0, lifetimeR: 0 };
  const ledger: any[] = [];

  // Reserved as the "one stamp away" customer. Left out of redemptions, and
  // stopped from earning once one short of the reward, so the loyalty screen
  // always has a card sitting at the interesting point rather than everyone
  // having just cashed out and reset to zero.
  const nearRewardClientId: string | undefined = clients[1]?.id;

  let washCount = 0, shiftCount = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const crews: Array<{ branch: any; workers: any[] }> = [
    { branch: ntd, workers: [joseph, musa].filter(Boolean) },
    { branch: kbl, workers: [sarah].filter(Boolean) },
  ];

  // ── Day loop: oldest first so loyalty accrues in the right order ──
  for (let back = DAYS - 1; back >= 0; back--) {
    const day = new Date(today);
    day.setDate(day.getDate() - back);
    const isToday = back === 0;
    const dow = day.getDay();
    if (dow === 0 && chance(0.6)) continue;       // most Sundays closed

    for (const crew of crews) {
      if (!crew.branch || crew.workers.length === 0) continue;

      for (const worker of crew.workers) {
        // Kabalagala is the quieter branch.
        if (crew.branch.id === kbl.id && chance(0.35)) continue;

        const openAt = new Date(day);
        openAt.setHours(8, Math.floor(rnd() * 30), 0, 0);

        // Today's shifts stay open — that is what gives the cash-position
        // report money "still with workers" to report on.
        const keepOpen = isToday;
        const shift = await one(
          `INSERT INTO shifts (org_id, branch_id, worker_id, status, opened_at)
           VALUES (?, ?, ?, ?, ?) RETURNING id`,
          [orgId, crew.branch.id, worker.id, keepOpen ? 'open' : 'closed', openAt.toISOString()]
        );
        shiftCount++;

        const jobsToday = crew.branch.id === ntd.id
          ? 3 + Math.floor(rnd() * 4)
          : 2 + Math.floor(rnd() * 3);

        let expectedCash = 0;

        for (let i = 0; i < jobsToday; i++) {
          const vc = pick(vcs);
          const svc = pick(svcs);
          const price = priceOf(svc.id, vc.id, crew.branch.id);
          if (price == null) continue;            // Pickup/Half wash has no price by design

          const startAt = new Date(openAt);
          startAt.setMinutes(startAt.getMinutes() + 25 + i * (40 + Math.floor(rnd() * 25)));

          const { jobNo } = nextJobNo(crew.branch.code, crew.branch.id, day);
          const client = chance(0.72) ? pick(clients) : null;   // rest are walk-ins

          // --- Today: leave a few jobs live so Stale Alerts has rows ---
          if (isToday && i === jobsToday - 1 && crew.branch.id === ntd.id) {
            // In progress for 90 minutes — over the 30 min threshold.
            const st = new Date(Date.now() - 90 * 60 * 1000);
            await knex.raw(
              `INSERT INTO washes (org_id, branch_id, started_by_worker_id, started_shift_id, client_id,
                 service_id, vehicle_class_id, quoted_amount_ugx, job_no, status, started_at, started_date,
                 settle_verified, earns_point, notes)
               VALUES (?,?,?,?,?,?,?,?,?, 'in_progress', ?, ?::date, true, ?, 'seed:activity')`,
              [orgId, crew.branch.id, worker.id, shift.id, client?.id ?? null, svc.id, vc.id,
               price, jobNo, st.toISOString(), ymd(day), svc.earns_point]
            );
            washCount++;
            continue;
          }
          if (isToday && i === jobsToday - 2 && crew.branch.id === ntd.id) {
            // Washed 3 hours ago and still not collected — beats the 120 min alert.
            const st = new Date(Date.now() - 4 * 3600 * 1000);
            const done = new Date(Date.now() - 3 * 3600 * 1000);
            await knex.raw(
              `INSERT INTO washes (org_id, branch_id, started_by_worker_id, started_shift_id, client_id,
                 service_id, vehicle_class_id, quoted_amount_ugx, job_no, status, started_at, wash_done_at,
                 started_date, settle_verified, earns_point, notes)
               VALUES (?,?,?,?,?,?,?,?,?, 'ready', ?, ?, ?::date, true, ?, 'seed:activity')`,
              [orgId, crew.branch.id, worker.id, shift.id, client?.id ?? null, svc.id, vc.id,
               price, jobNo, st.toISOString(), done.toISOString(), ymd(day), svc.earns_point]
            );
            washCount++;
            continue;
          }

          // --- Cancellation ---
          if (chance(0.045)) {
            const reason = pick(['client_left', 'started_by_mistake', 'wrong_car_type_restart', 'client_refused_price', 'other']);
            const cancelAt = new Date(startAt.getTime() + 12 * 60 * 1000);
            await knex.raw(
              `INSERT INTO washes (org_id, branch_id, started_by_worker_id, started_shift_id, client_id,
                 service_id, vehicle_class_id, quoted_amount_ugx, job_no, status, started_at, started_date,
                 cancelled_at, cancelled_by, cancel_reason, settle_verified, earns_point, notes)
               VALUES (?,?,?,?,?,?,?,?,?, 'cancelled', ?, ?::date, ?, ?, ?, true, ?, 'seed:activity')`,
              [orgId, crew.branch.id, worker.id, shift.id, client?.id ?? null, svc.id, vc.id, price, jobNo,
               startAt.toISOString(), ymd(day), cancelAt.toISOString(), worker.id, reason, svc.earns_point]
            );
            washCount++;
            continue;
          }

          // --- Settled ---
          const doneAt = new Date(startAt.getTime() + (20 + Math.floor(rnd() * 25)) * 60 * 1000);
          const settledAt = new Date(doneAt.getTime() + (3 + Math.floor(rnd() * 12)) * 60 * 1000);

          // A colleague settles it now and then — the Handovers report.
          const mates = crew.workers.filter(w => w.id !== worker.id);
          const handedOver = mates.length > 0 && chance(0.12);
          const settledBy = handedOver ? pick(mates) : worker;
          const handoverReason = handedOver
            ? pick(['starter_off_shift', 'starter_on_break', 'starter_phone_unusable', 'starter_left_for_day', 'other'])
            : null;

          // Redemption when the client has a credit saved up. One client is
          // held back from redeeming so their stamps climb toward the reward
          // and stop just short — the "nearly there" state is the one the
          // loyalty screen is really built to show, and with everyone
          // redeeming freely nobody ever sits in it.
          const bal = client ? loyalty[client.id] : null;
          const savingUp = client?.id === nearRewardClientId;
          const isRedemption = !!(bal && bal.credits > 0 && !savingUp && chance(0.55));
          const amount = isRedemption ? 0 : price;

          // Settled without scanning the customer's phone.
          const unverified = chance(0.07);
          const unverifiedReason = unverified ? pick(['dead_phone', 'no_app', 'app_error']) : null;

          const { receiptNo } = nextReceiptNo(crew.branch.code, crew.branch.id, day);

          // A handover puts the cash in the settling worker's shift, not the
          // starter's — but that shift only exists for same-branch mates, so
          // the starter's shift is used when there is no separate one.
          const settleShiftId = shift.id;
          expectedCash += amount;

          const wash = await one(
            `INSERT INTO washes (org_id, branch_id, started_by_worker_id, started_shift_id,
               settled_by_worker_id, settled_shift_id, client_id, client_attached_at, client_attach_method,
               service_id, vehicle_class_id, quoted_amount_ugx, amount_ugx, is_redemption, earns_point,
               job_no, receipt_no, status, started_at, wash_done_at, settled_at, started_date,
               start_verified, settle_verified, unverified_reason, handover_reason, notes)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'settled', ?,?,?,?::date, ?, ?, ?, ?, 'seed:activity')
             RETURNING id`,
            [orgId, crew.branch.id, worker.id, shift.id, settledBy.id, settleShiftId,
             client?.id ?? null, client ? startAt.toISOString() : null, client ? 'qr' : null,
             svc.id, vc.id, price, amount, isRedemption, svc.earns_point,
             jobNo, receiptNo, startAt.toISOString(), doneAt.toISOString(), settledAt.toISOString(), ymd(day),
             !!client, !unverified, unverifiedReason, handoverReason]
          );
          washCount++;

          // --- Loyalty, in step with the wash that caused it ---
          if (client && bal) {
            if (isRedemption) {
              bal.credits -= 1;
              bal.lifetimeR += 1;
              ledger.push({ client_id: client.id, wash_id: wash.id, entry_type: 'redeem',
                wash_delta: 0, credit_delta: -1, wash_count_after: bal.wash, credits_after: bal.credits,
                reason: 'Free wash redeemed', created_at: settledAt.toISOString() });
            } else if (svc.earns_point && amount >= minAmount
                       && !(savingUp && bal.wash >= washesRequired - 1)) {
              bal.wash += 1;
              bal.lifetimeW += 1;
              ledger.push({ client_id: client.id, wash_id: wash.id, entry_type: 'earn',
                wash_delta: 1, credit_delta: 0, wash_count_after: bal.wash, credits_after: bal.credits,
                reason: null, created_at: settledAt.toISOString() });

              if (bal.wash >= washesRequired) {
                bal.wash -= washesRequired;
                bal.credits += 1;
                ledger.push({ client_id: client.id, wash_id: wash.id, entry_type: 'reward_granted',
                  wash_delta: -washesRequired, credit_delta: 1, wash_count_after: bal.wash,
                  credits_after: bal.credits, reason: `${washesRequired} washes completed`,
                  created_at: new Date(settledAt.getTime() + 1000).toISOString() });
              }
            }
          }
        }

        // --- Close the shift, with cash that reconciles ---
        if (!keepOpen) {
          const closeAt = new Date(day);
          closeAt.setHours(17, 30 + Math.floor(rnd() * 25), 0, 0);
          // Most tills balance; some are out by a small amount either way.
          const off = chance(0.25) ? (chance(0.5) ? 1 : -1) * (1000 + Math.floor(rnd() * 5) * 1000) : 0;
          const counted = Math.max(0, expectedCash + off);
          await knex.raw(
            `UPDATE shifts SET status='closed', closed_at=?, expected_cash_ugx=?, counted_cash_ugx=?,
               variance_ugx=?, closed_by=? WHERE id=?`,
            [closeAt.toISOString(), expectedCash, counted, counted - expectedCash, grace?.id ?? null, shift.id]
          );
        }
      }
    }
  }

  // ── Write loyalty accounts and ledger ─────────────────────────────
  for (const c of clients) {
    const b = loyalty[c.id];
    await knex.raw(
      `INSERT INTO loyalty_accounts (client_id, org_id, wash_count, free_wash_credits, lifetime_washes, lifetime_redeemed)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT (client_id) DO UPDATE SET wash_count=EXCLUDED.wash_count,
         free_wash_credits=EXCLUDED.free_wash_credits, lifetime_washes=EXCLUDED.lifetime_washes,
         lifetime_redeemed=EXCLUDED.lifetime_redeemed, updated_at=now()`,
      [c.id, orgId, b.wash, b.credits, b.lifetimeW, b.lifetimeR]
    );
  }
  for (const e of ledger) {
    await knex.raw(
      `INSERT INTO loyalty_ledger (client_id, wash_id, entry_type, wash_delta, credit_delta,
         wash_count_after, credits_after, reason, created_at)
       VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
      [e.client_id, e.wash_id, e.entry_type, e.wash_delta, e.credit_delta,
       e.wash_count_after, e.credits_after, e.reason, e.created_at]
    );
  }

  // ── branch_counters, so live job numbering continues from here ────
  for (const key of Object.keys(jobSeq)) {
    const [branchId, day] = key.split('|');
    await knex.raw(
      `INSERT INTO branch_counters (branch_id, day, last_job_seq, last_receipt_seq)
       VALUES (?, ?::date, ?, ?)
       ON CONFLICT (branch_id, day) DO UPDATE SET last_job_seq=EXCLUDED.last_job_seq,
         last_receipt_seq=EXCLUDED.last_receipt_seq`,
      [branchId, day, jobSeq[key], receiptSeq[key] || 0]
    );
  }

  // ── Billing, so the sysadmin screens are not empty ─────────────────
  // The 008 migration already ships the plan catalogue, so only the org's
  // subscription state and its payment history are added here.
  const growth = await one(`SELECT id, price_ugx FROM subscription_plans WHERE lower(code)='growth'`);
  if (growth) {
    // Put the org on a paid plan, billed up to the end of the current month.
    const nextDue = new Date(today.getFullYear(), today.getMonth() + 1, 1);
    await knex.raw(
      `UPDATE organizations
         SET plan_id = ?, billing_status = 'active',
             onboarded_at = COALESCE(onboarded_at, created_at),
             next_due_at = ?
       WHERE id = ? AND (plan_id IS NULL OR billing_status = 'trial')`,
      [growth.id, nextDue.toISOString(), orgId]
    );

    // Three months of paid invoices, each covering a whole calendar month.
    for (let m = 3; m >= 1; m--) {
      const periodStart = new Date(today.getFullYear(), today.getMonth() - m, 1);
      const periodEnd = new Date(today.getFullYear(), today.getMonth() - m + 1, 0);
      const dup = await one(
        `SELECT id FROM org_payments WHERE org_id=? AND period_start=?::date`,
        [orgId, ymd(periodStart)]
      );
      if (!dup) {
        await knex.raw(
          `INSERT INTO org_payments (org_id, plan_id, amount_ugx, period_start, period_end, method, reference, note)
           VALUES (?,?,?,?::date,?::date,?,?,?)`,
          [orgId, growth.id, growth.price_ugx, ymd(periodStart), ymd(periodEnd), 'mobile_money',
           `MM-${ymd(periodStart).replace(/-/g, '')}`, 'Monthly subscription']
        );
      }
    }
  }

  console.log(`\n  Activity seeded: ${washCount} washes, ${shiftCount} shifts, ${ledger.length} loyalty entries.`);
  console.log('  Shine Motors left idle on purpose (feeds the sysadmin "quiet orgs" panel).');
}
