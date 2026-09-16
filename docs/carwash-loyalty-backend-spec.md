# Car Wash Loyalty & Cash Collection Platform
## Backend-First Technical Specification

**Stack:** React Native (Expo) · Node.js (Express) · PostgreSQL
**Currency:** UGX, stored as integers (no decimals)
**Scope:** data model, lifecycle, API surface, business rules, build order. Frontend is deliberately last.

**Revision: v3.3 · 27 Aug 2026.** The wash is a job with a lifecycle: quote → start → washing → done → collect and pay. Prices are set by manager/orgadmin per service and car type; the worker never enters an amount. The client generates a fresh single-use QR by tapping a button in their app at each of the two hand-off moments (§2.6). Payment is collected by scanning first and letting the token find the job, so two identical cars in the queue cannot be confused (§2.7). Handovers, where the worker who started a job is absent when the client pays, are an explicit flow with a reason and a notification (§2.10).

---

## 1. Decisions locked

| Decision | Choice |
|---|---|
| Client accounts | Clients install the app, self-register, hold one QR, see their points and live wash status |
| Loyalty unit | Per client, regardless of which vehicle they bring |
| Reward rule | 7 paid washes → 1 free wash credit |
| Payment | Cash only in v1, collected at car collection |
| Pricing | Set by orgadmin per service × car type, overridable per branch by the manager. Read-only to the worker |
| Amount entry | **None. There is no amount field anywhere in the worker app** |
| Scans | **Two, both of a client-generated single-use QR: one when the wash starts, one at payment.** Valid 3 minutes, one use, bound to the action |
| Tenancy | `org_id` on every row from day one |
| Structure | Platform → Orgs → Branches (bays) → Workers. Clients belong to an org |

### Roles

| Role | Scope | Can do |
|---|---|---|
| `sysadmin` | Whole platform | Every org and its bays, headline counts per org. Create/suspend orgs, create an org's first `orgadmin`. Cannot see washes, clients or loyalty data |
| `orgadmin` | Whole org | All branches, all reports, set car types, services and prices, create managers, set loyalty rules |
| `manager` | One branch | Branch price overrides, create/suspend workers in own branch, close shifts and count cash, correct/reverse washes, review cancellations, branch reports |
| `worker` | One branch | Open/close own shift, quote from the price list, start washes, run their queue, mark done, take payment. Cannot set or change any price |
| `client` | Self | Own QR, own points, live status of their current wash, own history, dispute a wash |

**`sysadmin` is a platform role, not an org role.** It lives in its own table with its own login endpoint and its own JWT type, and it is deliberately thin: an inventory and provisioning view, not an operational one.

The reason for the separation is that `org_id` scoping is load-bearing here. Every org query filters on the `org_id` in the JWT, and `staff_users.org_id` is `NOT NULL` precisely so that filter can never be satisfied by accident. A sysadmin sitting in `staff_users` would need a null `org_id`, and the first handler that forgets to special-case it either returns nothing or drops the filter and returns everything for everybody.

What sysadmin deliberately cannot do, and why it matters once this is SaaS: read a tenant's washes, clients, phone numbers or revenue detail. Your customers are competing car washes in the same city, and "the platform owner can read my daily takings" is a real objection at signup. Aggregate counts are enough for billing and support. Time-boxed, orgadmin-approved impersonation belongs in v2; the audit table already supports it.

Managers are created by orgadmins. Workers are created one by one by a manager (or orgadmin), who is handed a username and a temporary password. `must_change_password` forces a change on first login. There is no public staff signup.

---

## 2. The wash lifecycle

### 2.1 The timeline

```
TIME    PHYSICAL                          WORKER APP                     CLIENT PHONE
──────────────────────────────────────────────────────────────────────────────────────
T+0     Drives in, asks the price         New wash screen:
                                          tap car type → SUV
                                          tap wash type → Full wash
                                          → "UGX 25,000" appears
                                          reads it out / turns phone round
                                          (nothing created yet)

T+2     Agrees, hands over keys           tap START WASH                 taps START WASH
                                          → camera opens                 → QR pops up:
                                          scan the client's screen         "Show this to
                                          → PRICE LOCKED                    the attendant"
                                          → job enters the queue
                                                                         then push:
                                                                         "Full wash, SUV
                                                                          UGX 25,000
                                                                          Ntinda. Started."

T+3..35 Washing. Phone in pocket.         (job sits in the queue)        app shows
                                                                         "Washing..."

T+35    Car finished, parked              tap DONE                       push:
                                          → status: ready                "Your car is ready
                                                                          for collection"

T+40    Returns, inspects, pays cash      open the job in the queue      taps PAY NOW
        Worker gives change               tap SCAN, camera opens         → QR pops up,
        Client drives off                 scan the client's screen         bound to this wash
                                          → verify token + client
                                          → confirm cash received        then push:
                                          → SETTLE                       "Paid 25,000.
                                          → point issued, receipt no.     Washes 5/7"
```

The client's phone is needed at two moments and nowhere else: it is not needed while the car is being washed, and no screen on the worker's side ever sits waiting on a network reply from it. The two taps are local and instant. What happens when the phone is dead at collection is covered in §2.6.

### 2.2 State machine

```
                        ┌─────────────┐
  start token + START ──►│ IN_PROGRESS │
                        └──────┬──────┘
                               │ tap DONE
                        ┌──────▼──────┐
                        │    READY    │  car washed, waiting for the client
                        └──────┬──────┘
                               │ pay token + SETTLE (cash received)
                        ┌──────▼──────┐
                        │   SETTLED   │  point issued, receipt assigned
                        └──────┬──────┘
                               │
              ┌────────────────┼─────────────────┐
              │                │                 │
    client disputes     manager corrects   manager reverses
      (within 24h)      (wrong car type)    (never happened)
              │                │                 │
        ┌─────▼────┐     back to SETTLED    ┌────▼─────┐
        │ DISPUTED │     amount re-resolved │ REVERSED │
        └─────┬────┘     loyalty untouched  └──────────┘
              │
     manager resolves → SETTLED or REVERSED

  IN_PROGRESS or READY ──worker cancels with a reason──► CANCELLED
```

Six statuses. Loyalty points are issued only on the transition into `SETTLED`, in the same database transaction as the ledger write.

### 2.3 What the worker sees

Four screens. The first one is where the whole quote-and-start interaction happens.

**1. New wash — the home screen.** A two-step cascade, car type first, because the worker is standing in front of the car and already knows what it is. What they have to ask is which wash.

```
┌─ NEW WASH ──────────────────────────────┐
│                                         │
│  1. WHAT CAR?                           │
│   ┌────────┐┌────────┐┌────────┐        │
│   │ Saloon ││  SUV ✓ ││ Pickup │        │
│   └────────┘└────────┘└────────┘        │
│   ┌────────┐┌────────┐                  │
│   │  Van   ││ Truck  │                  │
│   └────────┘└────────┘                  │
│                                         │
│  2. WHICH WASH?                         │
│   ┌──────────────┐┌──────────────┐      │
│   │ Full wash ✓  ││  Half wash   │      │
│   │   25,000     ││    15,000    │      │
│   └──────────────┘└──────────────┘      │
│   ┌──────────────┐┌──────────────┐      │
│   │  Interior    ││    Engine    │      │
│   │   18,000     ││ — no price — │      │
│   └──────────────┘└──────────────┘      │
│                                         │
│      SUV · Full wash                    │
│         UGX 25,000                      │
│                                         │
│  Plate (optional): [ UBH 123J    ]      │
│                                         │
│   ┌───────────────────────────────┐     │
│   │       START WASH  ▸ scan      │     │
│   └───────────────────────────────┘     │
└─────────────────────────────────────────┘
```

Once a car type is picked, every wash tile shows its own price for that car at this branch, so the worker can answer "and how much for a half wash?" without navigating anywhere. Combinations with no price set are shown greyed with "no price", never as zero and never tappable.

The price appears the moment both are selected. The worker reads it out or turns the phone round. **The Start button is not pressed until the client agrees.** Nothing has been created yet at this point; the worker can change the car type or wash type freely, or walk away, and no record exists.

No search field and no filters. Five car types by four wash types is twenty combinations and two taps. Revisit only if an org ever exceeds roughly eight car types or ten services, at which point add search to the wash-type step only.

**2. The scan.** Tapping **Start wash** opens the camera directly. One tap, not two. The worker scans the code the client has just produced with their own **Start wash** button. A successful scan is the commit: the wash is created, the price is locked, and the job appears in the queue. Afterwards a summary line confirms what was created, with the job reachable in the queue if something was wrong.

On the camera screen there is one secondary option: **Client has no app.** That starts the wash immediately with no client attached. It runs normally and earns no points.

**3. Queue tab.** Two sections:

```
        ┌──────────────────────────────────┐
        │      SCAN PAYMENT  ▸ camera      │   ← the default way to collect
        └──────────────────────────────────┘

WASHING (3)
  NTD-7   UBH 123J   SUV · Full wash · 25,000    Musa K.     18 min
  NTD-8   UAX 891K   Saloon · Half wash · 8,000  walk-in      6 min
  NTD-9   UBG 442M   Pickup · Full wash · 30,000 Grace N.     2 min

READY FOR COLLECTION (2)
  NTD-5   UAP 220C   Saloon · Full wash · 20,000 Peter O.    ready 12 min
  NTD-6   UBB 771D   SUV · Interior · 15,000     walk-in     ready 41 min  ⚠
```

The elapsed timers are what stop a job being forgotten. A `ready` job past the branch threshold is flagged here and on the manager's exceptions report.

**Mark done** is one tap from a `WASHING` row. No money involved. Sets `wash_done_at` and pushes "your car is ready" to the client.

**Take payment** normally starts from the **Scan payment** button at the top, not from a row: the client's code carries the job it belongs to, so the app finds the right one. The amount shows for confirmation, the worker confirms cash received, and the receipt number and new balance appear. Tapping a `READY` row directly also works, and is needed for a walk-in with no app; if the scanned code turns out to belong to a different job, the error names that job and offers to switch (§2.7).

**4. Price list tab.** The full table for this branch, every car type against every wash type. Secondary, for when a client asks about a car that isn't in front of you, or a worker wants to check the whole board. Cached on the device, so it answers "how much?" even on a weak signal. Starts nothing.

**5. My shift.** Washes done, cash expected, breakdown by car type, and the request-close button.

There is no amount field on any screen. If a price is wrong the worker cannot fix it; the manager changes the price, or corrects the record afterwards.

### 2.4 What the client sees

Three push notifications per wash, which is enough to be useful and not enough to be spam:

1. **At start:** service, car type, amount, branch. This is their record of the quote, on their own phone, 35 minutes before any money moves.
2. **When done:** car is ready for collection.
3. **At payment:** amount paid, new wash count, and a "not right?" dispute link valid for 24 hours.

In the app, two buttons and nothing else to learn:

- **Start wash** — at the bay, before handing over the keys. Produces a QR headed "Show this to the attendant", valid 3 minutes, one use.
- **Pay now** — on the page of the wash that is ready. Produces a second QR, bound to that specific wash.

Deliberately not called "book": nothing is being reserved and no time slot exists. The client is standing at the bay.

Also in the app: their points progress, a live view of the wash currently in progress, their history, and their static member code for the rare case where a worker has to look them up by hand.

### 2.5 Pricing, owned by manager and orgadmin

```
orgadmin sets org-wide prices  ──►  apply to every branch
                                       │
manager sets a branch override ──►  applies to that branch only, wins over the org price
```

- One figure per **(service, car type, branch)**. No minimum, no maximum, no adjustment reason, no override PIN.
- The orgadmin defines the car types (Saloon, SUV, Pickup, Van, Truck) and the services (Full wash, Half wash, Interior only, Engine). Both are org-level.
- A manager may override any price for their own branch, because Ntinda and Kabalagala genuinely do not charge the same.
- Resolution: branch-specific row if one exists, otherwise the org default. Neither → `422 NO_PRICE_SET` naming the combination. The worker's grid greys out car types with no price rather than allowing a zero.
- If an org runs one service, mark it `is_default = true` and the start flow collapses to car type only.
- Every price change is audit-logged with the old and new figure and who made it.

**The price is locked when the job starts.** `quoted_amount_ugx` is snapshotted at scan 1. If the orgadmin raises SUV full wash to 30,000 at noon, a car quoted 25,000 at 11:40 still settles at 25,000. This is the main structural reason to create the record at the start of the wash rather than at the end.

### 2.6 Why the client generates the code, and what is still leaky

**Why the client generates the code, rather than the worker scanning a static one.**

An earlier draft of this spec had the worker scan the client's permanent member QR and claimed that proved the client was present. That was wrong. A static code can be photographed once by a worker and reused indefinitely, so it proves nothing about who is standing on the forecourt.

A code the client produces by tapping a button is different. It is generated on demand, expires in 3 minutes, works once, and is bound to one action on one wash. Producing it requires the client to unlock their own phone at that moment. That is what makes it evidence.

There is a second property worth naming. The client tapping **Pay now** is them asserting "I am paying." The worker scanning it is them asserting "I received it." That is the mutual confirmation v1 tried to build with a blocking handshake and a polling loop, except here both acts happen within ten seconds, face to face, with nothing waiting on a network round trip from a stranger's phone.

**Scan 1 also buys the client a record of the quote** on their own phone before any money moves. If the tile said 25,000 and they expected 15,000, they raise it while the car is still dry.

**Structurally impossible now:** typing a smaller amount. The request has no amount field, and the price came from a table only management can write to. This was the biggest hole in every earlier version.

**Still possible, and how each is caught:**

| Leak | Control |
|---|---|
| Off-book wash: never started in the app at all | The client wants their point. No scan, no point, and they complain. The loyalty programme is your auditor, free |
| Car-type misclassification: SUV washed, Saloon recorded | Shows as a **surplus** at shift close, every time. Plus the car-type mix report (§4.9) comparing each worker against their bay's average |
| Cancel-after-payment: start the job, take the cash, cancel it | The client tapped a button at start, so they were notified and get no point. Cancellations are a monitored per-worker rate with a mandatory reason, reviewed by the manager |
| Abuse of the dead-phone fallback | Unverified settlements require a reason and are a per-worker rate on the exceptions report. See below |

**The dead-phone fallback, and why it is the weak point.** If the client's battery is flat at collection, nothing can be scanned. The worker may still settle, but must attach the client by manual lookup, pick a reason, and the wash is stored with `settle_verified = false` and an `unverified_reason`. The client still earns their point, because they are a real customer and should not be punished for a flat battery.

Be clear-eyed about this: whatever you permit when there is no phone is exactly what a dishonest worker will claim happened every time. The control is not the rule, it is the rate. One unverified settlement a week is a flat battery. Fifteen is a worker who has worked out that unverified settlements are unchecked. `GET /reports/exceptions` shows the rate per worker, and it belongs in the manager's weekly review next to cancellations.

The tighter alternative is requiring a manager PIN for any unverified settlement. It is more secure and it will block a paying customer from leaving whenever the manager is off site, so it is specced as an option rather than the default (§9).

### 2.7 Telling two identical cars apart

Two SUVs in the queue, both full wash, both 25,000. A client walks up to pay. Which row is theirs? This is the most common way a bay-floor system gets confused, so it is worth solving properly rather than relying on the worker remembering.

**The fix is to invert the order: scan first, let the app find the job.**

The pay token is bound to one specific `wash_id` (§3.1). So the worker does not need to pick the right row at all. The queue has a single **Scan payment** button at the top; the worker taps it, scans whatever the client shows, and the app opens the correct job. Two identical cars stop being a problem because the worker never chooses between them.

The per-row path still exists, because it is needed for a walk-in with no app where there is nothing to scan, and it is sometimes just what the worker wants. But scan-first is the default and the one to put front and centre.

**When the worker does open the wrong row, the rejection has to be useful.** A bare `409 CLIENT_MISMATCH` tells a worker holding two identical SUVs nothing. The error carries the details of the job the token actually belongs to, so the app can offer the fix in one tap:

```json
{ "ok": false, "error": {
    "code": "CLIENT_MISMATCH",
    "message": "That code belongs to a different job.",
    "details": {
      "belongs_to_wash_id": "uuid",
      "job_no": "NTD-7",
      "client_name": "Musa K.",
      "plate": "UBH 123J",
      "vehicle_class": "SUV",
      "service": "Full wash",
      "amount_ugx": 25000
    }
} }
```

The worker sees "That's Musa's SUV, plate UBH 123J, job 7. Open it?" and taps once. No new privacy exposure: the worker can already see every client name in their own branch queue.

**Three things make the queue itself readable.**

1. **A job number, assigned at start.** Short, per branch, per day: `NTD-7`. Receipt numbers only exist after payment, so they cannot help while a car is being washed. A job number can be shouted across a forecourt, which matters more than it sounds.
2. **The client's name, captured by the start scan.** This is the main reason the start scan earns its keep beyond loyalty: from that moment the job has a human attached to it, not just a car type.
3. **The plate.** Optional in general, but the app should nudge for it when it would actually help. When a wash is started that matches an existing `in_progress` or `ready` job at the same branch on car type and service, and either job has no plate, the start response returns a `duplicate_warning` and the app prompts "There's already an SUV Full wash in the queue. Add a plate to tell them apart." A prompt, not a block: a busy worker must never be stopped by this.

A worker with no client attached to either job and no plates on either is the one case the system genuinely cannot disambiguate. That is what the job number is for, and it is also a good argument for making the plate mandatory once you have more than one worker per bay. Worth deciding after a week of real use.

### 2.8 Redemption

- The client's credit balance is known at scan 1, so the app offers "use free wash" at the start. `is_redemption = true`, `quoted_amount_ugx` records what it would have cost, `amount_ugx = 0`.
- **The credit is consumed at settlement, not at start.** If the client drives off and the job is cancelled, they keep their credit.
- Because the client was scanned at both ends and notified at both ends, no extra approval step is needed. This is simpler than v2, which required a separate approval because the client was only identified at payment.
- Consumes exactly one credit. Earns no new point.

### 2.9 Shift reconciliation

The primary cash control.

- Worker opens a shift at the start of the day. Cash from every settlement attaches to the shift **that was open when the payment was taken**, not the one open when the wash started. See §2.10.
- No wash can be started or settled without an open shift (`409 NO_OPEN_SHIFT`).
- One open shift per worker, enforced by a partial unique index.
- At close, the manager enters the physically counted cash. The system stores `expected_cash`, `counted_cash`, `variance` and who closed it.
- A recurring **surplus** is the fingerprint of car-type misclassification. A recurring **shortfall** is simple theft. The variance report separates them and is the first thing an orgadmin should read each morning.

### 2.10 Handovers: when the starter is not the settler

Two situations, both routine, both handled by the same pair of columns.

**Cross-shift.** A car washed at 5pm is collected at 9am the next day.

**Cross-worker.** Joseph washed the car and has gone home, or is on break, or his phone is broken. Grace is on the forecourt, the client wants to leave, so Grace takes the money.

The schema separates who did what:

- `started_shift_id` and `settled_shift_id` are separate. **Cash attributes to `settled_shift_id`**, because that is the drawer the notes actually went into.
- `started_by_worker_id` and `settled_by_worker_id` are separate. The wash count credits the worker who did the work; the cash credits the worker who took it. Both are stored, and the worker report shows both figures rather than blending them.
- A wash cannot be settled from another branch: `409 WRONG_BRANCH`.

#### First, the distinction that matters

**If the worker is present but their phone is not** — flat battery, cracked screen, no data — the right answer is not a handover. They borrow a colleague's phone and **log in as themselves**. Their shift is their shift regardless of which device it is on, so the settlement is completely ordinary and nothing needs explaining. The worker app should therefore make switching accounts easy, and log out cleanly.

**A handover is for when the worker is genuinely absent.** Gone home, on break, off shift. Keep the two apart, or "he lent me his phone" becomes the cover story for every irregular settlement.

Because a borrowed phone is now a supported path, logout has to be thorough:

- **Reassign the push token on every login, and clear it on logout.** `devices` maps a push token to one owner. If Joseph logs into Grace's phone and the row is not updated, Joseph's "your job was collected" notifications keep arriving on Grace's phone after he leaves. Upsert `devices` on login so the token points at the current user; delete the row on logout so it points at nobody.
- **Clear the cached queue and price list on logout.** The queue is per worker and the next person must not see the previous one's jobs.
- **Revoke that device's refresh token on logout,** not just the access token, or the previous session can be resumed from the same handset.

Two smaller things worth knowing: a worker fumbling their password on an unfamiliar phone can trip the five-attempt lockout and be locked out for fifteen minutes at the worst moment, so make the reset path easy for the manager to reach; and do not add PIN-based login to make switching quicker, because a PIN a worker types in front of colleagues is not a credential (§4.10).

#### The handover flow

Grace taps **Scan payment**, scans, and the system recognises the job is not hers:

```json
{ "ok": false, "error": {
    "code": "HANDOVER_CONFIRM_REQUIRED",
    "message": "This job was started by Joseph K.",
    "details": {
      "wash_id": "uuid", "job_no": "NTD-7", "plate": "UBH 123J",
      "started_by": "Joseph K.", "started_at": "...",
      "vehicle_class": "SUV", "service": "Full wash", "amount_ugx": 25000,
      "client_name": "Musa K."
    }
} }
```

The app shows "Started by Joseph K. Take the payment anyway?" Grace confirms, picks a reason, and retries with `handover_reason`. It settles.

Making it two calls is deliberate. A single call that quietly accepted any worker's job would make handovers invisible, and invisible is the same as unmonitored.

Reasons come from a fixed list: `starter_off_shift`, `starter_on_break`, `starter_phone_unusable`, `starter_left_for_day`, `other` with a note.

#### What everyone sees afterwards

- **The client** gets their point immediately, and their receipt names Grace as the person who took the money. From their side nothing is unusual.
- **Joseph** gets a push: "Your job NTD-7 (UBH 123J) was collected by Grace N. — UGX 25,000." His day summary shows it under washes he started but did not settle. He finds out from the app, not from an argument at the end of the week.
- **Grace's shift** carries the 25,000, so if it does not appear at close, her variance shows it. This is the important part: the cash control follows the cash, not the job.
- **The manager** sees it on `GET /reports/handovers` and on the exceptions list: who handed over, who collected, which reason, and the rate per worker.

#### Why this is safe enough

The amount was locked when Joseph started the job, so Grace cannot change what is owed. The cash lands in Grace's shift, so pocketing it produces a shortfall with her name on it. Joseph is notified, so a settlement he never knew about does not stay quiet. What remains is a rate to watch: a bay where 40% of settlements are handovers is not a bay with unlucky rotas, it is a bay where nobody is accountable for their own jobs.

#### Managers taking cash

A manager on the forecourt at closing time will end up collecting money. For the cash to have a drawer, **a manager may open a shift too**, and settle within it exactly like a worker. The `shifts` table is keyed on a staff member, not specifically a worker, and a manager settling someone else's job follows the same handover flow with the same reason.

#### If there is no working device at all

Nothing can be recorded, so nothing is. The wash stays `ready`, the client leaves, and it is settled when a device is available, possibly by another worker under the handover flow. The client's point arrives late with a notification that explains it. Retrospective back-dating is deliberately not supported in v1: a settlement timestamp a worker can choose is a settlement timestamp you cannot trust.

### 2.11 Cancellations, corrections, disputes, reversals

Four different things, deliberately separate.

**Cancel** applies to `in_progress` or `ready` only, never after payment. Worker-initiated with a reason from a fixed list (`client_left`, `started_by_mistake`, `wrong_car_type_restart`, `client_refused_price`, `other` with a note). No money, no loyalty effect. Rate-monitored per worker, because this is the natural route for an off-book wash.

**Correct** is manager-only, post-settlement, for the honest mistake of the wrong car type or service. Re-resolves the price server-side, updates `amount_ugx`, stores the original values, audit-logs both. Does not touch loyalty, because the wash did happen.

**Dispute** is client-initiated within 24 hours of settlement. Freezes the row and notifies the manager. The wash still counts in revenue until resolved, so the day's figures do not move under the manager's feet.

**Reverse** is manager-only, post-settlement, for a wash that should not exist. Requires a reason, writes a compensating loyalty ledger entry. Never a delete.

---

## 3. Data model

Naming: `snake_case`, plural tables, `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `created_at`/`updated_at TIMESTAMPTZ`. Money columns are `BIGINT` and named `*_ugx`.

**Migration order.** The DDL below is grouped for reading, not for running. Create in this order, one numbered knex migration per group:

`platform_admins` → `organizations` → `branches` → `staff_users` → `clients` → `vehicle_classes` → `services` → `prices` → `vehicles` → `shifts` → `washes` → `client_tokens` → `branch_counters` → `loyalty_configs` → `loyalty_accounts` → `loyalty_ledger` → `devices` → `refresh_tokens` → `otp_codes` → `audit_logs`

### 3.1 Tenancy & people

```sql
-- Platform-level identities. Intentionally NOT in staff_users: no org_id, so no
-- risk of a null tenant filter silently widening an org query.
CREATE TABLE platform_admins (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name            TEXT NOT NULL,
  email                TEXT NOT NULL,
  phone                TEXT,
  password_hash        TEXT NOT NULL,
  must_change_password BOOLEAN NOT NULL DEFAULT true,
  status               TEXT NOT NULL DEFAULT 'active',
  last_login_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON platform_admins (lower(email));

CREATE TABLE organizations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL,
  slug           TEXT NOT NULL,                    -- short handle, used on receipts
  phone          TEXT,
  contact_name   TEXT,
  plan           TEXT NOT NULL DEFAULT 'trial',    -- trial | active | overdue
  status         TEXT NOT NULL DEFAULT 'active',   -- active | suspended
  suspended_at   TIMESTAMPTZ,
  suspend_reason TEXT,
  created_by     UUID REFERENCES platform_admins(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON organizations (lower(slug));

CREATE TABLE branches (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id),
  name       TEXT NOT NULL,                    -- "Ntinda Bay"
  code       TEXT NOT NULL,                    -- "NTD", used in receipt numbers
  address    TEXT,
  phone      TEXT,
  latitude   NUMERIC(9,6),
  longitude  NUMERIC(9,6),
  ready_alert_minutes INT NOT NULL DEFAULT 120, -- flag a READY job older than this
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON branches (org_id);
CREATE UNIQUE INDEX ON branches (org_id, upper(code));

-- Staff and clients are separate tables: different auth, different lifecycle.
CREATE TABLE staff_users (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL REFERENCES organizations(id),
  branch_id            UUID REFERENCES branches(id),   -- NULL for orgadmin
  role                 TEXT NOT NULL,                  -- orgadmin | manager | worker
  full_name            TEXT NOT NULL,
  username             TEXT NOT NULL,
  phone                TEXT,
  email                TEXT,
  password_hash        TEXT NOT NULL,
  pin_hash             TEXT,                           -- managers only
  must_change_password BOOLEAN NOT NULL DEFAULT true,
  status               TEXT NOT NULL DEFAULT 'active',
  created_by           UUID REFERENCES staff_users(id),
  last_login_at        TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT staff_role_branch_ck CHECK (
    (role = 'orgadmin' AND branch_id IS NULL) OR (role <> 'orgadmin' AND branch_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX ON staff_users (org_id, lower(username));
CREATE INDEX ON staff_users (branch_id, role);

CREATE TABLE clients (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organizations(id),
  full_name      TEXT NOT NULL,
  phone          TEXT NOT NULL,                   -- E.164, +2567...
  member_code    TEXT NOT NULL,                   -- static; fallback lookup only, NOT payment proof
  password_hash  TEXT,
  phone_verified BOOLEAN NOT NULL DEFAULT false,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON clients (org_id, phone);
CREATE UNIQUE INDEX ON clients (member_code);

-- Single-use codes the client generates by tapping a button. This is the proof
-- mechanism: a static member_code can be photographed and replayed, a 3-minute
-- one-shot token bound to an action cannot.
CREATE TABLE client_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL,                    -- start | pay
  wash_id     UUID REFERENCES washes(id),        -- required for 'pay', NULL for 'start'
  token_hash  TEXT NOT NULL,                    -- sha256; the raw value only ever lives in the QR
  expires_at  TIMESTAMPTZ NOT NULL,             -- created_at + 3 minutes
  consumed_at TIMESTAMPTZ,
  consumed_by UUID REFERENCES staff_users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pay_token_needs_wash_ck CHECK (purpose <> 'pay' OR wash_id IS NOT NULL)
);
CREATE UNIQUE INDEX ON client_tokens (token_hash);
CREATE INDEX ON client_tokens (client_id, purpose, created_at DESC);
CREATE INDEX ON client_tokens (expires_at) WHERE consumed_at IS NULL;
```

`client_tokens` is created after `washes` in migration order because of the `wash_id` reference; it is shown here because it belongs with the client.

A token is consumed with a conditional update, so two workers scanning the same screen cannot both win:

```sql
UPDATE client_tokens SET consumed_at = now(), consumed_by = $worker
WHERE token_hash = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
RETURNING client_id, wash_id;    -- 0 rows → 409 BAD_TOKEN
```

When an org's `status` is `suspended`, the auth middleware rejects every login and every token for that org's staff and clients with `403 ORG_SUSPENDED`. That is your non-payment lever and it needs to exist before the first paying customer, not after.

### 3.2 Car types, services and prices

The only place an amount is ever decided.

```sql
CREATE TABLE vehicle_classes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     UUID NOT NULL REFERENCES organizations(id),
  name       TEXT NOT NULL,          -- Saloon | SUV | Pickup | Van | Truck
  sort_order INT NOT NULL DEFAULT 0, -- tile order in the worker's grid
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON vehicle_classes (org_id, lower(name));

CREATE TABLE services (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organizations(id),
  name        TEXT NOT NULL,         -- Full wash | Half wash | Interior only | Engine
  description TEXT,
  is_default  BOOLEAN NOT NULL DEFAULT false,
  earns_point BOOLEAN NOT NULL DEFAULT true,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON services (org_id, lower(name));
CREATE UNIQUE INDEX one_default_service_per_org ON services (org_id) WHERE is_default;

-- One price per (service, car type, branch). branch_id NULL = the org default.
CREATE TABLE prices (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES organizations(id),
  service_id       UUID NOT NULL REFERENCES services(id),
  vehicle_class_id UUID NOT NULL REFERENCES vehicle_classes(id),
  branch_id        UUID REFERENCES branches(id),   -- NULL = applies org-wide
  price_ugx        BIGINT NOT NULL CHECK (price_ugx >= 0),
  active           BOOLEAN NOT NULL DEFAULT true,
  updated_by       UUID REFERENCES staff_users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON prices (
  service_id, vehicle_class_id,
  COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
);
CREATE INDEX ON prices (org_id, branch_id) WHERE active;

CREATE TABLE vehicles (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  vehicle_class_id UUID NOT NULL REFERENCES vehicle_classes(id),
  plate            TEXT NOT NULL,
  label            TEXT,                            -- "Wife's car"
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON vehicles (client_id, upper(plate));
```

Price resolution, one query:

```sql
SELECT id, price_ugx FROM prices
WHERE service_id = $1 AND vehicle_class_id = $2 AND active
  AND (branch_id = $3 OR branch_id IS NULL)
ORDER BY branch_id NULLS LAST   -- branch override wins over the org default
LIMIT 1;
```

Vehicles are stored for plate history and to pre-fill a returning client's car type. Points accrue to the client, never the plate. `vehicles.vehicle_class_id` is a default only; the worker still picks the type at the bay, because clients bring different cars.

`earns_point = false` excludes add-ons from the loyalty count, so nobody reaches a free wash through seven 2,000-shilling tyre polishes.

### 3.3 Shifts

```sql
CREATE TABLE shifts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES organizations(id),
  branch_id         UUID NOT NULL REFERENCES branches(id),
  worker_id         UUID NOT NULL REFERENCES staff_users(id),  -- worker OR manager: whoever is
                                                              -- accountable for the cash (§2.10)
  status            TEXT NOT NULL DEFAULT 'open',   -- open | pending_close | closed
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at         TIMESTAMPTZ,
  expected_cash_ugx BIGINT,
  counted_cash_ugx  BIGINT,
  variance_ugx      BIGINT,
  closed_by         UUID REFERENCES staff_users(id),
  notes             TEXT
);
CREATE UNIQUE INDEX one_open_shift_per_worker ON shifts (worker_id) WHERE status <> 'closed';
CREATE INDEX ON shifts (branch_id, opened_at DESC);
```

`expected_cash_ugx` sums washes whose `settled_shift_id` is this shift, computed at close and then snapshotted, so a later reversal does not silently rewrite yesterday's variance.

A shift cannot close while its holder has washes in `in_progress`. `ready` jobs are fine to leave behind: they carry no cash yet, and another worker can settle them under the handover flow (§2.10).

Managers may open a shift as well as workers, because a manager on the forecourt at closing time will end up holding cash and it needs a drawer. A manager cannot close their own shift; an orgadmin closes it.

### 3.4 Washes

Renamed from `transactions` in v2. A row here is a car being washed that later becomes a paid sale, and calling a car currently being soaped a "transaction" gets confusing fast.

```sql
CREATE TABLE washes (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL REFERENCES organizations(id),
  branch_id            UUID NOT NULL REFERENCES branches(id),

  -- who and when: start and settlement can be different workers and shifts (§2.10)
  started_by_worker_id UUID NOT NULL REFERENCES staff_users(id),
  started_shift_id     UUID NOT NULL REFERENCES shifts(id),
  settled_by_worker_id UUID REFERENCES staff_users(id),
  settled_shift_id     UUID REFERENCES shifts(id),

  client_id            UUID REFERENCES clients(id),   -- NULL for a walk-in with no app
  client_attached_at   TIMESTAMPTZ,
  client_attach_method TEXT,                          -- start_token | pay_token | manual_lookup
  vehicle_id           UUID REFERENCES vehicles(id),
  plate                TEXT,

  service_id           UUID NOT NULL REFERENCES services(id),
  vehicle_class_id     UUID NOT NULL REFERENCES vehicle_classes(id),

  price_id             UUID REFERENCES prices(id),     -- which price row was applied
  quoted_amount_ugx    BIGINT NOT NULL,                -- locked at scan 1
  amount_ugx           BIGINT,                         -- charged at settle; 0 if redemption
  is_redemption        BOOLEAN NOT NULL DEFAULT false,
  earns_point          BOOLEAN NOT NULL DEFAULT true,  -- snapshot of services.earns_point

  job_no               TEXT NOT NULL,                    -- <BRANCH>-<seq>, assigned at start, for the queue
  status               TEXT NOT NULL DEFAULT 'in_progress',
  -- in_progress | ready | settled | cancelled | disputed | reversed

  started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  wash_done_at         TIMESTAMPTZ,
  settled_at           TIMESTAMPTZ,
  receipt_no           TEXT,                           -- <BRANCH>-<YYYYMMDD>-<seq>
  start_verified       BOOLEAN NOT NULL DEFAULT false,  -- a real start token was consumed
  settle_verified      BOOLEAN NOT NULL DEFAULT false,  -- a real pay token was consumed
  unverified_reason    TEXT,                            -- required when settle_verified = false
  handover_reason      TEXT,                            -- required when settled_by <> started_by
  handover_note        TEXT,

  cancelled_at         TIMESTAMPTZ,
  cancelled_by         UUID REFERENCES staff_users(id),
  cancel_reason        TEXT,                           -- fixed list, see §2.11
  cancel_note          TEXT,

  disputed_at          TIMESTAMPTZ,
  dispute_reason       TEXT,
  resolved_at          TIMESTAMPTZ,
  resolved_by          UUID REFERENCES staff_users(id),

  corrected_at         TIMESTAMPTZ,
  corrected_by         UUID REFERENCES staff_users(id),
  original_amount_ugx  BIGINT,
  original_vehicle_class_id UUID REFERENCES vehicle_classes(id),

  reversed_at          TIMESTAMPTZ,
  reversed_by          UUID REFERENCES staff_users(id),
  reverse_reason       TEXT,

  idempotency_key      TEXT,
  notes                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT settled_has_amount_ck CHECK (
    status <> 'settled' OR (amount_ugx IS NOT NULL AND settled_shift_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX ON washes (started_by_worker_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX ON washes (org_id, receipt_no) WHERE receipt_no IS NOT NULL;
CREATE UNIQUE INDEX ON washes (branch_id, job_no, (started_at::date));
CREATE INDEX dup_check ON washes (branch_id, vehicle_class_id, service_id) WHERE status IN ('in_progress','ready');
CREATE INDEX ON washes (branch_id, settled_at DESC) WHERE status = 'settled';
CREATE INDEX ON washes (settled_shift_id) WHERE status = 'settled';
CREATE INDEX ON washes (client_id, started_at DESC);
CREATE INDEX open_queue ON washes (started_by_worker_id, status) WHERE status IN ('in_progress','ready');
CREATE INDEX ON washes (branch_id, status, wash_done_at) WHERE status = 'ready';
CREATE INDEX ON washes (settled_by_worker_id, vehicle_class_id, settled_at);  -- car-type mix
CREATE INDEX handovers ON washes (branch_id, settled_at) WHERE handover_reason IS NOT NULL;
CREATE INDEX ON washes (status) WHERE status = 'disputed';
```

The idempotency key guards scan 1. A dropped response plus a retry must not put the same car in the queue twice. The device generates one key per tap.

Two short human-readable references come from one counter table:

```sql
CREATE TABLE branch_counters (
  branch_id        UUID NOT NULL REFERENCES branches(id),
  day              DATE NOT NULL,
  last_job_seq     INT  NOT NULL DEFAULT 0,   -- bumped at wash start  → job_no
  last_receipt_seq INT  NOT NULL DEFAULT 0,   -- bumped at settlement  → receipt_no
  PRIMARY KEY (branch_id, day)
);
```

Two separate sequences, deliberately. `job_no` is assigned when the wash starts, so the queue has something short to show and shout (`NTD-7`). `receipt_no` is assigned only at settlement, so the books have no gaps from cancelled jobs. Cars that are washed but never collected consume a job number and no receipt number, which is exactly right.

Bump either with `INSERT ... ON CONFLICT (branch_id, day) DO UPDATE SET last_job_seq = branch_counters.last_job_seq + 1 RETURNING last_job_seq`, inside the relevant transaction. Formats: job `<branches.code>-<seq>`, receipt `<branches.code>-<YYYYMMDD>-<4-digit seq>`.

### 3.5 Loyalty

An append-only ledger is the source of truth. The account row is a cached projection protected by a row lock. This is the only way to answer a client who insists they had six washes.

```sql
CREATE TABLE loyalty_configs (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL UNIQUE REFERENCES organizations(id),
  washes_required    INT NOT NULL DEFAULT 7,
  min_amount_ugx     BIGINT NOT NULL DEFAULT 0,   -- cheap washes don't count
  credit_expiry_days INT,                         -- NULL = never expires
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE loyalty_accounts (
  client_id         UUID PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  org_id            UUID NOT NULL REFERENCES organizations(id),
  wash_count        INT NOT NULL DEFAULT 0,   -- progress to next reward, 0..6
  free_wash_credits INT NOT NULL DEFAULT 0,
  lifetime_washes   INT NOT NULL DEFAULT 0,
  lifetime_redeemed INT NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT non_negative_ck CHECK (wash_count >= 0 AND free_wash_credits >= 0)
);

CREATE TABLE loyalty_ledger (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        UUID NOT NULL REFERENCES clients(id),
  wash_id          UUID REFERENCES washes(id),
  entry_type       TEXT NOT NULL,   -- earn | reward_granted | redeem | reversal | manual_adjust
  wash_delta       INT NOT NULL DEFAULT 0,
  credit_delta     INT NOT NULL DEFAULT 0,
  wash_count_after INT NOT NULL,
  credits_after    INT NOT NULL,
  reason           TEXT,
  created_by       UUID REFERENCES staff_users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON loyalty_ledger (client_id, created_at DESC);
CREATE UNIQUE INDEX ON loyalty_ledger (wash_id, entry_type) WHERE wash_id IS NOT NULL;
```

**Settlement, all in one database transaction:**

```
BEGIN;
  consume the pay token: unexpired, unused, purpose='pay', wash_id matches,
  and its client_id matches washes.client_id            -- else 409 BAD_TOKEN / CLIENT_MISMATCH
  verify caller has an open shift at this wash's branch    -- else 409 NO_OPEN_SHIFT / WRONG_BRANCH

  UPDATE washes SET status='settled', settled_at=now(),
                    settled_by_worker_id=$me, settled_shift_id=$my_shift,
                    amount_ugx = CASE WHEN is_redemption THEN 0 ELSE quoted_amount_ugx END,
                    settle_verified = true
   WHERE id=$1 AND status='ready';                         -- 0 rows → 409 BAD_STATE

  receipt_no = bump branch_counters.last_receipt_seq(branch, today)

  IF client_id IS NOT NULL THEN
     SELECT * FROM loyalty_accounts WHERE client_id=$c FOR UPDATE;

     IF is_redemption THEN
        require free_wash_credits >= 1                     -- else 422 NO_CREDITS
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
  END IF;
COMMIT;
```

The unique index on `(wash_id, entry_type)` makes this idempotent even if the whole call is retried.

**Reversal:** insert a `reversal` entry with the inverse deltas. If reversing an earn would take the count below zero and a credit was granted from it, remove the credit too, unless it has already been spent, in which case leave the balance and record the shortfall in `reason`. Never let the account go negative; the `CHECK` will stop you and the ledger keeps the truth.

### 3.6 Supporting tables

```sql
CREATE TABLE devices (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type   TEXT NOT NULL,    -- staff | client
  owner_id     UUID NOT NULL,
  push_token   TEXT NOT NULL,
  platform     TEXT NOT NULL,    -- ios | android
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON devices (push_token);

CREATE TABLE refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type TEXT NOT NULL,    -- staff | client | platform
  owner_id   UUID NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE otp_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  purpose     TEXT NOT NULL,     -- register | login | reset
  attempts    INT NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
CREATE INDEX ON otp_codes (phone, purpose, created_at DESC);

CREATE TABLE audit_logs (
  id         BIGSERIAL PRIMARY KEY,
  org_id     UUID,
  actor_type TEXT,              -- staff | client | platform | system
  actor_id   UUID,
  action     TEXT NOT NULL,     -- price.update, wash.correct, wash.cancel, staff.reset_password
  entity     TEXT,
  entity_id  UUID,
  before     JSONB,
  after      JSONB,
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_logs (org_id, created_at DESC);
CREATE INDEX ON audit_logs (entity, entity_id);
CREATE INDEX ON audit_logs (org_id, action, created_at DESC);
```

Price changes, cancellations and corrections are the three highest-value entries here. All three must write `before` and `after`.

---

## 4. API

Base: `/api/v1`. Bearer JWT access token (15 min) plus rotating refresh token (30 days).

```json
{ "ok": true, "data": { } }
{ "ok": false, "error": { "code": "NO_PRICE_SET", "message": "...", "details": {} } }
```

The JWT carries `sub`, `type` (`staff` | `client` | `platform`), `role`, `org_id`, `branch_id`. Every org query is scoped by `org_id` from the token, never from the request body. `platform` tokens carry no `org_id` and are accepted only by the `/platform` router.

### 4.1 Auth

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/auth/staff/login` | public | `{ username, password }`. Returns `must_change_password` |
| POST | `/auth/staff/change-password` | staff | `{ current_password, new_password }` |
| POST | `/auth/platform/login` | public | Separate from staff login |
| POST | `/auth/platform/change-password` | sysadmin | |
| POST | `/auth/client/register` | public | `{ full_name, phone, password }` → sends OTP |
| POST | `/auth/client/verify-otp` | public | `{ phone, code }` → tokens + `member_code` |
| POST | `/auth/client/login` | public | `{ phone, password }` |
| POST | `/auth/client/request-otp` | public | Rate limited: 3 per phone per hour |
| POST | `/auth/client/reset-password` | public | `{ phone, code, new_password }` |
| POST | `/auth/refresh` | public | Rotates and revokes the old token |
| POST | `/auth/logout` | any | |
| GET | `/me` | any | Identity, role, branch, permissions |
| POST | `/me/device` | any | Register push token |

### 4.2 Platform: sysadmin

Separate router at `/api/v1/platform`, guarded by middleware accepting only `type: 'platform'`. No handler here touches `washes`, `clients` or `loyalty_*`.

| Method | Path | Notes |
|---|---|---|
| GET | `/platform/orgs` | Name, slug, plan, status, branch/staff/client counts, washes in last 30 days. Paginated |
| POST | `/platform/orgs` | Creates the org, seeds default car types and loyalty config, creates the first `orgadmin`, returns that temp password once |
| GET | `/platform/orgs/:id` | The org plus its branches with counts only |
| PATCH | `/platform/orgs/:id` | Name, contact, plan |
| POST | `/platform/orgs/:id/suspend` | `{ reason }`. Blocks all logins for that tenant |
| POST | `/platform/orgs/:id/activate` | |
| POST | `/platform/orgs/:id/admins` | Add or reset an `orgadmin` |
| GET/POST | `/platform/admins` | List and add sysadmins. Keep at least two |
| POST | `/platform/admins/:id/reset-password` | Cannot target self |
| GET | `/platform/stats` | Platform totals and growth by org. Counts and sums only |
| GET | `/platform/audit` | Platform-level actions only |

Deliberately absent: any endpoint returning a wash row, a client record, a phone number, or a shilling figure attributable to a named customer of a tenant.

### 4.3 Org setup (orgadmin)

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/branches` | `code` required, used on receipts. `ready_alert_minutes` configurable |
| GET/PATCH | `/branches/:id` | |
| GET/POST | `/vehicle-classes` | Car types. `sort_order` controls the worker's grid |
| PATCH | `/vehicle-classes/:id` | Deactivating hides it from the grid; existing washes keep their reference |
| GET/POST | `/services` | Full wash, Half wash, Interior, Engine. `is_default`, `earns_point` |
| PATCH | `/services/:id` | |
| GET/PUT | `/loyalty-config` | `washes_required`, `min_amount_ugx`, `credit_expiry_days` |

### 4.4 Prices

#### `GET /prices?branch_id=`

The full matrix, which is what a price-management screen needs.

```json
{
  "ok": true,
  "data": {
    "services": [{ "id": "...", "name": "Full wash", "is_default": true }],
    "vehicle_classes": [{ "id": "...", "name": "Saloon", "sort_order": 1 }],
    "matrix": [
      { "service_id": "...", "vehicle_class_id": "...",
        "org_price_ugx": 20000, "branch_price_ugx": 25000,
        "effective_price_ugx": 25000, "source": "branch_override",
        "updated_by": "Sarah N.", "updated_at": "..." }
    ],
    "missing": [ { "service_id": "...", "vehicle_class_id": "...", "reason": "no price set" } ]
  }
}
```

The `missing` array is how an orgadmin discovers that a car type they just added has no price, before a worker discovers it at the bay with a customer waiting.

| Method | Path | Who | Notes |
|---|---|---|---|
| PUT | `/prices` | orgadmin | Upsert an org-wide price |
| PUT | `/prices/branch/:branch_id` | orgadmin, manager | Branch override. Manager restricted to own branch |
| DELETE | `/prices/branch/:branch_id/:price_id` | orgadmin, manager | Removes the override; org default resumes |
| POST | `/prices/bulk` | orgadmin | Array of upserts, one transaction. Setup and across-the-board increases |
| GET | `/prices/effective?branch_id=&vehicle_class_id=` | worker, manager, orgadmin | **Feeds both worker screens:** the new-wash cascade and the price-list tab. Returns car types in `sort_order`, each with its wash types and prices, plus an explicit `has_price: false` for unpriced combinations so the app greys them out instead of showing 0. Cached on device; filter by `vehicle_class_id` for the second step of the cascade |
| GET | `/prices/history?service_id=&vehicle_class_id=` | orgadmin, manager | From `audit_logs` |

Every write audit-logs `before` and `after`. A price change never alters an existing wash; `quoted_amount_ugx` is a snapshot.

### 4.5 Staff management

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/staff` | orgadmin, manager | Orgadmin any role; manager creates `worker` in own branch only. Returns a temp password once |
| GET | `/staff` | orgadmin, manager | Manager sees own branch only |
| GET | `/staff/:id` | orgadmin, manager | |
| PATCH | `/staff/:id` | orgadmin, manager | Role and branch changes are orgadmin-only |
| POST | `/staff/:id/reset-password` | orgadmin, manager | Target must be strictly junior to the caller (§4.10) |
| POST | `/staff/:id/set-pin` | manager (self), orgadmin | A manager can never set another manager's PIN |
| POST | `/staff/:id/suspend` | orgadmin, manager | Blocked if the worker has an open shift or `in_progress` washes |
| POST | `/staff/:id/activate` | orgadmin, manager | |

### 4.6 Shifts

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/shifts/open` | worker | `409 SHIFT_ALREADY_OPEN` if one exists |
| GET | `/shifts/current` | worker | Live totals: washes settled, cash expected, breakdown by car type |
| POST | `/shifts/:id/request-close` | worker | Rejected if any wash is `in_progress`. `ready` jobs may be handed over |
| POST | `/shifts/:id/close` | manager | `{ counted_cash_ugx, notes }`. Snapshots expected and variance |
| GET | `/shifts` | manager, orgadmin | Filters: `branch_id`, `worker_id`, `from`, `to`, `has_variance=true` |
| GET | `/shifts/:id` | manager, orgadmin | Includes the settled wash list |

### 4.7 Washes — the core

#### `POST /washes` — scan 1, start the wash

```json
// Header: Idempotency-Key: <uuid generated on the device, one per tap>
{
  "start_token": "8f3aQ7xR2m...",  // from the client's Start wash QR; null for a walk-in
  "service_id": "uuid",          // omit to use the org's is_default service
  "vehicle_class_id": "uuid",
  "plate": "UBH 123J",           // optional
  "use_free_wash": false         // offered only if the scan shows credits >= 1
}
```

There is no `amount` field. The request cannot express a price.

1. Reject if the caller has no `open` shift → `409 NO_OPEN_SHIFT`.
2. Resolve `service_id` (default if omitted); validate service and car type belong to the caller's org and are `active`.
3. Resolve the price for (service, car type, caller's branch). None → `422 NO_PRICE_SET` naming the combination. **Never fall back to zero.**
4. If `start_token` given, consume it with the conditional update in §3.1. Expired, already used, or wrong purpose → `409 BAD_TOKEN`. Client must belong to the caller's org. Set `client_attach_method = 'start_token'` and `start_verified = true`.
5. If `use_free_wash`, require `free_wash_credits >= 1` and set `is_redemption = true`. **The credit is not consumed yet.**
6. Insert with `status = 'in_progress'`, `quoted_amount_ugx` from step 3, `price_id`, `earns_point` snapshotted from the service.
7. Bump `branch_counters.last_job_seq` and set `job_no`.
8. Check for a same-branch `in_progress` or `ready` wash with the same car type and service where either job lacks a plate. If found, include `duplicate_warning` in the response. **This never blocks the start.**
9. Push to the client: service, car type, amount, branch, "started".

```json
// 201
{ "ok": true, "data": {
    "wash_id": "uuid", "job_no": "NTD-7", "status": "in_progress",
    "quoted_amount_ugx": 25000, "service_name": "Full wash", "vehicle_class": "SUV",
    "client": { "id": "...", "full_name": "Musa K.", "wash_count": 4, "free_wash_credits": 0 },
    "is_redemption": false, "started_at": "...",
    "duplicate_warning": {
      "message": "There is already an SUV Full wash in the queue without a plate.",
      "other_job_no": "NTD-4"
    }
} }
```

#### `GET /washes/queue` — the worker's home screen

Returns their `in_progress` and `ready` washes in two arrays, each with plate, car type, service, quoted amount, client name or "walk-in", elapsed minutes, and a `stale` flag for `ready` jobs past the branch's `ready_alert_minutes`.

#### `POST /washes/:id/wash-done`

`in_progress` → `ready`. Sets `wash_done_at`. Pushes "your car is ready for collection" to the client if one is attached. No money, no loyalty effect. Callable only by staff at that branch.

#### `POST /washes/settle-by-token` — the default: scan first, app finds the job

```json
{
  "pay_token": "Q4mZ8k1pW...",
  "handover_reason": null,   // required only on the retry after HANDOVER_CONFIRM_REQUIRED
  "handover_note": null
}
```

Consumes the token, reads the `wash_id` it is bound to, and settles that wash through exactly the same code path as below.

If the wash was started by a different staff member and no `handover_reason` is supplied, it returns `409 HANDOVER_CONFIRM_REQUIRED` with the details of who started it (§2.10) and **does not consume the token**. The app confirms with the worker, collects a reason, and retries. A handover settlement pushes a notification to the staff member who started the job. The worker never picks a row, so two identical cars in the queue cannot be confused (§2.7). Handovers, where the worker who started a job is absent when the client pays, are an explicit flow with a reason and a notification (§2.10). Rejects with `409 WRONG_BRANCH` if the bound wash is not at the caller's branch.

Use this wherever the client has the app. `POST /washes/:id/settle` remains for a walk-in with no app, and for when the worker deliberately opens a specific job.

#### `POST /washes/:id/settle` — settle a specific job

```json
{
  "pay_token": "Q4mZ8k1pW...",   // from the client's Pay now QR
  "unverified_reason": null      // required ONLY when pay_token is absent: dead_phone | no_app | app_error
}
```

1. Wash must be `ready` → else `409 BAD_STATE`. (Settling straight from `in_progress` is rejected; mark done first.)
2. Caller must have an open shift at the wash's branch → `409 NO_OPEN_SHIFT` / `409 WRONG_BRANCH`. If the caller did not start this wash, `handover_reason` is required → else `409 HANDOVER_CONFIRM_REQUIRED` carrying the starter's name and the job details (§2.10).
3. If `pay_token` given: consume it, require `purpose = 'pay'` and `wash_id` matching this wash, and require its `client_id` to equal the wash's attached client. Set `settle_verified = true`. This is the proof the client was standing there. On mismatch return `409 CLIENT_MISMATCH` **with the details of the job the token does belong to** (§2.7) so the app can offer a one-tap switch. Note the token is not consumed on a mismatch: the client must not have to tap Pay again because the worker opened the wrong row.
4. If `pay_token` is absent, require `unverified_reason` → else `422 REASON_REQUIRED`. Settle with `settle_verified = false`. The client still earns their point. Every such settlement appears on the exceptions report with a per-worker rate (§2.6).
4b. If no client was attached at start and a token is supplied now, attach them with `client_attach_method = 'pay_token'` and award the point. A client who installed the app on the bench still gets credit.
5. Set `amount_ugx` (0 if redemption, else `quoted_amount_ugx`), `settled_by_worker_id`, `settled_shift_id`, `settled_at`.
6. Assign `receipt_no` from the branch's daily counter.
7. Consume the credit, or run the earn algorithm. All of steps 5 to 7 in one database transaction (§3.5).
8. Push to the client: amount paid, new balance, dispute link.

```json
// 200
{ "ok": true, "data": {
    "wash_id": "uuid", "status": "settled",
    "receipt_no": "NTD-20260827-0042", "amount_ugx": 25000,
    "loyalty": { "wash_count": 5, "required": 7, "free_wash_credits": 0, "reward_granted": false },
    "shift_totals": { "washes": 12, "cash_expected_ugx": 240000 }
} }
```

Returning `shift_totals` on every settlement saves a second call and gives the worker a running figure they can be held to at close.

#### The rest

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/washes/:id/attach-client` | worker | `{ start_token }` or `{ member_code }` for manual lookup. For a walk-in who installs the app while waiting. Manual lookup sets `start_verified = false` |
| POST | `/washes/:id/cancel` | worker | `{ reason, note? }` from the fixed list. Only from `in_progress` or `ready`. Rate-monitored |
| GET | `/washes/:id` | involved parties | |
| GET | `/washes` | worker/manager/orgadmin | Scoped by role. Filters: `branch_id`, `worker_id`, `client_id`, `vehicle_class_id`, `status`, `from`, `to`. Keyset paginated |
| GET | `/washes/mine/today` | worker | Own day in three parts: **started and settled by me**, **started by me, settled by someone else** (with who and why), **started by someone else, settled by me**. Never a single blended number |
| POST | `/washes/:id/correct` | manager | `{ vehicle_class_id?, service_id?, reason }`. Re-resolves price, stores originals, audit-logs. Loyalty untouched |
| POST | `/washes/:id/reverse` | manager | `{ reason }` → `reversed` plus a compensating ledger entry |
| POST | `/washes/:id/dispute` | client | Within 24h of `settled_at`. `{ reason, note }` |
| POST | `/washes/:id/resolve-dispute` | manager | `{ resolution: 'uphold' \| 'correct' \| 'reverse', vehicle_class_id?, note }` |

### 4.8 Clients

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/clients/lookup?member_code=&phone=` | worker | The scan target. Minimal payload: id, name, wash count, credits. No history, no phone |
| GET | `/me/washes/active` | client | Live status of the wash in progress: stage, amount, branch, elapsed |
| GET | `/me/loyalty` | client | Progress and credits |
| POST | `/me/washes/start-token` | client | **The Start wash button.** Returns `{ token, expires_at }`, valid 3 minutes, one use. Rate limited: 5 per 10 minutes |
| POST | `/me/washes/:id/pay-token` | client | **The Pay now button.** Wash must be `ready` and belong to the caller. Token bound to this wash |
| GET | `/me/qr` | client | Static `member_code`, for manual lookup when a phone is dead. Not payment proof |
| GET | `/me/washes` | client | Own history with amounts and car types |
| GET | `/me/loyalty/ledger` | client | Why the number is what it is |
| GET/POST | `/me/vehicles` | client | |
| PATCH | `/me/profile` | client | |
| GET | `/clients` | manager, orgadmin | Search, paginated |
| POST | `/clients` | worker | Register a client at the bay. Phone plus name, unverified, claimable later by OTP |
| POST | `/clients/:id/loyalty/adjust` | orgadmin | `{ wash_delta, credit_delta, reason }`. Reason mandatory, audit-logged |

### 4.9 Reports

All accept `from` and `to`, scoped by role. Manager silently locked to their own branch.

| Path | Returns |
|---|---|
| `GET /reports/daily?branch_id&date` | Washes started, settled, cancelled; gross UGX; cash expected; breakdown by car type, service and worker; redemptions and their shilling value |
| `GET /reports/workers?from&to&branch_id` | Per worker: washes started, washes settled, cash taken, car-type mix, cancellation rate, corrections against them, disputes, total shift variance. Started and settled shown separately, never blended (§2.10) |
| `GET /reports/car-type-mix?from&to&branch_id` | Per worker, the share of each car type recorded against the bay average, with a deviation score. Sort by deviation and the top row is the worker to look at |
| `GET /reports/cancellations?from&to&branch_id` | Per worker, count and rate by reason. **The route an off-book wash takes**, so review it weekly |
| `GET /reports/cash-variance?from&to` | Every closed shift with a non-zero variance, worst first. Recurring **surpluses** flagged separately from shortfalls |
| `GET /reports/durations?from&to&branch_id` | Average wash time by service and car type, and average wait between `ready` and collection. Use it to quote honest waiting times |
| `GET /reports/stale?branch_id` | Live: `ready` jobs past `ready_alert_minutes`, and `in_progress` jobs open unusually long |
| `GET /reports/branches?from&to` | Orgadmin only. Side-by-side comparison |
| `GET /reports/price-changes?from&to` | From `audit_logs`. Who changed which price, when, by how much |
| `GET /reports/loyalty?from&to` | Clients at 5/7 and 6/7 (your marketing list), credits granted, redeemed, cost of rewards, unredeemed liability |
| `GET /reports/handovers?from&to&branch_id` | Every settlement where `settled_by <> started_by`: starter, settler, reason, amount. Plus a rate per worker in each direction. A bay where handovers are routine is a bay where nobody owns their own jobs |
| `GET /reports/unverified?from&to&branch_id` | Settlements with `settle_verified = false`, by worker, by reason, as a rate. The dead-phone fallback is the softest control in the system, so watch the rate rather than the incidents |
| `GET /reports/exceptions?from&to` | Cancellations, corrections, disputes, reversals, handover settlements, unverified settlements, washes settled with no client attached, stale jobs. The manager's morning list |

Serve these from explicit SQL, not the ORM.

On `car-type-mix`: mix legitimately varies by location and time of day, so treat it as a prompt to go and look, not as proof. It is most useful against the same worker's own history and against colleagues on the same shifts.

### 4.10 Credentials, resets and the escalation ladder

There is no self-service "forgot password" for staff. Workers are hired casually, may share a phone, and often have no email, so an emailed reset link is not a mechanism you can rely on. **Every staff password is reset by exactly one level above.**

| Who forgot | Who resets them | Endpoint |
|---|---|---|
| `client` | Themselves, by OTP | `POST /auth/client/reset-password` |
| `worker` | Their branch manager, or an orgadmin | `POST /staff/:id/reset-password` |
| `manager` | An orgadmin only | `POST /staff/:id/reset-password` |
| `orgadmin` | A sysadmin | `POST /platform/orgs/:id/admins` |
| `sysadmin` | Another sysadmin | `POST /platform/admins/:id/reset-password` |

**Strictly-junior rule.** Check the rank of the *target*, not just the role of the caller. Without it a manager can reset their orgadmin's password, log in as them, and own the org by lunchtime.

- `orgadmin` may reset any `manager` or `worker` in their org, and no other orgadmin.
- `manager` may reset a `worker` **in their own branch** only. Never another manager, never an orgadmin.
- Nobody resets a peer or themselves through this route. Own-password changes go through `/auth/*/change-password`, which requires the current password.

Reject violations with `403 CANNOT_RESET_PEER_OR_SENIOR` and audit-log the attempt.

**What a reset does, in one transaction:** generate a readable 8-character temp password (no `0/O` or `1/l`, because someone will read it aloud across a noisy bay); hash with argon2; set `must_change_password = true`; **revoke every refresh token for that user**, or an attacker with a live session keeps it; write an audit entry; return the password **once**, never stored in plaintext and never retrievable again.

**Enforcing the forced change** happens in auth middleware. While `must_change_password` is true, every route except `/auth/*/change-password`, `/me` and `/auth/logout` returns `403 PASSWORD_CHANGE_REQUIRED`.

**Delivery.** Read it to the person in front of you, or SMS if a phone is on file. Not email, not a push payload.

**Sysadmin bootstrap.** The first comes from the seed script reading an environment variable, forced to change on first login. Then **create a second sysadmin immediately.** With only one, a forgotten password leaves you with a database console or a recovery CLI, and that CLI is a permanent backdoor in your repo.

**Rate limits and PINs.** Five failed logins locks an account for 15 minutes. Manager PINs lock after 5 failures. A PIN is not a password: never accept it in place of one at login.

---

## 5. Correctness rules worth writing down

1. **Money is integer UGX.** No floats anywhere, ever.
2. **The API cannot accept a price.** Neither `POST /washes` nor `/settle` has an amount field. If you ever add one, the whole control is gone.
3. **Never fall back to a default price.** No price for a combination is a `422`, not a zero and not the cheapest available.
4. **`quoted_amount_ugx` is locked at scan 1** and never recomputed. Reports read the stored figure.
5. **Cash attributes to `settled_shift_id`,** the shift open when the notes were handed over, never the shift that started the wash. The cash control follows the cash, not the job.
5b. **Settling someone else's job requires a reason** and notifies the person who started it. Never allow a silent cross-worker settlement.
5c. **A borrowed phone is not a handover.** If the worker is present, they log in as themselves on the other device and the settlement is ordinary. Handover is for an absent worker only.
5d. **Login reassigns the device's push token; logout clears it** and revokes that device's refresh token. Shared handsets are normal here, and a stale `devices` row sends one worker's notifications to another's phone.
6. **A token is consumed by a conditional update, never a select-then-update.** `WHERE consumed_at IS NULL AND expires_at > now()` is what makes it single-use under concurrency.
6b. **A pay token is bound to one wash.** It cannot settle a different job, and its client must match the wash's client. Prefer `settle-by-token`, which uses that binding to find the job, over asking the worker to pick the right row.
6e. **Do not consume a token on a failed match.** The worker opened the wrong job; the client should not have to tap Pay again.
6c. **The raw token never touches the database.** Store the sha256 only; the raw value lives in the QR for 3 minutes and nowhere else.
6d. **Settling without a token requires a reason** and is stored as `settle_verified = false`. Never allow a silent unverified settlement.
7. **A wash cannot be settled from `in_progress`.** Mark done first, so `wash_done_at` is always real.
8. **Idempotency on `POST /washes`.** A dropped response plus a retry must not queue the same car twice.
9. **Row-lock the loyalty account** (`SELECT ... FOR UPDATE`) before mutating it.
10. **The free wash credit is consumed at settlement, never at start.** A cancelled job must not cost the client their reward.
11. **One open shift per worker,** enforced by the partial unique index, not application logic.
12. **A shift cannot close with `in_progress` washes.** `ready` jobs may be handed over.
13. **Never delete a wash or a ledger row.** Reverse it.
14. **Cancellations are a monitored metric,** with a reason from a fixed list. This is the off-book route.
15. **`job_no` at start, `receipt_no` at settlement.** Two separate sequences. A car washed and never collected consumes a job number and no receipt number.
16. **A correction is not a reversal.** Wrong car type recorded is a correction and keeps the point. A wash that never happened is a reversal and removes it.
17. **Scope every org query by `org_id` from the JWT.** A missing or null `org_id` on an org route is a `500`, never an unfiltered query.
18. **A suspended org blocks its own logins,** checked in auth middleware.
19. **Rate limit** OTP requests, staff login and PIN attempts.
20. **Server time only.** Phones in a bay are frequently set wrong.
21. **A password reset revokes refresh tokens,** and every reset is rank-checked (§4.10).

---

## 6. Project layout

```
server/
  src/
    config/          env loading and validation (zod)
    db/
      index.js       pg Pool
      migrations/    knex migrations, numbered
      seeds/         demo org, 2 branches, car types, services, full price matrix, staff
    middleware/
      auth.js        JWT verify, attaches req.actor
      requireRole.js
      requireBranch.js
      requirePlatform.js
      requirePasswordChanged.js
      requireOpenShift.js
      idempotency.js
      errorHandler.js
      rateLimit.js
    modules/
      auth/
      platform/      sysadmin router: orgs, provisioning, counts only
      staff/
      branches/
      catalogue/     car types and services
      pricing/       the matrix, resolution, history
      shifts/
      washes/        start, queue, done, settle, cancel, correct, reverse, dispute
      loyalty/       ledger plus account projection
      clients/
      tokens/        issue and consume client_tokens; nothing else touches that table
      reports/       explicit SQL
      audit/
    jobs/
      staleWashAlerts.js     ready past threshold → notify manager
      purgeTokens.js         delete consumed and expired client_tokens nightly
      nightlySummary.js
      expireCredits.js       only if credit_expiry_days is set
    utils/           money.js, receiptNo.js, phone.js, tempPassword.js
    app.js
    server.js
  tests/
```

Four rules that keep this maintainable:

- Only the `loyalty` module writes to `loyalty_accounts` and `loyalty_ledger`.
- Only the `washes` module changes a wash's status, and every transition lives in one file as an explicit allowed-from check.
- Only the `pricing` module resolves a price. One function, `resolvePrice(serviceId, vehicleClassId, branchId)`, used by start, correct and resolve-dispute alike. Three copies is how they drift.
- Notifications go through one `notify(client, event, payload)` helper, so the three client pushes stay consistent and testable.

Libraries: `express`, `pg`, `knex` (migrations only; raw SQL for reads), `zod`, `argon2`, `jsonwebtoken`, `pino`, `express-rate-limit`, `node-cron`. No heavy ORM, so the SQL stays visible.

---

## 7. Build order

**Phase 1 — foundation (2 to 3 days).** Migrations for platform_admins, organizations, branches, staff_users, clients. Platform login and `POST /platform/orgs` first, since provisioning creates every other fixture. Then staff and client auth, `/me`, role middleware, the reset ladder and the `must_change_password` middleware. Build the ladder now: it is five endpoints and it is where privilege-escalation bugs get baked in. Seed script. At the end you can log in as all five actor types in Postman.

**Phase 2 — catalogue and pricing (2 days).** Car types, services, the `prices` table, the matrix endpoint, bulk upsert, branch overrides, `GET /prices/effective`, and `resolvePrice` with unit tests for branch-override-wins and no-price-set. Load-bearing, so give it real tests.

**Phase 3 — shifts (1 day).** Open, current, request-close, close with variance. Prove the partial index rejects a second open shift.

**Phase 4 — the wash lifecycle (4 days). This is the project.** The token module first (issue, consume, expire), then `POST /washes`, queue, `wash-done`, `settle` with loyalty and receipt numbering in one database transaction, `cancel`, `attach-client`. Write the illegal-transition tests before moving on: settling from `in_progress`, settling twice, replayed token, expired token, token bound to another wash, cross-branch settle, retried start. If this phase is solid the rest is CRUD.

**Phase 5 — corrections, reversals, disputes (2 days).** Including the reversal ledger logic, the fiddliest code in the project.

**Phase 6 — reports (2 to 3 days).** Daily, workers, car-type mix, cancellations, cash variance, durations, stale, price changes, loyalty, exceptions. Then the `/platform` aggregates.

**Phase 7 — polish (2 days).** The three client push notifications, stale-wash alerts, audit coverage, rate limits, credit expiry if used.

Then React Native. Three shells on one API client: worker (price list, start, queue, settle), manager/orgadmin (prices, staff, shifts, reports), client (QR, points, active wash, history). The sysadmin console is a plain web page; nobody provisions tenants from a phone.

---

## 8. Testing

**Pricing**
- Branch override wins over the org default; org default applies where no override exists
- No price for the combination → 422 NO_PRICE_SET, never 0
- Inactive car type or service cannot start a wash
- A price change does not alter an existing wash's `quoted_amount_ugx`
- Manager cannot write a price for another branch → 403; worker cannot write any price → 403

**Starting a wash**
- No open shift → 409
- A request containing an `amount` field is rejected or ignored, never honoured
- Same `Idempotency-Key` twice → one wash in the queue
- Expired start token → 409 BAD_TOKEN
- Start token replayed a second time → 409 BAD_TOKEN
- Two workers scanning the same screen concurrently → exactly one wash created
- Starting a second unplated SUV Full wash returns `duplicate_warning` and still creates the wash
- Walk-in with no member code → starts fine, no client attached
- `use_free_wash` with 0 credits → 422; with 1 credit → flagged, credit **not** yet consumed

**Done and settle**
- Settling from `in_progress` → 409 BAD_STATE
- Pay token belonging to a different client → 409 CLIENT_MISMATCH
- Pay token bound to a different wash → 409 CLIENT_MISMATCH carrying that job's `job_no`, plate and client name
- A failed match does **not** consume the token; the same code still works on the correct job
- `settle-by-token` resolves the right job when two identical cars are in the queue
- `settle-by-token` for a wash at another branch → 409 WRONG_BRANCH
- Settling a job started by another worker without a reason → 409 HANDOVER_CONFIRM_REQUIRED, token **not** consumed
- The same token then works on the retry that carries a `handover_reason`
- A handover settlement puts the cash in the settler's shift, not the starter's
- A handover settlement credits the wash count to the starter
- A handover settlement notifies the starter
- A manager with an open shift can settle a worker's job under the handover flow
- Logging in on a device already registered to another user moves the `devices` row to the new user
- Logout deletes the `devices` row and revokes that device's refresh token
- After a logout and a different login, the queue returns only the new user's jobs
- Job numbers are sequential per branch per day and survive cancellations
- Pay token requested for a wash not yet `ready` → 422
- Settle with no token and no `unverified_reason` → 422 REASON_REQUIRED
- Settle with no token plus a reason → settles, `settle_verified = false`, client still earns the point
- Settling from another branch → 409 WRONG_BRANCH
- Settling twice → 409, exactly one point, exactly one receipt number
- Two concurrent settlements for one client → both succeed, total exactly +2
- Wash 7 grants exactly one credit and resets `wash_count` to 0
- Redemption consumes exactly one credit and earns no point
- Client attached only at scan 2 still earns the point
- Walk-in settles with no client → no points, appears in the day's totals
- Receipt numbers sequential per branch per day, no gaps from cancelled jobs

**Cross-shift**
- Wash started in shift A, settled in shift B → cash counts to B, wash credits the starting worker
- Shift cannot close with an `in_progress` wash; can close with a `ready` one
- A later reversal does not alter an already-closed shift's stored variance

**Cancel, correct, dispute, reverse**
- Cancel from `settled` → 409
- Cancel of a redemption job leaves the client's credit intact
- Correction re-resolves the price, stores the original amount, leaves loyalty alone
- Reversal writes a compensating entry and decrements the count
- Reversal where the granted credit was already spent does not push the account negative
- Dispute outside 24h → 422

**Credentials**
- Manager resetting a worker in own branch → 200; another branch → 403
- Manager resetting a manager or an orgadmin → 403 plus an audit entry
- A reset invalidates the target's refresh token
- `must_change_password` blocks every business endpoint → 403
- Change-password with a wrong `current_password` → 401

---

## 9. Open questions

1. **Add-ons.** Is a wash exactly one service, or can a worker add engine wash plus tyre polish to one job? If yes, `washes` needs a line-items child table and each line needs its own price resolution. Assumed one service per wash.
2. **Tips.** Recorded separately, or ignored? Untracked tips appear as phantom surpluses in shift variance, which is now your main cash control, so this matters more than it sounds.
3. **Free wash scope.** Does a credit cover any car type, or the type they usually bring? Earning on 10,000 saloon washes and redeeming on a 35,000 SUV full wash is a real cost leak. I would cap redemption value at the client's average paid wash.
4. **Credit expiry.** Never, or after some months? Column exists, rule undecided.
5. **Multiple workers on one car.** Common at a busy bay. Does the wash credit one worker or split across a team? Affects both the worker report and the car-type-mix control.
6. **Unverified settlements.** Specced as worker-settles-with-a-reason plus rate monitoring. The tighter option is a manager PIN for any settlement without a pay token. More secure, but it strands a paying customer whenever the manager is off site. Worth revisiting once you see the real rate in month one.
7. **Mandatory plates.** Optional today, with a soft prompt when a duplicate is detected (§2.7). Two unplated identical cars with no clients attached is the one case the system cannot disambiguate, and the job number is the only handle. Worth making the plate required once a bay runs more than one worker; decide after a week of real use.
8. **Cancellation authority.** Currently the worker can cancel with a reason and the manager reviews after the fact. The alternative is requiring manager approval to cancel, which is tighter but will annoy everyone on a busy morning. My recommendation is worker-cancels plus a weekly review of `GET /reports/cancellations`.
9. **Who closes a shift** if the manager is off site? `POST /shifts/:id/close` requires a manager today, and a manager's own shift requires an orgadmin. A worker self-closing defeats the control entirely.
9b. **Handover threshold.** Should a worker whose handover rate crosses some level be blocked rather than just reported? My instinct is no: blocking a settlement strands a paying customer, and the manager review is the right place for it. Revisit if the rate turns out to be high.
10. **Price change timing.** Instant, or effective from tomorrow? Instant is what is specced. Scheduled changes need an `effective_from` column, cheap now and awkward later.
11. **SMS provider.** OTP needs a gateway; Africa's Talking is the usual local choice. Confirm before Phase 1, since client auth depends on it.
12. **Offline behaviour.** If a bay loses connectivity, do workers stop or queue locally? Harder now than in v2, because scan 1 must resolve a member code and a price server-side. Minimum viable version: cache the price list and allow starts to queue locally, but require connectivity to settle, since settlement touches money and loyalty.
