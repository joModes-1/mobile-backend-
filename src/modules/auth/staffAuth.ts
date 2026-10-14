import { Router, Request, Response, NextFunction } from 'express';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';
import { authenticate } from '@/middleware/auth';

const router = Router();

/**
 * NOTE: this file used to hold staff username/password sign-in and
 * change-password. Both were removed — every role signs in with phone +
 * one-time code via `/auth/phone/*` (see phoneAuth.ts), and staff accounts
 * have been created with `password_hash = NULL` since the phone-login
 * migration.
 *
 * `logout` is kept: it is session handling shared by every role, not a
 * password mechanism.
 */

/**
 * POST /auth/staff/logout
 * Deletes the caller's device and revokes refresh tokens.
 */
router.post('/logout', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.actor || req.actor.type !== 'staff') {
      next(createAppError(403, 'FORBIDDEN', 'Staff access required'));
      return;
    }

    const pool = getPool();
    const staffId = req.actor.sub;

    // Delete this user's devices
    await pool.query('DELETE FROM devices WHERE owner_type = $1 AND owner_id = $2', ['staff', staffId]);

    // Revoke all refresh tokens
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE owner_type = $1 AND owner_id = $2 AND revoked_at IS NULL',
      ['staff', staffId]
    );

    res.json({ ok: true, data: { message: 'Logged out' } });
  } catch (err) {
    next(err);
  }
});

export default router;
