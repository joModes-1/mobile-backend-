import { getEnv } from '@/config';
import { logger } from '@/app';

/**
 * PesaPal API 3.0 adapter: token, IPN registration, order submission and
 * status. Nothing here touches the database — payments/index.ts owns that —
 * so the adapter can be swapped for a fake in tests.
 *
 * Credentials are looked up per organisation with a fall-back to Era92's own
 * (the env). Today every organisation resolves to the env account; giving an
 * organisation its own is then a change to `credentialsFor` alone.
 */

const BASE = {
  sandbox: 'https://cybqa.pesapal.com/pesapalv3',
  live: 'https://pay.pesapal.com/v3',
};

export interface PesapalCreds {
  key: string;
  secret: string;
  env: 'sandbox' | 'live';
}

export function credentialsFor(_orgId?: string): PesapalCreds | null {
  const env = getEnv();
  if (!env.PESAPAL_CONSUMER_KEY || !env.PESAPAL_CONSUMER_SECRET) return null;
  return { key: env.PESAPAL_CONSUMER_KEY, secret: env.PESAPAL_CONSUMER_SECRET, env: env.PESAPAL_ENV };
}

export function pesapalEnabled(): boolean {
  return credentialsFor() !== null;
}

/** The public address PesaPal reaches us on. */
export function publicBase(): string {
  const url = getEnv().PUBLIC_API_URL;
  if (!url) throw new Error('PUBLIC_API_URL is not set');
  return url.replace(/\/+$/, '');
}

async function call(creds: PesapalCreds, path: string, init: { method?: string; token?: string; body?: unknown; tolerateErrorBody?: boolean } = {}): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`${BASE[creds.env]}${path}`, {
      method: init.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
    // PesaPal puts a "Pending Payment" error object inside an HTTP 200 for an
    // order nobody has paid yet; the status call opts out of treating that as a failure.
    if (!res.ok || (!init.tolerateErrorBody && json && json.error && json.error.code)) {
      const detail = json?.error?.message || json?.message || text.slice(0, 200);
      throw new Error(`PesaPal ${path} failed (${res.status}): ${detail}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// Reuse a token until a minute before it expires rather than asking for a
// new one on every call.
const tokenCache = new Map<string, { token: string; expires: number }>();

async function getToken(creds: PesapalCreds): Promise<string> {
  const cacheKey = `${creds.env}:${creds.key}`;
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.expires - 60_000 > Date.now()) return hit.token;
  const r = await call(creds, '/api/Auth/RequestToken', {
    method: 'POST',
    body: { consumer_key: creds.key, consumer_secret: creds.secret },
  });
  if (!r?.token) throw new Error('PesaPal returned no token');
  tokenCache.set(cacheKey, { token: r.token, expires: r.expiryDate ? new Date(r.expiryDate).getTime() : Date.now() + 4 * 60_000 });
  return r.token;
}

// Registering the same IPN URL twice returns the same id, so this is cached
// per process only to save a round trip.
const ipnCache = new Map<string, string>();

async function getIpnId(creds: PesapalCreds): Promise<string> {
  const url = `${publicBase()}/api/v1/payments/ipn`;
  const cacheKey = `${creds.env}:${creds.key}:${url}`;
  const hit = ipnCache.get(cacheKey);
  if (hit) return hit;
  const token = await getToken(creds);
  const r = await call(creds, '/api/URLSetup/RegisterIPN', {
    method: 'POST', token,
    body: { url, ipn_notification_type: 'GET' },
  });
  if (!r?.ipn_id) throw new Error('PesaPal returned no ipn_id');
  ipnCache.set(cacheKey, r.ipn_id);
  return r.ipn_id;
}

export interface SubmitOrderInput {
  merchantReference: string;
  amountUgx: number;
  description: string;
  phone?: string;
  /** Where PesaPal sends the customer's browser when they are done. */
  callbackUrl: string;
  orgId?: string;
}

/** Creates the order and returns the hosted checkout page the app opens. */
export async function submitOrder(input: SubmitOrderInput): Promise<{ orderTrackingId: string; redirectUrl: string; env: 'sandbox' | 'live' }> {
  const creds = credentialsFor(input.orgId);
  if (!creds) throw new Error('PesaPal is not configured');
  const token = await getToken(creds);
  const ipnId = await getIpnId(creds);
  const r = await call(creds, '/api/Transactions/SubmitOrderRequest', {
    method: 'POST', token,
    body: {
      id: input.merchantReference,
      currency: 'UGX',
      amount: input.amountUgx,
      description: input.description.slice(0, 100),
      callback_url: input.callbackUrl,
      notification_id: ipnId,
      billing_address: {
        phone_number: input.phone || undefined,
        email_address: 'payments@era92.com',
        country_code: 'UG',
        first_name: 'Customer',
      },
    },
  });
  if (!r?.order_tracking_id || !r?.redirect_url) throw new Error('PesaPal returned no checkout link');
  return { orderTrackingId: r.order_tracking_id, redirectUrl: r.redirect_url, env: creds.env };
}

export interface PesapalStatus {
  state: 'succeeded' | 'failed' | 'pending';
  /** PesaPal's own words: Completed, Failed, Invalid, Reversed, Pending. */
  description: string;
  method: string | null;
  confirmationCode: string | null;
  amount: number | null;
  merchantReference: string | null;
}

/**
 * The authoritative answer. The IPN call is unauthenticated, so nothing in it
 * is trusted — callers act only on what this returns.
 */
export async function getStatus(orderTrackingId: string, orgId?: string): Promise<PesapalStatus> {
  const creds = credentialsFor(orgId);
  if (!creds) throw new Error('PesaPal is not configured');
  const token = await getToken(creds);
  const r = await call(creds, `/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(orderTrackingId)}`, { token, tolerateErrorBody: true });
  const description = String(r?.payment_status_description || '');
  const code = Number(r?.status_code);
  // status_code: 1 completed, 2 failed, 3 reversed, 0 invalid. An order
  // nobody has paid yet also reads 0 / INVALID, so 0 means "still pending",
  // never "failed": the customer may simply not have finished paying.
  const state = code === 1 || /^completed$/i.test(description) ? 'succeeded'
    : code === 2 || code === 3 || /^(failed|reversed)$/i.test(description) ? 'failed'
    : 'pending';
  logger.info({ orderTrackingId, description }, '[PESAPAL] status');
  return {
    state,
    description,
    method: r?.payment_method || null,
    confirmationCode: r?.confirmation_code || null,
    amount: r?.amount != null ? Number(r.amount) : null,
    merchantReference: r?.merchant_reference || null,
  };
}

/** PesaPal names the channel; the app only distinguishes MTN and Airtel. */
export function channelFor(method: string | null): 'mtn' | 'airtel' {
  return /airtel/i.test(method || '') ? 'airtel' : 'mtn';
}
