/**
 * Generate a random 8-character temporary password.
 * Excludes: 0, O, 1, l (ambiguous characters)
 */
export function generateTempPassword(): string {
  const chars = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  let password = '';
  const array = new Uint8Array(8);
  // Use crypto for randomness
  const crypto = require('crypto');
  crypto.randomFillSync(array);
  for (let i = 0; i < 8; i++) {
    password += chars[array[i] % chars.length];
  }
  return password;
}
