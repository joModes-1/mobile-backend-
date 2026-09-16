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
