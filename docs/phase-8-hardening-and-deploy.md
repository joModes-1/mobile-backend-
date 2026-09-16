# Phase 8 — Hardening and Deployment (3 days)

Read §5 of the spec in full, plus `README-phase-guide.md`.

## Why this is a phase and not an afterthought

This system becomes the only record of who paid what. A car wash that loses a day of
takings because nobody tested the restore path will stop using it, and they will be right
to. Everything here is about the day something goes wrong.

## Scope

**Build:** production configuration, migration strategy, backups with a proven restore,
error tracking, monitoring, verified rate limits, log hygiene, and a security pass.

**Do NOT build:** new features. If you find a missing feature here, write it down and tell
me; do not add it.

---

## Step 8.1 — Configuration

- Every secret from the environment. No connection string, JWT secret or provider key in
  the repo, in any file, at any point in history. **Check the git history, not just the
  working tree** — if the dev credentials were ever committed, say so.
- `.env.example` committed with keys and empty values; `.env` gitignored.
- Validate the whole environment with zod **at boot** and refuse to start if anything is
  missing or malformed. A server that boots with a null JWT secret is worse than one that
  will not boot.
- Separate `development`, `test` and `production` configs. Tests must never be able to
  point at the production database — assert on the database name at boot in test mode.
- `JWT_SECRET` for production must be freshly generated, not the dev value.

## Step 8.2 — Migrations in production

- Migrations run as an explicit deploy step, never automatically on app boot. Two instances
  booting at once will otherwise race.
- Never edit a migration that has run anywhere. Write a new one.
- Every migration needs a tested `down`. Prove it by rolling back and forward on a copy of
  production data.
- Additive-first for anything with live traffic: add a nullable column, backfill, then add
  the constraint. A `NOT NULL` added in one step locks the table.

## Step 8.3 — Backups, and the part everyone skips

- Automated `pg_dump` at least daily, ideally with point-in-time recovery. Off the machine
  that hosts the database.
- **Restore one into a scratch database and run the test suite against it.** A backup you
  have not restored from is a hope, not a backup. Paste the output of that restore.
- Document, in the repo, the exact commands to restore, so it can be done by someone
  panicking at 7am.
- Know and write down your recovery point objective: how many minutes of takings can you
  afford to lose? For a cash business, one day is too much.

## Step 8.4 — Observability

- Error tracking (Sentry or equivalent) with the actor id, org id and request id attached,
  and **no passwords, tokens, PINs or push tokens in any payload**.
- Request id generated per request, returned in a response header, logged on every line.
  This is how you follow one worker's failed settlement through the logs.
- Uptime check against `/api/v1/health`, which should verify the database connection, not
  just that Express is alive.
- Alerts that actually reach you: server down, error rate spike, database connections
  exhausted, a job failing.
- **Log hygiene:** never log a password, a raw token, an OTP code, or a full phone number.
  Audit your existing log lines for these before signing off — the OTP console log from
  Phase 1 must be removed or gated to development.

## Step 8.5 — Rate limits, verified under load

Phase 1 configured these. Now prove them with a load tool, not by reading the code:

- 5 failed logins → locked 15 minutes
- OTP: 3 per phone per hour
- Manager PIN: 5 attempts then locked
- `start-token`: 5 per 10 minutes per client
- A sensible global per-IP ceiling

Also confirm the pool size is sane for the host, and that pool exhaustion returns a 503
rather than hanging every request.

## Step 8.6 — Security pass

Work through this list and report on each:

- Every org route scoped by `org_id` from the token. **Grep every query for a `WHERE` that
  lacks it** and justify each exception.
- Every `:id` route: does it verify the resource belongs to the caller's org? A UUID is not
  an authorisation check.
- The strictly-junior reset rule, re-tested end to end.
- Platform routes reachable only with a `platform` token.
- No stack traces or SQL text in any production error response.
- HTTPS enforced; HSTS; sensible CORS, not `*`.
- `helmet` or equivalent headers.
- SQL: parameterised everywhere. Grep for string concatenation or template literals inside
  query text and report every hit.
- argon2 parameters appropriate for the host, not the library defaults if the host is small.
- Dependency audit clean, or every finding explained.

## Step 8.7 — Deploy

- One-command deploy, documented.
- Rollback procedure, documented and **tested once**.
- Database and application separately backed up and separately restorable.
- Health check wired to whatever restarts the process.
- A staging environment that runs the same migrations, even if it is small.

---

## Acceptance tests

```
Boot with a missing env var                      → refuses to start, names the var
Boot with JWT_SECRET unset                       → refuses to start
Test suite pointed at the production DB name     → refuses to run
Restore yesterday's backup into a scratch DB     → test suite passes against it
Rollback the latest migration and re-apply       → clean both ways
6th failed login                                 → locked, verified with a load tool
4th OTP in an hour                               → 429
6th start-token in 10 minutes                    → 429
Force a 500                                      → envelope only, no stack, no SQL
Grep logs for password/token/otp/phone           → no hits
Health endpoint with the DB stopped              → unhealthy, not 200
Pool exhaustion under load                       → 503, recovers, no hang
Deliberate deploy then rollback                  → previous version serving
```

## Done when

You have restored a real backup and run the tests against it, the app refuses to boot
misconfigured, no secret exists anywhere in the repo or its history, and you have rolled
back a deploy once on purpose.
