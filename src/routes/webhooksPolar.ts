import type { Request, Response, NextFunction } from 'express';
import { webhooks } from '@polar-sh/sdk/2026-10';
import { config } from '../config';
import { billing } from '../data';
import { applyPolarEvent } from '../lib/polarWebhooks';
import { log } from '../lib/safeLog';

/**
 * POST /webhooks/polar
 * Must receive the raw body via express.raw (registered before express.json in server.ts).
 * Signature verification uses Polar SDK webhooks.validateEvent — docs.polar.sh delivery guide.
 */
export async function polarWebhookHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const secret = config.polar.webhookSecret;
    if (!secret) {
      log('error', 'polar_webhook_secret_missing');
      res.status(503).send('');
      return;
    }

    // Raw body required before any JSON parse (Standard Webhooks / Polar HMAC).
    const rawBody = req.body;
    if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') {
      log('warn', 'polar_webhook_body_not_raw');
      res.status(400).send('');
      return;
    }

    const webhookId = req.header('webhook-id') ?? '';
    const webhookTimestamp = req.header('webhook-timestamp') ?? '';
    const webhookSignature = req.header('webhook-signature') ?? '';

    if (!webhookId || !webhookTimestamp || !webhookSignature) {
      res.status(403).send('');
      return;
    }

    let event: { type: string; data: unknown };
    try {
      event = (await webhooks.validateEvent(
        rawBody,
        {
          'webhook-id': webhookId,
          'webhook-timestamp': webhookTimestamp,
          'webhook-signature': webhookSignature,
        },
        secret,
      )) as { type: string; data: unknown };
    } catch (error) {
      if (error instanceof webhooks.PolarWebhookVerificationError) {
        res.status(403).send('');
        return;
      }
      if (error instanceof webhooks.PolarWebhookUnknownTypeError) {
        // Acknowledge unknown types so Polar does not retry forever
        res.status(202).send('');
        return;
      }
      throw error;
    }

    const claimed = await billing.claimWebhookEvent(webhookId, 'polar', event);
    if (!claimed) {
      // Duplicate delivery
      res.status(202).send('');
      return;
    }

    await applyPolarEvent(event.type, event.data);
    res.status(202).send('');
  } catch (err) {
    next(err);
  }
}
