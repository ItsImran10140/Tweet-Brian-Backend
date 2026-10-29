import { AppError } from '../../errors';
import { bankSummaryForPrompt } from '../experienceBank';

export type MaterialSourceKind = 'experience_bank' | 'newsletter' | 'reference_angle' | 'topic';

export interface MaterialItem {
  id: string;
  source: MaterialSourceKind;
  /** Short label for metadata / logs */
  label: string;
  /** What the drafter may use (facts / stories the user owns, or a structural angle only). */
  text: string;
  /** Optional digest item number when source is newsletter */
  digestIndex?: number;
  /** Optional reference handle when source is reference_angle (never copy their words) */
  referenceHandle?: string;
}

export interface MaterialPoolInput {
  userId: string;
  personaStories?: string[];
  hotTake?: string;
  topic?: string;
  digestItems: { n: number; headline: string; fact: string; sourceName?: string }[];
  referenceAngles: { handle: string; admireReason?: string; structurePatterns?: string[] }[];
}

/** Build a non-empty pool of concrete material; throw if nothing usable exists. */
export async function buildMaterialPool(input: MaterialPoolInput): Promise<MaterialItem[]> {
  const bank = await bankSummaryForPrompt(input.userId);
  const items: MaterialItem[] = [];
  let i = 0;

  const pushBank = (kind: string, texts: string[]) => {
    for (const text of texts) {
      const t = text.trim();
      if (!t) continue;
      items.push({
        id: `bank-${kind}-${i++}`,
        source: 'experience_bank',
        label: `experience:${kind}`,
        text: t,
      });
    }
  };

  pushBank('story', [...(input.personaStories ?? []), ...bank.stories]);
  pushBank('opinion', bank.opinions);
  pushBank('number', bank.numbers);
  pushBank('moment', bank.recentMoments);
  if (input.hotTake?.trim()) {
    items.push({
      id: `bank-hottake-${i++}`,
      source: 'experience_bank',
      label: 'experience:hot_take',
      text: input.hotTake.trim(),
    });
  }

  for (const d of input.digestItems) {
    const take =
      bank.opinions[d.n % Math.max(bank.opinions.length, 1)] ||
      input.hotTake?.trim() ||
      'Add a clear personal reaction — what you would do differently, or what this changes for you.';
    items.push({
      id: `news-${d.n}`,
      source: 'newsletter',
      label: `newsletter:#${d.n}`,
      text: `NEWS FACT (paraphrase, do not copy): ${d.headline}. ${d.fact}\nUSER TAKE TO APPLY: ${take}`,
      digestIndex: d.n,
    });
  }

  for (const ref of input.referenceAngles) {
    const pattern = (ref.structurePatterns ?? [])[0] || 'reactive take plus personal angle';
    items.push({
      id: `ref-${ref.handle}-${i++}`,
      source: 'reference_angle',
      label: `reference_angle:@${ref.handle}`,
      text:
        `STRUCTURE ANGLE ONLY (never copy wording/facts/stories from @${ref.handle}):\n` +
        `Pattern to borrow: ${pattern}\n` +
        (ref.admireReason ? `Why the user admires them (tone hint): ${ref.admireReason}\n` : '') +
        `Fill the pattern with the user's own experience bank / numbers / opinions only.`,
      referenceHandle: ref.handle,
    });
  }

  if (input.topic?.trim()) {
    items.push({
      id: `topic-${i++}`,
      source: 'topic',
      label: 'topic',
      text: input.topic.trim(),
    });
  }

  if (items.length === 0) {
    throw new AppError(
      400,
      'no_material',
      'Nothing to write about yet.',
      'Add stories/opinions in onboarding, connect a niche digest, paste a topic, or add reference accounts — generation refuses empty ideas.',
    );
  }
  return items;
}

/** One unique-ish material item per draft slot; round-robin with light shuffle. */
export function pickMaterialForBatch(pool: MaterialItem[], count: number): MaterialItem[] {
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const out: MaterialItem[] = [];
  for (let i = 0; i < count; i++) {
    out.push(shuffled[i % shuffled.length]);
  }
  return out;
}
