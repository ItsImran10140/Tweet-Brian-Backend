import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { AppError } from '../errors';

/** Prefer live env so tests can set ADMIN_KEY after config first-load. */
function adminKey(): string | undefined {
  const fromEnv = process.env.ADMIN_KEY?.trim();
  if (fromEnv) return fromEnv;
  return config.adminKey || undefined;
}

/**
 * Require a configured ADMIN_KEY via x-admin-key header.
 * If ADMIN_KEY is unset, admin routes are closed (not open) — safer for multi-user / free-plan deploys.
 */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  try {
    const key = adminKey();
    if (!key) {
      throw new AppError(
        503,
        'admin_not_configured',
        'Admin routes are disabled until ADMIN_KEY is set.',
        'Set ADMIN_KEY in .env to a long random string, then send x-admin-key with that value.',
      );
    }
    if (req.header('x-admin-key') !== key) {
      throw new AppError(
        401,
        'admin_key_required',
        'Missing or wrong x-admin-key header.',
        'Send the value of ADMIN_KEY from your .env as the x-admin-key header.',
      );
    }
    next();
  } catch (e) {
    next(e);
  }
}
