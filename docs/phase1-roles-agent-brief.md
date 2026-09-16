# Implementation Brief — Phase 1: Identity, Roles and Auth ONLY

You are implementing the foundation of a car wash management backend. Attached is
`carwash-loyalty-backend-spec.md`. Read §1 (Roles), §3.1, §4.1, §4.2, §4.3, §4.5, §4.10
and §5 before writing any code. That spec is the source of truth. If anything here
contradicts it, stop and ask rather than guessing.

---

## Scope — read this twice

**Build ONLY:** organizations, branches, and the five identity types with their auth,
role enforcement, and the password reset ladder.

**Do NOT build, scaffold, stub, or create migrations for:** washes, prices, services,
vehicle_classes, shifts, loyalty, client_tokens, reports, receipt counters, or anything
else in the spec. They come in later phases. Creating "just the table now, it's easier"
is out of scope and will be rejected.

If you finish early, do not start the next phase. Improve the tests instead.

---

## Environment

```
DB:       PostgreSQL, database `era92`, user `postgres`, password `root`, localhost:5432
Runtime:  Node.js + Express
Driver:   pg (node-postgres) with a connection pool
Migrations: knex — migrations only. Do NOT use knex or any ORM for queries; write raw SQL
Validation: zod on every request body
Hashing:  argon2 (argon2id) for passwords and PINs
Tokens:   jsonwebtoken
Logging:  pino
```

Put the credentials in `.env` and add `.env` to `.gitignore` before your first commit.
These are local development credentials only; never reuse them anywhere else, and the
production connection string must come from the environment, never from a file in the repo.
Provide a committed `.env.example` with the keys and empty values.

Required env keys: `DATABASE_URL`, `JWT_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`,
`SEED_SYSADMIN_EMAIL`, `SEED_SYSADMIN_PASSWORD`, `PORT`.

---

## Work order — one role at a time, each proven before the next

Do not move to the next step until the current one passes its verification block.
Report to me after each step with the evidence described under "Verification protocol".

### Step 0 — Skeleton
- `express` app, pino logging, JSON error handler producing the spec's envelope
  (`{ok:true,data}` / `{ok:false,error:{code,message,details}}`), health endpoint,
  pg pool, knex configured for migrations, zod set up.
- **Verify:** server boots, `GET /api/v1/health` returns 200, a deliberate thrown error
  returns the error envelope and not an HTML stack trace.

### Step 1 — Schema
Migrations for exactly these tables, from §3.1 and §3.6, in this order:
`platform_admins`, `organizations`, `branches`, `staff_users`, `clients`,
`refresh_tokens`, `otp_codes`, `devices`, `audit_logs`.

Include every constraint and index the spec lists, in particular:
- `staff_role_branch_ck` — orgadmin has NULL branch_id, everyone else has one
- unique `(org_id, lower(username))` on staff_users
- unique `(org_id, phone)` and unique `member_code` on clients
- unique `lower(email)` on platform_admins, unique `lower(slug)` on organizations
- unique `(org_id, upper(code))` on branches

**Verify:** `knex migrate:latest` then `knex migrate:rollback` then `migrate:latest`
again, clean both ways. Then prove each constraint by attempting the violation in psql
and pasting the error: an orgadmin with a branch_id, a worker without one, two staff with
the same username in one org, two clients with the same phone in one org.

### Step 2 — `sysadmin` (platform_admins)
Build first, because org provisioning is how every other fixture gets created.
- `POST /auth/platform/login`, `POST /auth/platform/change-password`, `GET /me`
- `POST /auth/refresh`, `POST /auth/logout` with rotating refresh tokens stored hashed
- `requirePlatform` middleware: accepts only `type:'platform'` JWTs
- `POST /platform/orgs` — creates the org, creates its first orgadmin, returns that
  temp password exactly once
- `GET /platform/orgs`, `GET /platform/orgs/:id`, `POST /platform/orgs/:id/suspend`,
  `POST /platform/orgs/:id/activate`, `POST /platform/orgs/:id/admins`
- `GET/POST /platform/admins`, `POST /platform/admins/:id/reset-password`
- Seed script creating the first sysadmin from env, with `must_change_password = true`

**Verify:** log in with the seeded account; confirm every business route is blocked until
the password is changed; create an org; confirm the returned temp password logs the new
orgadmin in; confirm a second call to fetch that password is impossible; confirm
`POST /platform/admins/:id/reset-password` refuses to target self.

### Step 3 — `orgadmin`
- `POST /auth/staff/login`, `POST /auth/staff/change-password`
- `requireRole` middleware and the `org_id`-from-JWT scoping helper
- `GET/POST /branches`, `GET/PATCH /branches/:id`
- `POST /staff` (any role), `GET /staff`, `GET /staff/:id`, `PATCH /staff/:id`,
  `POST /staff/:id/suspend`, `POST /staff/:id/activate`
- `POST /staff/:id/reset-password` with the strictly-junior rule from §4.10

**Verify:** an orgadmin from org A cannot see, fetch, patch or reset anything in org B —
test every one of those verbs, not just the list endpoint. Confirm an orgadmin cannot
reset another orgadmin. Confirm creating a manager returns a temp password that works and
forces a change.

### Step 4 — `manager`
- Reuses the staff routes with tighter scope: sees and manages own branch only
- May create `worker` only, in own branch only
- `POST /staff/:id/set-pin` for their own PIN; PIN hashed with argon2
- May reset a worker in their own branch; must be refused for a worker in another
  branch, for another manager, and for an orgadmin

**Verify:** all four reset cases, with the refusals returning
`403 CANNOT_RESET_PEER_OR_SENIOR` and writing an audit row. Confirm a manager creating a
staff member with `role: 'manager'` or `role: 'orgadmin'` is rejected. Confirm a manager
listing `/staff` cannot widen the result by passing another `branch_id`.

### Step 5 — `worker`
- Login, change own password, `GET /me` returning role and branch
- No management endpoints at all: every `/staff` write and every `/branches` write
  must return 403

**Verify:** enumerate every endpoint built so far and assert the worker's result for each
is either 200 where intended or 403. Produce that as a table in your report.

### Step 6 — `client`
- `POST /auth/client/register` → creates unverified client, issues OTP
- `POST /auth/client/verify-otp` → tokens plus `member_code`
- `POST /auth/client/login`, `POST /auth/client/request-otp`,
  `POST /auth/client/reset-password`
- `member_code` generated server-side, unguessable, unique
- OTP: hashed at rest, expiring, attempt-counted, rate limited to 3 per phone per hour
- For now log the OTP to the console instead of sending SMS, and mark clearly in code
  where the provider will plug in

**Verify:** an expired OTP fails; a consumed OTP cannot be reused; the fourth OTP request
within an hour is rejected; a client token is rejected by every staff and platform route.

### Step 7 — Cross-cutting, then done
- `requirePasswordChanged` middleware applied globally, allowing only
  `/auth/*/change-password`, `/me`, `/auth/logout`
- Suspended org blocks logins and rejects existing tokens for that org's staff and
  clients with `403 ORG_SUSPENDED`, checked in auth middleware
- `POST /me/device`: login upserts the `devices` row to the current owner, logout
  deletes it and revokes that device's refresh token (§2.10, rule 5d)
- Every password reset revokes all of that user's refresh tokens
- Audit rows for: org created, org suspended, staff created, password reset, reset
  refused, PIN set

---

## Non-negotiable rules from the spec

1. `sysadmin` lives in `platform_admins`, never in `staff_users`. There is no nullable
   `org_id` anywhere.
2. Every org query filters on `org_id` taken from the JWT, never from the request body,
   path or query. Route it through one helper so it cannot be forgotten.
3. A missing or null `org_id` on an org route is a 500, never a query that runs
   unfiltered.
4. Password reset checks the rank of the **target**, not just the role of the caller.
   A manager resetting an orgadmin must fail. This is the single most important check
   in this phase.
5. Temp passwords are returned once, in the response body, and never stored in plaintext
   or retrievable again. 8 characters, excluding `0 O 1 l`.
6. A reset revokes every refresh token for that user.
7. Refresh tokens are stored hashed, rotated on use, and the old one revoked.
8. A PIN is not a password. Never accept a PIN at any login endpoint.
9. Rate limit: 5 failed logins locks the account 15 minutes; OTP 3 per phone per hour;
   PIN 5 attempts then locked.
10. Server time only. Never trust a timestamp from a client.

---

## Verification protocol — this is the part that matters

"No bugs" is not achievable by instruction. It is achievable by proving each step before
building on it. For every step above:

1. Write the code.
2. Write integration tests hitting real HTTP against the real `era92` database. No mocks
   of the database, no mocks of argon2 or JWT.
3. Run them. Paste the actual output.
4. Additionally exercise the endpoints by hand with `curl` and paste real request and
   response pairs, including the failure cases.
5. State explicitly: what you verified, what you did NOT verify, and anything you are
   unsure about.

Rules for your reports:
- Never write "should work", "this will handle", or "presumably". Either you ran it and
  have output, or you say you did not test it.
- If a test fails, do not adjust the test to pass. Fix the code, or tell me the spec is
  wrong and why.
- If you cannot verify something, say so in that step's report rather than moving on.
- Do not refactor a previous step while working on a later one without telling me.
- If you find a contradiction or gap in the spec, stop and ask. Do not invent a rule.

## Definition of done for this phase

- `knex migrate:latest` from an empty `era92` database produces the full schema
- Seed produces one sysadmin, one demo org, two branches, one orgadmin, one manager,
  two workers, one client
- Every endpoint in §4.1, §4.2, §4.3 (branches only), §4.5 and §4.10 exists and is tested
- The permission table from Step 5 is complete, with all five actor types as rows and
  every endpoint as columns
- All acceptance tests below pass, run in one command

## Acceptance tests — all must pass

```
Manager resets a worker in own branch                   → 200
Manager resets a worker in another branch               → 403
Manager resets another manager                          → 403 + audit row
Manager resets an orgadmin                              → 403 + audit row
Orgadmin resets another orgadmin                        → 403
Orgadmin resets a manager                               → 200
Sysadmin resets an orgadmin                             → 200
Sysadmin resets self                                    → 403
A reset invalidates the target's existing refresh token → old token 401
must_change_password blocks a business endpoint         → 403 PASSWORD_CHANGE_REQUIRED
Change-password with a wrong current_password           → 401
Orgadmin of org A reading org B's staff                 → 403 or empty, never org B data
Orgadmin of org A patching a branch in org B            → 403
Worker calling any /staff write                         → 403
Client token on any staff route                         → 403
Staff token on any /platform route                      → 403
Suspended org: staff login                              → 403 ORG_SUSPENDED
Suspended org: existing valid access token               → 403 ORG_SUSPENDED
Sixth failed login in a row                             → 429 or 423, locked 15 min
Fourth OTP request within an hour                       → 429
Reused OTP code                                         → 400
Expired OTP code                                        → 400
Login on a device registered to another user            → devices row moves
Logout                                                  → devices row gone, refresh revoked
Orgadmin created with a branch_id                       → DB constraint rejects
Worker created without a branch_id                      → DB constraint rejects
```

Start with Step 0. Report back before starting Step 1.
