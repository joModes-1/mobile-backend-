import { getEnv } from '@/config';

/**
 * Look up a person's name from their phone number, for a brand-new client's
 * sign-up — so they never have to type it themselves.
 *
 * No provider is wired in yet. Every real option (an HLR lookup reseller, a
 * Truecaller-style partner API) needs an account and a key that has not been
 * chosen yet, and none of them are free or reliable enough for Uganda
 * numbers to pick blindly on someone else's behalf. Rather than block the
 * client-initiated redesign on that decision, or silently go back to asking
 * the client to type their name (which was explicitly ruled out), this is
 * one small swappable slot: set NAME_LOOKUP_URL and NAME_LOOKUP_API_KEY once
 * a provider is chosen, and sign-up starts using it with no other change
 * anywhere in the codebase.
 *
 * Until then, both env vars are unset, this returns null on every call, and
 * callers fall back to the same 'Customer' default that has always existed.
 * A lookup failure — no provider configured, the provider is down, the
 * number isn't found — must never be allowed to block sign-up, so every
 * failure mode here returns null rather than throwing.
 */
export async function lookupNameByPhone(phone: string): Promise<string | null> {
  const { NAME_LOOKUP_URL, NAME_LOOKUP_API_KEY } = getEnv();
  if (!NAME_LOOKUP_URL || !NAME_LOOKUP_API_KEY) return null;

  try {
    const res = await fetch(`${NAME_LOOKUP_URL}?phone=${encodeURIComponent(phone)}`, {
      headers: { Authorization: `Bearer ${NAME_LOOKUP_API_KEY}` },
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const name = typeof data?.name === 'string' ? data.name.trim() : '';
    return name || null;
  } catch {
    return null;
  }
}
