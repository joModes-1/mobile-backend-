# Tests

These are **integration scripts**, not unit tests. Each one drives the real
HTTP API against a running server and a real Postgres database.

## Running them

```bash
npm run dev                # in one terminal — server must be on :3456
npm run test:phase3        # in another
npm run test:all           # every phase in order, stops at the first failure
npm test                   # alias for test:e2e
```

`jest` and `ts-jest` are in `devDependencies` and `package.json` used to point
`npm test` at jest. There is no jest config and none of these files use jest
globals, so `jest --listTests` found **zero** tests and `npm test` passed
while running nothing at all. The scripts are now invoked directly through
`ts-node`, which is what they were always written for.

## They need a pristine database

This is the important caveat, and it is not a bug in the scripts so much as a
constraint on how they can be used.

Several scripts **change the state they depend on**. `phase3-test.ts`, for
example, logs in as `orgadmin` with the seeded password and then immediately
calls `change-password` to set a new one. On a second run the seeded password
no longer works and the script dies at setup with a 401 before asserting
anything:

```
Error: orgadmin login 401 {"ok":false,"error":{"code":"INVALID_CREDENTIALS",...}}
```

`001_seed.ts` is idempotent (select-then-insert), so re-seeding does **not**
put those passwords back — it sees the rows already exist and leaves them
alone. Getting a clean run means dropping and recreating the database, then
migrating and seeding:

```bash
dropdb carwash && createdb carwash    # or the equivalent for your setup
npm run migrate && npm run seed
npm run test:all
```

Until that is done, a failing run tells you very little: the failure is
probably leftover state from the last run rather than a real regression.

## They still authenticate with username + password

The mobile app no longer does. Sign-in moved to phone + one-time code for
every role, and the password routes survive only for out-of-band use (see
`docs/CURRENT-STATE.md`). These scripts continue to use `POST
/auth/staff/login` because that route still works and because rewriting them
to complete an OTP round-trip would mean reading codes out of the database
mid-test.

That makes them a test of the backend, not of the path real users take. The
phone flow has no automated coverage at all.

## Known gaps

- No coverage of `/auth/phone/*` — the only sign-in real users have.
- No coverage of worker commission (`worker_commission_ugx`, net expected
  cash), account deletion, worker points, billing, or issue reports.
- `phase2-test.ts` previously exited 0 even when assertions failed; it now
  exits non-zero like the others.
