import { Router, Request, Response, NextFunction } from 'express';
import argon2 from 'argon2';
import { z } from 'zod';
import { getPool } from '@/db';
import { signAccessToken, signRefreshToken, verifyToken } from '@/utils/jwt';
import { createAppError } from '@/middleware/errorHandler';
import { authenticate } from '@/middleware/auth';
import { requirePlatform } from '@/middleware/requirePlatform';
import crypto from 'crypto';
// NOTE: /me endpoint is in a separate meRouter to avoid path duplication

const router = Router();

// Validation schemas
// Accepts `username` (preferred) or `email`, so the app can send one identifier
// field for every role. Older clients that still post `email` keep working.
const loginSchema = z
  .object({
    username: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
    password: z.string().min(1),
  })
  .refine((d) => !!(d.username || d.email), {
    message: 'username or email is required',
    path: ['username'],
  });

const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8),
});

/**
 * POST /auth/platform/login
 * Public endpoint for sysadmin login
 */
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, email, password } = loginSchema.parse(req.body);
    const identifier = (username || email) as string;
    const pool = getPool();

    // Match on username or email (case-insensitive) so either identifier works.
    const result = await pool.query(
      `SELECT id, password_hash, must_change_password, status
       FROM platform_admins
       WHERE lower(username) = lower($1) OR lower(email) = lower($1)`,
      [identifier]
    );

    if (result.rows.length === 0) {
      next(createAppError(401, 'INVALID_CREDENTIALS', 'Invalid username or password'));
      return;
    }

    const admin = result.rows[0];

    if (admin.status !== 'active') {
      next(createAppError(403, 'ACCOUNT_SUSPENDED', 'Account is suspended'));
      return;
    }

    // Verify password
    const valid = await argon2.verify(admin.password_hash, password);
    if (!valid) {
      next(createAppError(401, 'INVALID_CREDENTIALS', 'Invalid username or password'));
      return;
    }

    // Update last login
    await pool.query(
      'UPDATE platform_admins SET last_login_at = now(), updated_at = now() WHERE id = $1',
      [admin.id]
    );

    // Generate tokens
    const tokenPayload = { sub: admin.id, type: 'platform' as const };
    const accessToken = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken(tokenPayload);

    // Store refresh token hash
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
    await pool.query(
      'INSERT INTO refresh_tokens (owner_type, owner_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
      ['platform', admin.id, tokenHash, expiresAt]
    );

    res.json({
      ok: true,
      data: {
        access_token: accessToken,
        refresh_token: refreshToken,
        must_change_password: admin.must_change_password,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/platform/change-password
 * Requires platform JWT
 */
router.post('/change-password', authenticate, requirePlatform, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { current_password, new_password } = changePasswordSchema.parse(req.body);
    const pool = getPool();
    const adminId = req.actor!.sub;

    // Get current hash
    const result = await pool.query(
      'SELECT password_hash FROM platform_admins WHERE id = $1',
      [adminId]
    );

    if (result.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Admin not found'));
      return;
    }

    // Verify current password
    const valid = await argon2.verify(result.rows[0].password_hash, current_password);
    if (!valid) {
      next(createAppError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect'));
      return;
    }

    // Hash new password
    const newHash = await argon2.hash(new_password);

    // Update password and clear must_change_password
    await pool.query(
      'UPDATE platform_admins SET password_hash = $1, must_change_password = false, updated_at = now() WHERE id = $2',
      [newHash, adminId]
    );

    // Revoke all refresh tokens for this user
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE owner_type = $1 AND owner_id = $2 AND revoked_at IS NULL',
      ['platform', adminId]
    );

    res.json({
      ok: true,
      data: { message: 'Password changed successfully' },
    });
  } catch (err) {
    next(err);
  }
});

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
