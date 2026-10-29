import { config } from '../config';
import { AppError } from '../errors';
import { freeGeneration, usage } from '../data';
import {
  assertPaidDraftQuota,
  decideGenerationAccess,
  throwBlocked,
  utcToday,
  withGenerationLock,
} from './gates';
import { generateForUser } from './generateTweets';
import type { GenerateOptions } from './generation/types';
import { db } from '../data';

/**
 * Server-side generation with free-batch / paid entitlement rules.
 * Free: exactly one normal-sized batch; mark used only when drafts persist successfully.
 * Paid: daily draft quota + normal persist.
 */
export async function generateWithEntitlement(userId: string, opts: GenerateOptions = {}) {
  return withGenerationLock(userId, async () => {
    const access = await decideGenerationAccess(userId);
    if (access.mode === 'blocked') throwBlocked(access);

    const user = await db.get('users', (u) => u.id === userId);
    const batchSize = opts.count ?? user?.daily_tweet_limit ?? 10;

    if (access.mode === 'free') {
      // Generate in memory first — free_generation_used flips only inside the save transaction.
      const result = await generateForUser(userId, {
        ...opts,
        count: batchSize,
        persist: false,
      });

      if (!result.tweets?.length) {
        throw new AppError(
          422,
          'generation_failed',
          'No drafts survived validation. Your free batch was not used.',
          'Try again; nothing was consumed.',
        );
      }

      try {
        await freeGeneration.persistFreeBatch(userId, result.tweets);
      } catch (err) {
        // free_generation_used stays false when persist fails
        throw err;
      }

      return { ...result, free_batch: true, free_generation_used: true };
    }

    // Paid path
    await assertPaidDraftQuota(userId, batchSize);
    const result = await generateForUser(userId, { ...opts, count: batchSize, persist: true });
    if (result.tweets?.length) {
      await usage.incrementDailyUsage(userId, utcToday(), { drafts_generated: result.tweets.length });
    }
    return { ...result, free_batch: false };
  });
}

export function generationRateLimitMax(): number {
  return config.limits.generatePerHour;
}
