# Phase 5 — Exceptions: Corrections, Reversals, Disputes (2 days)

Read §2.11, §3.4 (the correction/dispute/reverse columns), §3.5 (the reversal paragraph)
and §4.7 of the spec, plus `README-phase-guide.md`.

## Why these are four different things

Collapsing them into one "edit wash" endpoint is the most common way this kind of system
loses its audit trail. They differ in who acts and what happens to loyalty:

| | Who | When | Loyalty |
|---|---|---|---|
| **Cancel** (Phase 4) | worker | before payment | nothing to undo |
| **Correct** | manager | after payment | **untouched** — the wash did happen |
| **Dispute** | client | within 24h | frozen until resolved |
| **Reverse** | manager | after payment | **compensating entry** — the wash should not exist |

The line that matters: recording a Saloon when it was an SUV is a **correction**, because
the car was washed. A wash that never happened is a **reversal**. Getting this wrong means
either wiping loyalty points from honest customers or leaving points from fictional washes.

## Scope

**Build:** correct, reverse, dispute, resolve-dispute, and the orgadmin's manual loyalty
adjustment.

**Do NOT build:** any report endpoint (Phase 6), real notifications (Phase 7 — keep using
the `notify` stub).

---

## Step 5.1 — Correction

#### `POST /washes/:id/correct` — manager only

```json
{ "vehicle_class_id": "uuid", "service_id": null, "reason": "recorded as saloon, was an SUV" }
```

1. Wash must be `settled`. A `disputed` wash is corrected through resolve-dispute instead.
2. Re-resolve the price with `resolvePrice` for the **new** car type and service, at the
   wash's branch. Null → `422 NO_PRICE_SET`. Do not accept an amount from the request.
3. Store `original_amount_ugx` and `original_vehicle_class_id` **only on the first
   correction**, so the original survives a second correction.
4. Update `amount_ugx`, `vehicle_class_id`, `service_id`, `price_id`, `corrected_at`,
   `corrected_by`.
5. Audit-log with full `before` and `after`.
6. **Do not touch loyalty.** The client washed a car and earned a point either way.

The knock-on effect worth understanding: correcting an amount changes what that shift
*should* have collected, but the shift's `expected_cash_ugx` was snapshotted at close. That
is deliberate — the manager signed off on a figure and history does not move underneath
them. If the shift is still open, expected recomputes naturally on close.

**Verify:** correction re-resolves the price rather than trusting input; a second
correction does not overwrite `original_amount_ugx`; loyalty balance identical before and
after; correcting an unsettled wash → 409; a worker attempting it → 403; an already-closed
shift's stored variance is unchanged.

---

## Step 5.2 — Reversal

#### `POST /washes/:id/reverse` — manager only

```json
{ "reason": "wash was never done, recorded in error" }
```

Status `settled` → `reversed`. Reason mandatory. Never a delete. In one transaction, with
`SELECT ... FOR UPDATE` on the loyalty account.

**The reversal algorithm — the fiddliest code in the project:**

```
Read the ledger entries for this wash.

IF the wash had a `redeem` entry THEN
   refund the credit:  free_wash_credits += 1
   INSERT ledger (reversal, credit_delta = +1)

IF the wash had an `earn` entry THEN
   wash_count -= 1
   IF wash_count < 0 THEN
      -- this earn had rolled over into a granted reward
      IF free_wash_credits >= 1 THEN
         free_wash_credits -= 1
         wash_count += washes_required
         INSERT ledger (reversal, wash_delta = -1, credit_delta = -1)
      ELSE
         -- the credit was already SPENT on another wash. Do not go negative.
         wash_count = 0
         INSERT ledger (reversal, wash_delta = -1,
                        reason = 'credit already redeemed; shortfall absorbed')
      END IF
   ELSE
      INSERT ledger (reversal, wash_delta = -1)
   END IF
```

That last branch is the case to think about carefully. A client reached seven washes, got a
credit, spent it on a free wash, and then one of the seven is reversed. You cannot claw
back a free wash they already received. The balance stays non-negative, the ledger records
exactly what happened and why, and the business absorbs one free wash. The `non_negative_ck`
constraint is your safety net — if it ever fires, your logic is wrong, so do not remove it.

**Verify:** reversal of a plain paid wash → count -1; reversal of the 7th wash where the
credit is unspent → credit removed and count restored to 6; reversal of the 7th where the
credit was spent → count floored at 0, no negative, ledger reason recorded; reversal of a
redemption → credit refunded; reversing twice → 409; the ledger read back explains the
final balance arithmetically.

---

## Step 5.3 — Dispute

#### `POST /washes/:id/dispute` — client only

```json
{ "reason": "amount_wrong", "note": "I was told 15,000" }
```

- Caller must be the wash's client. Within 24 hours of `settled_at` → else `422`.
- `settled` → `disputed`. Sets `disputed_at`, `dispute_reason`.
- `notify(manager, 'wash_disputed', ...)`.
- **The wash still counts in revenue while disputed.** Deliberate: the day's figures must
  not move under a manager who has already closed a shift. Resolution is what changes money.

Reason list: `amount_wrong`, `service_wrong`, `car_type_wrong`, `never_washed`,
`already_paid`, `other`.

#### `POST /washes/:id/resolve-dispute` — manager only

```json
{ "resolution": "uphold" | "correct" | "reverse", "vehicle_class_id": null, "note": "..." }
```

- `uphold` → back to `settled`, nothing else changes.
- `correct` → runs the Step 5.1 path, then back to `settled`.
- `reverse` → runs the Step 5.2 path.
- Always sets `resolved_at`, `resolved_by`, and audit-logs the decision with the note.

**Verify:** dispute at 23h59 → 200, at 24h01 → 422; another client disputing → 403; a
worker resolving → 403; disputing a `reversed` wash → 409; each of the three resolutions
lands the wash in the right status with the right loyalty effect.

---

## Step 5.4 — Manual loyalty adjustment

#### `POST /clients/:id/loyalty/adjust` — orgadmin only

```json
{ "wash_delta": 1, "credit_delta": 0, "reason": "wash 12 Aug recorded on wrong account" }
```

Reason mandatory. Writes a `manual_adjust` ledger entry with `created_by`. Row-locked.
Cannot push either balance negative.

This exists because reality will need it: a wash recorded against the wrong client, a
goodwill gesture, a migration error. Restricting it to orgadmin and forcing a reason is
what stops it becoming the way managers hand out free washes to friends. Phase 6 reports
every use of it.

**Verify:** manager attempting it → 403; an adjustment that would go negative → 422; the
ledger entry names the actor and the reason.

---

## Non-negotiable rules

1. **A correction is not a reversal.** Correction keeps the point; reversal removes it.
2. **Never delete a wash or a ledger row.** Status changes plus compensating entries only.
3. **A correction re-resolves the price server-side.** No amount is ever accepted from a
   request, here or anywhere.
4. **The loyalty account can never go negative.** If `non_negative_ck` fires, fix the
   logic, do not drop the constraint.
5. **A closed shift's stored variance never changes** because of a later correction or
   reversal.
6. **Every one of these five endpoints writes an audit row** with `before` and `after`.
7. Row-lock the loyalty account for every mutation.

## Acceptance tests

```
Correct a settled wash                             → price re-resolved, loyalty unchanged
Correct twice                                      → original_amount_ugx from the FIRST
Correct an in_progress wash                        → 409
Worker corrects                                    → 403
Reverse a plain paid wash                          → wash_count -1
Reverse the 7th wash, credit unspent               → credit -1, wash_count restored to 6
Reverse the 7th wash, credit already spent         → wash_count floored at 0, reason logged
Reverse a redemption                               → credit refunded to the client
Reverse twice                                      → 409
Client disputes within 24h                         → 200, status disputed
Client disputes at 24h + 1 min                     → 422
A different client disputes                        → 403
Disputed wash still appears in revenue             → included until resolved
Resolve uphold / correct / reverse                 → correct status and loyalty each time
Orgadmin adjusts loyalty with a reason             → ledger row with actor and reason
Orgadmin adjusts without a reason                  → 422
Manager adjusts loyalty                            → 403
Adjustment that would go negative                  → 422
Closed shift variance after a reversal             → unchanged
Ledger replay equals loyalty_accounts for a client → matches exactly
```

That last test is the one to keep forever: sum the ledger deltas for a client and assert
they equal the cached account row. If those ever diverge, something is writing the account
directly and the module boundary has been broken.

## Done when

Every exception path is exercised, the reversal-with-spent-credit case is proven not to
produce a negative balance, and a ledger replay reconciles exactly with every cached
account row.
