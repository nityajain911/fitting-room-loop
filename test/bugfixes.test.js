// Regression tests for bugs found in a full code review. Each one failed before its fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../server/store.js';
import { createApp } from '../server/index.js';
import { makeConfig } from '../shared/config.js';
import { ruleBasedReason, ruleBasedCustomer } from '../shared/parser.js';
import { computeMetrics } from '../shared/metrics.js';
import { makeLog } from './helpers.js';

async function boot() {
  let clock = 1_000_000;
  const store = createStore({ now: () => clock });
  const { app } = createApp({ store, llm: null, config: makeConfig(), now: () => clock });
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { call, close: () => server.close() };
}
const onTheWay = async (s, room = 1) => {
  const r = (await s.call('POST', '/api/requests', { room, skuId: 'OX-M-SLIM', issue: 'too_tight', chips: ['waist'] })).body.requestId;
  await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' });
  await s.call('POST', `/api/requests/${r}/confirm`, { role: 'runner' });
  return r;
};

// ---------- what can still be done once the items are with the customer ----------
test('the items cannot be handed over once the customer has declined them', async (t) => {
  const s = await boot(); t.after(s.close);
  const r = await onTheWay(s);
  assert.equal((await s.call('POST', `/api/requests/${r}/decline-item`)).status, 200);
  assert.equal((await s.call('POST', `/api/requests/${r}/deliver`, { role: 'runner' })).status, 409);
});

test('after the hand-over: no floor pull can be asked for, and nothing can be reported "not on rack"', async (t) => {
  const s = await boot(); t.after(s.close);
  const r = await onTheWay(s);
  const events = async () => (await s.call('GET', '/api/events?since=0')).body.events;
  await s.call('POST', `/api/requests/${r}/deliver`, { role: 'runner' });
  assert.equal((await s.call('POST', `/api/requests/${r}/floor-pull`, { role: 'runner' })).status, 409);
  const item = (await events()).filter((e) => e.type === 'on_the_way').pop().payload.items[0].itemId;
  assert.equal((await s.call('POST', `/api/requests/${r}/next-best`, { cause: 'not_on_rack', role: 'runner', itemId: item })).status, 409);
  assert.ok(!(await events()).some((e) => e.type === 'inventory_discrepancy'), 'the customer still has the items: nothing is withdrawn');
});

test('a body that is too large is a client error, not a server error', async (t) => {
  const s = await boot(); t.after(s.close);
  const res = await s.call('POST', '/api/requests', { room: 1, skuId: 'OX-M-SLIM', issue: 'too_tight', text: 'x'.repeat(20_000) });
  assert.equal(res.status, 413);
});

// ---------- reading what an associate typed ----------
test('"come back later" is a plan to return, not a time constraint; "late" on its own still is one', () => {
  assert.equal(ruleBasedReason('Customer will come back later').reason_tag, 'will_return');
  assert.equal(ruleBasedReason('Running late for a flight').reason_tag, 'time_constraint');
  assert.equal(ruleBasedReason('has to leave, already late').reason_tag, 'time_constraint');
});

test('"arrange" and "orange" are not the word for colour; "rang" and "colour" are', () => {
  assert.notEqual(ruleBasedReason('Needs time to arrange funds').reason_tag, 'colour_unavailable');
  assert.equal(ruleBasedReason('wanted a different colour').reason_tag, 'colour_unavailable');
  assert.equal(ruleBasedReason('ye rang nahi chahiye').reason_tag, 'colour_unavailable');
});

test('Devanagari words are read (the range is written as code points, not literal marks)', () => {
  const r = ruleBasedCustomer('कमर टाइट है');
  assert.deepEqual([r.primary_area, r.primary_issue], ['waist', 'tight']);
});

// ---------- the event file ----------
test('a torn last line in the event file does not swallow the next event', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frl-store-'));
  const file = path.join(dir, 'events.jsonl');
  const first = createStore({ file });
  first.append({ requestId: 'r1', type: 'created', payload: { room: 1 } });
  fs.appendFileSync(file, '{"seq":2,"id":"e2","ts":5,"requestId":"r1","ty'); // the process died mid-write
  const second = createStore({ file });
  assert.equal(second.all().length, 1);
  second.append({ requestId: 'r1', type: 'routed', payload: {} });
  const third = createStore({ file });
  assert.deepEqual(third.all().map((e) => [e.seq, e.type]), [[1, 'created'], [2, 'routed']]);
});

// ---------- the dashboard ----------
test('the heatmap keeps the women\'s range apart from the men\'s of the same garment and cut', () => {
  const { events, add } = makeLog();
  const ask = (id, sku) => {
    add(0, id, 'created', { room: 1, skuId: sku, issue: 'too_tight', issues: ['too_tight'], chips: ['waist'], parsed: null, method: 'none' }, 'customer');
  };
  ask('a', 'OX-M-SLIM');   // men's Oxford shirt, Slim
  ask('b', 'WX-M-SLIM');   // women's Oxford shirt, Slim
  const rows = computeMetrics(events).heatmap.rows.map((r) => r.label).sort();
  assert.deepEqual(rows, ["Oxford Shirt · Slim", "Women's Oxford Shirt · Slim"]);
});

// ---------- the Admin timing form while fast timers are on ----------
test('settings carry the saved times beside the effective ones, so fast timers cannot be saved by accident', async (t) => {
  let clock = 1_000_000;
  const store = createStore({ now: () => clock });
  const { app } = createApp({ store, llm: null, config: makeConfig(), now: () => clock, demoControls: true });
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
  await post('/api/demo', { fastTimers: true });
  const cfg = await fetch(`${base}/api/config`).then((r) => r.json());
  assert.equal(cfg.config.acceptEscalateSeconds, 20);                 // what the clocks use while fast timers are on
  assert.deepEqual(cfg.saved, { acceptEscalateSeconds: 120, deliverEscalateSeconds: 120, primaryWaitSeconds: 20, secondaryWaitSeconds: 20, roomSessionMinutes: 30 });
});
