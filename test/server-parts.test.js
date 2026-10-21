import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';
import { makeLlm } from '../server/llm.js';
import { parseCustomerText } from '../shared/parser.js';

const okResponse = (content) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) });
const goodJson = JSON.stringify({
  primary_area: 'waist', primary_issue: 'tight', secondary_area: 'sleeves', secondary_issue: 'long',
  summary_en: 'Waist tight, sleeves long', evidence_type: 'customer-stated', confidence: 0.9,
});

test('makeLlm returns null without an API key', () => {
  assert.equal(makeLlm({}), null);
});

test('makeLlm calls the OpenAI-compatible endpoint with configured model and base URL', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return okResponse(goodJson); };
  const llm = makeLlm({ CEREBRAS_API_KEY: 'k', CEREBRAS_MODEL: 'my-model', CEREBRAS_BASE_URL: 'https://example.test/v1/' }, fetchImpl);
  const out = await llm('customer', 'kamar tight');
  assert.equal(seen.url, 'https://example.test/v1/chat/completions');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, 'my-model');
  assert.equal(body.temperature, 0);
  assert.equal(seen.init.headers.Authorization, 'Bearer k');
  assert.equal(out.method, 'ai:my-model');
  const parsed = await parseCustomerText('kamar tight', llm);
  assert.equal(parsed.method, 'ai:my-model');
});

test('think-tags are stripped before validation', async () => {
  const llm = makeLlm({ CEREBRAS_API_KEY: 'k' }, async () => okResponse(`<think>{not json}</think>${goodJson}`));
  const parsed = await parseCustomerText('x', llm);
  assert.equal(parsed.fields.primary_area, 'waist');
});

test('HTTP error and empty content fall back to rules', async () => {
  const text = 'kamar pe tight hai, sleeves thodi lambi';
  const http500 = makeLlm({ CEREBRAS_API_KEY: 'k' }, async () => ({ ok: false, status: 500, json: async () => ({}) }));
  assert.equal((await parseCustomerText(text, http500)).method, 'rule_fallback');
  const empty = makeLlm({ CEREBRAS_API_KEY: 'k' }, async () => okResponse('   '));
  assert.equal((await parseCustomerText(text, empty)).method, 'rule_fallback');
  const junk = makeLlm({ CEREBRAS_API_KEY: 'k' }, async () => okResponse('Sorry, I cannot help with that.'));
  assert.equal((await parseCustomerText(text, junk)).method, 'rule_fallback');
});

test('429 puts the adapter into cooldown: later calls skip the network and fall back', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: false, status: 429, headers: { get: () => '60' }, json: async () => ({}) }; };
  const llm = makeLlm({ CEREBRAS_API_KEY: 'k' }, fetchImpl);
  const text = 'kamar pe tight hai, sleeves thodi lambi';
  assert.equal((await parseCustomerText(text, llm)).method, 'rule_fallback');
  assert.equal((await parseCustomerText(text, llm)).method, 'rule_fallback');
  assert.equal(calls, 1);
});

test('reason prompt defines the tags (time constraint beats alteration when time is the reason)', async () => {
  let sent;
  const fetchImpl = async (_u, init) => { sent = JSON.parse(init.body); return okResponse('{}'); };
  await makeLlm({ CEREBRAS_API_KEY: 'k' }, fetchImpl)('reason', 'x');
  assert.match(sent.messages[0].content, /time_constraint: .*cannot wait/);
});

test('timeout aborts the call and falls back', async () => {
  const hang = (_url, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const llm = makeLlm({ CEREBRAS_API_KEY: 'k', LLM_TIMEOUT_MS: '30' }, hang);
  const t0 = Date.now();
  const out = await parseCustomerText('kamar tight', llm);
  assert.equal(out.method, 'rule_fallback');
  assert.ok(Date.now() - t0 < 2000);
});

test('store: seq/id/ts assigned by server, since cursor, persistence, reset', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'frl-')), 'events.jsonl');
  let t = 100;
  const s = createStore({ file, now: () => t });
  const e1 = s.append({ requestId: 'a', type: 'created', payload: { x: 1 } });
  t = 200;
  const e2 = s.append({ requestId: 'a', type: 'routed' });
  assert.deepEqual([e1.seq, e2.seq, e1.ts, e2.ts], [1, 2, 100, 200]);
  assert.deepEqual(s.since(1).map((e) => e.seq), [2]);

  const reloaded = createStore({ file });
  assert.equal(reloaded.all().length, 2);
  assert.equal(reloaded.epoch, s.epoch);
  assert.equal(reloaded.append({ requestId: 'b', type: 'created' }).seq, 3);

  const oldEpoch = reloaded.epoch;
  reloaded.reset();
  assert.equal(reloaded.all().length, 0);
  assert.notEqual(reloaded.epoch, oldEpoch);
  assert.equal(createStore({ file }).all().length, 0);
});
