import { getEnv } from '@/config';
import { logger } from '@/app';

/**
 * SMS via Africa's Talking.
 *
 * Same rule as the email module: sending must never throw into the caller.
 * A customer's verification code failing to send is a problem to report,
 * not a reason to fail the request that triggered it — every function here
 * returns a result object instead.
 */

const AT_URL_LIVE = 'https://api.africastalking.com/version1/messaging';
const AT_URL_SANDBOX = 'https://api.sandbox.africastalking.com/version1/messaging';

/**
 * Normalises a Ugandan number to the international form the API requires.
 *
 * People type what they know: 0706…, 256706…, +256706…, or with spaces.
 * The gateway accepts exactly one of those, so the conversion happens here
 * rather than being a rule every caller has to remember.
 */
export function normalizeUgPhone(input: string): string | null {
  const digits = String(input || '').replace(/[^\d+]/g, '');
  if (!digits) return null;

  if (digits.startsWith('+256') && digits.length === 13) return digits;
  if (digits.startsWith('256') && digits.length === 12) return `+${digits}`;
  // Local form: 0706965418 -> +256706965418
  if (digits.startsWith('0') && digits.length === 10) return `+256${digits.slice(1)}`;
  // Bare subscriber number, no trunk prefix: 706965418
  if (digits.length === 9 && !digits.startsWith('0')) return `+256${digits}`;

  return null;
}

/** How a number should read back to the person who typed it. */
export function displayUgPhone(e164: string): string {
  const m = /^\+256(\d{9})$/.exec(e164);
  if (!m) return e164;
  const n = m[1];
  return `0${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5)}`;
}

export interface SmsResult {
  sent: boolean;
  messageId?: string;
  cost?: string;
  error?: string;
}

function credentials(): { username: string; apiKey: string } | null {
  const env = getEnv();
  const username = env.AFRICASTALKING_USERNAME;
  const apiKey = env.AFRICASTALKING;
  if (!username || !apiKey) return null;
  return { username, apiKey };
}

/** Is SMS configured at all? Lets callers fall back rather than guess. */
export function smsEnabled(): boolean {
  return credentials() !== null;
}

/**
 * Sends one message, retrying on transient failures.
 *
 * The retry is not defensive padding: the gateway intermittently returns
 * 401 for a request that succeeds moments later with identical credentials.
 * Observed repeatedly in testing. Without a retry roughly one message in
 * three would vanish with no error the user could act on.
 */
export async function sendSms(to: string, message: string): Promise<SmsResult> {
  const creds = credentials();
  if (!creds) {
    logger.warn('[SMS] Not configured — skipping send');
    return { sent: false, error: 'SMS not configured' };
  }

  const phone = normalizeUgPhone(to);
  if (!phone) {
    return { sent: false, error: `Unrecognised phone number: ${to}` };
  }

  // Sandbox is Africa's Talking' own test environment, reached through a
  // different host — sending sandbox credentials to the live endpoint gets
  // a flat auth rejection, not a sandboxed send.
  const url = creds.username === 'sandbox' ? AT_URL_SANDBOX : AT_URL_LIVE;

  const MAX_ATTEMPTS = 3;
  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          apiKey: creds.apiKey,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          username: creds.username,
          to: phone,
          message,
        }),
      });

      const text = await res.text();

      if (res.status === 401) {
        // The intermittent one. Worth another go.
        lastError = 'auth rejected';
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 400 * attempt));
          continue;
        }
        break;
      }

      let body: any;
      try { body = JSON.parse(text); } catch { body = null; }

      const recipient = body?.SMSMessageData?.Recipients?.[0];
      if (recipient?.status === 'Success') {
        logger.info(`[SMS] Sent to ${phone} (${recipient.cost})`);
        return { sent: true, messageId: recipient.messageId, cost: recipient.cost };
      }

      // A named failure from the gateway — a bad sender ID, no credit, an
      // invalid number. Retrying will not change any of those.
      lastError = recipient?.status
        || body?.SMSMessageData?.Message
        || `HTTP ${res.status}`;
      break;
    } catch (e: any) {
      lastError = e?.message || 'network error';
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
    }
  }

  logger.error(`[SMS] Failed to ${phone}: ${lastError}`);
  return { sent: false, error: lastError };
}

/** The verification code sent when someone signs up or signs in. */
export async function sendOtpSms(phone: string, code: string): Promise<SmsResult> {
  return sendSms(
    phone,
    `${code} is your 92 CarWash verification code. It expires in 10 minutes. Do not share it with anyone.`
  );
}
