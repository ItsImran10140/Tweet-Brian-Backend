import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Config is read once per process, so this scenario lives in its own file.
test('digest pipeline: budget cap stops Parallel and feeds still produce a digest; failures keep the old digest', async () => {
  const now = new Date();
  let parallelCalls = 0;
  let feedOk = true;
  const fake = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url === '/feed.xml') {
      if (!feedOk) {
        res.writeHead(500);
        return res.end('down');
      }
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      return res.end(`<rss><channel><item><title>Official release of Widget 3 with new plugin API</title><link>https://widgets.example/3</link><pubDate>${now.toUTCString()}</pubDate><description>Widget 3 adds a plugin API.</description></item></channel></rss>`);
    }
    if (url === '/p/v1/search') {
      parallelCalls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ results: [] }));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  const dataFile = `./data/test-digest2-${process.pid}.json`;
  const cfgFile = `./data/test-digest2-${process.pid}.yml`;
  fs.writeFileSync(
    cfgFile,
    `llm: { provider: mock, fallback_provider: none }
digest:
  timezone: UTC
  parallel: { api_key: k, base_url: "${base}/p", monthly_cap: 0 }
  niches:
    tech:
      feeds: [ { name: Widgets, url: "${base}/feed.xml" } ]
      hacker_news: { enabled: false }
      search: [ { queries: ["ai news"] } ]
`,
  );
  process.env.CONFIG_FILE = cfgFile;
  process.env.DATA_FILE = dataFile;
  process.env.ADMIN_KEY = '';
  process.env.PARALLEL_API_KEY = '';
  const { runDigest } = await import('../src/digest/pipeline');
  const { latestDigest } = await import('../src/digest/store');
  try {
    const first: any = await runDigest('tech', { trigger: 'manual' });
    assert.equal(parallelCalls, 0, 'cap of 0 means Parallel is never called');
    assert.ok(first.sources.some((s: any) => s.kind === 'parallel-budget'));
    assert.equal(first.items_saved, 1, 'feeds alone carry the digest');
    assert.equal((await latestDigest('tech')).items.length, 1);

    feedOk = false;
    const second: any = await runDigest('tech', { trigger: 'manual', now: new Date(Date.now() + 1000) });
    assert.equal(second.status, 'empty');
    assert.equal(second.kept_previous_digest, true);
    assert.equal((await latestDigest('tech')).items.length, 1, 'previous digest still served after a failed run');
  } finally {
    fake.close();
    for (const f of [dataFile, `${dataFile}.tmp`, cfgFile]) if (fs.existsSync(f)) fs.rmSync(f);
  }
});
