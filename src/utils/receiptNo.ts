import crypto from 'crypto';

/**
 * Client-facing receipt reference, e.g. 850779GE828923: 6 digits, 2 letters,
 * 6 digits. Random rather than sequential so it can't be guessed, and
 * assigned once per wash (whichever comes first: the client declaring a
 * payment method, or the worker settling) — never changed after.
 */
export function generateReceiptNo(): string {
  const digits = (n: number) => Array.from({ length: n }, () => crypto.randomInt(10)).join('');
  const letters = Array.from({ length: 2 }, () => String.fromCharCode(65 + crypto.randomInt(26))).join('');
  return `${digits(6)}${letters}${digits(6)}`;
}
