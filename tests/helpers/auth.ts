/**
 * Shared sign-in for the test suites.
 *
 * The platform moved to phone + OTP and dropped staff passwords entirely,
 * which broke every suite written against `POST /auth/staff/login`. Rather
 * than patch 42 call sites individually, sign-in lives here: the suites ask
 * for a role by its seeded username and get a bearer token back.
 *
 * Two things this has to respect:
 *
 *  1. `/auth/phone/start` is rate limited to 3 per number per hour, in
 *     memory. A suite that signs the same user in repeatedly will trip it
 *     and fail for reasons that have nothing to do with what it tests, so
 *     tokens are cached per phone for the life of the process.
 *
 *  2. TEST_MODE must be on, since that is what returns the OTP in the
 *     response instead of sending an SMS. Without it there is no way to
 *     complete a sign-in here, and the error says so rather than surfacing
 *     as a confusing undefined-token crash.
 */

const BASE = process.env.TEST_BASE || 'http://localhost:3456/api/v1';

/**
 * The seeded accounts, by the username the old suites used.
 *
 * Includes the platform admin: `/auth/phone/verify` resolves all three actor
 * types (platform → staff → client) behind one endpoint, so the sysadmin signs
 * in the same way and needs no separate helper.
 */
export const ACCOUNT_PHONES: Record<string, string> = {
  sysadmin: '+256700200000', // platform admin
  orgadmin: '+256700200001',
  grace: '+256700200002',   // manager
  joseph: '+256700200003',  // worker, NTD
  // Also NTD — the seed puts both workers on the same branch, so these two
  // are NOT a cross-branch pair. Anything testing branch isolation needs a
  // worker created on another branch rather than reaching for musa.
  musa: '+256700200004',
};

const tokenCache = new Map<string, string>();

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  let parsed: any = null;
  try { parsed = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: parsed };
}

/**
 * Sign in by phone and return an access token.
 *
 * Cached: calling this twice for the same number costs one OTP, not two.
 */
export async function signInByPhone(phone: string): Promise<string> {
  const cached = tokenCache.get(phone);
  if (cached) return cached;

  const start = await post('/auth/phone/start', { phone });

  if (start.body?.error?.code === 'OTP_RATE_LIMITED') {
    throw new Error(
      `OTP rate limit hit for ${phone}. The limiter is in memory — restart the ` +
      `dev server to clear it, then re-run.`
    );
  }

  const code = start.body?.data?.otp_code;
  if (!code) {
    throw new Error(
      `No OTP returned for ${phone}. Set TEST_MODE=true on the backend so the ` +
      `code comes back in the response instead of by SMS. ` +
      `(start responded ${start.status}: ${JSON.stringify(start.body)})`
    );
  }

  const verify = await post('/auth/phone/verify', { phone, code });
  const token = verify.body?.data?.access_token;
  if (!token) {
    throw new Error(
      `Sign-in failed for ${phone}: verify responded ${verify.status} ` +
      `${JSON.stringify(verify.body)}`
    );
  }

  tokenCache.set(phone, token);
  return token;
}

/**
 * Sign in a seeded account by the username the suites already use.
 * Drop-in for the old `/auth/staff/login` + change-password dance.
 */
export async function signInAs(username: string): Promise<string> {
  const phone = ACCOUNT_PHONES[username];
  if (!phone) {
    throw new Error(
      `No phone mapped for account "${username}". Add it to ` +
      `ACCOUNT_PHONES in tests/helpers/auth.ts.`
    );
  }
  return signInByPhone(phone);
}
