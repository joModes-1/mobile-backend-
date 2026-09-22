# Tests

These are **integration scripts**, not unit tests. Each one drives the real
HTTP API against a running server and a real Postgres database.

## Running them

```bash
npm run dev                # in one terminal — server must be on :3456
npm run test:phase3        # in another
npm run test:all           # every suite in order, stops at the first failure
npm test                   # alias for test:e2e
```

Two requirements, both on the server rather than the scripts:

- it must already be running on `:3456` — no suite starts one for you;
- it must have **`TEST_MODE=true`**, which is what makes `/auth/phone/start`
  return the one-time code in the response instead of sending an SMS. Without
  it no suite can sign in, and they say so rather than failing obscurely.

`jest` and `ts-jest` are in `devDependencies` and `package.json` used to point
`npm test` at jest. There is no jest config and none of these files use jest
globals, so `jest --listTests` found **zero** tests and `npm test` passed
while running nothing at all. The scripts are now invoked directly through
`ts-node`, which is what they were always written for.

## They are re-runnable

This used to be the big caveat: several suites changed the state they
depended on (rotating the seeded passwords, creating fixed-name records,
leaving shifts open) and only gave a clean run against a freshly dropped and
re-seeded database. On a second run they failed for reasons that had nothing
to do with the code under test, which made a red run almost uninformative.

That is fixed. Every suite now normalises its own starting state and cleans up
what it creates, so `npm run test:all` passes twice in a row against the same
database. **A failure now means a real regression** — which is the only thing
that makes a test suite worth having.

If you do want to start from scratch, that still works:

```bash
dropdb carwash && createdb carwash    # or the equivalent for your setup
npm run migrate && npm run seed
```

## Sign-in: phone + one-time code

Staff passwords were removed from the platform; `POST /auth/staff/login` and
`POST /auth/staff/change-password` are gone. Every suite signs in the way real
users do, through `tests/helpers/auth.ts`:

```ts
import { signInAs } from './helpers/auth';

const orgadmin = await signInAs('orgadmin');   // returns a bearer token
const manager  = await signInAs('grace');
const worker   = await signInAs('joseph');
```

`signInAs` maps a seeded username to its phone number, completes the OTP
round-trip, and caches the token per number for the life of the process. Use
`signInByPhone(phone)` directly for client numbers or accounts a test creates.

Note that `joseph` and `musa` are **both on the NTD branch**. They are not a
cross-branch pair; a test that needs branch isolation has to create a worker
on another branch.

### The OTP rate limit

`/auth/phone/start` allows 3 codes per number per hour in production. That is
far too few for a suite that signs the same handful of seeded numbers in
repeatedly, so the cap is raised under `TEST_MODE` (`src/modules/auth/
phoneAuth.ts`). Production never sets `TEST_MODE`, so the real limit is
unchanged.

The limiter lives in memory. If you ever do hit it, restarting the dev server
clears it.

## What is covered

| Suite | Area |
|---|---|
| `phase2` | catalogue, price matrix, effective prices, price scoping |
| `phase3` | shifts, cash handover, variance |
| `phase4` | wash lifecycle, queue, idempotency |
| `phase5` | exceptions — cancel, reverse, dispute, loyalty adjust, ledger replay |
| `phase6` | reports, platform admin |
| `phase7` | handover between workers |
| `phase11` | phone auth for every role, staff creation by phone, worker commission and its effect on expected cash, the earnings endpoint, shift detail, loyalty consolidation |
| `e2e` | a full pass across the whole system, end to end |

## Known gaps

- Account deletion, billing, and issue reports have no coverage.
- `e2e-test.ts` no longer drops and re-seeds the database or spawns its own
  server; it runs against the one already up, like every other suite.
