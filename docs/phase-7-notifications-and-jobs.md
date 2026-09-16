# Phase 7 — Notifications and Background Jobs (2 days)

Read §2.4, §2.10, §3.6 (`devices`) of the spec, plus `README-phase-guide.md`.

Phases 4 and 5 called a `notify(...)` stub that logged and returned. This phase makes it
real. Nothing above depends on it, which is why it comes late.

## The rule that matters most

**A notification failure must never fail the operation that triggered it.** If Expo is down
or a push token is stale, the wash still settles and the point is still issued. Send after
the database transaction commits, never inside it, and swallow-and-log every send error.

The failure mode to avoid: a worker cannot take payment because a notification service in
another country is having a bad day.

## Scope

**Build:** the `notify` module, device registration lifecycle, the five notifications, and
four cron jobs.

**Do NOT build:** SMS for anything other than OTP (that is Phase 1's provider slot), email,
in-app inbox, or notification preferences. Those are v2.

---

## Step 7.1 — Device lifecycle

`POST /me/device` with `{ push_token, platform }`, for staff and clients alike.

**Shared handsets are normal in this business**, so the lifecycle is the interesting part:

- **On login**, upsert the `devices` row so the token points at the current user.
- **On logout**, delete the row and revoke that device's refresh token.

Miss this and Joseph logs into Grace's phone, goes home, and Joseph's "your job was
collected" notifications keep arriving on Grace's handset (rule 5d).

`devices.push_token` is uniquely indexed, which is what makes the upsert-on-login work:
one physical device, one owner at a time.

**Verify:** login on a device registered to another user moves the row; logout deletes it
and revokes the refresh token; a send to a deleted token does not error the caller.

---

## Step 7.2 — The five notifications

Every one goes through one function so payloads stay consistent and testable:

```
notify(recipient, event, payload)
```

| Event | To | When | Content |
|---|---|---|---|
| `wash_started` | client | scan 1 | wash type, car type, **amount**, branch. Their record of the quote, 35 minutes before money moves |
| `ready_for_collection` | client | worker taps Done | car is ready |
| `paid` | client | settlement | amount paid, new wash count, dispute link valid 24h |
| `reward_earned` | client | on `reward_granted` | "your next wash is free" — fires alongside `paid`, not instead of it |
| `job_collected_by` | staff | handover settlement | job no, plate, amount, who collected it |

Three client notifications per wash plus the occasional reward is enough to be useful and
not enough to be muted. Do not add more without asking.

`wash_started` is doing real work, not being polite: it is the client's only record of the
agreed price before they pay. Get the amount into it.

**Verify:** each event fires exactly once per trigger; `reward_earned` fires only on the
7th wash; `job_collected_by` fires only on a handover; a stale token logs and does not
raise; settlement still succeeds with the push service unreachable (test by pointing it at
a dead URL).

---

## Step 7.3 — Background jobs

Use `node-cron`. Every job must be **idempotent** — it will run twice one day.

### `staleWashAlerts.js` — every 15 minutes
Find `ready` washes older than the branch's `ready_alert_minutes`, notify the branch
manager. **Track what has already been alerted** so a car left overnight does not alert
every fifteen minutes until morning; one alert per wash, or escalate once after a long
interval.

### `purgeTokens.js` — nightly
Delete `client_tokens` rows that are consumed or expired and older than 7 days. They have
no value after the fact and the table would otherwise grow forever.

### `expireCredits.js` — nightly, only if `loyalty_configs.credit_expiry_days` is set
Expire free wash credits older than the window. **Write a `manual_adjust` ledger entry with
reason `credit_expired`**, never a silent decrement, or the ledger stops explaining the
balance. Notify the client a few days before, not on the day.

If `credit_expiry_days` is null, the job must do nothing at all. That is still the
undecided default (open question 4).

### `nightlySummary.js` — 6am
Push each manager their branch's previous-day one-liner: washes, gross, variance,
exceptions. Cheap to build, and it is what makes managers actually open the app.

**Verify:** each job run twice in a row produces the same end state; `expireCredits` writes
a ledger row and the account still reconciles with a ledger replay; `staleWashAlerts` does
not re-alert the same wash.

---

## Non-negotiable rules

1. A notification failure never fails the triggering operation.
2. Send after commit, never inside the transaction.
3. Login reassigns the device's push token; logout deletes it and revokes the refresh token.
4. Every job idempotent.
5. Credit expiry writes a ledger entry — never a silent balance change.
6. All five notifications go through the one `notify` function.

## Acceptance tests

```
Push service unreachable, settle a wash            → 200, wash settled, error logged
Push token stale/rejected, settle a wash           → 200, row cleaned or flagged
wash_started payload contains the amount           → present
paid payload contains new wash count               → present
reward_earned fires on wash 7 only                 → once, alongside paid
job_collected_by fires only on handover            → not on a normal settle
Login on another user's device                     → devices row moves
Logout                                             → row deleted, refresh revoked
staleWashAlerts run twice                          → one alert per wash
purgeTokens run twice                              → same end state
expireCredits with credit_expiry_days null         → no rows touched
expireCredits expiring a credit                    → ledger entry, replay reconciles
nightlySummary for a branch with no washes         → sends zeros, does not crash
```

## Done when

A full wash produces three client notifications with correct content, a handover notifies
the absent worker, every job is safe to run twice, and killing the push service does not
stop a single payment from being taken.
