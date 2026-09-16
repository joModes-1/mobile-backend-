# Phase 3 — Shifts (1 day)

Read §2.9, §2.10, §3.3, §4.6 of the spec first, plus `README-phase-guide.md`.

## Why this phase matters

Shift reconciliation is the primary cash control of the whole system. Per-wash rules stop
a worker from changing an amount; only counting the physical notes at the end of the day
catches a worker who recorded a Saloon and washed an SUV. A recurring surplus is the
fingerprint of car-type misclassification; a recurring shortfall is simple theft.

## Scope

**Build:** the `shifts` table and its six endpoints.

**Do NOT build:** washes, tokens, loyalty, reports. One deliberate gap is described in
Step 3.3 and is closed in Phase 4.

## Step 3.1 — Migration

`shifts` exactly as §3.3. The critical line:

```sql
CREATE UNIQUE INDEX one_open_shift_per_worker ON shifts (worker_id) WHERE status <> 'closed';
```

Enforce this in the database, not in application code. Two taps on two devices will
otherwise create two open shifts, and every cash figure afterwards is meaningless.

Note `worker_id` holds a worker **or a manager**: a manager on the forecourt at closing
time ends up holding cash and it needs a drawer (§2.10). Add a check that the referenced
staff member's role is `worker` or `manager`, enforced in the service layer since it needs
a lookup.

**Verify:** open a shift, then attempt a second for the same person, and paste the
constraint error. Confirm the index still permits a new shift after the first is `closed`.

## Step 3.2 — Endpoints

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/shifts/open` | worker, manager | `409 SHIFT_ALREADY_OPEN` if one exists. Branch comes from the token, never the body |
| GET | `/shifts/current` | worker, manager | Own open shift with live totals |
| POST | `/shifts/:id/request-close` | worker, manager | → `pending_close`. Own shift only |
| POST | `/shifts/:id/close` | manager, orgadmin | `{ counted_cash_ugx, notes }`. Computes and snapshots expected and variance |
| GET | `/shifts` | manager, orgadmin | Filters: `branch_id`, `worker_id`, `from`, `to`, `has_variance=true`. Manager locked to own branch |
| GET | `/shifts/:id` | manager, orgadmin | Detail |

Rules that are easy to get wrong:

- **A manager cannot close their own shift.** An orgadmin closes it. Otherwise the person
  holding the cash is the person certifying the count.
- **`request-close` is the worker's action; `close` is the manager's.** Two steps on
  purpose: the worker declares they are done, the manager counts the notes.
- Once `pending_close`, no new washes may be started on that shift (enforced in Phase 4).
- `variance_ugx = counted_cash_ugx - expected_cash_ugx`. Store all three. A positive
  variance is a surplus, and surpluses matter as much as shortfalls here.

## Step 3.3 — The deliberate gap

`expected_cash_ugx` is the sum of washes settled on this shift. **Washes do not exist
yet.** Do not create the table to work around this.

Implement `close` now with a single function, `computeExpectedCash(shiftId)`, that returns
0 with a one-line comment saying Phase 4 fills it in. Everything else about close works:
it accepts the count, computes variance against 0, snapshots, and records who closed it.

Phase 4 has "wire `computeExpectedCash` to the washes table" as an explicit deliverable.
It is listed in both files so it cannot fall between them.

**Why snapshot rather than compute on read:** a reversal in Phase 5 must not silently
rewrite last Tuesday's variance. The figure recorded at close is the figure the manager
signed off on.

## Acceptance tests

```
Open a shift                                         → 200, status open
Open a second shift for the same person              → 409 SHIFT_ALREADY_OPEN
Open a shift after closing the first                 → 200
Worker requests close of own shift                   → 200, pending_close
Worker requests close of someone else's shift        → 403
Worker closes their own shift                        → 403
Manager closes a worker's shift                      → 200, variance stored
Manager closes their own shift                       → 403
Orgadmin closes a manager's shift                    → 200
Close stores expected, counted and variance          → all three columns populated
Close twice                                          → 409
Manager lists shifts for another branch              → 403 or empty
Manager passes another branch_id in the query        → cannot widen the result
Orgadmin of org A reads org B's shifts               → 403 or empty
counted 240000 vs expected 0                         → variance +240000, positive stored
```

## Done when

A worker can open a shift, request close, and a manager can close it with a counted figure
that produces a stored variance; the database refuses a second open shift; and
`computeExpectedCash` exists as a single named function ready for Phase 4 to fill.
