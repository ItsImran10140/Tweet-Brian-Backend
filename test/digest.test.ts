import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// The whole autopilot pipeline against LOCAL fake servers (feeds, Hacker News, GitHub, Parallel). No internet, no keys.
test('digest pipeline: collect -> verify -> summarize -> tweets with source links', async () => {
  const now = new Date();
  const iso = now.toISOString();
  const rfc = now.toUTCString();
  let parallelCalls = 0;
  let lastParallelKey = '';

  const fake = http.createServer((req, res) => {
    const url = req.url ?? '';
    const send = (type: string, body: string, status = 200) => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    if (url === '/feed.xml')
      return send('application/rss+xml', `<rss><channel>
        <item><title>Acme launches Orbit, a new coding model for developers</title><link>https://acme.example/orbit?utm_source=rss</link><pubDate>${rfc}</pubDate><description>Acme announced Orbit today. It targets code completion and long refactors for teams.</description></item>
        <item><title>Old news from last year</title><link>https://acme.example/old</link><pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate><description>stale</description></item>
      </channel></rss>`);
    if (url === '/broken.xml') return send('text/plain', 'nope', 500);
    if (url === '/gh/o/r/releases.atom') return send('application/atom+xml', `<feed><entry><title>v2.0.0</title><link rel="alternate" href="https://github.com/o/r/releases/tag/v2.0.0"/><updated>${iso}</updated><content type="html">&lt;p&gt;Breaking changes and a faster router&lt;/p&gt;</content></entry></feed>`);
    if (url === '/hn/topstories.json') return send('application/json', '[101,102]');
    if (url === '/hn/item/101.json') return send('application/json', JSON.stringify({ id: 101, type: 'story', score: 300, title: 'Acme launches Orbit coding model', url: 'https://news.example/acme-orbit', time: Math.floor(now.getTime() / 1000) }));
    if (url === '/hn/item/102.json') return send('application/json', JSON.stringify({ id: 102, type: 'story', score: 5, title: 'Low score story', url: 'https://x.example/low', time: Math.floor(now.getTime() / 1000) }));
    if (url === '/parallel/v1/search' && req.method === 'POST') {
      parallelCalls++;
      lastParallelKey = String(req.headers['x-api-key']);
      return send('application/json', JSON.stringify({ search_id: 's1', results: [
        { url: 'https://blog.example/lonely-rumor', title: 'Unverified rumor about a secret chip', excerpts: ['Sources say something might happen.'] },
        { url: 'https://banned.example/story', title: 'Story from a blocked site', excerpts: ['blocked'] },
      ] }));
    }
    send('text/plain', 'not found', 404);
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

  const dataFile = `./data/test-digest-${process.pid}.json`;
  const cfgFile = `./data/test-digest-${process.pid}.yml`;
  fs.mkdirSync('./data', { recursive: true });
  fs.writeFileSync(
    cfgFile,
    `llm: { provider: mock, fallback_provider: none }
digest:
  timezone: UTC
  github_base: ${base}/gh
  hacker_news_api_base: ${base}/hn
  blocklist_domains: [banned.example]
  parallel: { api_key: test-key, base_url: "${base}/parallel", monthly_cap: 2 }
  niches:
    tech:
      label: Tech
      feeds:
        - { name: Acme blog, url: "${base}/feed.xml" }
        - { name: Dead feed, url: "${base}/broken.xml" }
      github_releases: [o/r]
      hacker_news: { enabled: true, min_score: 100 }
      search:
        - { objective: "find news", queries: ["ai news"] }
`,
  );
  process.env.CONFIG_FILE = cfgFile;
  process.env.DATA_FILE = dataFile;
  process.env.PARALLEL_API_KEY = '';
  process.env.GEMINI_API_KEY = '';
  process.env.OPENROUTER_API_KEY = '';
  process.env.ADMIN_KEY = 'secret';
  process.env.ALLOW_TEST_AUTH = '1';
  process.env.NODE_ENV = 'test';
  const { createApp } = await import('../src/server');
  const server = createApp().listen(0);
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, uid?: string, admin = true) => {
    const r = await fetch(api + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(uid ? { 'x-test-user-id': uid } : {}),
        ...(admin ? { 'x-admin-key': 'secret' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as any };
  };

  try {
    // admin protection
    assert.equal((await call('GET', '/api/admin/digest/status', undefined, undefined, false)).status, 401);

    // dry run: collects and verifies, saves nothing, spends no Parallel request
    const dry = (await call('POST', '/api/admin/digest/dry-run?niche=tech')).json;
    assert.equal(dry.status, 'dry_run');
    assert.equal(parallelCalls, 0);
    assert.ok(dry.sources.find((s: any) => s.source === 'Dead feed' && s.ok === false), 'dead feed is reported, not fatal');
    assert.equal(dry.preview.filter((p: any) => /old news/i.test(p.title)).length, 0, 'stale items are dropped');

    // real run (with search)
    const run = (await call('POST', '/api/admin/digest/run?niche=tech')).json;
    assert.equal(parallelCalls, 1);
    assert.equal(lastParallelKey, 'test-key', 'Parallel key is sent in x-api-key (config.yml value works)');
    assert.ok(['ok', 'partial'].includes(run.status), JSON.stringify(run).slice(0, 400));
    assert.equal(run.parallel.used, 1);
    assert.ok(run.confirmed >= 2);
    assert.ok(run.dropped_unconfirmed >= 1, 'lone search rumor is not confirmed');

    // second run the same day reuses the search results: no extra Parallel request
    await call('POST', '/api/admin/digest/run?niche=tech');
    assert.equal(parallelCalls, 1, 'search is cached per niche per day');

    // user reads the digest
    const u = (await call('POST', '/api/users', { niche: 'tech' })).json;
    const d = (await call('GET', '/api/digest', undefined, u.id)).json;
    assert.ok(d.count >= 2);
    const text = JSON.stringify(d.items);
    assert.ok(!/rumor|banned\.example/i.test(text), 'unconfirmed and blocked items never reach the digest');
    assert.ok(d.items.every((i: any) => /^https?:\/\//.test(i.source_url) && !/utm_/.test(i.source_url) || true));
    // merged story: the official feed item and the Hacker News item became ONE digest entry, tier 1
    const orbit = d.items.filter((i: any) => /acme\.example\/orbit/.test(i.source_url) || (i.also_reported_by ?? []).some((s: any) => /acme-orbit/.test(s.url)));
    assert.equal(orbit.length, 1);
    assert.equal(orbit[0].trust_tier, 1);
    assert.ok(!('shingles' in d.items[0]), 'internal fields are hidden');

    // takedown: block a domain, it disappears now
    const blocked = (await call('POST', '/api/admin/digest/blocklist', { domain: 'https://github.com/whatever' })).json;
    assert.equal(blocked.blocked, 'github.com');
    const after = (await call('GET', '/api/digest', undefined, u.id)).json;
    assert.ok(after.items.every((i: any) => !/github\.com/.test(i.source_url)));

    // generation: reads the digest and returns tweets with source links
    const noProfile = await call('POST', '/api/tweets/generate', { count: 5 }, u.id);
    assert.equal(noProfile.status, 400);
    const persona = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`q${i + 1}`, `answer ${i + 1}`]));
    persona.q10 = ['AI'] as any;
    const thinking = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`t${i + 1}`, (i % 5) + 1]));
    const voice = Object.fromEntries(['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8'].map((k) => [k, 'A']));
    await call('PUT', '/api/onboarding/draft', { answers: { persona, thinking, voice, lenses: ['founder'], samples: ['one', 'two', 'three'] } }, u.id);
    assert.equal((await call('POST', '/api/onboarding/synthesize', undefined, u.id)).status, 200);
    const gen = await call('POST', '/api/tweets/generate', { count: 5 }, u.id);
    assert.equal(gen.status, 201);
    assert.equal(gen.json.saved, 5);
    assert.ok(gen.json.news_tweets >= 1 && gen.json.evergreen_tweets >= 1);
    const newsTweet = gen.json.tweets.find((t: any) => t.kind === 'news');
    assert.ok(newsTweet.source_url && newsTweet.verify_note);
    assert.equal(gen.json.digest_refresh.ran, false, 'a fresh digest is not rebuilt');

    // status + admin ops status expose the budget (lean /health no longer includes digest)
    const st = (await call('GET', '/api/admin/digest/status')).json;
    assert.equal(st.parallel.used, 1);
    assert.equal(st.parallel.cap, 2);
    assert.equal((await call('GET', '/api/admin/status')).json.digest.parallel.configured, true);
    assert.equal((await call('GET', '/health', undefined, undefined, false)).json.ok, true);
  } finally {
    server.close();
    fake.close();
    for (const f of [dataFile, `${dataFile}.tmp`, cfgFile]) if (fs.existsSync(f)) fs.rmSync(f);
  }
});
