# Backend Build Guide — Car Wash Loyalty Platform

One file per phase. Hand the agent **this file, the phase file, and
`carwash-loyalty-backend-spec.md`** together. The spec is the source of truth; a phase
file only says which slice of it to build and how to prove it.

## Phase order and dependencies

```
0  Skeleton            ── error envelope, pool, migrations       (½ day)  DONE
1  Identity & roles    ── needs 0                                (3 days) IN PROGRESS
2  Catalogue & pricing ── needs 1 (org, branch, staff)           (2 days)
3  Shifts              ── needs 1                                (1 day)
4  Wash lifecycle      ── needs 2 and 3. THE PROJECT             (4 days)
5  Exceptions          ── needs 4 (something to correct)         (2 days)
6  Reports             ── needs 5 (or you count reversed sales)  (3 days)
7  Notifications/jobs  ── needs 4                                (2 days)
8  Hardening & deploy  ── needs all                              (3 days)
9  Pilot at one bay    ── needs 8                            (1–2 weeks)
```

Nothing here is optional and nothing can be reordered. Phase 6 before Phase 5 produces
reports that count reversed washes as revenue. Phase 4 before Phase 2 has no price to
charge. Do not start the React Native apps before Phase 4 is finished and its API is
stable; those endpoints are the ones most likely to move.

## Shared conventions — apply in every phase

```
Runtime      Node.js + Express
DB           PostgreSQL `era92`, user postgres, password root, localhost:5432
             (dev only; .env, gitignored, .env.example committed)
Driver       pg with a pool. Raw SQL for all queries
Migrations   knex, migrations only, numbered, never edited after being run
Validation   zod on every request body, query and param
Hashing      argon2id for passwords and PINs
Tokens       jsonwebtoken; access 15 min, refresh 30 days rotating, stored hashed
Money        BIGINT integer UGX, columns named *_ugx. No floats, ever
Time         server time only, TIMESTAMPTZ
Envelope     { ok:true, data } / { ok:false, error:{ code, message, details } }
Pagination   keyset, never OFFSET, on every list endpoint
```

**Module boundaries, enforced from Phase 2 onward:**

- Only `pricing` resolves a price. One function: `resolvePrice(serviceId, vehicleClassId, branchId)`.
- Only `loyalty` writes `loyalty_accounts` and `loyalty_ledger`.
- Only `washes` changes a wash's status, and every transition lives in one file as an
  explicit allowed-from check.
- Only `tokens` issues or consumes `client_tokens`.
- Only `notify` sends a push.

Three copies of any of these is how they drift apart.

## Verification protocol — every phase, every step

1. Write the code.
2. Write integration tests hitting real HTTP against the real `era92` database. No mocked
   database, no mocked argon2 or JWT.
3. Run them. Paste actual output.
4. Exercise the endpoints by hand with `curl` and paste real request/response pairs,
   including failures.
5. State what you verified, what you did not, and anything you are unsure about.

**Banned from your reports:** "should work", "this will handle", "presumably", "I've
implemented X" without output. Either you ran it and have output, or you say you did not
test it.

**If a test fails, fix the code — never adjust the test to pass.** If you believe the spec
is wrong, stop and say why.

**If the spec is silent or contradictory, stop and ask. Do not invent a rule.** Nine times
out of ten it is a product decision, not a technical one, and guessing wastes a day.

## Scope discipline

Each phase file lists what NOT to build. Creating a table early "because it's easier
while I'm in the migrations folder" is out of scope. Finishing early means improving the
tests, not starting the next phase.
