/**
 * PesaPal collection, end to end on the local API.
 *
 * Needs the server on :3456 with TEST_MODE=true and PESAPAL_* set to the
 * sandbox. Order creation talks to the real PesaPal sandbox; the "customer
 * paid" step is simulated by stubbing the status call, because completing a
 * checkout needs a browser and a test card.
 */
import 'dotenv/config';
import * as pesapal from '../src/modules/payments/pesapal';
import { refreshPayment } from '../src/modules/payments';
import { getPool } from '../src/db';

const API = 'http://localhost:3456/api/v1';
let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`, detail ?? ''); }
}

async function call(method: string, path: string, token?: string, body?: unknown): Promise<any> {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function signIn(phone: string): Promise<{ token: string; data: any }> {
  const s = await call('POST', '/auth/phone/start', undefined, { phone });
  const v = await call('POST', '/auth/phone/verify', undefined, { phone, code: s.data.otp_code });
  return { token: v.data.access_token, data: v.data };
}

async function main() {
  console.log('\n── PesaPal collection ──');
  const worker = await signIn('+256700200003');
  const client = await signIn('+256700123456');

  const wme = (await call('GET', '/me', worker.token)).data;
  const branchId = wme.branch_id;
  const prices = (await call('GET', `/me/washes/prices?branch_id=${branchId}`, client.token)).data;
  const cls = prices.vehicle_classes[0];
  const svc = cls.services.find((s: any) => s.has_price && s.price_ugx > 0);
  const plate = `UAP${Math.floor(Math.random() * 900 + 100)}T`;

  const booked = await call('POST', '/me/washes', client.token, { branch_id: branchId, vehicle_class_id: cls.id, service_id: svc.id, plate });
  const washId = booked.data?.wash_id;
  check('client books a wash', !!washId, booked);

  // A signed-in client only: no token, no payment.
  const anon = await call('POST', '/me/payments', undefined, { wash_id: washId });
  check('starting a payment needs sign-in', anon.ok === false);

  const started = await call('POST', '/me/payments', client.token, { wash_id: washId, phone: '0700123456' });
  check('PesaPal sandbox returns a checkout link', started.ok && /pesapal/.test(started.data?.redirect_url || ''), started);
  check('amount is the wash price', started.data?.amount_ugx === svc.price_ugx, started.data);
  const paymentId = started.data?.payment_id;

  const pending = await call('GET', `/me/payments/${paymentId}`, client.token);
  check('an unpaid order reads as pending, not failed', pending.data?.status === 'pending', pending);

  // Someone else's payment is invisible.
  const other = await signIn('+256700200001').catch(() => null);
  if (other) {
    const peek = await call('GET', `/me/payments/${paymentId}`, other.token);
    check('another account cannot read it', peek.ok === false);
  }

  // The IPN is public and untrusted: a call naming our payment changes nothing
  // while PesaPal still says it is unpaid.
  const ipn = await fetch(`${API}/payments/ipn?OrderTrackingId=${started.data && 'x'}&OrderMerchantReference=nope`);
  check('IPN answers PesaPal', ipn.status === 200);

  // ── customer pays: stub PesaPal's status ──
  const real = pesapal.getStatus;
  (pesapal as any).getStatus = async () => ({
    state: 'succeeded', description: 'Completed', method: 'AirtelMoney',
    confirmationCode: 'TESTCONF123', amount: svc.price_ugx, merchantReference: 'x',
  });
  await refreshPayment(paymentId);
  (pesapal as any).getStatus = real;

  const paid = await call('GET', `/me/payments/${paymentId}`, client.token);
  check('payment becomes succeeded', paid.data?.status === 'succeeded', paid);

  const again = await call('POST', '/me/payments', client.token, { wash_id: washId });
  check('a paid wash cannot be paid twice', again.ok === false && again.error?.code === 'ALREADY_PAID', again);

  // ── worker sees it and settles ──
  // Dispatch rules decide who may take a car; they are not what is tested
  // here, so the car is handed to this worker directly.
  await getPool().query(
    `UPDATE washes SET status = 'in_progress', started_by_worker_id = $2, started_at = now() WHERE id = $1`,
    [washId, wme.id || wme.sub]
  );
  const done = await call('POST', `/washes/${washId}/wash-done`, worker.token);
  check('worker finishes washing', done.ok === true, done);
  const queue = (await call('GET', '/washes/queue', worker.token)).data;
  const mine = [...(queue.ready || []), ...(queue.washing || []), ...(queue.requested || [])].find((w: any) => w.id === washId);
  check('worker queue says paid online', !!mine?.paid_online_at, mine);

  // The worker tries to book it as cash; the server settles it as the mobile money it was.
  const settled = await call('POST', `/washes/${washId}/settle`, worker.token, { unverified_reason: 'no_app', payment_method: 'cash' });
  check('worker can settle it', settled.ok === true, settled);

  const row = (await getPool().query(`SELECT payment_method, payment_ref FROM washes WHERE id = $1`, [washId])).rows[0];
  check('settled as airtel, not cash', row?.payment_method === 'airtel', row);
  check('PesaPal confirmation code kept as the reference', row?.payment_ref === 'TESTCONF123', row);

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  await getPool().end();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
