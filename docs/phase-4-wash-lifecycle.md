# Phase 4 — The Wash Lifecycle (4 days). THE PROJECT.

Read §2.1 through §2.11, §3.1 (`client_tokens`), §3.4, §3.5, §4.7, §4.8 and all of §5.
Then read `README-phase-guide.md`.

This is the phase where money and loyalty are written in the same database transaction.
Everything before it was setup and everything after it is CRUD. Do not proceed past a
"mostly working" step here. Budget four days and expect five.

## Scope

**Build:** `washes`, `client_tokens`, `branch_counters`, `loyalty_configs`,
`loyalty_accounts`, `loyalty_ledger`, and the start → done → settle lifecycle including
handovers, cancellation, and the client-facing read endpoints.

**Do NOT build:** corrections, reversals, disputes (Phase 5), any report endpoint
(Phase 6), push notifications (Phase 7). Where a notification belongs, call a
`notify(...)` stub that logs and returns; Phase 7 makes it real.

## The flow you are implementing

```
T+0   worker picks car type + wash type, price shows          nothing created yet
T+2   client taps "Start wash" → QR;  worker scans            → IN_PROGRESS, price locked
T+35  worker taps "Done"                                      → READY
T+40  client taps "Pay now" → QR;    worker scans             → SETTLED, point issued
```

Two scans, both of a code the **client** generates. The static `member_code` is a fallback
for manual lookup only, never payment proof: a static code can be photographed by a worker
and replayed forever (§2.6).

---

## Step 4.1 — Migrations

All six tables from §3.4 and §3.5, plus `client_tokens` from §3.1. Order matters because
`client_tokens.wash_id` references `washes`:

`washes` → `client_tokens` → `branch_counters` → `loyalty_configs` → `loyalty_accounts` → `loyalty_ledger`

Constraints that carry real weight:

```sql
-- one point per wash, even if the settle call is retried
CREATE UNIQUE INDEX ON loyalty_ledger (wash_id, entry_type) WHERE wash_id IS NOT NULL;

-- a settled wash always has an amount and a shift
CONSTRAINT settled_has_amount_ck CHECK (
  status <> 'settled' OR (amount_ugx IS NOT NULL AND settled_shift_id IS NOT NULL)
)

-- balances can never go negative
CONSTRAINT non_negative_ck CHECK (wash_count >= 0 AND free_wash_credits >= 0)

-- job numbers unique per branch per day
CREATE UNIQUE INDEX ON washes (branch_id, job_no, (started_at::date));

-- a retried start cannot queue the same car twice
CREATE UNIQUE INDEX ON washes (started_by_worker_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- pay tokens must name their wash
CONSTRAINT pay_token_needs_wash_ck CHECK (purpose <> 'pay' OR wash_id IS NOT NULL)
```

**Verify:** migrate up/down/up, then prove each constraint above by attempting the
violation in psql and pasting the error.

---

## Step 4.2 — The `tokens` module, first

Nothing else in this phase works without it. No other module touches `client_tokens`.

**Issue:** 32 random bytes, base64url. Store **only** the sha256. The raw value is
returned once and lives in the QR for 3 minutes and nowhere else. TTL 3 minutes.

**Consume — this exact shape:**

```sql
UPDATE client_tokens SET consumed_at = now(), consumed_by = $worker
WHERE token_hash = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
RETURNING client_id, wash_id;    -- 0 rows → 409 BAD_TOKEN
```

A conditional UPDATE, never select-then-update. Two workers scanning the same screen would
both pass a select-then-check, and you would create two washes or settle twice.

Client endpoints:

| Method | Path | Notes |
|---|---|---|
| POST | `/me/washes/start-token` | The **Start wash** button. `{ token, expires_at }`. Rate limit 5 per 10 min |
| POST | `/me/washes/:id/pay-token` | The **Pay now** button. Wash must be `ready` and belong to the caller, else 422. Token bound to this wash |

**Verify:** expired token rejected; consumed token rejected on second use; two concurrent
consumes of one token → exactly one succeeds (run this as a real concurrent test, not two
sequential calls); a `pay` token requested for a wash not yet `ready` → 422; a `pay` token
requested for someone else's wash → 403.

---

## Step 4.3 — Start a wash

#### `POST /washes`

```json
// Header: Idempotency-Key: <uuid from the device, one per tap>
{
  "start_token": "8f3aQ7xR2m...",   // null for a walk-in with no app
  "service_id": "uuid",             // omit → the org's is_default service
  "vehicle_class_id": "uuid",
  "plate": "UBH 123J",              // optional
  "use_free_wash": false
}
```

**There is no amount field. The request cannot express a price.** If you find yourself
adding one, stop and re-read §5 rule 2.

Sequence:

1. Caller must have an `open` shift (not `pending_close`) → `409 NO_OPEN_SHIFT`.
2. Resolve service (default if omitted). Validate service and car type belong to the
   caller's org and are `active`.
3. `resolvePrice(service, carType, callerBranch)` from Phase 2. Null → `422 NO_PRICE_SET`
   naming the combination in `details`. **Never 0, never a substitute price.**
4. If `start_token`: consume it. Client must be in the caller's org. Set
   `client_attach_method = 'start_token'`, `start_verified = true`.
5. If `use_free_wash`: require `free_wash_credits >= 1`, set `is_redemption = true`.
   **Do not consume the credit yet** — settlement consumes it, so a client who drives off
   keeps their reward.
6. Insert `status = 'in_progress'`, `quoted_amount_ugx` from step 3, `price_id`,
   `earns_point` snapshotted from the service.
7. Bump `branch_counters.last_job_seq`, set `job_no` = `<branch.code>-<seq>`.
8. Duplicate check: another `in_progress`/`ready` wash at this branch with the same car
   type and service where either row lacks a plate → include `duplicate_warning` in the
   response. **This never blocks the start.**
9. `notify(client, 'wash_started', ...)` — stub in this phase.

Response carries `wash_id`, `job_no`, `quoted_amount_ugx`, service and car type names, the
client's current loyalty figures, and `duplicate_warning` if any.

**Verify:** no open shift → 409; unpriced combination → 422 with the names in `details`;
same `Idempotency-Key` twice → one wash; expired start token → 409; walk-in with no token
→ starts with no client; `use_free_wash` with 0 credits → 422; with 1 credit → flagged and
the credit still 1 in `loyalty_accounts`.

---

## Step 4.4 — Queue and mark done

#### `GET /washes/queue`

The worker's home screen. Two arrays, `washing` and `ready`, each row carrying `job_no`,
plate, car type, wash type, `quoted_amount_ugx`, client name or `null` for a walk-in,
elapsed minutes, and a `stale` boolean for `ready` rows past the branch's
`ready_alert_minutes`.

Job numbers exist because receipt numbers do not yet: a car being washed has no receipt,
and `NTD-7` is something a worker can shout across a forecourt.

#### `POST /washes/:id/wash-done`

`in_progress` → `ready`. Sets `wash_done_at`. No money, no loyalty. Callable by any staff
member at that branch, not only the starter. `notify(client, 'ready_for_collection', ...)`.

**Verify:** `wash-done` from `ready` → 409; from another branch → 409 WRONG_BRANCH; the
queue returns only the caller's own jobs; a `ready` row older than the threshold has
`stale: true`.

---

## Step 4.5 — Settlement. The heart of the system.

#### `POST /washes/settle-by-token` — the default path

```json
{ "pay_token": "Q4mZ8k1pW...", "handover_reason": null, "handover_note": null }
```

Consume the token, read the `wash_id` it is bound to, settle that wash through the same
code path as below. The worker never picks a row, so two identical SUVs in the queue cannot
be confused (§2.7). Wrong branch → `409 WRONG_BRANCH`.

#### `POST /washes/:id/settle` — a specific job

```json
{
  "pay_token": "Q4mZ8k1pW...",
  "unverified_reason": null,   // required ONLY if pay_token absent: dead_phone | no_app | app_error
  "handover_reason": null,     // required if the caller did not start this wash
  "handover_note": null
}
```

Sequence, **all of it in one database transaction:**

1. Status must be `ready` → `409 BAD_STATE`. Settling from `in_progress` is forbidden, so
   `wash_done_at` is always real.
2. Caller needs an open shift at the wash's branch → `409 NO_OPEN_SHIFT` / `409 WRONG_BRANCH`.
3. If the caller did not start this wash and no `handover_reason` given →
   `409 HANDOVER_CONFIRM_REQUIRED` carrying the starter's name and the job details, and
   **do not consume the token**. The app confirms with the worker and retries with a reason.
4. If `pay_token`: consume it, require `purpose='pay'` and its `wash_id` to match this
   wash and its `client_id` to match the wash's client. Mismatch →
   `409 CLIENT_MISMATCH` **with the details of the job it does belong to**, and again
   **do not consume it** — the client must not have to tap Pay twice because the worker
   opened the wrong row. Set `settle_verified = true`.
5. If no `pay_token`: require `unverified_reason` → else `422 REASON_REQUIRED`. Settle with
   `settle_verified = false`. The client still earns their point; a flat battery is not
   their fault.
6. Set `amount_ugx` = 0 if `is_redemption` else `quoted_amount_ugx`. Set
   `settled_by_worker_id`, `settled_shift_id` (**the settler's shift, not the starter's**),
   `settled_at`, status `settled`.
7. Bump `branch_counters.last_receipt_seq`, set `receipt_no` =
   `<branch.code>-<YYYYMMDD>-<4-digit seq>`.
8. Loyalty, if a client is attached:

```
SELECT * FROM loyalty_accounts WHERE client_id = $c FOR UPDATE;   -- row lock, mandatory

IF is_redemption THEN
   require free_wash_credits >= 1                    -- else 422 NO_CREDITS
   free_wash_credits -= 1;  lifetime_redeemed += 1
   INSERT ledger (redeem, credit_delta = -1)
ELSIF earns_point AND amount_ugx >= min_amount_ugx THEN
   wash_count += 1;  lifetime_washes += 1
   INSERT ledger (earn, wash_delta = +1)
   IF wash_count >= washes_required THEN
      wash_count -= washes_required
      free_wash_credits += 1
      INSERT ledger (reward_granted, credit_delta = +1)
   END IF;
END IF;
```

9. `notify(client, 'paid', ...)`; if a handover, `notify(starter, 'job_collected_by', ...)`.

The `(wash_id, entry_type)` unique index makes step 8 idempotent under a retry. Rely on it
rather than on checking first.

**Verify — this is the block that matters most:**

```
Settle from in_progress                              → 409 BAD_STATE
Settle twice                                         → 409, exactly one point, one receipt
Pay token for a different client                     → 409 CLIENT_MISMATCH, token NOT consumed
Pay token bound to a different wash                  → 409 with that job's details
The same token then works on the correct job          → 200
No token, no unverified_reason                       → 422 REASON_REQUIRED
No token plus a reason                               → 200, settle_verified false, point still awarded
Settle from another branch                           → 409 WRONG_BRANCH
Two concurrent settles, same client, two washes      → both succeed, total exactly +2
Settling wash 7                                      → one credit granted, wash_count back to 0
Redemption                                           → one credit consumed, no point earned
Redemption with 0 credits                            → 422
Client attached only at settle                       → point awarded
Walk-in, no client                                   → settles, no ledger rows
Receipt numbers sequential per branch per day        → no gaps from cancelled jobs
```

Run the concurrency case as genuinely parallel requests. Sequential calls prove nothing
about the row lock.

---

## Step 4.6 — Handover

Already wired in step 4.5 point 3. What must also hold:

- Cash lands in the **settler's** shift; the wash count credits the **starter**.
- `handover_reason` from a fixed list: `starter_off_shift`, `starter_on_break`,
  `starter_phone_unusable`, `starter_left_for_day`, `other` with a note.
- A manager with an open shift can settle a worker's job under the same flow.
- A borrowed phone is **not** a handover: if the worker is present they log in as
  themselves on the other device and the settlement is ordinary (§2.10, rule 5c).

**Verify:** all four bullets, plus that the starter is notified via the stub.

---

## Step 4.7 — Cancel and attach

| Method | Path | Notes |
|---|---|---|
| POST | `/washes/:id/cancel` | `{ reason, note? }` from the fixed list. `in_progress` or `ready` only. Never after settlement |
| POST | `/washes/:id/attach-client` | `{ start_token }`, or `{ member_code }` for manual lookup which sets `start_verified = false`. For a walk-in who installs the app while waiting |

Cancel reasons: `client_left`, `started_by_mistake`, `wrong_car_type_restart`,
`client_refused_price`, `other`. Cancellation is the natural route for an off-book wash
(start it, take the cash, cancel it), which is why the reason is mandatory and why Phase 6
reports the rate per worker.

**Verify:** cancel from `settled` → 409; cancel of a redemption job leaves the credit
intact; a cancelled job keeps its `job_no` and never gets a `receipt_no`.

---

## Step 4.8 — Read endpoints

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/washes/:id` | involved parties | |
| GET | `/washes` | worker/manager/orgadmin | Role-scoped. Filters: branch, worker, client, car type, status, from, to. Keyset paginated |
| GET | `/washes/mine/today` | worker | **Three separate figures:** started and settled by me; started by me, settled by another (with who and why); started by another, settled by me. Never one blended number |
| GET | `/clients/lookup?member_code=&phone=` | worker | Minimal: id, name, wash count, credits. No history, no phone in the response |
| POST | `/clients` | worker | Register a client at the bay: phone plus name, unverified, claimable later by OTP |
| GET | `/me/washes/active` | client | Live status of the wash in progress |
| GET | `/me/washes` | client | Own history |
| GET | `/me/loyalty` | client | Progress and credits |
| GET | `/me/loyalty/ledger` | client | Why the number is what it is |
| GET | `/me/qr` | client | Static `member_code`, fallback lookup only |

---

## Step 4.9 — Close the Phase 3 gap

Wire `computeExpectedCash(shiftId)` to sum `amount_ugx` of washes where
`settled_shift_id = shiftId AND status = 'settled'`. Phase 3 left it returning 0.

Then enforce: **a shift cannot close while its holder has `in_progress` washes.** `ready`
jobs may be left behind — they carry no cash and another worker can settle them under the
handover flow.

**Verify:** a shift with settled washes closes with the right expected figure; a shift with
an `in_progress` wash → 409; a shift with only `ready` washes closes fine.

---

## Non-negotiable rules

1. No amount field on any request. Ever.
2. `resolvePrice` null → 422. Never 0, never a fallback.
3. `quoted_amount_ugx` locked at start, never recomputed.
4. Cash to `settled_shift_id`; wash count to `started_by_worker_id`.
5. Row-lock the loyalty account with `FOR UPDATE` before mutating it.
6. Credit consumed at settlement, never at start.
7. A token is consumed by conditional UPDATE, and never consumed on a failed match.
8. Cannot settle from `in_progress`.
9. `job_no` at start, `receipt_no` at settlement. Two sequences.
10. Settlement and the ledger write are one transaction, or you will hand out free washes
    you cannot explain.

## Done when

A worker can run five cars through the full lifecycle in one shift, one of them a
redemption, one a walk-in, one a handover, one settled without a token; the loyalty ledger
explains every balance; every test above passes in one command; and no test needed to be
weakened to get there.
