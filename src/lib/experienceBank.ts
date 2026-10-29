import { db } from '../data';

export type ExperienceKind = 'story' | 'opinion' | 'number' | 'hate' | 'moment' | 'daily';

export interface ExperienceItemInput {
  kind: ExperienceKind;
  text: string;
  tags?: string[];
  source?: string;
}

const KIND_TAGS: Record<ExperienceKind, string[]> = {
  story: ['story'],
  opinion: ['opinion'],
  number: ['number', 'proof'],
  hate: ['hate', 'niche'],
  moment: ['moment'],
  daily: ['daily', 'moment'],
};

export function normalizeTags(kind: ExperienceKind, tags?: string[]): string[] {
  const base = KIND_TAGS[kind] ?? [kind];
  const extra = (tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...base, ...extra])];
}

export async function insertExperienceItem(userId: string, input: ExperienceItemInput) {
  const text = input.text.trim();
  if (!text) return null;
  return db.insert('experience_items', {
    user_id: userId,
    kind: input.kind,
    text,
    tags: normalizeTags(input.kind, input.tags),
    source: input.source ?? 'manual',
  });
}

/** Replace all onboarding-sourced items of the given kinds, then insert fresh ones. */
export async function replaceOnboardingBank(
  userId: string,
  items: ExperienceItemInput[],
  kinds: ExperienceKind[] = ['story', 'opinion', 'number', 'hate'],
) {
  await db.remove(
    'experience_items',
    (r) => r.user_id === userId && kinds.includes(r.kind) && (r.source === 'onboarding' || !r.source),
  );
  const created = [];
  for (const item of items) {
    const row = await insertExperienceItem(userId, { ...item, source: 'onboarding' });
    if (row) created.push(row);
  }
  return created;
}

export async function searchExperienceItems(userId: string, opts: { q?: string; kind?: string; tag?: string; limit?: number } = {}) {
  const q = (opts.q ?? '').trim().toLowerCase();
  const kind = opts.kind?.trim().toLowerCase();
  const tag = opts.tag?.trim().toLowerCase();
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  let rows = await db.all('experience_items', (r) => r.user_id === userId);
  if (kind) rows = rows.filter((r) => r.kind === kind);
  if (tag) rows = rows.filter((r) => Array.isArray(r.tags) && r.tags.includes(tag));
  if (q) {
    rows = rows.filter(
      (r) =>
        String(r.text ?? '')
          .toLowerCase()
          .includes(q) ||
        (Array.isArray(r.tags) && r.tags.some((t: string) => String(t).toLowerCase().includes(q))),
    );
  }
  return rows
    .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
    .slice(0, limit);
}

export async function bankSummaryForPrompt(userId: string, maxItems = 40): Promise<{
  stories: string[];
  opinions: string[];
  numbers: string[];
  hates: string[];
  recentMoments: string[];
}> {
  const all = await db.all('experience_items', (r) => r.user_id === userId);
  const take = (kind: ExperienceKind, n: number) =>
    all
      .filter((r) => r.kind === kind)
      .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
      .slice(0, n)
      .map((r) => String(r.text));

  return {
    stories: take('story', maxItems),
    opinions: take('opinion', maxItems),
    numbers: take('number', maxItems),
    hates: take('hate', maxItems),
    recentMoments: [...take('moment', 10), ...take('daily', 10)].slice(0, 12),
  };
}

export function chipsToItems(
  chips: unknown,
  kind: ExperienceKind,
  tags?: string[],
): ExperienceItemInput[] {
  if (!Array.isArray(chips)) return [];
  return chips
    .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    .map((text) => ({ kind, text: text.trim(), tags }));
}
