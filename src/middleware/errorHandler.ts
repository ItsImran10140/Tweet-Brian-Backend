import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../errors';
import { log } from '../lib/safeLog';

/** Express 404 fallback. */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: 'not_found',
      message: 'Route not found.',
      hint: 'Open GET / for a list of starting points.',
    },
  });
}

/**
 * Central error handler. Structured logs never include tokens/secrets.
 * Clients never receive raw stack traces or secret-bearing messages.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string | undefined)?.slice(0, 64);
  const path = req.originalUrl?.split('?')[0] ?? req.path;
  const method = req.method;
  const userId = (req as { userId?: string }).userId;

  if (err instanceof AppError) {
    if (err.status === 500) {
      log('error', err.message, { code: err.code, status: err.status, path, method, userId, requestId, details: err.details });
    } else if (err.status !== 401 && err.status !== 404) {
      log('warn', err.message, { code: err.code, status: err.status, path, method, userId, requestId });
    }
    res.status(err.status).json({
      error: { code: err.code, message: err.message, hint: err.hint, details: err.details },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation',
        message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      },
    });
    return;
  }

  if (err instanceof SyntaxError && 'body' in (err as object)) {
    res.status(400).json({
      error: {
        code: 'invalid_json',
        message: 'Request body is not valid JSON.',
        hint: 'In Postman choose Body > raw > JSON and check for trailing commas or smart quotes.',
      },
    });
    return;
  }

  log('error', 'unhandled_error', {
    path,
    method,
    userId,
    requestId,
    err,
  });

  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'Unexpected error',
      hint: 'Retry once. If it keeps failing, check server logs (secrets are redacted).',
    },
  });
}
