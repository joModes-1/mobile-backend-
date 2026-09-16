# Phase 2 — Catalogue and Pricing (2 days)

Read §2.5, §3.2, §4.3, §4.4 of the spec first. Read `README-phase-guide.md` for
conventions and the verification protocol.

## Why this phase matters more than it looks

The worker app has no amount field anywhere. A worker selects a car type and a wash type,
and the server decides the price. That makes this table the entire revenue control of the
business: under-recording by typing a smaller number is impossible only for as long as
this phase is airtight. Treat it like money code, not like CRUD.

## Scope

**Build:** `vehicle_classes`, `services`, `prices`, their management endpoints, and
`resolvePrice`.

**Do NOT build:** washes, shifts, loyalty, tokens, reports, receipt counters. No table
that Phase 3 or 4 owns.

## Step 2.1 — Migrations

Three tables exactly as §3.2 specifies. Constraints that must be present:

- `prices.price_ugx >= 0`
- unique `(org_id, lower(name))` on both `vehicle_classes` and `services`
- `one_default_service_per_org` — partial unique index on `services (org_id) WHERE is_default`
- the price uniqueness index, which needs an explicit cast:

```sql
CREATE UNIQUE INDEX ON prices (
  service_id, vehicle_class_id,
  COALESCE(branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
);
```

That COALESCE is how one index covers both org defaults (`branch_id IS NULL`) and branch
overrides. Without the `::uuid` cast the index will not build.

**Verify:** migrate up, down, up. Then prove each constraint by attempting the violation
in psql and pasting the error, including two `is_default` services in one org.

## Step 2.2 — `resolvePrice`, before any endpoint

One function, in the `pricing` module, used by everything later.

```sql
SELECT id, price_ugx FROM prices
WHERE service_id = $1 AND vehicle_class_id = $2 AND active
  AND (branch_id = $3 OR branch_id IS NULL)
ORDER BY branch_id NULLS LAST   -- branch override wins over the org default
LIMIT 1;
```

Returns `{ price_id, price_ugx }` or null. **Null is never 0 and never a fallback to
another price.** Callers turn null into `422 NO_PRICE_SET` naming the combination.

**Verify with unit tests before writing endpoints:**
- org default only → returns it
- branch override present → returns the override, not the default
- override for branch A, querying branch B → returns the org default
- inactive override, active default → returns the default
- neither exists → null
- inactive service or inactive car type → null

## Step 2.3 — Catalogue endpoints (orgadmin)

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/vehicle-classes` | `name`, `sort_order`. Sort order drives the worker's tile order |
| PATCH | `/vehicle-classes/:id` | Deactivating hides it from new washes; existing rows keep the reference |
| GET/POST | `/services` | `name`, `is_default`, `earns_point` |
| PATCH | `/services/:id` | Setting `is_default` must clear the previous default in the same transaction |

`earns_point = false` exists so add-ons (engine wash, tyre polish) do not count toward the
loyalty reward. Without it a client reaches a free wash through seven 2,000-shilling extras.

**Never hard-delete either table.** Washes will reference them for years.

## Step 2.4 — Price endpoints

#### `GET /prices?branch_id=` — the management matrix

Returns services, car types, and one row per combination with the org price, the branch
price, the effective price and its source. Plus a `missing` array for combinations with no
price at all.

```json
{ "ok": true, "data": {
  "services": [{ "id": "...", "name": "Full wash", "is_default": true }],
  "vehicle_classes": [{ "id": "...", "name": "Saloon", "sort_order": 1 }],
  "matrix": [{
    "service_id": "...", "vehicle_class_id": "...",
    "org_price_ugx": 20000, "branch_price_ugx": 25000,
    "effective_price_ugx": 25000, "source": "branch_override",
    "updated_by": "Sarah N.", "updated_at": "..."
  }],
  "missing": [{ "service_id": "...", "vehicle_class_id": "...", "reason": "no price set" }]
} }
```

The `missing` array is the point of this endpoint. It is how an orgadmin discovers that a
car type they added yesterday has no price, instead of a worker discovering it at the bay
with a customer waiting.

#### `GET /prices/effective?branch_id=&vehicle_class_id=` — what the worker app calls

Car types in `sort_order`, each with its wash types and prices, and an explicit
`has_price: false` for unpriced combinations so the app greys the tile instead of showing 0.

```json
{ "ok": true, "data": { "vehicle_classes": [
  { "id": "...", "name": "SUV", "sort_order": 2, "services": [
      { "id": "...", "name": "Full wash", "price_ugx": 25000, "has_price": true },
      { "id": "...", "name": "Engine",    "price_ugx": null,  "has_price": false }
  ]}
]}}
```

Nested this way, not flat, because once the worker taps a car type every wash tile must
already show its own price. That is how they answer "and how much for a half wash?"
without navigating.

| Method | Path | Who | Notes |
|---|---|---|---|
| PUT | `/prices` | orgadmin | Upsert an org-wide price |
| PUT | `/prices/branch/:branch_id` | orgadmin, manager | Branch override. Manager restricted to own branch — check the token, never the path |
| DELETE | `/prices/branch/:branch_id/:price_id` | orgadmin, manager | Removes the override; the org default resumes |
| POST | `/prices/bulk` | orgadmin | Array of upserts in ONE transaction. Setup and across-the-board increases |
| GET | `/prices/history?service_id=&vehicle_class_id=` | orgadmin, manager | Read from `audit_logs` |

## Non-negotiable rules

1. **No endpoint accepts a price from a worker.** Only orgadmin and manager can write, and
   a manager only for their own branch.
2. **Null price is a 422, never a 0 and never a substitute price.**
3. **Every write audit-logs `before` and `after`** with the actor. This becomes
   `GET /reports/price-changes` in Phase 6, so get the shape right now.
4. **A price change never alters an existing wash.** Nothing to enforce yet — Phase 4
   snapshots the amount — but do not build any "recalculate" helper that could later be
   pointed at historical rows.
5. `POST /prices/bulk` is one transaction. A half-applied price increase is worse than a
   failed one.

## Acceptance tests

```
Branch override wins over org default                    → override returned
Org default applies where no override exists             → default returned
Override for branch A does not affect branch B           → B gets the default
No price for the combination                             → resolvePrice null
Inactive service                                         → resolvePrice null
Manager writes a price for their own branch              → 200
Manager writes a price for another branch                → 403
Manager writes an org-wide price                         → 403
Worker writes any price                                  → 403
Client token on any price endpoint                       → 403
Orgadmin of org A reads org B's prices                   → 403 or empty, never B's data
Two services with is_default in one org                  → DB constraint rejects
GET /prices lists every unpriced combination in `missing` → count matches reality
GET /prices/effective marks unpriced tiles has_price:false → never price 0
POST /prices/bulk with one invalid row                   → nothing committed
Every PUT writes an audit row with before and after      → row present, both populated
```

## Done when

An orgadmin can set a full price matrix for a two-branch org, a manager can override one
branch, `GET /prices/effective` returns exactly what the worker's two-step screen needs,
and `resolvePrice` has passing unit tests for all six cases above.
