import { config } from '../../config';
import { collectFeed } from './feed';
import type { RawItem } from '../types';

/** Release notes straight from the project (Atom feed GitHub publishes for every repo). Tier 1. */
export async function collectGithubReleases(niche: string, repo: string, now = new Date()): Promise<RawItem[]> {
  const url = `${config.digest.githubBase.replace(/\/$/, '')}/${repo}/releases.atom`;
  const items = await collectFeed(niche, { url, name: repo, tier: 1 }, now);
  return items.slice(0, 3).map((i) => ({ ...i, kind: 'github' as const, title: i.title.toLowerCase().includes(repo.split('/')[1].toLowerCase()) ? i.title : `${repo} ${i.title}` }));
}
