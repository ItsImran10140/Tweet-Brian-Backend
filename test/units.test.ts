import test from 'node:test';
import assert from 'node:assert/strict';
import { planTypes } from '../src/lib/generateTweets';
import { scoreThinking, scoreVoice } from '../src/lib/scoring';
import { validateTweet } from '../src/lib/validateTweet';
import { buildClusters } from '../src/digest/rank';
import { safetyCheck } from '../src/digest/safety';
import { makeItem, parseFeed } from '../src/digest/sources/feed';
import { canonicalUrl, overlapsShingles, shingleHashes, trimAtBoundary } from '../src/digest/text';

test('planTypes splits N tweets and swaps stories when none exist', () => {
  assert.equal(planTypes(10, true).length, 10);
  assert.equal(planTypes(10, true).filter((t) => t === 'story').length, 2);
  assert.equal(planTypes(10, false).filter((t) => t === 'story').length, 0);
});

test('scoring handles reverse keys and A/B', () => {
  const t = scoreThinking([{ id: 'a', text: '', dimension: 'x', direction: '+' }, { id: 'b', text: '', dimension: 'x', direction: '-' }], { a: 5, b: 1 });
  assert.equal(t.x.score, 5);
  const v = scoreVoice([{ id: 'v', axis: 'f', a_is_high: true, a: '', b: '' }], { v: 'A' });
  assert.equal(v.f.score, 5);
});

test('validateTweet blocks banned words, hashtags and long text', () => {
  const ctx = { bannedWords: ['synergy'], offLimitsTopics: [], usesHashtags: false, referenceSamples: [] };
  assert.equal(validateTweet('Great synergy here', ctx).ok, false);
  assert.equal(validateTweet('Nice #tag', ctx).ok, false);
  assert.equal(validateTweet('x'.repeat(281), ctx).ok, false);
  assert.equal(validateTweet('Short and fine.', ctx).ok, true);
});

test('trimAtBoundary cuts at a sentence boundary', () => {
  const t = trimAtBoundary('First sentence is here. Second sentence is also here. Third one runs on and on.', 60);
  assert.ok(t.endsWith('.'));
  assert.ok(t.length <= 61);
});

test('parseFeed reads RSS and Atom', () => {
  const rss = '<rss><channel><item><title>Model X ships</title><link>https://a.com/x</link><pubDate>Mon, 05 Oct 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Hello world&lt;/p&gt;</description></item></channel></rss>';
  const atom = '<feed><entry><title>v1.2.0</title><link rel="alternate" href="https://github.com/o/r/releases/tag/v1.2.0"/><updated>2026-10-05T10:00:00Z</updated><content type="html">&lt;p&gt;Fixes&lt;/p&gt;</content></entry></feed>';
  const a = parseFeed(rss);
  assert.equal(a[0].title, 'Model X ships');
  assert.equal(a[0].text, 'Hello world');
  assert.equal(parseFeed(atom)[0].url, 'https://github.com/o/r/releases/tag/v1.2.0');
  assert.throws(() => parseFeed('<html><body>not a feed</body></html>'));
});

test('canonicalUrl strips tracking junk', () => {
  assert.equal(canonicalUrl('https://www.a.com/p/?utm_source=x&id=2#top'), 'https://a.com/p/?id=2');
});

test('clusters merge duplicates and apply trust tiers', () => {
  const mk = (kind: any, tier: any, title: string, url: string) => makeItem({ niche: 't', kind, source_name: new URL(url).hostname, tier, title, url, text: '', published: new Date().toISOString() });
  const cl = buildClusters(
    [
      mk('feed', 1, 'OpenAI releases new reasoning model for developers', 'https://openai.com/a'),
      mk('search', 3, 'OpenAI releases new reasoning model for developers today', 'https://news.example/b'),
      mk('search', 3, 'Totally unrelated rumor about a startup', 'https://blog.example/c'),
    ],
    { maxAgeHours: 48 },
  );
  assert.equal(cl.length, 2);
  const merged = cl.find((c) => c.items.length === 2)!;
  assert.equal(merged.confirmed, true);
  assert.equal(merged.best_tier, 1);
  const lone = cl.find((c) => c.items.length === 1)!;
  assert.equal(lone.confirmed, false); // a single web-search result is not a fact
});

test('shingles detect copied wording without storing the text', () => {
  const src = 'the quick brown fox jumps over the lazy dog near the river bank today';
  const sh = shingleHashes(src, 6);
  assert.equal(overlapsShingles('Look: the quick brown fox jumps over it', sh, 6), true);
  assert.equal(overlapsShingles('A fox leaped across a sleepy hound', sh, 6), false);
});

test('safety gate blocks invented experience, stray numbers, accusations and copied text', () => {
  const ctx = { digestText: 'Acme released Model 5 with a 2x speedup', digestShingles: shingleHashes('Acme released Model 5 with a 2x speedup in its latest update', 6), profileText: '{}' };
  assert.equal(safetyCheck('I tested Model 5 for a week and it is fast.', ctx).ok, false);
  assert.equal(safetyCheck('Model 5 is 47% faster than anything else.', ctx).ok, false);
  assert.equal(safetyCheck('Acme is lying about everything.', ctx).ok, false);
  assert.equal(safetyCheck('Acme released Model 5 with a 2x speedup in its latest.', ctx).ok, false);
  assert.equal(safetyCheck('A 2x jump means the bottleneck moves to your own code.', ctx).ok, true);
});
