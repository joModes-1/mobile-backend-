# Backend setup

Express + PostgreSQL API for the car wash loyalty platform.

---

## What you need first

| | Version | Notes |
|---|---|---|
| Node.js | 20 or newer | Developed against 24.x |
| PostgreSQL | 14 or newer | Local install, Docker, or a hosted database |
| npm | comes with Node | |

Check what you have:

```bash
node --version
psql --version      # or just confirm Postgres is running
```

---

## 1. Install

```bash
cd server
npm install
```

---

## 2. Create the database

The app does not create the database itself — only the tables inside it.

```bash
createdb era92
```

No `createdb` on your machine (common on Windows)? Use any Postgres client, or:

```bash
psql -U postgres -c "CREATE DATABASE era92"
```

---

## 3. Configure

```bash
cp .env.example .env
```

Then fill in `.env`:

```ini
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/era92
JWT_SECRET=any-long-random-string-at-least-8-chars
PORT=3456

SEED_SYSADMIN_USERNAME=sysadmin
SEED_SYSADMIN_EMAIL=admin@carwash.local
SEED_SYSADMIN_PASSWORD=choose-a-password
```

**Required:** `DATABASE_URL`, `JWT_SECRET`, `SEED_SYSADMIN_EMAIL`, `SEED_SYSADMIN_PASSWORD`.
The server refuses to start without them and names the one that is missing.

**Email is optional.** Leave the `SMTP_*` block blank and the app runs fine —
staff creation and password resets still work, they just report that no mail
was sent instead of emailing a temporary password.

If you do set it up, one gotcha: `SMTP_SECURE` must be `false` for port 587
and `true` for port 465. Gmail needs an [app password](https://myaccount.google.com/apppasswords),
not your normal one.

---

## 4. Create the tables

```bash
npm run migrate
```

---

## 5. Add starting data

```bash
npm run seed
```

This is safe to run at any time. Both seeders only **add** what is missing —
they never delete or overwrite. Re-running on a populated database reports
what was already there and changes nothing, and it will not reset a password
you have since changed.

Two seeders run in order:

**`001_seed.ts`** — the fixture: one platform admin, two organisations
(Demo Car Wash, Shine Motors), three branches, staff, one client, the
vehicle/service catalogue and a price matrix.

**`002_activity.ts`** — 30 days of operating history so the reports have
something in them: shifts, washes, cash handovers, cancellations, loyalty
progress, subscription payments. Skips itself if activity already exists.

### Default logins

Every staff account must change its password on first sign-in. Clients do not.

| Username | Password | Role |
|---|---|---|
| `sysadmin` | whatever you set as `SEED_SYSADMIN_PASSWORD` | Platform admin |
| `orgadmin` | `Orgadmin123!` | Org admin — Demo Car Wash |
| `grace` | `Manager123!` | Manager — Ntinda |
| `joseph` | `Worker123!` | Worker — Ntinda |
| `musa` | `Worker123!` | Worker — Ntinda |
| `sarah` | `Worker123!` | Worker — Kabalagala |
| `shineadmin` | `Orgadmin123!` | Org admin — Shine Motors |
| `peter_o` | `Client123!` | Customer |

The activity seeder adds more workers and customers; all of them use
`Worker123!` and `Client123!` respectively.

Shine Motors is deliberately left with no activity — the platform admin's
"quiet organisations" panel needs an idle org to have anything to show.

---

## 6. Run it

```bash
npm run dev
```

Serving on `http://localhost:3456/api/v1`. It also prints a LAN address —
use that one when testing from a phone on the same Wi-Fi, since `localhost`
on a phone means the phone itself.

Check it is alive:

```bash
curl http://localhost:3456/api/v1/health
```

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server, restarts on save |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled build (production) |
| `npm run migrate` | Apply pending migrations |
| `npm run migrate:rollback` | Undo the last migration batch |
| `npm run migrate:make <name>` | Create a new migration file |
| `npm run seed` | Add any missing seed data |
| `npm test` | Run the test suite |

---

## Deploying

Currently hosted on [Render](https://render.com) as a Web Service plus a
managed Postgres database.

**Build command**

```
npm install && npm run build && npm run migrate
```

Add `&& npm run seed` only if you want the seed data on every deploy. It is
safe now that seeding is additive, but it is usually clearer to seed a fresh
database once by hand.

**Start command**

```
npm start
```

**Environment variables** — set the same keys as `.env` in the Render
dashboard. `DATABASE_URL` comes from the managed database; the rest you
supply. Never commit a real `.env`; it is git-ignored for good reason.

SSL is handled automatically: both the app pool and the migration connection
detect a hosted database from the URL and enable TLS without certificate
verification, which is what Render's Postgres requires.

---

## When something breaks

**Server exits immediately on start**
Config validation failed. The error names the missing or malformed variable.

**`ECONNREFUSED` on any request**
Postgres is not running, or `DATABASE_URL` points somewhere wrong.

**`relation "..." does not exist`**
Migrations have not run. `npm run migrate`.

**Seeder says "already present" but you wanted a reset**
That is by design — seeding never destroys data. A real reset means dropping
and recreating the database, then migrating and seeding again.

**Email fails with "wrong version number"**
`SMTP_SECURE` does not match the port. `false` for 587, `true` for 465.

**A phone cannot reach the server**
Use the LAN address printed at startup, not `localhost`, and confirm both
devices are on the same network.
