/**
 * Answer the Tweet Brain onboarding questions in your terminal (no UI needed).
 *
 *   npm run onboard
 *
 * The server must be running (npm run dev in another terminal). Your answers are saved after every section,
 * so you can press Ctrl+C and run it again later: it resumes where you stopped and keeps earlier answers.
 * Env: TB_URL (default http://localhost:3001)   TB_USER_ID (reuse an existing user id)
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const BASE = (process.env.TB_URL ?? `http://localhost:${process.env.PORT ?? 3001}`).replace(/\/$/, '');
const USER_FILE = path.join(__dirname, '..', '.tweet-brain-user');

const rl = readline.createInterface({ input: process.stdin });
const lines: string[] = [];
const waiters: ((l: string | null) => void)[] = [];
let closed = false;
rl.on('line', (l) => (waiters.length ? waiters.shift()!(l) : lines.push(l)));
rl.on('close', () => {
  closed = true;
  while (waiters.length) waiters.shift()!(null);
});
function ask(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    if (lines.length) return resolve(lines.shift()!.trim());
    if (closed) return resolve('');
    waiters.push((l) => resolve((l ?? '').trim()));
  });
}

async function api(method: string, p: string, userId?: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json', ...(userId ? { 'x-user-id': userId } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    console.error(`\nCannot reach ${BASE}. Start the server first:  npm run dev   (in another terminal)`);
    process.exit(1);
  }
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`\n${method} ${p} failed (${res.status}): ${json?.error?.message ?? JSON.stringify(json)}`);
    if (json?.error?.hint) console.error(`Hint: ${json.error.hint}`);
    process.exit(1);
  }
  return json;
}

const line = '-'.repeat(64);

async function main() {
  console.log(`\nTweet Brain onboarding  (server: ${BASE})\n${line}`);
  let userId = process.env.TB_USER_ID ?? (fs.existsSync(USER_FILE) ? fs.readFileSync(USER_FILE, 'utf8').trim() : '');
  if (userId) {
    const me = await fetch(`${BASE}/api/users/me`, { headers: { 'x-user-id': userId } }).catch(() => null);
    if (me && me.status === 401) userId = '';
  }
  if (!userId) {
    const handle = await ask('Your X (Twitter) handle, e.g. imran_builds (Enter to skip): ');
    const created = await api('POST', '/api/users', undefined, handle ? { twitter_handle: handle } : {});
    userId = created.id;
    fs.writeFileSync(USER_FILE, userId);
    console.log(`Created your user. id = ${userId}  (saved to .tweet-brain-user)`);
    console.log('Paste this id into the Postman collection variable "userId" if you want to use the same user there.\n');
  } else {
    console.log(`Using existing user ${userId}\n`);
  }

  const tpl = await api('GET', '/api/onboarding/template', userId);
  const draft = (await api('GET', '/api/onboarding/draft', userId)).answers ?? {};
  const questions = tpl.questions_by_id as Record<string, any>;
  const lensOptions: string[] = tpl.lens_options;

  // ---- 1. persona (free text) ----
  console.log(`PART 1 of 5: About you (free text). Press Enter to skip any question. Keep the real stories real: the app never invents biography.\n${line}`);
  const persona: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions).filter(([, q]) => q.step === 'persona')) {
    const prev = draft.persona?.[id];
    const hint = prev && !String(prev).includes('TYPE YOUR ANSWER') ? `  [saved: ${Array.isArray(prev) ? prev.join(', ') : String(prev).slice(0, 50)}... Enter keeps it]` : '';
    if (Array.isArray(tpl.body.answers.persona[id])) {
      const opts = (q.answer_with as string).replace(/^a list, any of: /, '');
      const options: string[] = JSON.parse(opts);
      console.log(`\n${id}. ${q.question}`);
      options.forEach((o, i) => console.log(`   ${i + 1}) ${o}`));
      const a = await ask('Numbers separated by commas, e.g. 1,2,5: ');
      if (a) persona[id] = a.split(',').map((n) => options[Number(n.trim()) - 1]).filter(Boolean);
      else if (prev) persona[id] = prev;
    } else {
      const a = await ask(`\n${id}. ${q.question}${hint}\n> `);
      if (a) persona[id] = a;
      else if (prev && !String(prev).includes('TYPE YOUR ANSWER')) persona[id] = prev;
      else persona[id] = '';
    }
  }
  await api('PUT', '/api/onboarding/draft', userId, { step: 'persona', answers: { persona } });
  console.log('Saved.\n');

  // ---- 2. thinking style (1-5) ----
  console.log(`PART 2 of 5: How you think. Rate each statement 1 (strongly disagree) to 5 (strongly agree). Enter = skip.\n${line}`);
  const thinking: Record<string, number | null> = {};
  for (const [id, q] of Object.entries(questions).filter(([, q]) => q.step === 'thinking')) {
    for (;;) {
      const a = await ask(`${id}. "${q.statement}"  [1-5]: `);
      if (a === '') { thinking[id] = draft.thinking?.[id] ?? null; break; }
      const n = Number(a);
      if (Number.isInteger(n) && n >= 1 && n <= 5) { thinking[id] = n; break; }
      console.log('   Please type a whole number from 1 to 5.');
    }
  }
  await api('PUT', '/api/onboarding/draft', userId, { step: 'thinking', answers: { thinking } });
  console.log('Saved.\n');

  // ---- 3. voice (A/B) ----
  console.log(`PART 3 of 5: Your voice. Which one sounds more like you? Type A, B, or N for neither.\n${line}`);
  const voice: Record<string, string | null> = {};
  for (const [id, q] of Object.entries(questions).filter(([, q]) => q.step === 'voice')) {
    console.log(`\n${id}.\n   A: ${q.A}\n   B: ${q.B}`);
    for (;;) {
      const a = (await ask('Your pick [A/B/N]: ')).toUpperCase();
      if (a === '') { voice[id] = draft.voice?.[id] ?? null; break; }
      if (a === 'A' || a === 'B') { voice[id] = a; break; }
      if (a === 'N') { voice[id] = 'neither'; break; }
      console.log('   Type A, B or N.');
    }
  }
  await api('PUT', '/api/onboarding/draft', userId, { step: 'voice', answers: { voice } });
  console.log('Saved.\n');

  // ---- 4. lenses ----
  console.log(`PART 4 of 5: Pick up to 2 lenses you think through.\n${line}`);
  lensOptions.forEach((o, i) => console.log(`   ${i + 1}) ${o}`));
  const l = await ask('Numbers, e.g. 3,5 (Enter to keep/skip): ');
  const lenses = l ? l.split(',').map((n) => lensOptions[Number(n.trim()) - 1]).filter(Boolean).slice(0, 2) : draft.lenses ?? [];
  await api('PUT', '/api/onboarding/draft', userId, { step: 'lenses', answers: { lenses } });
  console.log('Saved.\n');

  // ---- 5. samples ----
  console.log(`PART 5 of 5: Your own writing. Paste 3-10 of your past posts, one per line. Finish with an empty line.\n(Or type "fetch" to pull them from your X account if a Twitter key is in config.yml.)\n${line}`);
  const samples: string[] = [];
  for (;;) {
    const s = await ask(`post ${samples.length + 1}> `);
    if (s.toLowerCase() === 'fetch' && samples.length === 0) {
      const r = await api('POST', '/api/onboarding/own-tweets', userId, {});
      console.log(`Fetched ${r.fetched} tweets and saved ${r.samples_saved} as samples.`);
      samples.push(...r.samples);
      break;
    }
    if (!s) break;
    samples.push(s);
  }
  if (samples.length) await api('PUT', '/api/onboarding/draft', userId, { step: 'samples', answers: { samples } });
  console.log('Saved.\n');

  const status = await api('GET', '/api/onboarding/draft', userId);
  console.log(line);
  if (!status.ready_to_synthesize) {
    console.log('Not enough answers yet:\n - ' + status.missing.join('\n - ') + '\nRun npm run onboard again to finish.');
    return;
  }
  const go = await ask('Build your profile now? (calls the LLM) [Y/n]: ');
  if (go.toLowerCase() === 'n') return console.log('OK. Later: POST /api/onboarding/synthesize with header x-user-id: ' + userId);
  console.log('Working...');
  const out = await api('POST', '/api/onboarding/synthesize', userId);
  console.log(`\nDone. Your profile summary:\n${out.profile.summary}\n\nNext steps (Postman or curl, header x-user-id: ${userId}):\n  POST /api/references   connect Twitter accounts you admire\n  POST /api/admin/digest/run  build today's niche digest\n  POST /api/tweets/generate`);
}

main().finally(() => rl.close());
