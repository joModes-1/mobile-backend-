import { Router, Request, Response, NextFunction } from 'express';
import { getPool } from '@/db';
import { authenticate } from '@/middleware/auth';
import { createAppError } from '@/middleware/errorHandler';

const router = Router();

/**
 * POST /auth/client/delete-account
 *
 * Required by both Apple (Guideline 5.1.1(v)) and Google Play for any app
 * that lets people create an account — an in-app way to delete it, not
 * just a support-email process.
 *
 * This anonymises rather than hard-deletes: `washes.client_id` and
 * `loyalty_ledger.client_id` have no ON DELETE CASCADE (deliberately —
 * wash and loyalty history is the organisation's operational and
 * financial record, not only the client's), so a real DELETE would either
 * fail outright on the foreign key or, if cascaded, destroy an org's wash
 * history because one customer asked to leave. Scrubbing every personally
 * identifying column while leaving the row (and the history that points
 * to it) in place satisfies "delete my data" without doing either.
 *
 * NOTE: this is the only route left in this file. The email/password client
 * auth surface (register, verify-email, login, request-password-reset,
 * reset-password, change-password) was removed — every role signs in with
 * phone + one-time code now, via `/auth/phone/*` in phoneAuth.ts.
 */
router.post('/delete-account', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  const pool = getPool();
  const conn = await pool.connect();
  try {
    if (!req.actor || req.actor.type !== 'client') {
      next(createAppError(403, 'FORBIDDEN', 'Client access required'));
      return;
    }

    const result = await conn.query('SELECT id, status FROM clients WHERE id = $1', [req.actor.sub]);
    if (result.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Client not found'));
      return;
    }
    if (result.rows[0].status === 'deleted') {
      // Already gone — treat a repeat call as success rather than an error.
      res.json({ ok: true, data: { message: 'Account already deleted' } });
      return;
    }

    await conn.query('BEGIN');

    // A unique, non-guessable placeholder per column, so the row still
    // satisfies (org_id, phone) / (org_id, lower(username)) / lower(email)
    // uniqueness without holding anything that identifies the person.
    const anon = req.actor.sub.replace(/-/g, '').slice(0, 12);
    await conn.query(
      `UPDATE clients SET
         full_name = 'Deleted user',
         phone = NULL,
         email = $2,
         username = $3,
         password_hash = NULL,
         phone_verified = false,
         email_verified = false,
         status = 'deleted',
         updated_at = now()
       WHERE id = $1`,
      [req.actor.sub, `deleted+${anon}@deleted.local`, `deleted_${anon}`]
    );

    await conn.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE owner_type = $1 AND owner_id = $2 AND revoked_at IS NULL',
      ['client', req.actor.sub]
    );

    await conn.query('COMMIT');
    res.json({ ok: true, data: { message: 'Account deleted' } });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    conn.release();
  }
});

export default router;
