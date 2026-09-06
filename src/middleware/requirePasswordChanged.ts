import { Request, Response, NextFunction } from 'express';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';

// Routes that are allowed even when must_change_password is true
const ALLOWED_PATHS = [
  '/api/v1/auth/staff/change-password',
  '/api/v1/auth/platform/change-password',
  '/api/v1/auth/client/change-password',
  '/api/v1/me',
  '/api/v1/auth/logout',
  '/api/v1/auth/platform/logout',
  '/api/v1/auth/refresh',
];

/**
 * Middleware to check if user must change password.
 * Applied globally. Blocks all routes except password change, /me, and logout.
 */
export async function requirePasswordChanged(req: Request, _res: Response, next: NextFunction): Promise<void> {
  // Skip if no actor (unauthenticated routes)
  if (!req.actor) {
    next();
    return;
  }

  // Skip if path is in allowed list (use originalUrl for mounted routers)
  if (ALLOWED_PATHS.some(p => req.originalUrl.startsWith(p))) {
    next();
    return;
  }

  try {
    const pool = getPool();
    let mustChange = false;

    if (req.actor.type === 'platform') {
      const result = await pool.query(
        'SELECT must_change_password FROM platform_admins WHERE id = $1',
        [req.actor.sub]
      );
      mustChange = result.rows[0]?.must_change_password || false;
    } else if (req.actor.type === 'staff') {
      const result = await pool.query(
        'SELECT must_change_password FROM staff_users WHERE id = $1',
        [req.actor.sub]
      );
      mustChange = result.rows[0]?.must_change_password || false;
    }
    // Client accounts don't have must_change_password

    if (mustChange) {
      next(createAppError(403, 'PASSWORD_CHANGE_REQUIRED', 'You must change your password before continuing'));
      return;
    }

    next();
  } catch (err) {
    next(err);
  }
}
