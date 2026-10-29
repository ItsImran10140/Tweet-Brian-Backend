// Pure functions. NO LLM. Scores are computed here; the LLM only interprets them.
import type { Big5Item, Questions } from './brain';

export type Confidence = 'high' | 'medium' | 'low';
export interface Scored { score: number; confidence: Confidence; answered: number; total: number }
export type VoiceAnswer = 'A' | 'B' | 'neither';

const r2 = (n: number) => Math.round(n * 100) / 100;
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const valid = (x: unknown): x is number => typeof x === 'number' && x >= 1 && x <= 5;

/** high: all answered AND varied responses; medium: 80%+ answered; else low */
export function confidenceOf(answered: number, total: number, varied: boolean): Confidence {
  if (total === 0 || answered === 0) return 'low';
  if (answered === total && varied) return 'high';
  if (answered / total >= 0.8) return 'medium';
  return 'low';
}

function scaleGroup(
  groups: Record<string, { id: string; reverse: boolean }[]>,
  answers: Record<string, number>,
): Record<string, Scored> {
  const out: Record<string, Scored> = {};
  for (const [name, items] of Object.entries(groups)) {
    const vals = items
      .filter((i) => valid(answers[i.id]))
      .map((i) => (i.reverse ? 6 - answers[i.id] : answers[i.id]));
    const raw = items.filter((i) => valid(answers[i.id])).map((i) => answers[i.id]);
    const varied = items.length < 2 || new Set(raw).size > 1;
    out[name] = {
      score: vals.length ? r2(mean(vals)) : 3,
      confidence: confidenceOf(vals.length, items.length, varied),
      answered: vals.length,
      total: items.length,
    };
  }
  return out;
}

export function scoreBig5(items: Big5Item[], answers: Record<string, number>): Record<string, Scored> {
  const groups: Record<string, { id: string; reverse: boolean }[]> = {};
  for (const i of items) (groups[i.trait] ??= []).push({ id: i.id, reverse: i.reverse });
  return scaleGroup(groups, answers);
}

export function scoreThinking(items: Questions['thinking'], answers: Record<string, number>): Record<string, Scored> {
  const groups: Record<string, { id: string; reverse: boolean }[]> = {};
  for (const i of items) (groups[i.dimension] ??= []).push({ id: i.id, reverse: i.direction === '-' });
  return scaleGroup(groups, answers);
}

/** A/B pair -> 1-5 axis. 'neither' moves nothing but counts as answered. */
export function scoreVoice(pairs: Questions['voice'], answers: Record<string, VoiceAnswer>): Record<string, Scored> {
  const byAxis: Record<string, Questions['voice']> = {};
  for (const p of pairs) (byAxis[p.axis] ??= []).push(p);
  const out: Record<string, Scored> = {};
  for (const [axis, ps] of Object.entries(byAxis)) {
    const moves: number[] = [];
    let answered = 0;
    for (const p of ps) {
      const a = answers[p.id];
      if (a !== 'A' && a !== 'B' && a !== 'neither') continue;
      answered++;
      if (a === 'neither') continue;
      const pickedHigh = (a === 'A') === p.a_is_high;
      moves.push(pickedHigh ? 1 : -1);
    }
    out[axis] = {
      score: moves.length ? r2(3 + 2 * mean(moves)) : 3,
      confidence: confidenceOf(answered, ps.length, moves.length > 0),
      answered,
      total: ps.length,
    };
  }
  return out;
}

export function computeAllScores(q: Questions, big5Items: Big5Item[], draft: any) {
  return {
    big5: scoreBig5(big5Items, draft.big5 ?? {}),
    thinkingStyle: scoreThinking(q.thinking, draft.thinking ?? {}),
    voice: scoreVoice(q.voice, draft.voice ?? {}),
  };
}

export const flat = (s: Record<string, Scored>) =>
  Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.score]));
