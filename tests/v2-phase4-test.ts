/**
 * V2 Phase 4 — name lookup by phone number.
 *
 * Two halves:
 *  1. The lookup logic, called directly with fake MTN / Airtel providers:
 *     network by prefix, 3 attempts, falling over to the other network,
 *     other networks never queried, the user### fallback, name tidying.
 *  2. The real adapters' requests, with fetch stubbed: the URLs, headers and
 *     number formats MTN and Airtel expect, and how their answers are read.
 *  3. One real sign-up through the API: with no network keys configured
 *     (the local setup), a new client gets the placeholder name and is told
 *     it is new; signing in again never renames anyone and is not "new".
 */

import {
  resolveName, registeredName, networkFor, toMsisdn, tidyName, generatedName,
  mtnProvider, airtelProvider, NameProvider, Network,
  newClientName, PLACEHOLDER_NAME,
} from '../src/modules/nameLookup';

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

/** A provider scripted call by call: a string = found, null = not found, 'fail' = temporary error. */
function fake(network: Network, script: Array<string | null | 'fail'>) {
  const calls: string[] = [];
  const provider: NameProvider = {
    network,
    async lookup(msisdn: string) {
      calls.push(msisdn);
      const step = script[Math.min(calls.length - 1, script.length - 1)];
      if (step === 'fail') throw new Error('network down');
      return step;
    },
  };
  return { provider, calls };
}

const fast = { backoffMs: 1 };

async function main() {
  console.log('V2 PHASE 4 — name lookup');

  await act('Act 1 — numbers and networks', async () => {
    check('0772… → 256772…', toMsisdn('0772123456') === '256772123456');
    check('+256 70… with spaces', toMsisdn('+256 701 234 567') === '256701234567');
    check('9 digits without the 0', toMsisdn('751234567') === '256751234567');
    check('not a Ugandan mobile → null', toMsisdn('+254712345678') === null && toMsisdn('12345') === null);
    check('MTN prefixes 76/77/78', ['0761234567', '0771234567', '0781234567'].every((p) => networkFor(p) === 'mtn'));
    check('Airtel prefixes 70/74/75', ['0701234567', '0741234567', '0751234567'].every((p) => networkFor(p) === 'airtel'));
    check('other networks → null', networkFor('0711234567') === null && networkFor('0721234567') === null);
  });

  await act('Act 2 — tidying names and the made-up fallback', async () => {
    check('capitals tidied', tidyName('JOHN  MUKASA ') === 'John Mukasa', String(tidyName('JOHN  MUKASA ')));
    check('hyphens and apostrophes', tidyName("mary-jane o'neil") === "Mary-Jane O'Neil", String(tidyName("mary-jane o'neil")));
    check('blank → null', tidyName('   ') === null && tidyName(null) === null);
    check('user + 3 digits', /^user\d{3}$/.test(generatedName()));
    check('always three digits (100–999)', generatedName(() => 0) === 'user100' && generatedName(() => 0.9999) === 'user999');
  });

  await act('Act 3 — the right network first, found first time', async () => {
    const mtn = fake('mtn', ['JOHN MUKASA']);
    const airtel = fake('airtel', ['SHOULD NOT BE ASKED']);
    const r = await resolveName('0772123456', { providers: [mtn.provider, airtel.provider], ...fast });
    check('name from MTN, tidied', r.name === 'John Mukasa' && r.source === 'mtn', JSON.stringify(r));
    check('MTN asked once with 2567… format', mtn.calls.length === 1 && mtn.calls[0] === '256772123456');
    check('Airtel not asked', airtel.calls.length === 0);

    const a = fake('airtel', ['Grace Nakato']);
    const r2 = await resolveName('0751234567', { providers: [fake('mtn', [null]).provider, a.provider], ...fast });
    check('an Airtel number asks Airtel first', r2.source === 'airtel' && r2.name === 'Grace Nakato' && a.calls.length === 1);
  });

  await act('Act 4 — retries: up to 3 attempts per network', async () => {
    const mtn = fake('mtn', ['fail', 'fail', 'Peter Okello']);
    const r = await resolveName('0772123456', { providers: [mtn.provider], ...fast });
    check('two failures then success → found on the 3rd attempt',
      r.name === 'Peter Okello' && mtn.calls.length === 3 && r.attempts.mtn === 3, JSON.stringify(r));

    const down = fake('mtn', ['fail']);
    const airtel = fake('airtel', ['Sarah Achieng']);
    const r2 = await resolveName('0772123456', { providers: [down.provider, airtel.provider], ...fast });
    check('MTN down 3 times → stops at 3 and asks Airtel', down.calls.length === 3 && r2.source === 'airtel',
      `mtn calls ${down.calls.length}, ${JSON.stringify(r2)}`);
  });

  await act('Act 5 — not found on its network: try the other (number may have moved)', async () => {
    const mtn = fake('mtn', [null]);
    const airtel = fake('airtel', ['Moved Person']);
    const r = await resolveName('0772123456', { providers: [mtn.provider, airtel.provider], ...fast });
    check('a definite "not found" is not retried', mtn.calls.length === 1);
    check('found on the other network', r.source === 'airtel' && r.name === 'Moved Person');
  });

  await act('Act 6 — nobody knows the number: user###', async () => {
    const mtn = fake('mtn', [null]);
    const airtel = fake('airtel', ['fail']);
    const r = await resolveName('0772123456', { providers: [mtn.provider, airtel.provider], ...fast });
    check('made-up name', r.source === 'generated' && /^user\d{3}$/.test(r.name), JSON.stringify(r));
    check('each network tried its full allowance', mtn.calls.length === 1 && airtel.calls.length === 3);

    const none = await resolveName('0772123456', { providers: [], ...fast });
    check('no providers configured → user###', none.source === 'generated');
  });

  await act('Act 7 — other networks are never sent to MTN or Airtel', async () => {
    const mtn = fake('mtn', ['X']);
    const airtel = fake('airtel', ['Y']);
    const r = await resolveName('0711234567', { providers: [mtn.provider, airtel.provider], ...fast });
    check('UTL number gets user### straight away', r.source === 'generated' && mtn.calls.length === 0 && airtel.calls.length === 0);
    check('registeredName (for withdrawals) gives null, never a made-up name',
      (await registeredName('0711234567', { providers: [mtn.provider] })) === null
        && (await registeredName('0772123456', { providers: [fake('mtn', [null]).provider], ...fast })) === null);
  });

  // ─── The real adapters, with fetch stubbed ───────────────────────────
  const realFetch = globalThis.fetch;
  type Seen = { url: string; init: any };
  function stubFetch(handler: (url: string, init: any) => { status: number; body?: any }) {
    const seen: Seen[] = [];
    (globalThis as any).fetch = async (url: string, init: any = {}) => {
      seen.push({ url, init });
      const { status, body } = handler(url, init);
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    };
    return seen;
  }

  await act('Act 8 — MTN MoMo adapter: token, then basic user info', async () => {
    const seen = stubFetch((url) => url.endsWith('/collection/token/')
      ? { status: 200, body: { access_token: 'tok123', expires_in: 3600 } }
      : { status: 200, body: { given_name: 'JOHN', family_name: 'MUKASA' } });
    try {
      const p = mtnProvider({ baseUrl: 'https://mtn.test', subscriptionKey: 'sub', apiUser: 'user', apiKey: 'key', targetEnv: 'sandbox' });
      const name = await p.lookup('256772123456');
      check('name read from given_name + family_name', name === 'JOHN MUKASA', String(name));
      check('token request uses Basic auth and the subscription key',
        seen[0].init.method === 'POST' && seen[0].init.headers.Authorization === 'Basic ' + Buffer.from('user:key').toString('base64')
          && seen[0].init.headers['Ocp-Apim-Subscription-Key'] === 'sub');
      check('lookup URL carries the msisdn',
        seen[1].url === 'https://mtn.test/collection/v1_0/accountholder/msisdn/256772123456/basicuserinfo', seen[1].url);
      check('lookup headers: bearer, target environment, subscription key',
        seen[1].init.headers.Authorization === 'Bearer tok123' && seen[1].init.headers['X-Target-Environment'] === 'sandbox'
          && seen[1].init.headers['Ocp-Apim-Subscription-Key'] === 'sub');
      await p.lookup('256772123456');
      check('token reused for the next lookup', seen.filter((s) => s.url.endsWith('/token/')).length === 1);
    } finally { globalThis.fetch = realFetch; }

    stubFetch((url) => url.endsWith('/token/') ? { status: 200, body: { access_token: 't', expires_in: 3600 } } : { status: 404 });
    try {
      const p = mtnProvider({ baseUrl: 'https://mtn.test', subscriptionKey: 's', apiUser: 'u', apiKey: 'k', targetEnv: 'sandbox' });
      check('404 = not a MoMo account → null (no retry)', (await p.lookup('256772123456')) === null);
    } finally { globalThis.fetch = realFetch; }

    stubFetch((url) => url.endsWith('/token/') ? { status: 200, body: { access_token: 't', expires_in: 3600 } } : { status: 503 });
    try {
      const p = mtnProvider({ baseUrl: 'https://mtn.test', subscriptionKey: 's', apiUser: 'u', apiKey: 'k', targetEnv: 'sandbox' });
      let threw = false;
      try { await p.lookup('256772123456'); } catch { threw = true; }
      check('503 = temporary → throws so the caller retries', threw);
    } finally { globalThis.fetch = realFetch; }
  });

  await act('Act 9 — Airtel adapter: token, then user enquiry', async () => {
    const seen = stubFetch((url) => url.endsWith('/auth/oauth2/token')
      ? { status: 200, body: { access_token: 'air', expires_in: 3600 } }
      : { status: 200, body: { data: { first_name: 'GRACE', last_name: 'NAKATO' }, status: { success: true } } });
    try {
      const p = airtelProvider({ baseUrl: 'https://airtel.test', clientId: 'id', clientSecret: 'secret' });
      const name = await p.lookup('256751234567');
      check('name read from data.first_name + last_name', name === 'GRACE NAKATO', String(name));
      const tokenBody = JSON.parse(seen[0].init.body);
      check('token request is client credentials',
        tokenBody.client_id === 'id' && tokenBody.client_secret === 'secret' && tokenBody.grant_type === 'client_credentials');
      check('number sent WITHOUT 256', seen[1].url === 'https://airtel.test/standard/v1/users/751234567', seen[1].url);
      check('country and currency headers', seen[1].init.headers['X-Country'] === 'UG' && seen[1].init.headers['X-Currency'] === 'UGX');
    } finally { globalThis.fetch = realFetch; }
  });

  await act('Act 10 — the sign-up name: placeholder until keys exist', async () => {
    const none = await newClientName('0772123456', { providers: [] });
    check('no providers configured → placeholder name', none.name === PLACEHOLDER_NAME && none.source === 'placeholder', JSON.stringify(none));
    const mtn = fake('mtn', ['jordan okello']);
    const real = await newClientName('0772123456', { providers: [mtn.provider], backoffMs: 0 });
    check('with a provider the real lookup runs', real.name === 'Jordan Okello' && real.source === 'mtn', JSON.stringify(real));
    const unknown = await newClientName('0772123456', { providers: [fake('mtn', [null]).provider], backoffMs: 0 });
    check('a provider that does not know the number still gives user###', unknown.source === 'generated', JSON.stringify(unknown));
  });

  await act('Act 11 — real sign-up through the API', async () => {
    // A fresh number on the MTN range. With no MTN/Airtel keys in the local
    // .env, the server gives the placeholder name.
    const phone = '+25677' + String(Date.now()).slice(-7);
    const verifyOnce = async () => {
      const start = await (await fetch(BASE + '/auth/phone/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }),
      })).json() as any;
      const res = await (await fetch(BASE + '/auth/phone/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, code: start?.data?.otp_code }),
      })).json() as any;
      return { code: start?.data?.otp_code, res };
    };

    const first = await verifyOnce();
    check('first sign-in creates the account and says so', first.res?.data?.is_new === true, JSON.stringify(first.res).slice(0, 200));
    const me = await (await fetch(BASE + '/me', { headers: { Authorization: `Bearer ${first.res?.data?.access_token}` } })).json() as any;
    check('new client given the placeholder name, never asked', me?.data?.full_name === PLACEHOLDER_NAME, JSON.stringify(me?.data?.full_name));

    // Signing in again must not rename them, nor call them new.
    const second = await verifyOnce();
    const again = second.res;
    check('signing in again is not a new account', again?.data?.is_new === false, JSON.stringify(again).slice(0, 200));
    const me2 = await (await fetch(BASE + '/me', { headers: { Authorization: `Bearer ${again?.data?.access_token}` } })).json() as any;
    check('signing in again keeps the same name', me2?.data?.full_name === me?.data?.full_name,
      `${me?.data?.full_name} vs ${me2?.data?.full_name}`);

    const reuse = await (await fetch(BASE + '/auth/phone/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, code: second.code }),
    })).json() as any;
    check('the same code cannot sign in twice', reuse?.ok === false, JSON.stringify(reuse).slice(0, 200));
  });

  console.log(`\n=== V2 PHASE 4: ${pass} passed, ${failCount} failed ===`);
  if (failCount > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
