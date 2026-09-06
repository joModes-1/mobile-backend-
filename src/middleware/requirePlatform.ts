import { Request, Response, NextFunction } from 'express';
import { createAppError } from '@/middleware/errorHandler';

/**
 * Middleware to restrict access to platform (sysadmin) tokens only.
 * Must be used after authenticate middleware.
 */
export function requirePlatform(req: Request, _res: Response, next: NextFunction): void {
  if (!req.actor || req.actor.type !== 'platform') {
    next(createAppError(403, 'FORBIDDEN', 'Platform access required'));
    return;
  }
  next();
}
