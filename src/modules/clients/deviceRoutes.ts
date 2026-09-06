import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getPool } from '@/db';
import { createAppError } from '@/middleware/errorHandler';

const router = Router();

const registerDeviceSchema = z.object({
  push_token: z.string().min(1),
  platform: z.enum(['ios', 'android']),
});

/**
 * POST /me/device
 * Register or reassign push token for the current user
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data = registerDeviceSchema.parse(req.body);
    const pool = getPool();
    const actor = req.actor!;

    // Determine owner type
    const ownerType = actor.type === 'client' ? 'client' : 'staff';

    // Upsert: delete any existing device with same push_token, then insert
    // This handles the case where the push token was previously registered to another user
    await pool.query('DELETE FROM devices WHERE push_token = $1', [data.push_token]);

    // Also delete any existing device for this user (one device per user at a time)
    await pool.query(
      'DELETE FROM devices WHERE owner_type = $1 AND owner_id = $2',
      [ownerType, actor.sub]
    );

    // Insert new device
    await pool.query(
      `INSERT INTO devices (owner_type, owner_id, push_token, platform, last_seen_at)
       VALUES ($1, $2, $3, $4, now())`,
      [ownerType, actor.sub, data.push_token, data.platform]
    );

    res.json({
      ok: true,
      data: { message: 'Device registered successfully' },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
