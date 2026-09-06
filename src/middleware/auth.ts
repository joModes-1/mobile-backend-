import { Request, Response, NextFunction } from 'express';
import { verifyToken, JwtPayload } from '@/utils/jwt';
import { createAppError } from '@/middleware/errorHandler';

// Extend Express Request to include actor info
declare global {
  namespace Express {
    interface Request {
      actor?: JwtPayload;
    }
  }
}

/**
 * Middleware to verify JWT access token and attach actor to request.
 */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next(createAppError(401, 'UNAUTHORIZED', 'Missing or invalid authorization header'));
    return;
  }

  const token = authHeader.slice(7);
  
  try {
    const payload = verifyToken(token);
    req.actor = payload;
    next();
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      next(createAppError(401, 'TOKEN_EXPIRED', 'Access token has expired'));
    } else {
      next(createAppError(401, 'INVALID_TOKEN', 'Invalid access token'));
    }
  }
}
