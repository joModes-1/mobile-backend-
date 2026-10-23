import { getEnv } from '@/config';

/**
 * Name lookup by phone number — so a new client never types their name.
 *
 * The registered name comes from the mobile-money network that holds the
 * number (MTN MoMo or Airtel Money). The flow the owner set:
 *
 *   1. Work out the network from the number's prefix.
 *   2. Ask that network, retrying a failed call up to 3 times in total.
 *   3. If it doesn't know the number (or keeps failing), ask the other one —
 *      the person may have moved networks and kept their number.
 *   4. If neither returns a name, make one up: `user` + 3 random digits.
 *
 * Numbers on any other network are never sent to MTN or Airtel; they get the
 * made-up name straight away. Nothing here ever throws to the caller: a
 * lookup problem must never stop someone signing up.
 *
 * Providers are only used when their credentials are in the environment, so
 * with none configured every sign-up gets a `user###` name — which is how it
 * runs until the MTN / Airtel keys arrive.
 */

export type Network = 'mtn' | 'airtel';

export interface NameProvider {
  network: Network;
  /**
   * The registered name, or null if the network definitively doesn't know
   * this number. THROWS on a temporary failure (network error, 5xx, auth
   * hiccup) — that is what tells the caller to retry.
   */
  lookup(msisdn: string): Promise<string | null>;
}

export interface NameResult {
  name: string;
  source: Network | 'generated';
  /** Calls made, per network — for logs and tests. */
  attempts: Partial<Record<Network, number>>;
}

const MAX_ATTEMPTS = 3;

/**
 * Uganda mobile prefixes (the two digits after 256). From the regulator's
 * numbering plan as commonly published: MTN 76/77/78, Airtel 70/74/75.
 * Anything else (UTL, Lyca, landlines) is "another network".
 */
const PREFIXES: Record<string, Network> = {
  '76': 'mtn', '77': 'mtn', '78': 'mtn',
  '70': 'airtel', '74': 'airtel', '75': 'airtel',
};

/** 2567XXXXXXXX (digits only), or null if it isn't a Ugandan mobile number. */
export function toMsisdn(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  let msisdn = digits;
  if (digits.startsWith('0') && digits.length === 10) msisdn = '256' + digits.slice(1);
  else if (digits.length === 9 && digits.startsWith('7')) msisdn = '256' + digits;
  return /^2567\d{8}$/.test(msisdn) ? msisdn : null;
}

export function networkFor(phone: string): Network | null {
  const msisdn = toMsisdn(phone);
  return msisdn ? PREFIXES[msisdn.slice(3, 5)] ?? null : null;
}

/** "JOHN  mukasa " → "John Mukasa". Networks often return names in capitals. */
export function tidyName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned
    .toLowerCase()
    .replace(/(^|[\s'-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

export function generatedName(random: () => number = Math.random): string {
  return 'user' + String(100 + Math.floor(random() * 900));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One network, up to MAX_ATTEMPTS calls; null = not found or gave up. */
async function askNetwork(provider: NameProvider, msisdn: string, attempts: Partial<Record<Network, number>>, backoffMs: number) {
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    attempts[provider.network] = i;
    try {
      return tidyName(await provider.lookup(msisdn));
    } catch (err: any) {
      if (i === MAX_ATTEMPTS) {
        console.warn(`[NAME] ${provider.network} lookup failed ${MAX_ATTEMPTS} times: ${err?.message}`);
        return null;
      }
      await sleep(backoffMs * i);
    }
  }
  return null;
}

/**
 * The name to give a brand-new account. Always returns a name.
 * `providers` and `backoffMs` are injectable for tests; production uses the
 * configured MTN / Airtel adapters.
 */
export async function resolveName(
  phone: string,
  opts: { providers?: NameProvider[]; backoffMs?: number; random?: () => number } = {}
): Promise<NameResult> {
  const attempts: Partial<Record<Network, number>> = {};
  const name = await registeredName(phone, { ...opts, attempts });
  if (name) return { name: name.name, source: name.network, attempts };
  return { name: generatedName(opts.random), source: 'generated', attempts };
}

/**
 * The registered name only, or null — no made-up fallback. For showing a
 * withdrawal's recipient ("You are sending to JOHN MUKASA"), where an
 * invented name would be worse than none.
 */
export async function registeredName(
  phone: string,
  opts: { providers?: NameProvider[]; backoffMs?: number; attempts?: Partial<Record<Network, number>> } = {}
): Promise<{ name: string; network: Network } | null> {
  const msisdn = toMsisdn(phone);
  const primary = msisdn ? PREFIXES[msisdn.slice(3, 5)] : undefined;
  if (!msisdn || !primary) return null;   // another network: never sent to MTN/Airtel

  const providers = opts.providers ?? configuredProviders();
  const order = [primary, primary === 'mtn' ? 'airtel' : 'mtn'] as Network[];
  const attempts = opts.attempts ?? {};
  for (const network of order) {
    const provider = providers.find((p) => p.network === network);
    if (!provider) continue;
    const name = await askNetwork(provider, msisdn, attempts, opts.backoffMs ?? 300);
    if (name) return { name, network };
  }
  return null;
}

// ─── Adapters ───────────────────────────────────────────────────────────

class TemporaryError extends Error {}

async function fetchWithTimeout(url: string, init: RequestInit, ms = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/**
 * MTN MoMo — "Get basic user info" on the Collection product:
 *   POST {base}/collection/token/                       (Basic apiUser:apiKey)
 *   GET  {base}/collection/v1_0/accountholder/msisdn/{msisdn}/basicuserinfo
 * Both carry Ocp-Apim-Subscription-Key; the second X-Target-Environment
 * ("sandbox" on the sandbox, "mtnuganda" live). Field names follow MTN's
 * published spec (given_name / family_name / name) — re-check against the
 * portal when the real keys are issued.
 */
export function mtnProvider(cfg: {
  baseUrl: string; subscriptionKey: string; apiUser: string; apiKey: string; targetEnv: string;
}): NameProvider {
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 30_000) return token.value;
    const res = await fetchWithTimeout(`${cfg.baseUrl}/collection/token/`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${cfg.apiUser}:${cfg.apiKey}`).toString('base64'),
        'Ocp-Apim-Subscription-Key': cfg.subscriptionKey,
      },
    });
    if (!res.ok) throw new TemporaryError(`MTN token ${res.status}`);
    const body: any = await res.json();
    token = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000 };
    return token.value;
  }

  return {
    network: 'mtn',
    async lookup(msisdn: string) {
      const res = await fetchWithTimeout(
        `${cfg.baseUrl}/collection/v1_0/accountholder/msisdn/${msisdn}/basicuserinfo`,
        {
          headers: {
            Authorization: `Bearer ${await accessToken()}`,
            'X-Target-Environment': cfg.targetEnv,
            'Ocp-Apim-Subscription-Key': cfg.subscriptionKey,
          },
        }
      );
      if (res.status === 404 || res.status === 400) return null;   // not a MoMo account
      if (res.status === 401) token = null;                        // retry with a fresh token
      if (!res.ok) throw new TemporaryError(`MTN lookup ${res.status}`);
      const body: any = await res.json();
      return body.name || [body.given_name, body.family_name].filter(Boolean).join(' ') || null;
    },
  };
}

/**
 * Airtel Money — KYC "user enquiry":
 *   POST {base}/auth/oauth2/token          { client_id, client_secret, grant_type }
 *   GET  {base}/standard/v1/users/{number} X-Country: UG, X-Currency: UGX
 * The number goes WITHOUT the 256 country code. Not confirmed from public
 * documentation at the time of writing — verify the path and the response
 * fields (data.first_name / data.last_name) with Airtel when access is
 * granted; only this adapter would need to change.
 */
export function airtelProvider(cfg: { baseUrl: string; clientId: string; clientSecret: string }): NameProvider {
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 30_000) return token.value;
    const res = await fetchWithTimeout(`${cfg.baseUrl}/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: '*/*' },
      body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'client_credentials' }),
    });
    if (!res.ok) throw new TemporaryError(`Airtel token ${res.status}`);
    const body: any = await res.json();
    token = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000 };
    return token.value;
  }

  return {
    network: 'airtel',
    async lookup(msisdn: string) {
      const local = msisdn.slice(3);
      const res = await fetchWithTimeout(`${cfg.baseUrl}/standard/v1/users/${local}`, {
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          'X-Country': 'UG',
          'X-Currency': 'UGX',
          Accept: '*/*',
        },
      });
      if (res.status === 404 || res.status === 400) return null;
      if (res.status === 401) token = null;
      if (!res.ok) throw new TemporaryError(`Airtel lookup ${res.status}`);
      const body: any = await res.json();
      const d = body?.data ?? {};
      if (body?.status && body.status.success === false) return null;
      return [d.first_name, d.last_name].filter(Boolean).join(' ') || null;
    },
  };
}

let cached: NameProvider[] | null = null;

/** Whichever providers have credentials in the environment. */
export function configuredProviders(): NameProvider[] {
  if (cached) return cached;
  const env = getEnv();
  const list: NameProvider[] = [];
  if (env.MTN_MOMO_SUBSCRIPTION_KEY && env.MTN_MOMO_API_USER && env.MTN_MOMO_API_KEY) {
    list.push(mtnProvider({
      baseUrl: env.MTN_MOMO_BASE_URL || 'https://sandbox.momodeveloper.mtn.com',
      subscriptionKey: env.MTN_MOMO_SUBSCRIPTION_KEY,
      apiUser: env.MTN_MOMO_API_USER,
      apiKey: env.MTN_MOMO_API_KEY,
      targetEnv: env.MTN_MOMO_TARGET_ENV || 'sandbox',
    }));
  }
  if (env.AIRTEL_CLIENT_ID && env.AIRTEL_CLIENT_SECRET) {
    list.push(airtelProvider({
      baseUrl: env.AIRTEL_BASE_URL || 'https://openapiuat.airtel.africa',
      clientId: env.AIRTEL_CLIENT_ID,
      clientSecret: env.AIRTEL_CLIENT_SECRET,
    }));
  }
  cached = list;
  return list;
}
