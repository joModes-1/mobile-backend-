import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';

const router = Router();

const TOKEN_TTL_MS = 3 * 60 * 1000; // 3 minutes

/**
 * Issue a raw token and return its sha256 hash.
 * The raw token goes to the client (QR); only the hash is stored.
 */
function issueTokenPair() {
  const raw = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

/**
 * POST /me/washes/start-token
 * Client taps "Start wash" → issues a one-time start token (TTL 3 min).
 * Rate limit: 5 per 10 min per client.
 */
router.post('/start-token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.actor || req.actor.type !== 'client') {
      next(createAppError(403, 'FORBIDDEN', 'Client access required'));
      return;
    }

    const pool = getPool();
    const clientId = req.actor.sub;
    const now = new Date();

    // Rate limit: 5 start tokens in last 10 minutes
    const rl = await pool.query(
      `SELECT COUNT(*) as cnt FROM client_tokens
       WHERE client_id = $1 AND purpose = 'start'
       AND created_at > now() - interval '10 minutes'`,
      [clientId]
    );
    if (parseInt(rl.rows[0].cnt) >= 5) {
      next(createAppError(429, 'RATE_LIMITED', 'Too many start tokens. Wait a few minutes.'));
      return;
    }

    const { raw, hash } = issueTokenPair();
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);

    await pool.query(
      `INSERT INTO client_tokens (client_id, purpose, token_hash, expires_at)
       VALUES ($1, 'start', $2, $3)`,
      [clientId, hash, expiresAt]
    );

    res.status(201).json({
      ok: true,
      data: {
        token: raw,
        expires_at: expiresAt.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /me/washes/:id/pay-token
 * Client taps "Pay now" → issues a pay token bound to this wash.
 * Wash must be `ready` and belong to the caller, else 422.
 */
router.post('/:id/pay-token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.actor || req.actor.type !== 'client') {
      next(createAppError(403, 'FORBIDDEN', 'Client access required'));
      return;
    }

    const pool = getPool();
    const clientId = req.actor.sub;
    const { id: washId } = req.params;

    // Verify the wash belongs to this client and is ready
    const washResult = await pool.query(
      `SELECT id, client_id, status FROM washes WHERE id = $1`,
      [washId]
    );

    if (washResult.rows.length === 0) {
      next(createAppError(404, 'NOT_FOUND', 'Wash not found'));
      return;
    }

    const wash = washResult.rows[0];

    if (wash.client_id !== clientId) {
      next(createAppError(403, 'FORBIDDEN', 'This wash does not belong to you'));
      return;
    }

    if (wash.status !== 'ready') {
      next(createAppError(422, 'BAD_STATE', `Wash is ${wash.status}, not ready for payment`));
      return;
    }

    const { raw, hash } = issueTokenPair();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    await pool.query(
      `INSERT INTO client_tokens (client_id, purpose, wash_id, token_hash, expires_at)
       VALUES ($1, 'pay', $2, $3, $4)`,
      [clientId, washId, hash, expiresAt]
    );

    res.status(201).json({
      ok: true,
      data: {
        token: raw,
        expires_at: expiresAt.toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Consume a token — exported for use by wash start and settlement.
 * Conditional UPDATE; two concurrent calls, exactly one wins.
 */
export async function consumeToken(
  pool: any,
  tokenHash: string,
  purpose: string,
  workerId: string
): Promise<{ client_id: string; wash_id: string | null } | null> {
  const result = await pool.query(
    `UPDATE client_tokens SET consumed_at = now(), consumed_by = $1
     WHERE token_hash = $2 AND purpose = $3 AND consumed_at IS NULL AND expires_at > now()
     RETURNING client_id, wash_id`,
    [workerId, tokenHash, purpose]
  );
  return result.rows.length > 0 ? result.rows[0] : null;
}

/**
 * Hash a raw token string (for external callers).
 */
export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export default router;
