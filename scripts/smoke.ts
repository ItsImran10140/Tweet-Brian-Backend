/**
 * Runs the WHOLE flow against the running server and prints a pass/fail line for each step.
 *   npm run dev     (terminal 1)
 *   npm run smoke   (terminal 2)
 * Uses a throw-away user with sample answers and a pasted reference account, so it works with no Twitter key.
 * With real LLM keys in config.yml it makes ~5 real LLM calls.
 */
import 'dotenv/config';
const BASE = (process.env.TB_URL ?? `http://localhost:${process.env.PORT ?? 3001}`).replace(/\/$/, '');
let userId = '';
let failed = 0;

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(userId ? { 'x-user-id': userId } : {}), ...(process.env.ADMIN_KEY ? { 'x-admin-key': process.env.ADMIN_KEY } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }).catch(() => null);
  if (!r) {
    console.error(`Cannot reach ${BASE}. Start the server first: npm run dev`);
    process.exit(1);
  }
  return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
}
async function step(name: string, fn: () => Promise<string | void>) {
  try {
    const note = await fn();
    console.log(`  PASS  ${name}${note ? `  (${note})` : ''}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e instanceof Error ? e.message : String(e)}`);
  }
}
function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

(async () => {
  console.log(`Smoke test against ${BASE}\n`);
  await step('health', async () => {
    const r = await call('GET', '/health');
    expect(r.status === 200, `status ${r.status}`);
    return `llm=${r.json.llm.mode}${r.json.llm.order?.length ? ' ' + r.json.llm.order.map((o: any) => o.provider + ':' + o.model).join(' -> ') : ''}`;
  });
  await step('llm test', async () => {
    const r = await call('GET', '/api/llm/test');
    expect(r.json.ok, `LLM check failed: ${JSON.stringify(r.json.results ?? r.json)}`);
    return r.json.mode === 'mock' ? 'mock mode' : r.json.results.map((x: any) => `${x.provider}:${x.ok ? 'ok' : 'FAILED'}`).join(' ');
  });
  await step('create user', async () => {
    const r = await call('POST', '/api/users', { daily_tweet_limit: 5 });
    expect(r.status === 201, JSON.stringify(r.json));
    userId = r.json.id;
  });
  await step('save onboarding answers', async () => {
    const persona = { q1: 'Founder building dev tools', q2: 'Honest builder', q3: 'indie hackers', q4: 'Most startups should not raise money', q5: 'I lost my first client because I replied late.', q6: 'politics', q7: 'synergy, leverage', q8: 'Very competitive', q9: 'AI and startups', q10: ['AI', 'Startups'] };
    const thinking = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`t${i + 1}`, [5, 2, 4, 3, 4, 2, 5, 1, 4, 5, 2, 4, 3, 4, 3][i]]));
    const voice = { v1: 'B', v2: 'B', v3: 'A', v4: 'neither', v5: 'A', v6: 'A', v7: 'A', v8: 'B' };
    const r = await call('PUT', '/api/onboarding/draft', { step: 'all', answers: { persona, thinking, voice, lenses: ['founder', 'economist'], samples: ['Shipping beats planning. Every time.', 'Nobody reads your roadmap.', 'Pricing is a product decision, not a spreadsheet one.'] } });
    expect(r.json.ready_to_synthesize, JSON.stringify(r.json));
  });
  await step('synthesize profile (LLM)', async () => {
    const r = await call('POST', '/api/onboarding/synthesize');
    expect(r.status === 200, JSON.stringify(r.json));
    return String(r.json.profile.summary).slice(0, 60) + '...';
  });
  let refId = '';
  await step('connect reference account (pasted tweets) + style analysis (LLM)', async () => {
    const r = await call('POST', '/api/references', { handle: 'IndieHackers', admire_reason: 'Short punchy lessons', text: 'Ship the ugly version this week and get real feedback fast\n---\nSimple pricing beats clever pricing. One plan. One price.\n---\nWhat is one thing you shipped this week?', analyze: true });
    expect(r.status === 201, JSON.stringify(r.json));
    refId = r.json.account.id;
    return `${r.json.account.tweets} tweets, style profile: ${r.json.account.has_style_profile}`;
  });
  await step('see the context sent to the LLM', async () => {
    const r = await call('GET', `/api/references/${refId}/context`);
    expect(r.json.context?.includes('<reference_style'), JSON.stringify(r.json));
    return `${r.json.chars} chars`;
  });
  await step('niche digest: dry run (no LLM, saves nothing)', async () => {
    const r = await call('POST', '/api/admin/digest/dry-run');
    expect(r.status === 200 && r.json.status === 'dry_run', JSON.stringify(r.json).slice(0, 300));
    const bad = (r.json.sources as any[]).filter((x) => !x.ok).length;
    return `collected ${r.json.collected}, confirmed ${r.json.confirmed}, ${bad} source(s) failed`;
  });
  await step('niche digest: build it (LLM)', async () => {
    const r = await call('POST', '/api/admin/digest/run');
    const out = Object.values(r.json)[0] as any;
    const run = out?.status ? out : r.json;
    // "empty" is acceptable here: with no internet or no feeds there is nothing new to summarize
    expect(r.status === 200 && ['ok', 'partial', 'empty'].includes(run.status), JSON.stringify(r.json).slice(0, 400));
    return `${run.status}, ${run.items_saved ?? 0} item(s) saved, parallel used ${run.parallel?.used ?? 0}/${run.parallel?.cap ?? '-'}`;
  });
  await step("read today's digest", async () => {
    const r = await call('GET', '/api/digest');
    expect(r.status === 200, JSON.stringify(r.json));
    return `${r.json.count} item(s)${r.json.items?.[0] ? `; first: "${String(r.json.items[0].headline).slice(0, 60)}"` : ''}`;
  });
  let tweetId = '';
  await step('generate tweets (LLM)', async () => {
    const r = await call('POST', '/api/tweets/generate', { count: 5 });
    expect(r.status === 201 && r.json.saved > 0, JSON.stringify(r.json).slice(0, 400));
    tweetId = r.json.tweets[0].id;
    return `saved ${r.json.saved}/${r.json.requested} (${r.json.news_tweets} news, ${r.json.evergreen_tweets} evergreen); first: "${String(r.json.tweets[0].text).slice(0, 70)}"`;
  });
  await step('like a tweet', async () => {
    const r = await call('POST', `/api/tweets/${tweetId}/like`);
    expect(r.status === 200, JSON.stringify(r.json));
  });
  await step('overview', async () => {
    const r = await call('GET', '/api/overview');
    expect(r.status === 200, JSON.stringify(r.json));
    return `${r.json.tweets.pending} pending, ${r.json.tweets.liked} liked`;
  });
  await call('DELETE', '/api/users/me');
  console.log(failed ? `\n${failed} step(s) failed.` : '\nAll steps passed. (The throw-away user was deleted.)');
  process.exit(failed ? 1 : 0);
})();
