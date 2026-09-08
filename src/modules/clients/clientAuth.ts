import { Router, Request, Response, NextFunction } from 'express';
import argon2 from 'argon2';
import { z } from 'zod';
import { getPool } from '@/db';
import { signAccessToken, signRefreshToken } from '@/utils/jwt';
import { authenticate } from '@/middleware/auth';
import { createAppError } from '@/middleware/errorHandler';
import { sendVerificationCodeEmail, sendPasswordResetCodeEmail } from '@/utils/email';
import crypto from 'crypto';

const router = Router();

// --- OTP helpers ---
function generateOtp(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += Math.floor(Math.random() * 10).toString();
  }
  return code;
}

function generateMemberCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'MC-';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// Rate limit: max 3 code requests per email per hour
const otpRateLimits = new Map<string, { count: number; windowStart: number }>();
const OTP_RATE_LIMIT = 3;
const OTP_RATE_WINDOW = 60 * 60 * 1000; // 1 hour

function checkOtpRateLimit(email: string): void {
  const now = Date.now();
  const record = otpRateLimits.get(email);
  if (!record || now - record.windowStart > OTP_RATE_WINDOW) {
    otpRateLimits.set(email, { count: 1, windowStart: now });
    return;
  }
  if (record.count >= OTP_RATE_LIMIT) {
    throw createAppError(429, 'OTP_RATE_LIMITED', 'Too many requests. Try again later.');
  }
  record.count++;
}

// --- Validation schemas ---
const registerSchema = z.object({
  full_name: z.string().min(1),
  username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_.]+$/, 'Username may only contain letters, numbers, dots and underscores'),
  email: z.string().email(),
  password: z.string().min(6),
});

const verifyEmailSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
});

const clientLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const requestPasswordResetSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
  new_password: z.string().min(6),
});

const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(6),
});

/**
 * POST /auth/client/register
 * Creates unverified client, emails a verification code
 */
router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = registerSchema.parse(req.body);
    const pool = getPool();

    // Find the org (for now, use the first active org; in production, this would come from the request)
    const orgResult = await pool.query("SELECT id FROM organizations WHERE status = 'active' LIMIT 1");
    if (orgResult.rows.length === 0) {
      next(createAppError(500, 'NO_ORG', 'No active organization found'));
      return;
    }
    const orgId = orgResult.rows[0].id;

    const existingUsername = await pool.query(
      'SELECT id FROM clients WHERE org_id = $1 AND lower(username) = lower($2)',
      [orgId, data.username]
    );
    if (existingUsername.rows.length > 0) {
      next(createAppError(409, 'USERNAME_EXISTS', 'Username already taken'));
      return;
    }

    const existingEmail = await pool.query(
      'SELECT id FROM clients WHERE lower(email) = lower($1)',
      [data.email]
    );
    if (existingEmail.rows.length > 0) {
      next(createAppError(409, 'EMAIL_EXISTS', 'Email already registered'));
      return;
    }

    // Create client
    const passwordHash = await argon2.hash(data.password);
    const memberCode = generateMemberCode();

    const result = await pool.query(
      `INSERT INTO clients (org_id, full_name, username, email, member_code, password_hash, email_verified)
       VALUES ($1, $2, $3, $4, $5, $6, false) RETURNING id`,
      [orgId, data.full_name, data.username, data.email, memberCode, passwordHash]
    );

    // Issue verification code
    checkOtpRateLimit(data.email);
    const otpCode = generateOtp();
    const otpHash = await argon2.hash(otpCode);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await pool.query(
      `INSERT INTO otp_codes (email, code_hash, purpose, expires_at)
       VALUES ($1, $2, 'register', $3)`,
      [data.email, otpHash, expiresAt]
    );

    await sendVerificationCodeEmail(data.email, otpCode);
    if (process.env.NODE_ENV !== 'production') console.log(`[EMAIL CODE] Register verification for ${data.email}: ${otpCode}`);

    res.status(201).json({
      ok: true,
      data: {
        client_id: result.rows[0].id,
        message: 'Registration successful. Please verify your email with the code we sent.',
        // In development, return the code in the response
        ...(process.env.NODE_ENV !== 'production' ? { otp_code: otpCode } : {}),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/client/verify-email
 * Verifies the emailed code, returns tokens and member_code
 */
router.post('/verify-email', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = verifyEmailSchema.parse(req.body);
    const pool = getPool();

    const otpResult = await pool.query(
      `SELECT id, code_hash, attempts, expires_at
       FROM otp_codes
       WHERE email = $1 AND purpose = 'register' AND consumed_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [data.email]
    );

    if (otpResult.rows.length === 0) {
      next(createAppError(400, 'OTP_NOT_FOUND', 'No verification code found. Please request a new one.'));
      return;
    }

    const otp = otpResult.rows[0];

    if (new Date(otp.expires_at) < new Date()) {
      next(createAppError(400, 'OTP_EXPIRED', 'Code has expired. Please request a new one.'));
      return;
    }

    if (otp.attempts >= 5) {
      next(createAppError(429, 'OTP_TOO_MANY_ATTEMPTS', 'Too many failed attempts. Request a new code.'));
      return;
    }

    const valid = await argon2.verify(otp.code_hash, data.code);
    if (!valid) {
      await pool.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
      next(createAppError(400, 'OTP_INVALID', 'Invalid verification code.'));
      return;
    }

    await pool.query('UPDATE otp_codes SET consumed_at = now() WHERE id = $1', [otp.id]);

    const clientResult = await pool.query(
      `SELECT id, org_id, member_code FROM clients WHERE lower(email) = lower($1)`,
      [data.email]
    );

    if (clientResult.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Client not found'));
      return;
    }

    const client = clientResult.rows[0];

    await pool.query(
      'UPDATE clients SET email_verified = true, updated_at = now() WHERE id = $1',
      [client.id]
    );

    const tokenPayload = { sub: client.id, type: 'client' as const, org_id: client.org_id };
    const accessToken = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken(tokenPayload);

    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO refresh_tokens (owner_type, owner_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
      ['client', client.id, tokenHash, expiresAt]
    );

    res.json({
      ok: true,
      data: {
        access_token: accessToken,
        refresh_token: refreshToken,
        member_code: client.member_code,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/client/login
 */
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { username, password } = clientLoginSchema.parse(req.body);
    const pool = getPool();

    const result = await pool.query(
      `SELECT id, org_id, password_hash, email_verified, status
       FROM clients WHERE lower(username) = lower($1)`,
      [username]
    );

    if (result.rows.length === 0) {
      next(createAppError(401, 'INVALID_CREDENTIALS', 'Invalid username or password'));
      return;
    }

    const client = result.rows[0];

    if (client.status !== 'active') {
      next(createAppError(403, 'ACCOUNT_SUSPENDED', 'Account is suspended'));
      return;
    }

    if (!client.password_hash) {
      next(createAppError(401, 'NO_PASSWORD', 'Account has no password set. Please reset your password.'));
      return;
    }

    const valid = await argon2.verify(client.password_hash, password);
    if (!valid) {
      next(createAppError(401, 'INVALID_CREDENTIALS', 'Invalid username or password'));
      return;
    }

    const tokenPayload = { sub: client.id, type: 'client' as const, org_id: client.org_id };
    const accessToken = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken(tokenPayload);

    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO refresh_tokens (owner_type, owner_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
      ['client', client.id, tokenHash, expiresAt]
    );

    res.json({
      ok: true,
      data: {
        access_token: accessToken,
        refresh_token: refreshToken,
        email_verified: client.email_verified,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/client/request-password-reset
 * Rate limited to 3 per email per hour
 */
router.post('/request-password-reset', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = requestPasswordResetSchema.parse(req.body);
    const pool = getPool();

    checkOtpRateLimit(email);

    const clientResult = await pool.query(
      'SELECT id FROM clients WHERE lower(email) = lower($1)',
      [email]
    );

    if (clientResult.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'No account found with this email'));
      return;
    }

    const otpCode = generateOtp();
    const otpHash = await argon2.hash(otpCode);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      `INSERT INTO otp_codes (email, code_hash, purpose, expires_at)
       VALUES ($1, $2, 'password_reset', $3)`,
      [email, otpHash, expiresAt]
    );

    await sendPasswordResetCodeEmail(email, otpCode);
    if (process.env.NODE_ENV !== 'production') console.log(`[EMAIL CODE] Password reset for ${email}: ${otpCode}`);

    res.json({
      ok: true,
      data: {
        message: 'A password reset code has been sent to your email.',
        ...(process.env.NODE_ENV !== 'production' ? { otp_code: otpCode } : {}),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/client/reset-password
 * Uses the emailed code to verify identity, then sets new password
 */
router.post('/reset-password', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = resetPasswordSchema.parse(req.body);
    const pool = getPool();

    const otpResult = await pool.query(
      `SELECT id, code_hash, attempts, expires_at
       FROM otp_codes
       WHERE email = $1 AND purpose = 'password_reset' AND consumed_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [data.email]
    );

    if (otpResult.rows.length === 0) {
      next(createAppError(400, 'OTP_NOT_FOUND', 'No reset code found. Please request a new one.'));
      return;
    }

    const otp = otpResult.rows[0];

    if (new Date(otp.expires_at) < new Date()) {
      next(createAppError(400, 'OTP_EXPIRED', 'Code has expired. Please request a new one.'));
      return;
    }

    if (otp.attempts >= 5) {
      next(createAppError(429, 'OTP_TOO_MANY_ATTEMPTS', 'Too many failed attempts.'));
      return;
    }

    const valid = await argon2.verify(otp.code_hash, data.code);
    if (!valid) {
      await pool.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
      next(createAppError(400, 'OTP_INVALID', 'Invalid reset code.'));
      return;
    }

    await pool.query('UPDATE otp_codes SET consumed_at = now() WHERE id = $1', [otp.id]);

    const passwordHash = await argon2.hash(data.new_password);
    await pool.query(
      'UPDATE clients SET password_hash = $1, updated_at = now() WHERE lower(email) = lower($2)',
      [passwordHash, data.email]
    );

    const clientResult = await pool.query('SELECT id FROM clients WHERE lower(email) = lower($1)', [data.email]);
    if (clientResult.rows.length > 0) {
      await pool.query(
        'UPDATE refresh_tokens SET revoked_at = now() WHERE owner_type = $1 AND owner_id = $2 AND revoked_at IS NULL',
        ['client', clientResult.rows[0].id]
      );
    }

    res.json({
      ok: true,
      data: { message: 'Password reset successfully' },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/client/change-password
 *
 * The in-app "know my current password, want a new one" flow — distinct
 * from reset-password, which is the emailed-OTP path for someone who is
 * locked out. Clients set their own password at registration and have no
 * must_change_password flag, so this is an ordinary account-settings
 * action, not a forced first-login step.
 */
router.post('/change-password', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.actor || req.actor.type !== 'client') {
      next(createAppError(403, 'FORBIDDEN', 'Client access required'));
      return;
    }

    const { current_password, new_password } = changePasswordSchema.parse(req.body);
    const pool = getPool();

    const result = await pool.query(
      'SELECT password_hash, org_id FROM clients WHERE id = $1',
      [req.actor.sub]
    );

    if (result.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Client not found'));
      return;
    }

    const client = result.rows[0];

    if (!client.password_hash) {
      next(createAppError(401, 'NO_PASSWORD', 'Account has no password set. Use "Forgot password" instead.'));
      return;
    }

    const valid = await argon2.verify(client.password_hash, current_password);
    if (!valid) {
      next(createAppError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect'));
      return;
    }

    const newHash = await argon2.hash(new_password);
    await pool.query(
      'UPDATE clients SET password_hash = $1, updated_at = now() WHERE id = $2',
      [newHash, req.actor.sub]
    );

    // Same reasoning as the staff route: revoke every other session on this
    // account, but issue this session a fresh pair rather than revoking it
    // too — otherwise the very next refresh fails and the app has nothing to
    // do but drop the client back to the login screen right after they set
    // their new password.
    await pool.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE owner_type = $1 AND owner_id = $2 AND revoked_at IS NULL',
      ['client', req.actor.sub]
    );

    const tokenPayload = { sub: req.actor.sub, type: 'client' as const, org_id: client.org_id };
    const accessToken = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken(tokenPayload);

    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await pool.query(
      'INSERT INTO refresh_tokens (owner_type, owner_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
      ['client', req.actor.sub, tokenHash, expiresAt]
    );

    res.json({
      ok: true,
      data: {
        message: 'Password changed successfully',
        access_token: accessToken,
        refresh_token: refreshToken,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
