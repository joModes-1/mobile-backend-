import jwt from 'jsonwebtoken';
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
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_REFRESH_TTL as any });
}

export function verifyToken(token: string): JwtPayload {
  const env = getEnv();
  return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
}
