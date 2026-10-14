import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getPool } from '@/db';
import { signAccessToken, signRefreshToken, verifyToken } from '@/utils/jwt';
import { createAppError } from '@/middleware/errorHandler';
import crypto from 'crypto';
// NOTE: /me endpoint is in a separate meRouter to avoid path duplication
//
// Sysadmin (platform admin) sign-in is phone + OTP now, same as every other
// role — see phoneAuth.ts, which has always checked platform_admins first
// (the most privileged tier) before staff or clients. POST /login and
// POST /change-password used to be the only way in; both are removed along
// with password_hash's NOT NULL constraint (20260923_017 migration).
// /refresh and /logout below are unrelated to how someone signs in — every
// role's session rotation and logout goes through these two — so they stay.

const router = Router();

/**
 * POST /auth/refresh
 * Rotates refresh tokens
 */
router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refresh_token } = z.object({ refresh_token: z.string() }).parse(req.body);
    const pool = getPool();

    // Verify the token signature
    let payload;
    try {
      payload = verifyToken(refresh_token);
    } catch {
      next(createAppError(401, 'INVALID_TOKEN', 'Invalid refresh token'));
      return;
    }

    // Hash and find the token
    const tokenHash = crypto.createHash('sha256').update(refresh_token).digest('hex');
    const result = await pool.query(
      'SELECT id, owner_type, owner_id, revoked_at, expires_at FROM refresh_tokens WHERE token_hash = $1',
      [tokenHash]
    );

    if (result.rows.length === 0 || result.rows[0].revoked_at) {
      next(createAppError(401, 'INVALID_TOKEN', 'Refresh token is invalid or revoked'));
      return;
    }

    if (new Date(result.rows[0].expires_at) < new Date()) {
      next(createAppError(401, 'TOKEN_EXPIRED', 'Refresh token has expired'));
      return;
    }

    // Check if org is suspended (for staff tokens)
    if (payload.type === 'staff' && payload.org_id) {
      const orgResult = await pool.query(
        'SELECT status FROM organizations WHERE id = $1',
        [payload.org_id]
      );
      if (orgResult.rows[0]?.status === 'suspended') {
        next(createAppError(403, 'ORG_SUSPENDED', 'Organization is suspended'));
        return;
      }
    }

    // Revoke old token
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1',
      [result.rows[0].id]
    );

    // Issue new tokens
    const newAccessToken = signAccessToken({
      sub: payload.sub,
      type: payload.type,
      role: payload.role,
      org_id: payload.org_id,
      branch_id: payload.branch_id,
    });
    const newRefreshToken = signRefreshToken({
      sub: payload.sub,
      type: payload.type,
      role: payload.role,
      org_id: payload.org_id,
      branch_id: payload.branch_id,
    });

    // Store new refresh token
    const newTokenHash = crypto.createHash('sha256').update(newRefreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO refresh_tokens (owner_type, owner_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
      [result.rows[0].owner_type, result.rows[0].owner_id, newTokenHash, expiresAt]
    );

    res.json({
      ok: true,
      data: {
        access_token: newAccessToken,
        refresh_token: newRefreshToken,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/logout
 * Revokes the refresh token
 */
router.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refresh_token } = z.object({ refresh_token: z.string() }).parse(req.body);
    const pool = getPool();

    // Verify the token to get owner info
    let payload;
    try {
      payload = verifyToken(refresh_token);
    } catch {
      // Token invalid/expired - still return success
      res.json({ ok: true, data: { message: 'Logged out successfully' } });
      return;
    }

    const tokenHash = crypto.createHash('sha256').update(refresh_token).digest('hex');

    // Revoke this refresh token
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
      [tokenHash]
    );

    // Delete device rows for this owner (clear push token)
    const ownerType = payload.type === 'client' ? 'client' : payload.type === 'platform' ? 'platform' : 'staff';
    await pool.query(
      'DELETE FROM devices WHERE owner_type = $1 AND owner_id = $2',
      [ownerType, payload.sub]
    );

    res.json({
      ok: true,
      data: { message: 'Logged out successfully' },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
