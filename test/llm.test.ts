import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Fake Gemini + OpenRouter servers, so the real request/response code is exercised without any key or internet.
const seen: { gemini: any[]; openrouter: any[] } = { gemini: [], openrouter: [] };
let geminiMode: 'ok' | 'quota' = 'ok';

function serve(handler: (req: http.IncomingMessage, body: any, res: http.ServerResponse) => void) {
  return new Promise<http.Server>((resolve) => {
    const s = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => handler(req, raw ? JSON.parse(raw) : {}, res));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const send = (res: http.ServerResponse, status: number, obj: unknown) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
};

test('gemini main provider, openrouter fallback', async () => {
  const gem = await serve((req, body, res) => {
    seen.gemini.push({ url: req.url, key: req.headers['x-goog-api-key'], body });
    if (geminiMode === 'quota') return send(res, 429, { error: { message: 'quota exceeded' } });
    send(res, 200, { candidates: [{ content: { parts: [{ thought: true, text: 'thinking...' }, { text: '[{"text":"hello from gemini","type":"opinion"}]' }] } }] });
  });
  const orr = await serve((req, body, res) => {
    seen.openrouter.push({ url: req.url, auth: req.headers.authorization, body });
    send(res, 200, { choices: [{ message: { content: '```json\n[{"text":"hello from openrouter","type":"lesson"}]\n```' } }] });
  });
  process.env.CONFIG_FILE = '/nonexistent.yml';
  process.env.LLM_PROVIDER = 'gemini';
  process.env.LLM_FALLBACK_PROVIDER = 'openrouter';
  process.env.GEMINI_API_KEY = 'gem-key';
  process.env.GEMINI_MODEL = 'gemini-3.5-flash-lite';
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${(gem.address() as AddressInfo).port}`;
  process.env.OPENROUTER_API_KEY = 'or-key';
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(orr.address() as AddressInfo).port}/api/v1`;
  process.env.DATA_FILE = `./data/test-${process.pid}.json`;

  const { llmJson, llmInfo, llmPing } = await import('../src/lib/llm');
  const { z } = await import('zod');
  const schema = z.array(z.object({ text: z.string(), type: z.string() }));

  assert.deepEqual(llmInfo().order.map((o) => o.provider), ['gemini', 'openrouter']);

  // 1) Gemini works: thought parts are dropped, JSON mode requested, key sent as header
  const a = await llmJson({ kind: 'generate', brain: 'BRAIN', system: 'SYS', user: 'write' }, schema);
  assert.equal(a[0].text, 'hello from gemini');
  assert.equal(seen.gemini[0].url, '/v1beta/models/gemini-3.5-flash-lite:generateContent');
  assert.equal(seen.gemini[0].key, 'gem-key');
  assert.equal(seen.gemini[0].body.generationConfig.responseMimeType, 'application/json');
  assert.match(seen.gemini[0].body.systemInstruction.parts[0].text, /BRAIN[\s\S]*SYS/);
  assert.equal(seen.openrouter.length, 0);

  // 2) Gemini hits its quota -> OpenRouter answers automatically
  geminiMode = 'quota';
  const b = await llmJson({ kind: 'generate', brain: 'BRAIN', user: 'write' }, schema);
  assert.equal(b[0].text, 'hello from openrouter');
  assert.equal(seen.openrouter[0].url, '/api/v1/chat/completions');
  assert.equal(seen.openrouter[0].auth, 'Bearer or-key');
  assert.equal(seen.openrouter[0].body.model, 'openrouter/free');
  assert.equal(seen.openrouter[0].body.messages[0].role, 'system');

  // 3) ping reports each provider separately
  const ping: any = await llmPing();
  assert.equal(ping.results.find((r: any) => r.provider === 'gemini').ok, false);
  assert.equal(ping.results.find((r: any) => r.provider === 'openrouter').ok, true);

  gem.close();
  orr.close();
});
