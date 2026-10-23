import { Request, Response, NextFunction } from 'express';
import { verifyToken, JwtPayload } from '@/utils/jwt';
import { createAppError } from '@/middleware/errorHandler';
import { getPool } from '@/db';

// Extend Express Request to include actor info
declare global {
  namespace Express {
    interface Request {
      actor?: JwtPayload;
    }
  }
}

/**
 * When each staff member's app was last in touch, for the dispatcher's
 * "on site" test (modules/dispatch). Written at most once a minute per
 * person — the worker app polls every few seconds, and a write per poll
 * would be pointless load. Fire-and-forget: presence must never slow or
 * fail the request that carried it.
 */
const lastSeenWritten = new Map<string, number>();
const LAST_SEEN_THROTTLE_MS = 60_000;

function touchStaffPresence(staffId: string): void {
  const now = Date.now();
  if (now - (lastSeenWritten.get(staffId) ?? 0) < LAST_SEEN_THROTTLE_MS) return;
  lastSeenWritten.set(staffId, now);
  getPool()
    .query(`UPDATE staff_users SET last_seen_at = now() WHERE id = $1`, [staffId])
    .catch(() => lastSeenWritten.delete(staffId));
}

/**
 * Middleware to verify JWT access token and attach actor to request.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next(createAppError(401, 'UNAUTHORIZED', 'Missing or invalid authorization header'));
    return;
  }

  const token = authHeader.slice(7);
  
  try {
    const payload = verifyToken(token);
    req.actor = payload;
    if (payload.type === 'staff') touchStaffPresence(payload.sub);
    next();
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      next(createAppError(401, 'TOKEN_EXPIRED', 'Access token has expired'));
    } else {
      next(createAppError(401, 'INVALID_TOKEN', 'Invalid access token'));
    }
  }
}
