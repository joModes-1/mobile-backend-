/**
 * Phase 14 — nearby branches (`GET /me/branches/nearby`).
 *
 * Covers what NEARBY_BRANCH_LOCATION.md asked this endpoint to prove:
 *   - distance ORDERING is real (verified against the Haversine formula
 *     computed independently here, not just "returns something"),
 *   - radius_km EXCLUDES far branches entirely (no "412km away" rows),
 *   - branches with NULL coordinates are omitted, not shown last,
 *   - org scoping: another org's branch never appears,
 *   - the endpoint is client-only (staff actor gets 403),
 *   - validation: bad lat/lng/radius are 400s.
 *
 * Style: same assertion-record + act-wrap pattern as phase13. Re-running
 * the suite passes twice in a row: its fixture branches are looked up and
 * PATCHed rather than re-created on a second run, and its client is fresh
 * every time.
 */

import { signInAs, signInByPhone } from './helpers/auth';

const BASE = process.env.TEST_BASE || 'http://localhost:3456/api/v1';

let pass = 0;
let failCount = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { failCount++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

async function act(name: string, fn: () => Promise<void>) {
  console.log('\n── ' + name + ' ──');
  try { await fn(); }
  catch (e: any) { failCount++; failures.push(name + ' threw: ' + e.message); console.log('  ✗ ACT THREW: ' + e.message); }
}

async function call(method: string, path: string, body?: any, token?: string) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let parsed: any = null;
  try { parsed = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: parsed };
}

/** Haversine — the same math as the SQL, written independently for asserting expected distances. */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dp / 2) * Math.sin(dp / 2) +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Fixture geometry. The probe point is exactly on P14A, a known ~5.7km from
// P14B — far enough apart that rounding (1 decimal) cannot flip the order.
const PROBE = { lat: 0.3, lng: 32.61 };
const FIXTURES = [
  { code: 'P14A', name: 'Phase14 Alpha', lat: 0.3, lng: 32.61 },
  { code: 'P14B', name: 'Phase14 Beta', lat: 0.35, lng: 32.62 },
];

async function main() {
  console.log('PHASE 14 — nearby branches, against ' + BASE);

  let orgadmin = '', grace = '', client = '';
  let orgId = '';

  await act('Act 1 — sign-in and discovery', async () => {
    orgadmin = await signInAs('orgadmin');
    grace = await signInAs('grace');
    // A fresh client every run — lands in the oldest active org (demo),
    // the same tenant as orgadmin's branches.
    const clientPhone = '+2567' + String(Date.now() + 14).slice(-8);
    client = await signInByPhone(clientPhone);
    check('tokens acquired', !!orgadmin && !!grace && !!client);

    const me = await call('GET', '/me', undefined, client);
    orgId = me.body?.data?.org_id;
    check('client has an org_id', !!orgId, JSON.stringify(me.body).slice(0, 200));
  });

  // Create the fixture branches on the first run; on later runs they already
  // exist (409), so re-fetch and PATCH their coordinates back to the known
  // values instead — the suite never depends on which run created them.
  async function ensureFixture(f: { code: string; name: string; lat: number; lng: number }) {
    const created = await call('POST', '/branches', {
      name: f.name, code: f.code, address: 'Phase14 fixture',
      latitude: f.lat, longitude: f.lng,
    }, orgadmin);
    if (created.status === 201) return true;

    if (created.status !== 409) return false;
    const list = await call('GET', '/branches', undefined, orgadmin);
    const existing = (list.body?.data || []).find((b: any) => b.code === f.code);
    if (!existing) return false;
    const patched = await call('PATCH', `/branches/${existing.id}`, {
      latitude: f.lat, longitude: f.lng,
    }, orgadmin);
    return patched.status === 200;
  }

  await act('Act 2 — fixture branches with real coordinates', async () => {
    for (const f of FIXTURES) {
      const ok = await ensureFixture(f);
      check(`fixture ${f.code} present at (${f.lat}, ${f.lng})`, ok);
    }
    // A third branch with NO coordinates at all — must never appear.
    const created = await call('POST', '/branches', {
      name: 'Phase14 NoCoords', code: 'P14C', address: 'Nowhere',
    }, orgadmin);
    check('fixture P14C (no coordinates) created or already there',
      created.status === 201 || created.status === 409, JSON.stringify(created.body).slice(0, 200));
  });

  await act('Act 3 — ordering matches hand-computed Haversine', async () => {
    const res = await call('GET',
      `/me/branches/nearby?org_id=${orgId}&lat=${PROBE.lat}&lng=${PROBE.lng}`,
      undefined, client);
    check('nearby returns 200 for a client', res.status === 200, 'status ' + res.status);

    const rows = res.body?.data || [];
    const a = rows.findIndex((r: any) => r.code === 'P14A');
    const b = rows.findIndex((r: any) => r.code === 'P14B');
    check('both coordinate fixtures are returned', a !== -1 && b !== -1,
      JSON.stringify(rows.map((r: any) => r.code)));

    if (a !== -1 && b !== -1) {
      check('closest branch sorts first (P14A before P14B)', a < b, `index ${a} vs ${b}`);

      const rowA = rows[a];
      const rowB = rows[b];
      const expB = haversineKm(PROBE.lat, PROBE.lng, FIXTURES[1].lat, FIXTURES[1].lng);
      check('P14A distance is 0 (probe stands on it)', Number(rowA.distance_km) === 0, `got ${rowA.distance_km}`);
      check('P14B distance matches Haversine',
        Math.abs(Number(rowB.distance_km) - expB) <= 0.15,
        `got ${rowB.distance_km}, expected ~${expB.toFixed(2)}`);
      check('row shape has id/name/code/distance_km',
        !!rowA.id && !!rowA.name && !!rowA.code && typeof rowA.distance_km === 'number',
        JSON.stringify(rowA));
    }
  });

  await act('Act 4 — radius_km excludes far branches entirely', async () => {
    const res = await call('GET',
      `/me/branches/nearby?org_id=${orgId}&lat=${PROBE.lat}&lng=${PROBE.lng}&radius_km=2`,
      undefined, client);
    const rows = res.body?.data || [];
    check('near branch (P14A) still inside a 2km radius', rows.some((r: any) => r.code === 'P14A'),
      JSON.stringify(rows.map((r: any) => r.code)));
    check('far branch (P14B, ~5.7km) omitted at radius 2km', !rows.some((r: any) => r.code === 'P14B'),
      JSON.stringify(rows.map((r: any) => r.code)));
  });

  await act('Act 5 — branches with NULL coordinates are omitted', async () => {
    const res = await call('GET',
      `/me/branches/nearby?org_id=${orgId}&lat=${PROBE.lat}&lng=${PROBE.lng}`,
      undefined, client);
    const rows = res.body?.data || [];
    check('P14C (no coordinates) is not in the list', !rows.some((r: any) => r.code === 'P14C'),
      JSON.stringify(rows.map((r: any) => r.code)));
  });

  await act('Act 6 — org scoping: another org\'s branch never appears', async () => {
    const res = await call('GET',
      `/me/branches/nearby?org_id=${orgId}&lat=${PROBE.lat}&lng=${PROBE.lng}`,
      undefined, client);
    const rows = res.body?.data || [];
    check('Shine Motors branch (SHN) never appears for a demo-org client',
      !rows.some((r: any) => r.code === 'SHN'), JSON.stringify(rows.map((r: any) => r.code)));
  });

  await act('Act 7 — client-only guard: staff get 403', async () => {
    const asManager = await call('GET',
      `/me/branches/nearby?org_id=${orgId}&lat=${PROBE.lat}&lng=${PROBE.lng}`, undefined, grace);
    check('manager gets 403', asManager.status === 403, 'status ' + asManager.status);
    const asOrgadmin = await call('GET',
      `/me/branches/nearby?org_id=${orgId}&lat=${PROBE.lat}&lng=${PROBE.lng}`, undefined, orgadmin);
    check('orgadmin gets 403', asOrgadmin.status === 403, 'status ' + asOrgadmin.status);
  });

  await act('Act 8 — no fix degrades gracefully, bad fix is a 400', async () => {
    // No fix at all (permission declined / GPS off / web): 200 with ALL the
    // org's active branches alphabetically, no distance figures — the picker
    // must never block a client who could otherwise scan a QR.
    const noFix = await call('GET', `/me/branches/nearby?org_id=${orgId}`, undefined, client);
    check('no fix returns 200', noFix.status === 200, 'status ' + noFix.status);
    const plain = noFix.body?.data || [];
    check('no-fix list contains even branches without coordinates',
      plain.some((r: any) => r.code === 'P14C') && plain.some((r: any) => r.code === 'P14A'),
      JSON.stringify(plain.map((r: any) => r.code)));
    check('no-fix list carries no distance figures',
      plain.every((r: any) => r.distance_km === undefined), JSON.stringify(plain[0] || {}));
    const names = plain.map((r: any) => r.name);
    check('no-fix list is alphabetical',
      JSON.stringify(names) === JSON.stringify([...names].sort((a: string, b: string) => a.localeCompare(b))),
      JSON.stringify(names));

    const noOrg = await call('GET', `/me/branches/nearby?lat=${PROBE.lat}&lng=${PROBE.lng}`, undefined, client);
    check('missing org_id is 400', noOrg.status === 400, 'status ' + noOrg.status);

    const badLat = await call('GET', `/me/branches/nearby?org_id=${orgId}&lat=999&lng=${PROBE.lng}`, undefined, client);
    check('out-of-range lat is 400', badLat.status === 400, 'status ' + badLat.status);

    const badLng = await call('GET', `/me/branches/nearby?org_id=${orgId}&lat=${PROBE.lat}&lng=999`, undefined, client);
    check('out-of-range lng is 400', badLng.status === 400, 'status ' + badLng.status);

    const nanLat = await call('GET', `/me/branches/nearby?org_id=${orgId}&lat=abc&lng=${PROBE.lng}`, undefined, client);
    check('non-numeric lat is 400', nanLat.status === 400, 'status ' + nanLat.status);

    const badRadius = await call('GET', `/me/branches/nearby?org_id=${orgId}&lat=${PROBE.lat}&lng=${PROBE.lng}&radius_km=0`, undefined, client);
    check('radius_km=0 is 400', badRadius.status === 400, 'status ' + badRadius.status);

    const bigRadius = await call('GET', `/me/branches/nearby?org_id=${orgId}&lat=${PROBE.lat}&lng=${PROBE.lng}&radius_km=501`, undefined, client);
    check('radius_km=501 is 400', bigRadius.status === 400, 'status ' + bigRadius.status);
  });

  console.log(`\n══════ PHASE 14: ${pass} passed, ${failCount} failed ══════`);
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
