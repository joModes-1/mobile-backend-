import { Router, Request, Response, NextFunction } from 'express';
import argon2 from 'argon2';
import { z } from 'zod';
import { getPool } from '@/db';
import { signAccessToken, signRefreshToken, verifyToken } from '@/utils/jwt';
import { createAppError } from '@/middleware/errorHandler';
import { authenticate } from '@/middleware/auth';
import crypto from 'crypto';

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8),
});

// Failed login tracking (in-memory for now; production would use Redis)
const failedLogins = new Map<string, { count: number; lockedUntil?: Date }>();

function checkRateLimit(identifier: string): void {
  const record = failedLogins.get(identifier);
  if (record?.lockedUntil && record.lockedUntil > new Date()) {
    throw createAppError(423, 'ACCOUNT_LOCKED', `Account locked. Try again after ${record.lockedUntil.toISOString()}`);
  }
}

function recordFailedLogin(identifier: string): void {
  const record = failedLogins.get(identifier) || { count: 0 };
  record.count++;
  if (record.count >= 5) {
    record.lockedUntil = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
  }
  failedLogins.set(identifier, record);
}

function clearFailedLogins(identifier: string): void {
  failedLogins.delete(identifier);
}

/**
 * POST /auth/staff/login
 */
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password } = loginSchema.parse(req.body);
    const pool = getPool();

    // Find staff by username (case-insensitive)
    const result = await pool.query(
      `SELECT s.id, s.org_id, s.branch_id, s.role, s.password_hash, s.must_change_password, s.status,
              o.status as org_status
       FROM staff_users s
       JOIN organizations o ON s.org_id = o.id
       WHERE lower(s.username) = lower($1)`,
      [username]
    );

    if (result.rows.length === 0) {
      next(createAppError(401, 'INVALID_CREDENTIALS', 'Invalid username or password'));
      return;
    }

    const staff = result.rows[0];

    // Check rate limit
    const lockId = `staff:${staff.id}`;
    checkRateLimit(lockId);

    if (staff.status !== 'active') {
      next(createAppError(403, 'ACCOUNT_SUSPENDED', 'Account is suspended'));
      return;
    }

    if (staff.org_status === 'suspended') {
      next(createAppError(403, 'ORG_SUSPENDED', 'Organization is suspended'));
      return;
    }

    // Verify password
    const valid = await argon2.verify(staff.password_hash, password);
    if (!valid) {
      recordFailedLogin(lockId);
      next(createAppError(401, 'INVALID_CREDENTIALS', 'Invalid username or password'));
      return;
    }

    clearFailedLogins(lockId);

    // Update last login
    await pool.query(
      'UPDATE staff_users SET last_login_at = now(), updated_at = now() WHERE id = $1',
      [staff.id]
    );

    // Generate tokens
    const tokenPayload = {
      sub: staff.id,
      type: 'staff' as const,
      role: staff.role,
      org_id: staff.org_id,
      branch_id: staff.branch_id,
    };
    const accessToken = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken(tokenPayload);

    // Store refresh token hash
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO refresh_tokens (owner_type, owner_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
      ['staff', staff.id, tokenHash, expiresAt]
    );

    // Device lifecycle: upsert push token on login
    const pushToken = req.body.push_token;
    const platform = req.body.platform;
    if (pushToken && platform) {
      await pool.query(
        `INSERT INTO devices (owner_type, owner_id, push_token, platform)
         VALUES ('staff', $1, $2, $3)
         ON CONFLICT (push_token) DO UPDATE SET owner_id = $1, owner_type = 'staff', platform = $3, last_seen_at = now()`,
        [staff.id, pushToken, platform]
      );
    }

    res.json({
      ok: true,
      data: {
        access_token: accessToken,
        refresh_token: refreshToken,
        must_change_password: staff.must_change_password,
        role: staff.role,
        org_id: staff.org_id,
        branch_id: staff.branch_id,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/staff/change-password
 */
router.post('/change-password', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.actor || req.actor.type !== 'staff') {
      next(createAppError(403, 'FORBIDDEN', 'Staff access required'));
      return;
    }

    const { current_password, new_password } = changePasswordSchema.parse(req.body);
    const pool = getPool();

    const result = await pool.query(
      'SELECT password_hash FROM staff_users WHERE id = $1',
      [req.actor.sub]
    );

    if (result.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Staff not found'));
      return;
    }

    const valid = await argon2.verify(result.rows[0].password_hash, current_password);
    if (!valid) {
      next(createAppError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect'));
      return;
    }

    const newHash = await argon2.hash(new_password);

    await pool.query(
      'UPDATE staff_users SET password_hash = $1, must_change_password = false, updated_at = now() WHERE id = $2',
      [newHash, req.actor.sub]
    );

    // Revoke all refresh tokens for this user
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE owner_type = $1 AND owner_id = $2 AND revoked_at IS NULL',
      ['staff', req.actor.sub]
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
