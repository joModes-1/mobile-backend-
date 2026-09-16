# Phase 9 — Pilot at One Bay (1–2 weeks of calendar time)

This phase is not code. It is the phase where you find out which of your assumptions were
wrong, and it is the only way to answer the open questions in §9 of the spec.

Everything in phases 0–8 was built on guesses about how a Kampala car wash actually runs.
Some of those guesses are mine. A pilot that changes nothing means nobody was watching.

## Setup

- **One branch only.** Not two, not "one and a half".
- Real workers, real cash, real clients. Not a staged run with colleagues.
- **You physically present for the first two days**, standing on the forecourt, not
  reading dashboards from home.
- Paper fallback ready: a notebook where a worker records a wash if the system cannot.
  Every line in that notebook at the end of the week is a bug report.
- Manager briefed on the exceptions report and asked to open it every morning.
- Real prices loaded before day one, with **no unpriced combinations** — check
  `GET /prices` and confirm `missing` is empty.

## What to watch, in order of what usually breaks

**Do workers mark jobs done?** The `ready` status only exists if someone taps a button
that earns them nothing. If the durations report shows `wash_done_at` clustering
suspiciously close to `settled_at`, they are tapping both at payment time and the ready
state is fiction. That changes whether the "your car is ready" notification is worth
anything.

**How many clients install the app?** This is the number the whole loyalty design rests on.
If it is 20%, most washes are walk-ins with no points, the client-generated QR is rarely
used, and the honest question is whether the client app earns its keep in v1. The bench is
your best install moment — a client waiting 30 minutes with nothing to do. Put a sign there
and measure whether it works.

**The unverified settlement rate.** Watch `GET /reports/unverified` daily. Under 10% means
the scan flow works. At 40%, blocking confirmation has failed in practice and you should
consider the manager-PIN variant, or accept it and lean harder on shift reconciliation.

**The handover rate.** High rates mean your shift boundaries do not match how people
actually work, not that workers are dishonest.

**Cancellation reasons.** Which reason dominates tells you what the flow gets wrong. Lots
of `started_by_mistake` means the start screen is too easy to fire.

**Shift variance.** The first week's variances are mostly learning, not theft. Look for a
pattern by the second week: same worker, same direction, every day.

**Car-type mix.** Establish each worker's baseline. Deviation is only meaningful against a
baseline you actually have.

## The open questions this phase answers

Each of these is in §9 of the spec and should be decided from data, not opinion:

| Question | What tells you |
|---|---|
| Mandatory plates? | How often two identical cars sit in the queue together |
| Add-ons as line items? | How often a worker wants to charge for two things at once |
| Tips tracked separately? | Whether shift variance shows unexplained surpluses |
| Free wash value cap? | Whether clients redeem on bigger cars than they earn on |
| Credit expiry? | The size of your unredeemed liability after two weeks |
| Multiple workers per car? | Whether the crew works one car at a time or as a team |
| Unverified settlements need a PIN? | The rate |
| `ready_alert_minutes` default | The real collection-wait distribution |
| Offline queueing needed? | How often connectivity actually dropped |

## Expect to change

Likely small and worth doing: tile order, wording, notification timing,
`ready_alert_minutes`, price corrections.

Possible and worth thinking hard about: making plates mandatory, adding line items,
whether the client app should be simplified or promoted harder.

**Do not** add features during the pilot. Write them down. Changing the system while
measuring it means you learn nothing from either.

## Exit criteria

Move to a second branch only when:

- A full week runs with no wash recorded on paper
- The manager opens the exceptions report unprompted
- Unverified settlement and handover rates are stable and understood
- Every §9 question above has an answer written down
- At least one client has redeemed a free wash end to end, and it worked
- You have restored a backup since going live (yes, again — the first restore drill was
  against test data)

## The thing worth remembering

The most likely failure of this project is not a bug. It is that workers find the app
slower than not using it, and quietly stop. Watch for the tell: washes appearing in
clusters at the end of a shift rather than spread across the day. That means someone is
recording from memory, and every control in the system is downstream of records being made
at the moment the work happens.
