import { Router, Request, Response, NextFunction } from 'express';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';

const router = Router();

/**
 * GET /me/branches/resolve?code=NTD&org_id=<uuid>
 *
 * Turns a wall-mounted branch QR into the branch it names, so a client's app
 * can scope the rest of a self-service booking to it.
 *
 * The QR encodes org_id + code together, not the bare code: `code` is only
 * unique per organisation (see branches' own uniqueness check in
 * branchRoutes.ts), so a code alone is ambiguous across orgs. It does not
 * fall back to the calling client's own org_id — the QR itself is the source
 * of truth for which branch (and organisation) the client is physically
 * standing at, the same way a worker's scan of a customer's code is trusted
 * over anything already on the worker's own token.
 */
router.get('/resolve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.actor || req.actor.type !== 'client') {
      next(createAppError(403, 'FORBIDDEN', 'Client access required'));
      return;
    }

    const code = String(req.query.code || '').trim();
    const orgId = String(req.query.org_id || '').trim();
    if (!code || !orgId) {
      next(createAppError(400, 'VALIDATION_ERROR', 'code and org_id are required'));
      return;
    }

    const pool = getPool();
    const result = await pool.query(
      `SELECT id, name, code, status FROM branches WHERE org_id = $1 AND upper(code) = upper($2)`,
      [orgId, code]
    );

    if (result.rows.length === 0) {
      next(createAppError(404, 'BRANCH_NOT_FOUND', 'That branch code was not recognised'));
      return;
    }

    const branch = result.rows[0];
    if (branch.status !== 'active') {
      next(createAppError(409, 'BRANCH_INACTIVE', 'This branch is not currently accepting bookings'));
      return;
    }

    res.json({ ok: true, data: { id: branch.id, name: branch.name, code: branch.code } });
  } catch (err) {
    next(err);
  }
});

export default router;
