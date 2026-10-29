export type SourceKind = 'feed' | 'hn' | 'github' | 'search';

/** One collected item. Only a short excerpt is kept, and it is purged after digest.raw_retention_hours. */
export interface RawItem {
  id: string; // sha1 of the canonical url
  niche: string;
  kind: SourceKind;
  source_name: string;
  /** 1 = official source, 2 = community signal (Hacker News), 3 = web search result */
  tier: 1 | 2 | 3;
  title: string;
  url: string;
  domain: string;
  excerpt: string;
  published_at: string | null;
  fetched_at: string;
  fetch_date: string;
  score?: number;
  /** hashed 6-word windows of the original text: lets the safety gate detect copied wording without keeping the text */
  shingles: string[];
}

export interface SourceReport {
  source: string;
  kind: SourceKind | 'parallel-budget';
  ok: boolean;
  items: number;
  error?: string;
  note?: string;
}

export interface Cluster {
  key: string;
  items: RawItem[];
  title: string;
  url: string;
  sources: { name: string; url: string; tier: number; kind: SourceKind; domain: string }[];
  best_tier: number;
  domains: number;
  confirmed: boolean;
  score: number;
  published_at: string | null;
  excerpt: string;
  shingles: string[];
}

export const CATEGORIES = ['model-release', 'tool-release', 'framework-update', 'funding', 'policy', 'research', 'security', 'industry', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];
