# Phase 10 — End-to-End System Verification

Run this only when phases 1 through 8 are complete. Read `README-phase-guide.md` and
`carwash-loyalty-backend-spec.md` first.

This is not a new feature phase. It proves that the phases, built weeks apart, actually
work as one system. Most of what you find here will be seams between phases, not bugs
inside them.

---

## The loop

```
CYCLE:
  1. TEAR DOWN    drop and recreate the era92 database from zero
  2. MIGRATE      knex migrate:latest
  3. SEED         the fixture in §2
  4. RUN          every act in order, TO THE END
                    - an assertion failure is recorded, not thrown
                    - the run continues past it
                    - unless it is a HARD STOP (see below)
  5. REPORT       the full failure list, classified (see below)
  6. FIX          every INDEPENDENT failure, in the code
  7. GO TO 1      full teardown. Never resume a run, never re-run one act
REPEAT until a cycle finishes with zero failures.
THEN run two more complete cycles. Done after THREE CONSECUTIVE clean cycles.
```

**Run to the end, then fix in a batch.** One cycle that surfaces twelve failures is worth
far more than twelve cycles that each surface one, and unrelated bugs in Act 8 should not
stay hidden behind a bug in Act 4.

**But always re-run from step 1 after fixing.** Never patch and resume mid-run. After a
failure the database holds half-finished state, so an act that passes against dirty data
proves nothing, and a fix in Act 6 can break Act 2 without you noticing.

### Classify every failure before fixing anything

```
INDEPENDENT  the assertion failed on its own terms          → fix it
CASCADED     it failed only because an earlier act failed   → do NOT fix, do NOT touch
BLOCKED      it could not run at all (its prerequisite      → do NOT fix, mark and move on
             data does not exist)
```

This classification is the whole reason batching is safe. If wash 1 never settles, then
every arithmetic assertion in Act 6 fails too — that is **one** bug, not fourteen. An agent
that "fixes" fourteen things has almost certainly broken something to make the numbers
match. Report the counts separately: *4 independent, 11 cascaded, 3 blocked*.

When you are unsure whether a failure is independent or cascaded, treat it as cascaded and
let the next cycle tell you. If it survives the next cycle after its suspected cause is
fixed, it is independent.

### Hard stops — abort the cycle immediately

Continuing past these produces pure noise, so stop, fix, and start a new cycle:

- A migration fails, or migrate up/down/up is not clean
- The seed fixture does not complete
- Sysadmin, orgadmin, manager, worker or client **cannot log in at all**
- The server will not boot, or crashes rather than returning an error envelope
- Any 500 from an endpoint that should return a 4xx (a crash, not a rejection)

Everything else is recorded and the run continues.

### The convergence rule

**The independent-failure count must strictly decrease every cycle.**

```
cycle 1:  9 independent   → fix all 9
cycle 2:  3 independent   → fine, converging; fix
cycle 3:  0               → clean, start the confirmation runs
```

If a cycle produces **more** independent failures than the one before, or the same ones
reappear after being fixed, **stop and report**. Do not keep cycling. That pattern means a
fix caused a regression, or two "fixes" are fighting each other, and more cycles will bury
the cause rather than reveal it. Report which failures are new, which recurred, and what
you changed between the two cycles.

Likewise, if the same assertion fails in three consecutive cycles despite being fixed each
time, stop and report. Something in your model of the system is wrong and another attempt
will not fix it.

### The harness has to support this

Your test runner must collect failures rather than exit on the first one, and an act whose
prerequisite is missing must report `BLOCKED` rather than throw. Practically: no bare
`assert` that aborts the process, and each act wrapped so its own exception is recorded and
the next act still runs. Get this working before cycle 1, or the loop above cannot happen.

## What "fix the code" means, and what it does not

You will be tempted to make things green. These are the ways people do it, and all of them
are forbidden here:

- **Never change an assertion to match what the code produced.** If the code says 90,000
  and this file says 113,000, one of them is wrong and you must work out which. If you
  believe this file has an arithmetic error, stop and tell me — do not adjust it yourself.
- **Never delete, skip, comment out or mark pending a failing test.**
- **Never add a `sleep` or a retry to make a concurrency test pass.** That converts a real
  race into an intermittent one.
- **Never widen a permission to make a request succeed.** A 403 that should be a 403 is a
  passing test.
- **Never relax a database constraint.** If `non_negative_ck` fires, your loyalty logic is
  wrong. The constraint is the test.
- **Never seed data mid-run** to get past a failure.

At the end, produce a diff of every test file against its state at the start of this phase,
and justify each change. Zero changes is the expected answer.

---

## §2 The seed fixture

Exact values, because Act 9 asserts exact arithmetic.

**Platform:** one sysadmin (from env).

**Org A — "Sparkle Wash"** (`slug: sparkle`)

| Branch | Code | Notes |
|---|---|---|
| Ntinda | NTD | has price overrides |
| Kabalagala | KBL | org defaults only |

**Staff:** Diana (orgadmin, no branch), Robert (manager, NTD), Joseph (worker, NTD),
Amina (worker, NTD), Moses (manager, KBL), Julius (worker, KBL).

**Car types:** Saloon (1), SUV (2), Pickup (3).
**Services:** Full wash (`is_default`, earns_point), Half wash (earns_point),
Engine (`earns_point = false`).

**Org default prices (UGX):**

| | Full | Half | Engine |
|---|---|---|---|
| Saloon | 20,000 | 12,000 | 8,000 |
| SUV | 30,000 | 18,000 | 10,000 |
| Pickup | 35,000 | **no price** | 12,000 |

**Ntinda overrides:** Saloon Full 25,000, SUV Full 35,000. Nothing else.

Pickup + Half wash is deliberately unpriced everywhere, to prove `422 NO_PRICE_SET`.

**Loyalty config:** `washes_required = 7`, `min_amount_ugx = 10,000`, no expiry.

**Clients:** Musa, Peter, Sarah. Then, using `POST /clients/:id/loyalty/adjust` as Diana
(which also exercises Phase 5), set **Musa to 6 washes** and **Peter to 1 credit**. Sarah
starts empty.

**Two rules the spec leaves implicit. Decide them this way, and make the code match:**

1. **`manual_adjust` does not touch `lifetime_washes` or `lifetime_redeemed`.** Those count
   real washes only. Seeding Musa to 6 therefore leaves his `lifetime_washes` at 0, which is
   why Act 6 expects 2 rather than 8.
2. **A reversal decrements `lifetime_washes`.** The wash did not happen, so it should not
   sit in a lifetime total. "Lifetime" here means real washes, not rows ever written; the
   ledger keeps the full history either way.

If you disagree with either, say so before you start rather than coding the other way.

**Org B — "Shine Motors"** (`slug: shine`), one branch, one orgadmin, one worker. Exists
only to prove tenant isolation.

---

## §3 Act 1 — Provisioning, as sysadmin

Assert: seeded sysadmin must change password before any other route works; creating Org A
returns a temp password exactly once and it logs Diana in; `GET /platform/orgs` shows both
orgs with correct branch and staff counts; `GET /platform/stats` returns **no** wash rows,
client records or phone numbers; a sysadmin token on `/reports/daily` → 403; a staff token
on any `/platform` route → 403.

## §4 Act 2 — Setup, as orgadmin and manager

Assert: Diana creates both branches, all car types, all services, the full org price
matrix; `GET /prices` `missing` array contains **exactly one** entry, Pickup + Half wash;
Robert sets the two Ntinda overrides; Robert attempting to set a Kabalagala override → 403;
Robert attempting an org-wide price → 403; Joseph attempting any price write → 403; two
services with `is_default` → constraint rejects; every price write produced an audit row
with `before` and `after`.

`GET /prices/effective?branch_id=NTD` must show Saloon Full at **25,000** (override) and
Saloon Half at **12,000** (default), and Pickup Half with `has_price: false`.

## §5 Act 3 — The reset ladder

The single most important block in the system. Assert every line:

```
Robert resets Joseph (own branch)              → 200
Robert resets Julius (other branch)            → 403
Robert resets Moses (another manager)          → 403 + audit row
Robert resets Diana (orgadmin)                 → 403 + audit row
Diana resets Robert                            → 200
Diana resets Org B's orgadmin                  → 403
Sysadmin resets Diana                          → 200
Sysadmin resets self                           → 403
After any reset, the target's old refresh token → 401
Target must change password before any route   → 403 PASSWORD_CHANGE_REQUIRED
```

## §6 Act 4 — The business day at Ntinda

Joseph and Amina each open a shift. Then, in this order:

| # | Client | Car | Wash | Price | Started | Settled | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Musa | SUV | Full | 35,000 | Joseph | Joseph | Musa 6→7, **reward granted** |
| 2 | Sarah | Saloon | Half | 12,000 | Joseph | **Amina** | handover, reason `starter_on_break` |
| 3 | Peter | Saloon | Full | quoted 25,000, charged **0** | Joseph | Joseph | redemption, credit 1→0 |
| 4 | walk-in | Pickup | Full | 35,000 | Joseph | Joseph | no client, no points |
| 5 | Sarah | Saloon | Engine | 8,000 | Joseph | Joseph | `earns_point=false` **and** below min: no point |
| 6 | Musa | Saloon | Full | 25,000 | Joseph | Joseph | settled with **no pay token**, `unverified_reason: dead_phone` |
| 7 | — | Pickup | Half | — | Joseph | — | must fail `422 NO_PRICE_SET` |
| 8 | Sarah | SUV | Full | 35,000 | Joseph | — | **cancelled**, reason `client_left` |

Assertions during the day:

- Wash 1: the client taps Start, Joseph scans; the price locks at 35,000 (the override, not
  30,000). Musa's reward fires: `wash_count` 0, `free_wash_credits` 1.
- Wash 2: Amina settling Joseph's job → first call `409 HANDOVER_CONFIRM_REQUIRED` and the
  **token is not consumed**; the retry with a reason succeeds using **the same token**. Cash
  lands in **Amina's** shift; the wash count credits **Joseph**. Joseph is notified.
- Wash 3: `amount_ugx = 0`, `quoted_amount_ugx = 25,000`, one credit consumed, **no point
  earned**.
- Wash 5: no ledger row at all. Two independent reasons, so also verify a Saloon Engine at
  a hypothetical 15,000 still earns nothing (`earns_point=false` alone is sufficient).
- Wash 6: `settle_verified = false`, and **Musa still earns his point**.
- Wash 7: the error names the service and car type in `details`.
- Wash 8: keeps its `job_no`, never receives a `receipt_no`, and Sarah's balance is untouched.
- Marking done then settling: settling straight from `in_progress` → `409 BAD_STATE`.
- Job numbers `NTD-1` … `NTD-8` with no gaps. Receipt numbers `NTD-<date>-0001` …
  `NTD-<date>-0006` in settlement order, with **no number consumed by wash 7 or 8**.
- Two identical cars: start two unplated SUV Full washes; the second returns
  `duplicate_warning` and still succeeds. Then `settle-by-token` resolves the correct one.

## §7 Act 5 — Exceptions

In this order, and the order matters:

1. **Musa disputes wash 6** within the window → `disputed`. Assert it **still counts** in
   `GET /reports/daily` gross while disputed.
2. **Robert resolves it as a correction**: recorded Saloon, actually SUV. Price re-resolves
   to **35,000** (the Ntinda override). `original_amount_ugx = 25,000` stored. **Musa's
   loyalty is unchanged.** Status back to `settled`.
3. **Joseph requests close; Robert closes his shift.** Expected =
   35,000 + 0 + 35,000 + 8,000 + 35,000 = **113,000**. Counted 113,000 → variance **0**.
4. **Amina requests close; Robert closes hers.** Expected = **12,000**. Counted 15,000 →
   variance **+3,000**, and it must be reported as a **surplus**, distinctly from a shortfall.
5. **Robert reverses wash 2** (12,000, Sarah's point) — after Amina's shift is closed.
   Sarah 1/7 → 0/7. **Amina's stored variance must still read +3,000.**
6. Try to close a shift with an `in_progress` wash → 409. Confirm a shift with only `ready`
   washes closes fine.
7. Robert attempting a loyalty adjustment → 403. Diana with no reason → 422.

## §8 Act 6 — Final state, exact arithmetic

```
Musa    wash_count 1   credits 1   lifetime_washes 2   lifetime_redeemed 0
Peter   wash_count 0   credits 0   lifetime_washes 0   lifetime_redeemed 1
Sarah   wash_count 0   credits 0   lifetime_washes 0   lifetime_redeemed 0

  Musa   : seeded 6/7 by adjust (no lifetime effect) + w1 earn -> 7 -> reward
           (count 0, credits 1) + w6 earn -> count 1. Two real earns -> lifetime 2.
  Sarah  : w2 earn -> 1/7, w5 no earn, w2 reversed -> 0/7 and lifetime back to 0.
  Peter  : redemption only. No earn, one credit consumed.

Ntinda daily gross (settled, excluding reversed)          113,000
  = 35,000 + 0 + 35,000 + 8,000 + 35,000
Reward cost (quoted value of redemptions)                  25,000
Washes started 10   settled 6   cancelled 1   reversed 1
Unverified settlements 1        Handovers 1
```

**The invariant to keep forever:** for every client, the sum of `loyalty_ledger`
`wash_delta` and `credit_delta` must equal the cached `loyalty_accounts` row exactly. Run
it for all three clients. If it diverges, something is writing the account directly and the
module boundary has been broken.

Also assert: no wash has `status = 'settled'` with a null `amount_ugx` or null
`settled_shift_id`; no `loyalty_accounts` row is negative; every settled wash has exactly
one `earn` or one `redeem` ledger entry, never both and never two.

## §9 Act 7 — Tenant and scope isolation

For **every** endpoint built in every phase, assert Org B's orgadmin gets 403 or empty —
never Org A's data. Test all verbs, not just the list endpoints: GET, PATCH, POST and every
`/:id` route. A UUID is not an authorisation check, and this is the act most likely to find
a real hole.

Then the permission sweep: produce a table with every endpoint as a row and the five actor
types as columns, filled with the actual observed status code. Every cell must match the
spec. Attach the table to your report.

Also: Moses (KBL manager) must not see a single Ntinda wash, shift, price or report row,
and must not be able to widen his scope by passing `branch_id=NTD` in any query.

## §10 Act 8 — Concurrency and idempotency

Genuinely parallel requests. Two sequential calls prove nothing.

```
Same start token scanned by two workers at once   → exactly one wash created
Same pay token submitted twice at once            → exactly one settlement, one point
Same Idempotency-Key twice                        → one wash
Two settlements for one client at once            → both succeed, total exactly +2
Two shift-opens for one worker at once            → exactly one shift
Two concurrent job_no bumps at one branch         → no duplicate job numbers
Settle the same wash from two devices at once     → one 200, one 409
```

## §11 Act 9 — Resilience

```
Push service unreachable → settle a wash          → 200, wash settled, error logged
Kill the DB mid-request                           → 503 envelope, no crash, recovers
Missing env var at boot                           → refuses to start, names the var
Malformed JSON body                               → 400 envelope, not an HTML stack trace
Unknown route                                     → 404 envelope
Expired access token                              → 401, refresh works
Revoked refresh token                             → 401
Suspend Org A mid-session                         → existing tokens 403 ORG_SUSPENDED
Reactivate Org A                                  → works again
Restore last night's backup into a scratch DB     → this whole suite passes against it
```

## §12 The fix log

Maintain this throughout and include it in your final report:

| # | Cycle | Act | Class | Symptom | Root cause | Fix (file, line) | Phase that owned the bug |
|---|---|---|---|---|---|---|---|

Only `INDEPENDENT` rows should have a fix. If a `CASCADED` row has one, explain why.

The last column matters: a cluster in one phase tells us where to look harder next time,
and bugs found here are usually in the **seams** — a Phase 6 report reading a Phase 5
column it does not understand, a Phase 4 status the Phase 3 close check does not know about.

## §13 Exit criteria

- Three consecutive clean cycles from an empty database, all three pasted in full.
- The per-cycle failure counts, showing a strictly decreasing independent count.
- Zero assertions modified, or every modification justified and approved by me.
- The permission table complete, all five actor types, every endpoint.
- The ledger-replay invariant passing for all three clients on all three runs.
- A restored backup passing the whole suite.
- The fix log complete, including anything you chose not to fix and why.

Report after **cycle 1** before starting any fixes, so I can see the raw failure count and
the classification. Then report after every cycle: counts, what you fixed, and the diff of
any test file you touched (expected: none).
