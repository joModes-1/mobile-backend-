import http from 'http';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const BASE = 'http://localhost:3456';

function req(method: string, urlPath: string, token?: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + urlPath);
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    const opts: http.RequestOptions = { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: h };
    const r = http.request(opts, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode!, body: d }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

let pass = 0;
let fail = 0;

async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`✅ ${name}`); pass++; }
  catch (e: any) { console.log(`❌ ${name}: ${e.message}`); fail++; }
}

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(msg); }

async function main() {
  // ── Setup: login with seed passwords, bypass must_change by using the token directly ──
  let r = await req('POST', '/api/v1/auth/staff/login', undefined, { username: 'orgadmin', password: 'Orgadmin123!' });
  assert(r.status === 200, 'orgadmin login ' + r.status + ' ' + JSON.stringify(r.body));
  const OA = r.body.data.access_token;

  r = await req('POST', '/api/v1/auth/staff/login', undefined, { username: 'grace', password: 'Manager123!' });
  assert(r.status === 200, 'manager login ' + r.status);
  const MG = r.body.data.access_token;

  r = await req('POST', '/api/v1/auth/staff/login', undefined, { username: 'joseph', password: 'Worker123!' });
  assert(r.status === 200, 'worker login ' + r.status);
  const W1 = r.body.data.access_token;

  // Get vehicle class
  r = await req('GET', '/api/v1/vehicle-classes', OA);
  assert(r.status === 200, 'list vc ' + r.status);
  const saloonId = r.body.data.find((v: any) => v.name === 'Saloon').id;

  // Open shift for worker (ignore if already open)
  r = await req('POST', '/api/v1/shifts/open', W1);
  if (r.status !== 201 && r.status !== 409) { console.log('ERROR opening shift:', JSON.stringify(r.body)); process.exit(1); }

  // Create some test data
  async function createSettledWash(): Promise<string> {
    const key = 'p6-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    r = await req('POST', '/api/v1/washes', W1, { vehicle_class_id: saloonId });
    if (r.status !== 201) throw new Error('create wash: ' + JSON.stringify(r.body));
    const washId = r.body.data.wash_id;
    r = await req('POST', `/api/v1/washes/${washId}/wash-done`, W1);
    r = await req('POST', `/api/v1/washes/${washId}/settle`, W1, { unverified_reason: 'no_app' });
    if (r.status !== 200) throw new Error('settle: ' + JSON.stringify(r.body));
    return washId;
  }

  // Create 3 settled washes
  for (let i = 0; i < 3; i++) await createSettledWash();

  const today = new Date().toISOString().slice(0, 10);
  const lastWeek = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  // ═══ Report Tests ═══

  await test('GET /reports/daily → summary', async () => {
    r = await req('GET', `/api/v1/reports/daily?date=${today}`, OA);
    assert(r.status === 200, `status ${r.status} ${JSON.stringify(r.body)}`);
    assert(r.body.data.summary, 'has summary');
    assert(Array.isArray(r.body.data.by_car_type), 'by_car_type');
    assert(Array.isArray(r.body.data.by_worker), 'by_worker');
  });

  await test('GET /reports/daily empty date → 200 zeros', async () => {
    r = await req('GET', `/api/v1/reports/daily?date=2000-01-01`, OA);
    assert(r.status === 200, `status ${r.status}`);
    assert(parseInt(r.body.data.summary.settled_washes) === 0, 'zero settled');
  });

  await test('GET /reports/workers → worker stats', async () => {
    r = await req('GET', `/api/v1/reports/workers?from=${lastWeek}&to=${today}`, OA);
    assert(r.status === 200, `status ${r.status}`);
    assert(Array.isArray(r.body.data), 'is array');
    if (r.body.data.length > 0) {
      assert('washes_started' in r.body.data[0], 'has washes_started');
      assert('cash_taken_ugx' in r.body.data[0], 'has cash_taken_ugx');
    }
  });

  await test('GET /reports/car-type-mix → deviation', async () => {
    r = await req('GET', `/api/v1/reports/car-type-mix?from=${lastWeek}&to=${today}`, OA);
    assert(r.status === 200, `status ${r.status}`);
    assert(Array.isArray(r.body.data.workers), 'workers array');
    assert(r.body.data.caveat, 'has caveat');
  });

  await test('GET /reports/cash-variance → surplus/shortfall', async () => {
    r = await req('GET', `/api/v1/reports/cash-variance?from=${lastWeek}&to=${today}`, OA);
    assert(r.status === 200, `status ${r.status}`);
    assert(r.body.data.summary, 'has summary');
  });

  await test('GET /reports/handovers → rates', async () => {
    r = await req('GET', `/api/v1/reports/handovers?from=${lastWeek}&to=${today}`, OA);
    assert(r.status === 200, `status ${r.status}`);
    assert(Array.isArray(r.body.data.handovers), 'handovers array');
    assert(Array.isArray(r.body.data.rates), 'rates array');
  });

  await test('GET /reports/unverified → rate_pct', async () => {
    r = await req('GET', `/api/v1/reports/unverified?from=${lastWeek}&to=${today}`, OA);
    assert(r.status === 200, `status ${r.status}`);
    assert(Array.isArray(r.body.data), 'is array');
  });

  await test('GET /reports/cancellations', async () => {
    r = await req('GET', `/api/v1/reports/cancellations?from=${lastWeek}&to=${today}`, OA);
    assert(r.status === 200, `status ${r.status}`);
    assert(Array.isArray(r.body.data), 'is array');
  });

  await test('GET /reports/durations → avg minutes', async () => {
    r = await req('GET', `/api/v1/reports/durations?from=${lastWeek}&to=${today}`, OA);
    assert(r.status === 200, `status ${r.status}`);
    assert(Array.isArray(r.body.data), 'is array');
  });

  await test('GET /reports/stale → live stale jobs', async () => {
    r = await req('GET', '/api/v1/reports/stale', OA);
    assert(r.status === 200, `status ${r.status}`);
    assert('stale_ready' in r.body.data, 'has stale_ready');
    assert('long_in_progress' in r.body.data, 'has long_in_progress');
  });

  await test('GET /reports/exceptions → combined list', async () => {
    r = await req('GET', `/api/v1/reports/exceptions?from=${lastWeek}&to=${today}`, OA);
    assert(r.status === 200, `status ${r.status}`);
    assert(Array.isArray(r.body.data), 'is array');
  });

  await test('GET /reports/branches → orgadmin comparison', async () => {
    r = await req('GET', `/api/v1/reports/branches?from=${lastWeek}&to=${today}`, OA);
    assert(r.status === 200, `status ${r.status}`);
    assert(Array.isArray(r.body.data), 'is array');
    if (r.body.data.length > 0) {
      assert('branch_name' in r.body.data[0], 'has branch_name');
      assert('gross_ugx' in r.body.data[0], 'has gross_ugx');
    }
  });

  await test('GET /reports/price-changes', async () => {
    r = await req('GET', `/api/v1/reports/price-changes?from=${lastWeek}&to=${today}`, OA);
    assert(r.status === 200, `status ${r.status}`);
    assert(Array.isArray(r.body.data), 'is array');
  });

  await test('GET /reports/loyalty → near-reward + liability', async () => {
    r = await req('GET', `/api/v1/reports/loyalty?from=${lastWeek}&to=${today}`, OA);
    assert(r.status === 200, `status ${r.status}`);
    assert(Array.isArray(r.body.data.near_reward), 'near_reward');
    assert(typeof r.body.data.unredeemed_liability_ugx === 'number', 'liability');
  });

  await test('GET /reports/platform/stats → sysadmin', async () => {
    r = await req('POST', '/api/v1/auth/platform/login', undefined, { email: 'admin@carwash.com', password: 'admin123' });
    assert(r.status === 200, 'platform login');
    const PToken = r.body.data.access_token;
    r = await req('GET', '/api/v1/reports/platform/stats', PToken);
    assert(r.status === 200, `status ${r.status}`);
    assert(typeof r.body.data.total_orgs !== 'undefined', 'has total_orgs');
    assert(typeof r.body.data.washes_this_month !== 'undefined', 'has washes_this_month');
  });

  // ── Scope tests ──

  await test('Manager daily → 200 (locked to own branch)', async () => {
    r = await req('GET', `/api/v1/reports/daily?date=${today}`, MG);
    assert(r.status === 200, `status ${r.status}`);
  });

  await test('Worker /reports/workers → 403', async () => {
    r = await req('GET', `/api/v1/reports/workers?from=${lastWeek}&to=${today}`, W1);
    assert(r.status === 403, `expected 403 got ${r.status}`);
  });

  console.log(`\n=== PHASE 6 RESULTS: ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
