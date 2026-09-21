# Current state of the system

**The phase docs in this folder are a build history, not a description of
what exists.** They were written before the system was finished and parts of
them are now wrong. This file records where the code actually stands. Where
the two disagree, this one is right.

Each section below names the phase doc it supersedes.

---

## Client authentication is email and username, not phone OTP

*Supersedes: backend spec §4.1, phase1-roles-agent-brief Step 6*

The spec describes customers signing up with a phone number and verifying by
SMS OTP — `/auth/client/request-otp`, `/auth/client/verify-otp`, rate limited
per phone. **None of that exists.** Migration `20260829_006` moved client auth
to username + email.

What is actually there, in `modules/clients/clientAuth.ts`:

| Route | Body |
|---|---|
| `POST /auth/client/register` | `{ full_name, username, email, password }` |
| `POST /auth/client/verify-email` | `{ email, code }` |
| `POST /auth/client/login` | `{ username, password }` |
| `POST /auth/client/request-password-reset` | `{ email }` |
| `POST /auth/client/reset-password` | `{ email, code, new_password }` |
| `POST /auth/client/change-password` | `{ current_password, new_password }` |

Verification codes go by email (`utils/email.ts`), and the rate limit —
3 per hour — is keyed on the email address.

### Changing a password reissues the session

The spec says a password change requires the current password. True, but
incomplete, and the omission breaks the flow if you build to it.

All three change-password routes (platform, staff, client) **revoke every
refresh token on the account and then mint a fresh pair for the caller**,
returned in the response body as `access_token` and `refresh_token`.

Revoking the caller's own token as well was the obvious reading, and it was
wrong: the next token refresh failed and the app dumped the user back on the
login screen to retype the password they had just set. Other devices are
signed out; the device doing the changing stays in.

### Refresh and logout are not generic routes

The spec lists `POST /auth/refresh` and `POST /auth/logout` as shared. They
are not. `/refresh` exists **only** at `/auth/platform/refresh` — every actor
type uses that one path. Logout exists at `/auth/platform/logout` and
`/auth/staff/logout`. There is no client logout route.

---

## The catalogue is branch-scoped

*Supersedes: phase-2-catalogue-and-pricing Steps 2.1 and 2.3*

Phase 2 describes vehicle classes and services as organisation-wide, unique on
`(org_id, lower(name))`. Migration `20260907_009` changed that: both tables
gained a nullable `branch_id`.

- `branch_id IS NULL` — shared across the organisation, as before
- `branch_id` set — belongs to that branch alone

Two branches can now each define their own "SUV" without colliding. The old
unique index could not express that, so it was replaced by four partial ones
(shared names unique per org; branch names unique per branch), and the
single-default-service rule likewise split into a per-org and a per-branch
index.

### Managers can edit the catalogue

Phase 2 heads its endpoint table "Catalogue endpoints (orgadmin)". All six are
now `requireRole('orgadmin', 'manager')`. A manager adding a car type is the
normal case — that is what branch scoping is for.

The rules live in `modules/catalogue/scope.ts` and are worth stating plainly,
because they are not obvious and appear in no other doc:

- **`catalogueScope()`** — an org admin with no filter sees everything in the
  org. A manager or worker is pinned to their own branch and **cannot widen it
  by passing `branch_id` in the query string**.
- **`catalogueWriteBranch()`** — a manager creating a row for another branch
  gets `403`. Rejected outright, not quietly redirected to their own branch.
- **`assertCanEditCatalogueRow()`** — a manager editing a shared
  (`branch_id IS NULL`) row gets `403 SHARED_CATALOGUE_ITEM`. Shared rows
  belong to the org admin.

Error codes `NO_BRANCH` and `SHARED_CATALOGUE_ITEM` come from here.

**One caution:** this migration's `down()` deletes branch-scoped rows along
with the prices and washes referencing them. It is destructive by design and
does not round-trip cleanly, which contradicts phase-2's "never hard-delete"
and phase-8's expectation of a reversible migration. Do not roll it back on a
database with real data.

---

## Issue reporting exists and is documented nowhere else

*New — no phase doc covers this*

Any signed-in user can report a problem. Org admins triage their own
organisation's reports and escalate what they cannot fix; platform admins see
everything and are the end of the line.

Tables: `issue_reports` (migration `_010`) plus escalation columns (`_011`) —
`escalated_at`, `escalated_by`, `escalation_note`, `resolved_by_type`,
`reporter_email`, and delivery tracking for the resolution email.

Routes in `modules/support/issueRoutes.ts`: `POST /issues`, `GET /issues`,
`PATCH /issues/:id`.

**These routes are mounted without `requirePasswordChanged`, on purpose.**
Someone locked out behind a broken forced-password-change is exactly the
person who needs to report it. This is a real exception to the rule stated in
the spec and in phase 1 that only `/auth/*/change-password`, `/me` and
`/auth/logout` skip that gate.

---

## Billing and subscriptions

*New — no phase doc covers this*

Migration `20260906_008` added `subscription_plans` and `org_payments`, plus
six columns on `organizations`: `plan_id`, `billing_status`
(`trial` / `active` / `past_due` / `cancelled`), `onboarded_at`,
`trial_ends_at`, `next_due_at`, `billing_notes`.

Six endpoints in `modules/platform/orgRoutes.ts`:

```
GET    /platform/plans
POST   /platform/plans
PATCH  /platform/plans/:id
PUT    /platform/orgs/:id/subscription
POST   /platform/orgs/:id/payments
GET    /platform/billing/summary
```

A payment records the **service window it buys** (`period_start`,
`period_end`), not just when it arrived. Renewal is measured from the end of
the previous period, so a late payment still extends from where cover ran out.

---

## Reports

*Supersedes: phase-6-reports*

Phase 6 says twelve endpoints, each in its own file under
`modules/reports/queries/`. There are **seventeen**, all inline in
`reportRoutes.ts`. That directory does not exist.

Three are entirely undocumented: `GET /reports/trend`,
`GET /reports/cash-position`, and the platform overview.

**`/platform/stats` is at the wrong path in every doc.** It is mounted under
the reports router, so the real path is **`/api/v1/reports/platform/stats`**.

**No report endpoint admits workers.** Phase 6 says "a worker sees only
themselves"; in fact every route is `orgadmin` or `orgadmin, manager`, so a
worker gets 403 from all seventeen. Phase 6's acceptance test only ever
exercises its 403 branch.

`/reports/price-changes` and `/reports/loyalty` are **orgadmin-only** — phase 6
implies managers can read them.

Route naming to be precise about: it is `/reports/cash-variance`, and the
unverified-settlement report is `/reports/unverified`.

---

## Notifications

*Supersedes: phase-7-notifications-and-jobs*

The signature in the doc is wrong. It is:

```ts
notify(recipientType: 'client' | 'staff', recipientId: string,
       event: string, payload?: Record<string, any>)
```

Four arguments, not three. One file, `modules/notify/index.ts`, with a
`switch` over the event name. Sending never throws — a failed push must never
fail the wash that triggered it.

**The mobile half now exists**, which the doc predates: `expo-notifications`
and `expo-device` are installed, the app requests permission and registers its
push token on sign-in (`mobile/src/hooks/usePushNotifications.ts`), and
`POST /me/device` stores it.

Worth knowing: the server had been sending pushes correctly all along. Nothing
arrived because no device had ever registered a token to send to.

Background jobs are TypeScript, not the `.js` filenames the doc lists, and
there is an undocumented `jobs/scheduler.ts` that wires them to cron.

---

## Deployment

*Supersedes: phase-8-hardening-and-deploy Step 8.7*

Phase 8 describes deployment in the abstract. Concretely:

**Backend** — Render Web Service plus managed Postgres, configured by
`render.yaml`. Migrations run in the **build command**, not on boot:

```
npm install && npm run build && npm run migrate
```

`knex migrate:latest` only applies what has not run, so a redeploy with no new
migrations is a safe no-op.

**Mobile** — EAS Build for binaries, EAS Update for over-the-air JavaScript
updates. A JS-only fix reaches installed apps in about a minute without a
rebuild; native changes (new native library, permissions, icon) still need a
full build.

**Configuration on a host is environment variables, not a `.env` file.** The
seeder reads `process.env` directly for exactly this reason.

**`render.yaml`'s comment about seeding is now out of date** — it warns that
seeding would "duplicate or fight with real data on every subsequent deploy".
That was true of the old destructive seeder. Seeding is now additive and safe
to repeat; it is still left out of the build command because seeding a fresh
database once, deliberately, is clearer than doing it on every deploy.

---

## Seeding

*Supersedes: backend spec line ~1220, phase-10 §2*

There are two seed files, and the first one no longer behaves as documented.

### `001_seed.ts` — the fixture, now idempotent

It **used to delete every table** before inserting, which made it a
reset-to-zero tool that could not safely be run twice. It now looks each row
up by its natural key and inserts only what is missing.

Consequences worth being explicit about:

- Safe to run at any time, on any database, as often as you like
- **It will not reset a password that has since been changed** — an existing
  account keeps its current password
- It can no longer produce a pristine database

That last point breaks an assumption in **phase 10**, whose verification loop
begins "tear down, migrate, seed the fixture" and expects a clean slate each
cycle. Getting one now means dropping and recreating the database first;
seeding alone will not do it.

(The unique indexes here are expression indexes — `lower(slug)`, `upper(code)`,
`lower(username)` — which `ON CONFLICT` cannot target. Hence select-then-insert
rather than an upsert.)

### `002_activity.ts` — 30 days of history

New, and undocumented anywhere else. Generates coherent operating history so
the reports have something to show: shifts, washes, cash handovers,
cancellations, disputes, reversals, corrections, loyalty progress, and
subscription payments.

Coherent is the point. Every figure reconciles against the rows around it:

- a wash belongs to a shift its worker actually had open, at that branch
- a shift's expected cash is the exact sum of the washes settled into it
- variance is genuinely counted minus expected
- a client's loyalty balance equals the sum of their ledger entries

Three deliberate arrangements, each there so a screen has something real to
show rather than an empty state:

- **Two workers hold cash over 24 hours**, so the overdue-cash alert fires
- **One shift sits in `pending_close`** — counted, awaiting a manager
- **Shine Motors gets no washes at all**, because the platform admin's "quiet
  organisations" panel needs an idle org

Idempotent via a marker: every row it writes carries `notes = 'seed:activity'`,
and it exits early if any are already present.

---

## Endpoints that exist in code but in no doc

Inline in `app.ts`:

```
GET  /clients/lookup
GET  /clients                      orgadmin search and list
POST /clients                      bay registration
GET  /loyalty-config
PUT  /loyalty-config
GET  /audit-logs                   org-scoped
POST /clients/:id/loyalty/adjust
```

Elsewhere:

```
POST /washes/settle-by-token
POST /washes/:id/apply-free-wash
GET  /washes/mine/today
GET  /me/washes/loyalty/ledger
POST /prices/resolve
POST /shifts/:id/request-close
POST /shifts/:id/reopen
POST /staff/:id/set-pin
```

Two notes on these:

`POST /clients` synthesises a `walkin_*` username and an `@walkin.local` email
so a customer registered at the bay satisfies the auth columns added by
migration 006.

Loyalty adjustment is defined **twice** — as `POST /clients/:id/loyalty/adjust`
in `app.ts` and as `POST /washes/:id/loyalty/adjust` in `exceptionRoutes.ts`.
Different paths, near-identical logic. Worth consolidating.

### Documented but does not exist

`GET /platform/audit`, in the spec's §4.2 table. There is no such route. The
only audit endpoint is the org-scoped `GET /api/v1/audit-logs`.

---

# September 2026 — phone sign-in, commission, and what it broke

Everything above this line predates a run of changes made on 20–21 September
2026. Where the two disagree, this section is the later word.

## Sign-in is now phone + one-time code, for every role

This is the second complete reversal of the auth design, and it lands on the
opposite side of the first one.

The spec wanted clients on phone + SMS OTP and staff on username + password.
Migration `20260829_006` abandoned the phone half and moved clients to
username + email. That is the state described further up this file.

Now the reverse: **`POST /auth/phone/start` and `/auth/phone/verify` are the
only sign-in the mobile app offers, for clients, staff and platform admins
alike.** One number, one code, no passwords anywhere in the UI.

`phoneAuth.ts` resolves a number in priority order — `platform_admins`, then
`staff_users`, then `clients` — because the same number must not mean two
people and the more privileged account should win if it ever did. A number
nobody recognises creates a new **client** account, and that is the only case
that asks for a name.

The password routes (`/auth/staff/login`, `/auth/client/login`,
`/auth/platform/login`, all three `change-password`) still exist and still
work. Nothing in the app calls them. They were left mounted deliberately, as
an out-of-band way in if the SMS gateway is down.

Consequences worth knowing:

- **The app has no login screen.** `LoginScreen`, `ForgotPasswordScreen`,
  `ChangePasswordScreen` and `AuthShell` were deleted, along with
  `login` / `changePassword` / `mustChangePassword` on the auth context. The
  `must_change_password` gate in `App.tsx` is gone — a passwordless account
  would otherwise have been routed to a change-password screen with nothing
  to type.
- **SMS is now load-bearing.** `AFRICASTALKING` / `AFRICASTALKING_USERNAME`
  are `.optional()` in config, so the server boots without them, `sendSms`
  logs a warning and returns `{sent:false}`, and `/auth/phone/start` still
  answers `200 ok`. A deployment missing those two variables accepts a phone
  number, reports success, and sends nothing. Neither `.env.example` nor
  `render.yaml` lists them. `TEST_MODE=true` returns the code in the response
  body and is the only reason local testing works.
- **Staff creation no longer issues a password or sends email.** See below.

## Constraints that later migrations relaxed

Three places where a later migration reversed an earlier decision. None are in
the phase docs, and each is invisible unless you read the migrations in order.

| Original | Reversed by | Why |
|---|---|---|
| `clients.phone NOT NULL` (001) | 006 drops it | username/email auth meant a client need not have a phone |
| `services` / `vehicle_classes` single unique-name index + `one_default_service_per_org` (002) | 009 drops both, replaces with four partial indexes | branch-scoped catalogue |
| `staff_users.password_hash NOT NULL` (001) | 014 drops it | phone-only staff have no password |

Migration 014 also added `staff_users_phone_uniq`, a partial unique index on
`phone WHERE phone IS NOT NULL`. **001 had no uniqueness on staff phone at
all.** Before this, two staff rows could share a number and phone sign-in
would resolve whichever one Postgres happened to return first. The same
migration normalised existing phones to E.164 — one seeded worker was stored
as `0709011288`, which sign-in could never have matched, because it normalises
input to `+256709011288` before looking it up.

## Staff creation (supersedes phase-1 and spec §4.10)

`POST /staff` now:

- **requires `phone`**, normalises it to E.164, and rejects a duplicate with
  `409 PHONE_TAKEN` — it is the sign-in identity, so an account without one
  cannot be signed into at all
- **generates no password** (`password_hash` is `NULL`) and **sends no email**
- sets `must_change_password = false`, because there is nothing to change

`PATCH /staff/:id` applies the same normalisation and uniqueness. It
previously stored whatever string was submitted, which is how the
`0709011288` row above came to exist.

The spec's staff password-reset ladder (§4.10) still exists as code —
`POST /staff/:id/reset-password` — but the app no longer exposes it, and for
an account created since this change there is no password for it to reset. It
would create one.

**Not converted:** the sysadmin screens that create organisations and platform
admins still generate temp passwords. Those accounts can only sign in if their
phone number happens to be on file.

## Worker commission (undocumented anywhere else)

Migration 015. A worker keeps a percentage of the cash they collect.

- `branches.worker_commission_bp` — the rate, per branch, in basis points
  (250 = 2.5%), `CHECK` between 0 and 10000. Basis points rather than a float
  because a split done in binary floating point eventually disagrees with
  itself by a shilling, and cash reconciliation is exactly where that gets
  noticed. Set through `PATCH /branches/:id` as `worker_commission_pct`,
  converted on the way in.
- `washes.worker_commission_ugx` — what the worker actually earned on that
  wash, **computed and frozen at settlement**, never derived from the branch
  rate at read time. The rate changes; last month's report must still show
  what was owed last month.

Cash only. A mobile-money or free wash earns nothing, because the worker never
holds that money. Rounded **down** — rounding up would have them keeping a
shilling the till never received.

The consequence that matters: **`computeExpectedCash` now returns
`amount_ugx - worker_commission_ugx`.** The worker keeps their cut out of the
notes in their hand, so the till was never going to receive it. Summing the
gross would make every handover look short by exactly the commission, and the
variance report would flag honest workers as light. The `GET /shifts` list
query nets it the same way and additionally exposes `worker_commission_ugx`
per shift.

`/reports/daily` gained `worker_commission_ugx` and `net_ugx` alongside the
untouched `gross_ugx`.

`GET /washes/mine/earnings` is new: today / this week / this month totals,
fourteen daily buckets, and the last twenty washes with their individual cuts.
Attribution is to `settled_by_worker_id` — whoever took the money earned the
cut, which is also whoever is holding the cash it came out of. On a handover
that is deliberately the settling worker, not the starter.

## Account deletion (required by both app stores)

`POST /auth/client/delete-account`. Apple guideline 5.1.1(v) and Google Play
both require an in-app way to delete an account for any app that lets people
create one; a support email is not enough.

It **anonymises rather than hard-deletes**. `washes.client_id` and
`loyalty_ledger.client_id` have no `ON DELETE CASCADE`, deliberately — wash and
loyalty history is the organisation's operational record, not only the
customer's. A real `DELETE` would either fail on the foreign key or, if
cascaded, destroy an org's history because one customer asked to leave.
Instead every identifying column is scrubbed, `status` becomes `'deleted'`,
and the row stays so the history pointing at it stays.

Setting `phone = NULL` has a useful side effect: the number becomes invisible
to phone sign-in and free for reuse, so a later signup on it correctly creates
a fresh account rather than resurrecting the old one.

## Notification events (supersedes phase-7)

`notify()` takes four arguments, not the three the phase doc shows:
`(recipientType, recipientId, event, payload)`.

Two events were added in September: **`stale_wash`** and **`daily_summary`**.
Both existed before as calls to `wash_started` with their text smuggled
through that template's `service_name` slot, which meant a manager's phone
read *"Wash Started — Your Daily Summary wash (…) is in progress. Quoted: UGX
0"*. They are their own events now, so the copy can say what it means and an
edit to the customer-facing wash copy cannot silently rewrite an operational
alert.

While fixing that: `nightlySummary` referenced `$2` while passing a single
parameter, so Postgres rejected the query with *"could not determine data type
of parameter $1"* on every run. The job's own `try/catch` swallowed it.
**It had never once sent a summary.** Now `$1` throughout.

## Tests

`package.json` pointed `npm test` at jest. There is no jest config, and the
seven scripts in `tests/` are standalone `ts-node` programs that drive the HTTP
API — so `jest --listTests` found nothing and `npm test` passed while running
zero tests. There are now `test:phase2` … `test:phase7`, `test:e2e` and
`test:all` scripts that invoke them properly, and `phase2-test.ts` exits
non-zero on failure like the rest.

They need a **pristine database**: several change the credentials they
authenticate with (`phase3-test.ts` changes the orgadmin password during
setup), and the seeder is idempotent, so re-seeding does not put the original
back. See `tests/README.md`. They also still sign in with username and
password, so they exercise a path no real user takes — **the phone flow has no
automated coverage at all.**

## Still open

- `GET /shifts/:id` returns `washes: []` unconditionally
  (`shiftRoutes.ts:456`, "Washes will be added in Phase 4"). Phase 4 shipped
  long ago. Dormant only because nothing calls the endpoint.
- ~~Loyalty adjustment is defined twice.~~ **Fixed.** The duplicate in
  `exceptionRoutes.ts` has been deleted. It was mounted under `/washes`, so
  it answered at `/washes/:id/loyalty/adjust` while reading `:id` as a
  **client** id: passing a real wash id returned `500` with Postgres `23503`
  as it tried to create a loyalty account for a non-existent client, and
  passing a genuine client id would have succeeded and mutated balances
  through a path nothing was meant to use. It rolled back cleanly either
  way, so nothing was ever corrupted.

  The surviving implementation is `app.ts:95` at
  `/clients/:id/loyalty/adjust` — the one the app calls. Verified after
  removal: the orphan now 404s, and the real route still returns 200, moves
  the balance, and writes a `manual_adjust` row to `loyalty_ledger`.

  (An earlier draft of this document claimed the live route wrote no ledger
  entry. That was wrong — it calls `writeLedgerEntry` at `app.ts:127`. The
  ledger simply had no `manual_adjust` rows because the feature had never
  been used.)
- Around twenty endpoints are no longer called by the app, mostly the password
  routes orphaned by phone sign-in. They were probed rather than assumed
  harmless:

  - `POST /auth/staff/login` and `/auth/staff/change-password` called
    `argon2.verify()` on a `password_hash` that is now `NULL` for phone-only
    staff. argon2 throws on a null hash rather than returning true — so this
    was **never an authentication bypass** — but the exception escaped the
    handler and a failed login returned **500** instead of 401. Both now
    reject with `NO_PASSWORD_SET` before reaching argon2. Verified by
    creating a passwordless staff row and logging in against it: 500 before,
    401 after.
  - `platform_admins.password_hash` is still `NOT NULL`, so the platform
    login has no equivalent exposure. `clientAuth` already guarded it.
  - `POST /staff/:id/reset-password` is harmless — it *writes* a hash rather
    than verifying one. It would hand a phone-only account a password it has
    no use for, but it cannot error.
- Shifts auto-open (client-side, on the worker's home screen) but never
  auto-close. A shift and its running cash total continue indefinitely until a
  manager closes it on Cash Handover. This is deliberate: closing a shift *is*
  the act of counting the cash, and a scheduled job has nobody to count it —
  auto-closing with `counted = expected` would make variance always zero and
  silently disable the only check on missing cash.
