/**
 * Smoke-test the multi-step generation pipeline in MOCK mode.
 *
 *   npx tsx scripts/test-pipeline.ts
 *   npx tsx scripts/test-pipeline.ts --single   # legacy path
 */
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';

const preferSingle = process.argv.includes('--single');

async function main() {
  const file = `./data/test-pipeline-${process.pid}.json`;
  process.env.CONFIG_FILE = '/nonexistent.yml';
  process.env.DATA_FILE = file;
  process.env.LLM_PROVIDER = 'mock';
  process.env.GEMINI_API_KEY = '';
  process.env.OPENROUTER_API_KEY = '';
  process.env.GENERATION_PIPELINE = preferSingle ? 'single' : 'multi';
  process.env.GENERATION_LOG_STAGES = 'true';
  process.env.GENERATION_LOG_DIR = './data/generation-logs';

  const { createApp } = await import('../src/server');
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, uid?: string) => {
    const r = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(uid ? { 'x-user-id': uid } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as any };
  };

  try {
    const u = (await call('POST', '/api/users', {})).json;
    const H = u.id as string;

    const samples = Array.from({ length: 12 }, (_, i) => `Shipped feature ${i}. Kept it short.`).join('\n\n');
    await call(
      'PUT',
      '/api/onboarding/draft',
      {
        step: 'persona',
        answers: {
          frontend_answers: {
            'p-1': 'I build tools for founders',
            'p-2': 'indie hackers',
            'p-3': ['ship faster'],
            'p-4': { beliefs: ['clarity over hype'] },
            'p-5': 'Most advice is noise',
            'p-6': { experiences: ['Lost a client after a late reply'] },
            'p-7': { authority: ['cold email'], learning: ['ads'] },
            'p-10': ['Hot takes', 'Build-in-public updates'],
            'ts-1': 4, 'ts-2': 4, 'ts-3': 3, 'ts-4': 4, 'ts-5': 3, 'ts-6': 4, 'ts-7': 3, 'ts-8': 4, 'ts-9': 3, 'ts-10': 4,
            'ab-directness': 'A', 'ab-structure': 'B', 'ab-humor': 'A', 'ab-vulnerability': 'B', 'ab-hook': 'A', 'ab-register': 'neither',
            'yv-samples': samples,
            'st-stories': { stories: ['Lost first client', 'Hit $1k MRR', 'Quit consulting', 'Shipped ugly MVP', 'Hired first contractor'] },
            'st-opinions': { opinions: ['Threads are overrated', 'Ship before polish', 'Pricing is a feature', 'Most newsletters are fluff', 'AI demos hide ops cost'] },
            'st-numbers': { numbers: ['12k followers', '$8k MRR', 'Next.js + Supabase'] },
            'st-hates': { hates: ['just ship it with no context', 'hustle porn', 'synergy'] },
          },
        },
      },
      H,
    );
    const syn = await call('POST', '/api/onboarding/synthesize', { questionnaire: [] }, H);
    if (syn.status !== 200) throw new Error(`synthesize failed: ${JSON.stringify(syn.json)}`);

    await call(
      'POST',
      '/api/references',
      {
        handle: 'IndieHackers',
        admire_reason: 'Clear hooks',
        tweets: Array.from({ length: 20 }, (_, i) => `Build in public tip ${i}: show the number.`),
        analyze: true,
      },
      H,
    );

    const pipeline = preferSingle ? 'single' : 'multi';
    const gen = await call('POST', '/api/tweets/generate', { count: 4, refresh_digest: false, pipeline }, H);
    console.log('pipeline:', gen.json.pipeline);
    console.log('status:', gen.status, 'saved:', gen.json.saved, 'requested:', gen.json.requested);
    if (gen.status !== 201) {
      console.error(gen.json);
      process.exitCode = 1;
      return;
    }

    if (pipeline === 'multi') {
      const tweets = gen.json.tweets ?? [];
      for (const t of tweets) {
        console.log('-', t.format_id, '|', t.material_source, '| score', t.style_match_score, '|', String(t.text).slice(0, 80));
      }
      const logFile = gen.json.stage_log?.log_file;
      console.log('stage_log file:', logFile);
      if (logFile && fs.existsSync(logFile)) {
        const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
        console.log('stage entries:', lines.length);
        console.log('stages:', [...new Set(lines.map((l) => JSON.parse(l).stage))].join(', '));
      }
      if (!tweets.some((t: any) => t.format_id) || !tweets.some((t: any) => t.material_source)) {
        console.error('Missing format/material metadata on saved tweets');
        process.exitCode = 1;
      }
    } else {
      console.log('legacy single-pass ok, tweets:', (gen.json.tweets ?? []).length);
    }
  } finally {
    server.close();
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
