import { randomUUID } from 'node:crypto';
import { db, type Row } from '../data';
import type { RefAccountRow, StoredStyle, StoredTweet, SyncSource } from './types';

/**
 * Reference accounts live in `reference_accounts`, one row per (user, handle).
 * Everything goes through this module / src/data.
 */

const mine = (userId: string, id: string) => (r: Row) => r.id === id && r.user_id === userId;

export async function listAccounts(userId: string): Promise<RefAccountRow[]> {
  return (await db.all('reference_accounts', (r) => r.user_id === userId)) as RefAccountRow[];
}

export async function getAccount(userId: string, id: string): Promise<RefAccountRow | undefined> {
  return (await db.get('reference_accounts', mine(userId, id))) as RefAccountRow | undefined;
}

export async function findByHandle(userId: string, handle: string): Promise<RefAccountRow | undefined> {
  return (await db.get('reference_accounts', (r) => r.user_id === userId && String(r.handle).toLowerCase() === handle.toLowerCase())) as RefAccountRow | undefined;
}

export async function createAccount(
  userId: string,
  input: { handle: string; displayName?: string; preferredSource: SyncSource; admireReason?: string },
): Promise<RefAccountRow> {
  return (await db.insert('reference_accounts', {
    id: `acc_${randomUUID().slice(0, 8)}`,
    user_id: userId,
    handle: input.handle,
    display_name: input.displayName,
    preferred_source: input.preferredSource,
    admire_reason: input.admireReason ?? '',
    tweets: [],
    style: null,
  })) as RefAccountRow;
}

export async function updateAccount(userId: string, id: string, patch: Partial<RefAccountRow>): Promise<void> {
  await db.update('reference_accounts', mine(userId, id), patch);
}

export async function deleteAccount(userId: string, id: string): Promise<boolean> {
  return (await db.remove('reference_accounts', mine(userId, id))) > 0;
}

export function getTweets(acc: RefAccountRow): StoredTweet[] {
  return acc.tweets ?? [];
}

export function compareNewestFirst(a: StoredTweet, b: StoredTweet): number {
  const ta = a.createdAt ? Date.parse(a.createdAt) : NaN;
  const tb = b.createdAt ? Date.parse(b.createdAt) : NaN;
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return tb - ta;
  if (!Number.isNaN(ta)) return -1;
  if (!Number.isNaN(tb)) return 1;
  return Date.parse(b.addedAt) - Date.parse(a.addedAt);
}

/** Merge tweets into a list: duplicates (same normalized text) are skipped, but richer copies upgrade the stored one. */
export function mergeTweets(existing: StoredTweet[], incoming: StoredTweet[], maxStored: number): { merged: StoredTweet[]; added: number; updated: number } {
  const byKey = new Map(existing.map((t) => [t.key, t]));
  let added = 0;
  let updated = 0;
  for (const t of incoming) {
    const cur = byKey.get(t.key);
    if (!cur) {
      byKey.set(t.key, t);
      added++;
      continue;
    }
    let changed = false;
    if (!cur.tweetId && t.tweetId) {
      cur.tweetId = t.tweetId;
      changed = true;
    }
    if (!cur.createdAt && t.createdAt) {
      cur.createdAt = t.createdAt;
      changed = true;
    }
    const better = t.likeCount + t.retweetCount + t.replyCount + t.quoteCount > cur.likeCount + cur.retweetCount + cur.replyCount + cur.quoteCount;
    if (better) {
      cur.likeCount = t.likeCount;
      cur.retweetCount = t.retweetCount;
      cur.replyCount = t.replyCount;
      cur.quoteCount = t.quoteCount;
      changed = true;
    }
    if (changed) updated++;
  }
  const merged = [...byKey.values()].sort(compareNewestFirst).slice(0, maxStored);
  return { merged, added, updated };
}

export async function upsertTweets(userId: string, id: string, incoming: StoredTweet[], maxStored: number): Promise<{ added: number; updated: number; total: number }> {
  const acc = await getAccount(userId, id);
  if (!acc) return { added: 0, updated: 0, total: 0 };
  const { merged, added, updated } = mergeTweets(acc.tweets ?? [], incoming, maxStored);
  await db.update('reference_accounts', mine(userId, id), { tweets: merged });
  return { added, updated, total: merged.length };
}

export async function clearTweets(userId: string, id: string): Promise<void> {
  await db.update('reference_accounts', mine(userId, id), { tweets: [], style: null });
}

export async function saveStyle(userId: string, id: string, style: StoredStyle): Promise<void> {
  await db.update('reference_accounts', mine(userId, id), { style });
}

export type RefRow = RefAccountRow;
