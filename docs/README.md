# Documentation

## Start here

| File | What it is |
|---|---|
| [CURRENT-STATE.md](CURRENT-STATE.md) | **What the system actually does today.** Read this first. |
| [../SETUP.md](../SETUP.md) | Getting the backend running |
| [../../mobile/SETUP.md](../../mobile/SETUP.md) | Getting the mobile app running |

---

## The phase docs are history

Everything else in this folder is the original build plan — phases 1 through
10, written before the system was finished. They are kept because the
reasoning in them is still worth reading: why cash handovers work the way they
do, why a reversal writes a compensating ledger entry instead of a delete, why
job numbers are per-branch-per-day.

**But parts of them are now wrong.** The code moved; these files did not.

Known-stale areas, all covered in `CURRENT-STATE.md`:

- Client auth is email/username, not phone OTP
- The catalogue is branch-scoped, and managers can edit it
- Seeding is additive now, not destructive — which breaks phase 10's teardown loop
- Issue reporting, billing and several report endpoints are missing entirely
- Deployment is Render plus EAS, not the generic description in phase 8

If a phase doc and `CURRENT-STATE.md` disagree, `CURRENT-STATE.md` is right.

| File | Covers |
|---|---|
| [README-phase-guide.md](README-phase-guide.md) | How the phases were meant to be worked through |
| [carwash-loyalty-backend-spec.md](carwash-loyalty-backend-spec.md) | The full original spec — the reference the phases were cut from |
| [phase1-roles-agent-brief.md](phase1-roles-agent-brief.md) | Roles, auth, permissions |
| [phase-2-catalogue-and-pricing.md](phase-2-catalogue-and-pricing.md) | Vehicle classes, services, price resolution |
| [phase-3-shifts.md](phase-3-shifts.md) | Opening, closing, cash reconciliation |
| [phase-4-wash-lifecycle.md](phase-4-wash-lifecycle.md) | Start → done → settle, tokens, job numbers |
| [phase-5-exceptions.md](phase-5-exceptions.md) | Disputes, corrections, reversals, handovers |
| [phase-6-reports.md](phase-6-reports.md) | The reporting surface |
| [phase-7-notifications-and-jobs.md](phase-7-notifications-and-jobs.md) | Push notifications, scheduled jobs |
| [phase-8-hardening-and-deploy.md](phase-8-hardening-and-deploy.md) | Security, rate limits, deployment |
| [phase-9-pilot.md](phase-9-pilot.md) | Running the first real site |
| [phase-10-end-to-end-verification.md](phase-10-end-to-end-verification.md) | Full-system verification protocol |

---

## Keeping this honest

When you change behaviour the docs describe, update `CURRENT-STATE.md` in the
same commit. It is the one file people are told to trust, so it is the one
that has to stay true.

The phase docs are deliberately frozen. Correcting them in place would mean
rewriting a plan that was accurate when it was written — better to leave them
as the record of how the system was built and keep one current document
alongside.
