import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import pino from 'pino';

const logger = pino({ name: 'error-handler' });

interface AppError extends Error {
  statusCode?: number;
  code?: string;
  details?: unknown;
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  // Zod validation errors
  if (err instanceof ZodError) {
    res.status(400).json({
      ok: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.errors.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      },
    });
    return;
  }

  // Application errors
  const appErr = err as AppError;
  const statusCode = appErr.statusCode || 500;
  const code = appErr.code || 'INTERNAL_ERROR';
  const message = statusCode === 500 ? 'Internal server error' : appErr.message;

  if (statusCode === 500) {
    logger.error({ err, stack: err.stack }, 'Unhandled error');
  }

  res.status(statusCode).json({
    ok: false,
    error: {
      code,
      message,
      ...(appErr.details ? { details: appErr.details } : {}),
    },
  });
}

export function createAppError(statusCode: number, code: string, message: string, details?: unknown): AppError {
  const err = new Error(message) as AppError;
  err.statusCode = statusCode;
  err.code = code;
  err.details = details;
  return err;
}
