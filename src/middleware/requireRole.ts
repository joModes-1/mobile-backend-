import { Request, Response, NextFunction } from 'express';
import { createAppError } from '@/middleware/errorHandler';

type Role = 'orgadmin' | 'manager' | 'worker';

/**
 * Middleware to restrict access to specific staff roles.
 * Must be used after authenticate middleware.
 */
export function requireRole(...allowedRoles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.actor || req.actor.type !== 'staff') {
      next(createAppError(403, 'FORBIDDEN', 'Staff access required'));
      return;
    }

    if (!req.actor.role || !allowedRoles.includes(req.actor.role as Role)) {
      next(createAppError(403, 'FORBIDDEN', 'Insufficient permissions'));
      return;
    }

    next();
  };
}

/**
 * Helper to extract org_id from JWT. Returns the org_id or throws 500 if missing.
 */
export function getOrgId(actor: { org_id?: string }): string {
  if (!actor.org_id) {
    throw createAppError(500, 'INTERNAL_ERROR', 'Missing org_id in token');
  }
  return actor.org_id;
}

/**
 * Helper to extract branch_id from JWT. Returns the branch_id or null.
 */
export function getBranchId(actor: { branch_id?: string }): string | null {
  return actor.branch_id || null;
}
