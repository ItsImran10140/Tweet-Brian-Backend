import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config';

const root = path.join(ROOT, 'brain');

export function loadBrain(): { text: string; version: string } {
  const text = fs.readFileSync(path.join(root, 'brain-file.md'), 'utf8');
  const m = text.match(/^---\s*[\r\n]+([\s\S]*?)[\r\n]+---/);
  const v = m?.[1]?.match(/brain_version:\s*(.+)/)?.[1]?.trim() ?? 'unknown';
  return { text, version: v };
}

/** Reads bullets under the "## Banned AI phrases" heading */
export function bannedAiPhrases(): string[] {
  const { text } = loadBrain();
  const sec = text.split(/^## /m).find((s) => /^banned ai phrases/i.test(s));
  if (!sec) return [];
  return sec
    .split('\n')
    .filter((l) => l.trim().startsWith('- '))
    .map((l) => l.replace(/^\s*-\s*/, '').trim().toLowerCase());
}

/** Quick sanity check shown in /health so a wrong brain file is spotted immediately. */
export function brainStatus() {
  const { text, version } = loadBrain();
  const warnings: string[] = [];
  if (version === 'unknown') warnings.push('brain-file.md has no "brain_version:" line in its --- front matter.');
  if (bannedAiPhrases().length === 0) warnings.push('No bullets found under a "## Banned AI phrases" heading.');
  if (!/synthesis instructions/i.test(text)) warnings.push('No "Synthesis Instructions" section: onboarding synthesis may return the wrong JSON shape.');
  if (/PLACEHOLDER/i.test(text)) warnings.push('brain-file.md is still the PLACEHOLDER version. Replace it with your real brain file.');
  return { version, chars: text.length, bannedPhrases: bannedAiPhrases().length, warnings };
}

export interface Questions {
  persona: any[];
  thinking: { id: string; text: string; dimension: string; direction: '+' | '-' }[];
  voice: { id: string; axis: string; a_is_high: boolean; a: string; b: string }[];
  lenses: string[];
}
export function loadQuestions(): Questions {
  return JSON.parse(fs.readFileSync(path.join(root, 'questions.json'), 'utf8'));
}

export interface Big5Item {
  id: string;
  text: string;
  trait: string;
  reverse: boolean;
}
export function loadBig5(): Big5Item[] {
  return JSON.parse(fs.readFileSync(path.join(root, 'instruments', 'ipip-big5.json'), 'utf8')).items ?? [];
}
