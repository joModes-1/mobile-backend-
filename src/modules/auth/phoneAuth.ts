import { Router, Request, Response, NextFunction } from 'express';
import argon2 from 'argon2';
import crypto from 'crypto';
import { z } from 'zod';
import { getPool } from '@/db';
import { signAccessToken, signRefreshToken } from '@/utils/jwt';
import { createAppError } from '@/middleware/errorHandler';
import { sendOtpSms, normalizeUgPhone, displayUgPhone } from '@/utils/sms';
import { newClientName, generatedName } from '@/modules/nameLookup';
import { getEnv } from '@/config';

const router = Router();

/**
 * One phone number, one code, every role.
 *
 * A number that matches an existing staff account (manager, worker,
 * orgadmin) logs that person straight in as themselves — the OTP is the
 * whole check, same trust level as the customer flow, by explicit choice:
 * this is faster for staff at the cost of the password no longer being a
 * second factor for that path. A number that matches an existing client
 * logs them in the same way. A number nobody recognises becomes a new
 * client, and only then is a name actually asked for — an existing person
 * never sees that screen, because their name is already on file.
 *
 * Checked in that order — staff, then client — because a phone number is
 * only supposed to belong to one identity; if it were ever recorded on
 * both a staff row and a client row, staff wins, since that is the more
 * privileged account and the one a manager would expect to reach.
 */

const OTP_RATE_LIMIT = 3;
const OTP_RATE_WINDOW = 60 * 60 * 1000;
const otpRateLimits = new Map<string, { count: number; windowStart: number }>();

/**
 * Three codes an hour is right for real numbers — it is what stops an
 * attacker walking a range, and what stops us paying for a flood of SMS.
 *
 * It is wrong for the test suites, which sign the same handful of seeded
 * numbers in dozens of times across seven files and would otherwise spend
 * their budget before the first suite finished. TEST_MODE already changes
 * this endpoint's behaviour (it returns the code in the response instead of
 * sending an SMS), so the limit rides on the same switch. Production never
 * sets TEST_MODE, so the real limit there is unchanged.
 */
function otpRateLimit(): number {
  return getEnv().TEST_MODE ? 1000 : OTP_RATE_LIMIT;
}

function checkOtpRateLimit(phone: string): void {
  const now = Date.now();
  const record = otpRateLimits.get(phone);
  if (!record || now - record.windowStart > OTP_RATE_WINDOW) {
    otpRateLimits.set(phone, { count: 1, windowStart: now });
    return;
  }
  if (record.count >= otpRateLimit()) {
    throw createAppError(429, 'OTP_RATE_LIMITED', 'Too many requests. Try again later.');
  }
  record.count++;
}

function generateOtp(): string {
  let code = '';
  for (let i = 0; i < 4; i++) code += Math.floor(Math.random() * 10).toString();
  return code;
}

const startSchema = z.object({ phone: z.string().min(9).max(20) });

/**
 * POST /auth/phone/start
 * Sends a code. Same shape whether the number is staff, client, or new, so
 * the response cannot be used to fingerprint who has an account — except
 * for `role`, which the app needs to decide whether to show the name step,
 * and which reveals only "does an account exist", not who it belongs to.
 */
router.post('/start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = startSchema.parse(req.body);
    const phone = normalizeUgPhone(data.phone);
    if (!phone) {
      next(createAppError(422, 'INVALID_PHONE', 'Enter a valid Ugandan mobile number'));
      return;
    }

    const pool = getPool();
    checkOtpRateLimit(phone);

    const otpCode = generateOtp();
    const otpHash = await argon2.hash(otpCode);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      `INSERT INTO otp_codes (phone, code_hash, purpose, expires_at)
       VALUES ($1, $2, 'phone_login', $3)`,
      [phone, otpHash, expiresAt]
    );

    const sms = await sendOtpSms(phone, otpCode);

    const platform = await pool.query(
      `SELECT id FROM platform_admins WHERE phone = $1 AND status = 'active' LIMIT 1`,
      [phone]
    );
    const isPlatform = platform.rows.length > 0;

    const staff = isPlatform
      ? { rows: [] as any[] }
      : await pool.query(
          `SELECT role FROM staff_users WHERE phone = $1 AND status = 'active' LIMIT 1`,
          [phone]
        );
    const isStaff = !isPlatform && staff.rows.length > 0;

    const client = isPlatform || isStaff
      ? { rows: [] as any[] }
      : await pool.query(`SELECT id FROM clients WHERE phone = $1 LIMIT 1`, [phone]);
    const isExistingClient = !isPlatform && !isStaff && client.rows.length > 0;

    res.json({
      ok: true,
      data: {
        phone,
        phone_display: displayUgPhone(phone),
        // Tells the app whether to show the "your name" step next, and
        // what kind of account this code will sign in to. null means
        // "nobody has this number yet" — the only case that asks for a name.
        is_new: !isPlatform && !isStaff && !isExistingClient,
        role: isPlatform ? 'sysadmin' : isStaff ? staff.rows[0].role : isExistingClient ? 'client' : null,
        sent: sms.sent,
        ...(sms.sent ? {} : { delivery_error: sms.error }),
        // Sandbox never reaches a real handset, so without this there would
        // be no way to actually get the code during testing. Also on
        // outside production, same as before.
        ...(getEnv().TEST_MODE || process.env.NODE_ENV !== 'production'
          ? { otp_code: otpCode } : {}),
      },
    });
  } catch (err) {
    next(err);
  }
});

const verifySchema = z.object({
  phone: z.string().min(9).max(20),
  code: z.string().length(4),
  // Only used when the number is genuinely new — an existing account of
  // any kind already has a name and this is ignored for it.
  full_name: z.string().min(1).max(120).optional(),
});

/**
 * POST /auth/phone/verify
 * Checks the code, then routes to whichever identity actually owns the
 * number: staff, an existing client, or (only then) a newly created one.
 */
router.post('/verify', async (req: Request, res: Response, next: NextFunction) => {
  const pool = getPool();
  const conn = await pool.connect();
  try {
    const data = verifySchema.parse(req.body);
    const phone = normalizeUgPhone(data.phone);
    if (!phone) {
      next(createAppError(422, 'INVALID_PHONE', 'Enter a valid Ugandan mobile number'));
      return;
    }

    const otpResult = await conn.query(
      `SELECT id, code_hash, attempts, expires_at
         FROM otp_codes
        WHERE phone = $1 AND purpose = 'phone_login' AND consumed_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    if (otpResult.rows.length === 0) {
      next(createAppError(400, 'OTP_NOT_FOUND', 'No code found. Request a new one.'));
      return;
    }
    const otp = otpResult.rows[0];

    if (new Date(otp.expires_at) < new Date()) {
      next(createAppError(400, 'OTP_EXPIRED', 'That code has expired. Request a new one.'));
      return;
    }
    if (otp.attempts >= 5) {
      next(createAppError(429, 'OTP_TOO_MANY_ATTEMPTS', 'Too many tries. Request a new code.'));
      return;
    }
    const valid = await argon2.verify(otp.code_hash, data.code);
    if (!valid) {
      await conn.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
      next(createAppError(400, 'OTP_INVALID', 'That code is not right.'));
      return;
    }

    // A brand-new number becomes a client, and a client never types their
    // name: it comes from MTN / Airtel, or is made up — a placeholder while
    // no network keys are configured (modules/nameLookup).
    // Looked up BEFORE the transaction — with retries across two networks
    // it can take seconds, and a transaction must not sit open on a
    // phone company's API.
    let lookedUpName: string | null = null;
    if (!data.full_name?.trim()) {
      const known = await conn.query(
        `SELECT 1 FROM platform_admins WHERE phone = $1
         UNION ALL SELECT 1 FROM staff_users WHERE phone = $1
         UNION ALL SELECT 1 FROM clients WHERE phone = $1
         LIMIT 1`,
        [phone]
      );
      if (known.rows.length === 0) {
        const result = await newClientName(phone);
        lookedUpName = result.name;
        console.log(`[NAME] new client name from ${result.source}`, result.attempts);
      }
    }

    await conn.query('BEGIN');
    // Conditional, so the same code used twice at once (a double-tap, made
    // likelier by the lookup above) can only sign in once.
    const consumed = await conn.query(
      'UPDATE otp_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id',
      [otp.id]
    );
    if (consumed.rows.length === 0) {
      await conn.query('ROLLBACK');
      next(createAppError(400, 'OTP_NOT_FOUND', 'That code was already used. Request a new one.'));
      return;
    }

    // ── Platform admin wins the number first — the most privileged tier ──
    const platformRow = (await conn.query(
      `SELECT id, full_name, status FROM platform_admins WHERE phone = $1 LIMIT 1`,
      [phone]
    )).rows[0];

    if (platformRow) {
      if (platformRow.status !== 'active') {
        await conn.query('ROLLBACK');
        next(createAppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended'));
        return;
      }

      const tokenPayload = { sub: platformRow.id, type: 'platform' as const };
      const accessToken = signAccessToken(tokenPayload);
      const refreshToken = signRefreshToken(tokenPayload);
      const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await conn.query(
        'INSERT INTO refresh_tokens (owner_type, owner_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)',
        ['platform', platformRow.id, tokenHash, expiresAt]
      );
      // See the staff branch below: a phone-code sign-in proves identity,
      // and there is no password to change, so the old flag is cleared.
      await conn.query(
        'UPDATE platform_admins SET must_change_password = false, last_login_at = now() WHERE id = $1',
        [platformRow.id]
      );

      await conn.query('COMMIT');
      res.json({
        ok: true,
        data: {
          account_type: 'platform',
          role: 'sysadmin',
          access_token: accessToken,
          refresh_token: refreshToken,
          full_name: platformRow.full_name,
          phone_display: displayUgPhone(phone),
        },
      });
      return;
    }

    // ── Staff wins the number next, if it has it ──────────────────────
    const staffRow = (await conn.query(
      `SELECT id, org_id, branch_id, role, full_name, status
         FROM staff_users WHERE phone = $1 LIMIT 1`,
      [phone]
    )).rows[0];

    if (staffRow) {
      if (staffRow.status !== 'active') {
        await conn.query('ROLLBACK');
        next(createAppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended'));
        return;
      }

      const tokenPayload = {
        sub: staffRow.id, type: 'staff' as const,
        role: staffRow.role, org_id: staffRow.org_id, branch_id: staffRow.branch_id,
      };
      const accessToken = signAccessToken(tokenPayload);
      const refreshToken = signRefreshToken(tokenPayload);
      const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await conn.query(
        'INSERT INTO refresh_tokens (owner_type, owner_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)',
        ['staff', staffRow.id, tokenHash, expiresAt]
      );
      // Sign-in is phone + one-time code only; nothing in the app can change
      // a password. Accounts seeded or created under the old password flow
      // still carried must_change_password = true, and the auth gate then
      // answered 403 PASSWORD_CHANGE_REQUIRED to almost every staff request
      // with no way out. Proving the phone is the identity check now, so a
      // successful code sign-in clears the flag.
      await conn.query(
        'UPDATE staff_users SET must_change_password = false, last_login_at = now() WHERE id = $1',
        [staffRow.id]
      );

      await conn.query('COMMIT');
      res.json({
        ok: true,
        data: {
          account_type: 'staff',
          role: staffRow.role,
          access_token: accessToken,
          refresh_token: refreshToken,
          full_name: staffRow.full_name,
          phone_display: displayUgPhone(phone),
        },
      });
      return;
    }

    // ── Otherwise, a client — existing or new ────────────────────────
    let row = (await conn.query(
      `SELECT id, org_id, full_name FROM clients WHERE phone = $1 LIMIT 1`,
      [phone]
    )).rows[0];
    // Told to the app so it can show the new account (and the name it was
    // given) before going in; a returning client goes straight to home.
    const isNew = !row;

    if (!row) {
      // Which organisation does a brand-new customer belong to?
      //
      // Nothing in a sign-up says: they type a phone number, and that is all.
      // This used to be `LIMIT 1` with no ORDER BY, so Postgres returned
      // whichever active org it felt like — in practice the SECOND one. Every
      // new customer landed in an org with no staff, and the moment a worker
      // scanned their code the wash was refused with WRONG_ORG, which the app
      // showed as "that code has expired". The code was fine; the customer was
      // in the wrong tenant.
      //
      // Until customers pick a branch at sign-up, the oldest active org is the
      // stable answer — it is the real one on a single-tenant deployment, and
      // deterministic on any other, which an unordered LIMIT 1 never was.
      const orgResult = await conn.query(
        "SELECT id FROM organizations WHERE status = 'active' ORDER BY created_at ASC LIMIT 1"
      );
      if (orgResult.rows.length === 0) {
        await conn.query('ROLLBACK');
        next(createAppError(500, 'NO_ORG', 'No active organization found'));
        return;
      }
      const orgId = orgResult.rows[0].id;
      const local = phone.replace('+256', '0');

      // Looked up before the transaction (see above). The generated
      // fallback covers the one case it wasn't: the number was claimed by
      // someone else between that check and here.
      const resolvedName = data.full_name?.trim() || lookedUpName || generatedName();

      row = (await conn.query(
        `INSERT INTO clients
           (org_id, full_name, phone, phone_verified,
            username, email, email_verified, password_hash)
         VALUES ($1, $2, $3, true, $4, $5, false, NULL)
         RETURNING id, org_id, full_name`,
        [orgId, resolvedName, phone, `u${local}`, `${local}@phone.local`]
      )).rows[0];
    } else {
      await conn.query(
        `UPDATE clients SET phone_verified = true, updated_at = now() WHERE id = $1`,
        [row.id]
      );
    }

    const tokenPayload = { sub: row.id, type: 'client' as const, org_id: row.org_id };
    const accessToken = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken(tokenPayload);
    const tokenHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await conn.query(
      'INSERT INTO refresh_tokens (owner_type, owner_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)',
      ['client', row.id, tokenHash, expiresAt]
    );

    await conn.query('COMMIT');
    res.json({
      ok: true,
      data: {
        account_type: 'client',
        is_new: isNew,
        access_token: accessToken,
        refresh_token: refreshToken,
        full_name: row.full_name,
        phone: phone,
        phone_display: displayUgPhone(phone),
      },
    });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    conn.release();
  }
});

export default router;
