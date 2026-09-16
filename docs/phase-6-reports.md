# Phase 6 — Reports (3 days)

Read §4.9 of the spec, plus `README-phase-guide.md`.

## Why after Phase 5, not before

A report written before reversals exist counts reversed washes as revenue. You would
rewrite every query. `status = 'settled'` is only trustworthy once `reversed` and
`disputed` are real.

## The one architectural rule

**Explicit SQL, not the ORM, not a query builder.** These are the queries you will tune,
and the ones a manager will question out loud. You need to be able to read one aloud and
say what it counts. Put each in its own file under `modules/reports/queries/`, named after
its endpoint.

**Every report takes `from` and `to`, and is role-scoped:** an orgadmin sees the whole org,
a manager is silently locked to their own branch (never trust a `branch_id` in the query
for a manager), a worker sees only themselves.

## Scope

**Build:** the twelve report endpoints below, plus the `/platform` aggregates.

**Do NOT build:** any new mutation endpoint, notifications, or schema changes. If a report
needs a column that does not exist, stop and ask rather than adding one.

---

## The operational reports

### `GET /reports/daily?branch_id&date`
The one a manager opens every morning. Washes started, settled, cancelled; gross UGX; cash
expected; breakdowns by car type, by wash type, by worker; redemption count and their
shilling value.

`WHERE status = 'settled' AND settled_at::date = $date`. Redemptions have `amount_ugx = 0`
but a `quoted_amount_ugx`, so report both figures — the second is what the loyalty
programme actually costs.

### `GET /reports/workers?from&to&branch_id`
Per worker: washes started, washes settled, cash taken, car-type mix, cancellation rate,
handovers in both directions, unverified settlements, corrections against them, disputes,
total shift variance.

**Started and settled must be separate columns, never blended.** A worker who started
twelve and settled three had a handover-heavy day; one number hides that entirely.

### `GET /reports/car-type-mix?from&to&branch_id`
Per worker, the share of each car type they recorded, against the bay average, with a
deviation score. Sort by deviation descending.

This is the control for the one leak that survives server-side pricing: washing an SUV and
tapping the Saloon tile. Compute the worker's distribution and the branch's distribution
over the same window, then the sum of absolute differences.

**Include this caveat in the response payload itself**, because whoever reads it will
otherwise treat it as proof: mix legitimately varies by location and shift, so a high score
means go and look, not guilt. It is most useful against the same worker's own history and
against colleagues working the same shifts.

### `GET /reports/cash-variance?from&to`
Every closed shift with a non-zero variance, worst first. **Flag recurring surpluses
separately from shortfalls.** A shortfall is simple theft; a surplus is the fingerprint of
car-type misclassification, because the worker collected SUV money and recorded a Saloon.
Most systems only look for shortfalls and miss the more interesting signal.

### `GET /reports/handovers?from&to&branch_id`
Every settlement where `settled_by_worker_id <> started_by_worker_id`: starter, settler,
reason, amount, plus a rate per worker in each direction. A bay where handovers are routine
does not have unlucky rotas, it has nobody accountable for their own jobs.

### `GET /reports/unverified?from&to&branch_id`
Settlements with `settle_verified = false`, by worker, by reason, as a rate. This is the
softest control in the system — whatever you permit when a client's phone is dead is what a
dishonest worker will claim happened every time. One a week is a flat battery; fifteen is a
worker who has worked out nobody checks. **Report the rate, not the incidents.**

### `GET /reports/cancellations?from&to&branch_id`
Per worker, count and rate by reason. Cancellation is the natural route for an off-book
wash: start it, take the cash, cancel it. Weekly review item.

### `GET /reports/durations?from&to&branch_id`
Average `wash_done_at - started_at` by wash type and car type, and average
`settled_at - wash_done_at` as the collection wait. Use it to quote honest waiting times
and to set each branch's `ready_alert_minutes` from data instead of the 120-minute default.

### `GET /reports/stale?branch_id`
Live, not historical: `ready` washes past `ready_alert_minutes`, and `in_progress` washes
open unusually long. No date range.

### `GET /reports/exceptions?from&to`
The single morning list: cancellations, corrections, disputes, reversals, handovers,
unverified settlements, washes settled with no client attached, stale jobs. One endpoint so
a manager has one thing to open.

---

## The management reports

### `GET /reports/branches?from&to` — orgadmin only
Side-by-side branch comparison: washes, gross, average ticket, variance total, exception
counts. Sortable.

### `GET /reports/price-changes?from&to`
From `audit_logs` where `action = 'price.update'`. Who changed which price, when, from what
to what. This is why Phase 2 was required to write `before` and `after`.

### `GET /reports/loyalty?from&to`
Clients at 5/7 and 6/7 — **that list is a marketing asset, not a statistic**; it is exactly
who to send "one more wash and your next is free" to. Plus credits granted, credits
redeemed, cost of rewards at `quoted_amount_ugx`, and unredeemed liability (outstanding
credits × average wash price), which is a real number the owner should know.

### Platform aggregates — sysadmin only
`GET /platform/stats` and the counts inside `GET /platform/orgs`. Counts and sums only:
orgs, active orgs, branches, washes this month, growth by org. **No endpoint here returns a
wash row, a client record, a phone number, or a shilling figure attributable to a named
customer of a tenant.** Your customers are competing car washes in the same city.

---

## Non-negotiable rules

1. Explicit SQL, one file per report.
2. `status = 'settled'` for all revenue. Never count `disputed` as absent or `reversed` as
   present.
3. Money read from stored `amount_ugx`, never re-resolved against today's prices.
4. A manager cannot widen their scope by passing a `branch_id`. Branch comes from the token.
5. Keyset pagination on anything that can return more than a page.
6. No report may write anything, including a cache table, without asking me first.
7. Platform reports return aggregates only.

## Acceptance tests

```
Reversed wash excluded from daily gross              → excluded
Disputed wash still included in daily gross          → included
Corrected wash uses the corrected amount             → new amount
Redemption: amount 0 and quoted 25000                → both reported, reward cost = 25000
Manager requests another branch's daily              → 403 or own branch, never theirs
Manager passes branch_id of another branch           → cannot widen
Worker requests /reports/workers                     → own row only, or 403
Client token on any report                           → 403
Sysadmin on /reports/daily                           → 403 (org route, platform token)
/platform/stats returns no client or wash rows       → assert shape, no PII
car-type-mix deviation for a worker matching bay avg  → score ~0
car-type-mix for a worker at 80% saloon vs 45% bay    → high score, flagged
cash-variance separates surplus from shortfall        → both present, labelled
handovers rate counts both directions per worker      → given and received distinct
unverified report returns a rate, not just a list     → rate present
durations from a wash with known timestamps           → arithmetic matches
loyalty: client at 6/7 appears in the marketing list  → present
unredeemed liability = credits × avg price            → arithmetic matches
Empty date range                                      → 200 with zeros, never 500
Date range spanning a price change                    → historical amounts unchanged
```

## Done when

A manager can answer "how did Ntinda do yesterday and is anyone stealing" from two
endpoints, an orgadmin can compare branches, every figure traces to stored amounts rather
than recomputed prices, and no report can be widened past the caller's scope.
