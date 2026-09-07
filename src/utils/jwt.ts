import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { getEnv } from '@/config';

export interface JwtPayload {
  sub: string;        // user ID
  type: 'platform' | 'staff' | 'client';
  role?: string;      // for staff: orgadmin, manager, worker
  org_id?: string;    // for staff and client
  branch_id?: string; // for staff
}

export function signAccessToken(payload: JwtPayload): string {
  const env = getEnv();
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_ACCESS_TTL as any });
}

export function signRefreshToken(payload: JwtPayload): string {
  const env = getEnv();
  // `jti` makes every refresh token unique. JWT's own `iat` claim has
  // one-second resolution, so two tokens signed for the same user within the
  // same second came out byte-identical — and refresh_tokens.token_hash is
  // UNIQUE, so the second insert failed with 23505. That bit any flow issuing
  // a token twice in quick succession (changing a password, or logging in
  // again immediately after).
  return jwt.sign(
    { ...payload, jti: crypto.randomUUID() },
    env.JWT_SECRET,
    { expiresIn: env.JWT_REFRESH_TTL as any }
  );
}

export function verifyToken(token: string): JwtPayload {
  const env = getEnv();
  return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
}
