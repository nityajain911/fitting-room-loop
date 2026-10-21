import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/store.js';
import { createApp } from '../server/index.js';
import { makeConfig } from '../shared/config.js';
import { deriveAll, customerSteps } from '../shared/derive.js';
import { buildQueue } from '../shared/routing.js';
import { computeMetrics } from '../shared/metrics.js';

async function boot(opts = {}) {
  let clock = opts.clock ?? 1_000_000;
  const store = createStore({ now: () => clock });
  const { app, sweep } = createApp({ store, llm: null, config: makeConfig(), now: () => clock, ...opts });
  const server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const events = async () => (await call('GET', '/api/events?since=0')).body.events;
  return { call, events, advance: (ms) => { clock += ms; }, sweep, store, close: () => server.close() };
}

test('demo script runs end to end (no API key -> rule-based fallback)', async (t) => {
  const s = await boot();
  t.after(s.close);

  // 1. Customer: Room 2 -> Oxford L Slim -> too tight + Hinglish text
  const created = await s.call('POST', '/api/requests', {
    room: 2, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [], text: 'kamar pe tight hai, sleeves thodi lambi',
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.method, 'rule_fallback');
  const r1 = created.body.requestId;
  let ev = await s.events();
  const createdEv = ev.find((e) => e.type === 'created');
  assert.equal(createdEv.payload.parsed.primary_area, 'waist');
  assert.equal(createdEv.payload.parsed.secondary_area, 'sleeves');
  assert.ok(!JSON.stringify(ev).includes('kamar pe tight'), 'raw text must not be stored');

  // 2. Runner phone: request in queue, accept
  s.advance(8000);
  assert.deepEqual(buildQueue('runner', deriveAll(ev), 0).map((x) => x.id), [r1]);
  assert.equal((await s.call('POST', `/api/requests/${r1}/accept`, { role: 'runner' })).status, 200);
  ev = await s.events();
  assert.equal(customerSteps(deriveAll(ev).byId[r1])[1].label, 'Accepted (checking stock…)');

  // 3. Suggestion = Regular M, confirm & bring, floor pull, close bought_alternative
  const sug = ev.find((e) => e.type === 'suggestion_shown').payload;
  assert.equal(sug.kind, 'alternative');
  assert.equal(sug.itemId, 'OX-M-REG');
  assert.equal((await s.call('POST', `/api/requests/${r1}/confirm`, {})).status, 200);
  ev = await s.events();
  assert.match(customerSteps(deriveAll(ev).byId[r1])[2].label, /^On the way to Room 2 \(bringing Oxford Shirt/);
  const pull = await s.call('POST', `/api/requests/${r1}/floor-pull`, {});
  assert.equal(pull.status, 200);
  ev = await s.events();
  assert.deepEqual(buildQueue('floor', deriveAll(ev), 0).map((x) => x.id), [pull.body.taskId]);
  assert.equal((await s.call('POST', `/api/tasks/${pull.body.taskId}/accept`)).status, 200);
  assert.equal((await s.call('POST', `/api/tasks/${pull.body.taskId}/done`)).status, 200);
  s.advance(20000);
  assert.equal((await s.call('POST', `/api/requests/${r1}/close`, { outcome: 'bought_alternative' })).status, 200);
  assert.equal(computeMetrics(await s.events()).saveRate, 1);

  // 4. Second request: chinos 32, too long -> hemming message -> left -> reason
  const second = await s.call('POST', '/api/requests', { room: 4, skuId: 'CH-32-SLIM', issue: 'too_long', chips: [] });
  const r2 = second.body.requestId;
  assert.equal(second.body.method, 'none');
  await s.call('POST', `/api/requests/${r2}/accept`, { role: 'runner' });
  ev = await s.events();
  const sug2 = ev.filter((e) => e.type === 'suggestion_shown' && e.requestId === r2)[0].payload;
  assert.equal(sug2.kind, 'alteration_or_crossstore');
  assert.match(sug2.reason, /hemming/);
  assert.equal((await s.call('POST', `/api/requests/${r2}/confirm`, {})).status, 409);
  await s.call('POST', `/api/requests/${r2}/close`, { outcome: 'left' });
  const parsed = await s.call('POST', `/api/parse/reason`, { text: 'Customer travelling tonight, cannot wait for alteration' });
  assert.equal(parsed.body.fields.evidence_type, 'customer-stated');
  assert.equal(parsed.body.fields.reason_tag, 'time_constraint');
  assert.ok(!(await s.events()).some((e) => e.type === 'reason_added'), 'parsing alone logs nothing');
  const add = await s.call('POST', `/api/requests/${r2}/reason`, { ...parsed.body.fields, method: parsed.body.method, edited: false });
  assert.equal(add.status, 200);

  // 5. Dashboard numbers come from the log
  ev = await s.events();
  const m = computeMetrics(ev);
  assert.equal(m.saveRate, 0.5);
  assert.equal(m.closed, 2);
  assert.equal(m.outcomeMix.bought_alternative, 1);
  assert.equal(m.outcomeMix.left, 1);
  assert.equal(m.medianAcceptMs, 4000); // r1 accepted after 8s, r2 after 0s
  assert.deepEqual(m.reasons.byEvidence['customer-stated'], [{ tag: 'time_constraint', count: 1 }]);
  const types = new Set(ev.map((e) => e.type));
  for (const t of ['created', 'routed', 'accepted', 'suggestion_shown', 'suggestion_confirmed', 'on_the_way',
    'floor_pull_requested', 'floor_pull_done', 'closed', 'reason_added']) assert.ok(types.has(t), `timeline has ${t}`);
});

test('state guards return 409/400/404', async (t) => {
  const s = await boot();
  t.after(s.close);
  const { body: { requestId: r } } = await s.call('POST', '/api/requests', { room: 1, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [] });
  assert.equal((await s.call('POST', `/api/requests/${r}/confirm`, {})).status, 409); // before accept
  assert.equal((await s.call('POST', `/api/requests/${r}/close`, { outcome: 'left' })).status, 409); // before accept
  assert.equal((await s.call('POST', `/api/requests/${r}/accept`, { role: 'floor' })).status, 400); // wrong queue
  assert.equal((await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' })).status, 200);
  assert.equal((await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' })).status, 409); // twice
  assert.equal((await s.call('POST', `/api/requests/${r}/close`, { outcome: 'nonsense' })).status, 400);
  assert.equal((await s.call('POST', `/api/requests/${r}/close`, { outcome: 'left' })).status, 200);
  assert.equal((await s.call('POST', `/api/requests/${r}/close`, { outcome: 'left' })).status, 409); // twice
  assert.equal((await s.call('POST', `/api/requests/nope/accept`, { role: 'runner' })).status, 404);
  assert.equal((await s.call('POST', '/api/requests', { room: 1, skuId: 'X', issue: 'too_tight' })).status, 400);
  assert.equal((await s.call('POST', '/api/requests', { room: 1, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: ['knees'] })).status, 400);
  assert.equal((await s.call('POST', `/api/requests/${r}/reason`, { reason_tag: 'price', summary_en: 'x', evidence_type: 'unknown', confidence: 1, method: 'made-up' })).status, 400);
});

test('stock-check requests go to the floor queue and floor can accept them', async (t) => {
  const s = await boot({ catalogue: SMALL_CATALOGUE });
  t.after(s.close);
  const { body: { requestId: r } } = await s.call('POST', '/api/requests', { room: 3, skuId: 'OX-L-SLIM', issue: 'check_stock', chips: [] });
  assert.equal((await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' })).status, 400);
  assert.equal((await s.call('POST', `/api/requests/${r}/accept`, { role: 'floor' })).status, 200);
  const sug = (await s.events()).find((e) => e.type === 'suggestion_shown').payload;
  assert.equal(sug.kind, 'stock_check');
  assert.equal((await s.call('POST', `/api/requests/${r}/confirm`, { itemId: 'OX-XL-REG' })).status, 200);
});

test('escalation sweep appends exactly one escalated event past the threshold', async (t) => {
  const s = await boot();
  t.after(s.close);
  await s.call('POST', '/api/requests', { room: 1, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [] });
  s.advance(119_000);
  s.sweep();
  assert.equal(computeMetrics(await s.events()).escalations, 0);
  s.advance(2_000);
  s.sweep();
  s.sweep();
  const ev = await s.events();
  assert.equal(ev.filter((e) => e.type === 'escalated').length, 1);
  assert.equal(computeMetrics(ev).escalations, 1);
});

test('reset clears the log and changes the epoch', async (t) => {
  const s = await boot();
  t.after(s.close);
  await s.call('POST', '/api/requests', { room: 1, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [] });
  const before = (await s.call('GET', '/api/events?since=0')).body;
  assert.ok(before.events.length > 0);
  await s.call('POST', '/api/reset');
  const after = (await s.call('GET', '/api/events?since=0')).body;
  assert.equal(after.events.length, 0);
  assert.notEqual(after.epoch, before.epoch);
});

test('since cursor returns only newer events', async (t) => {
  const s = await boot();
  t.after(s.close);
  await s.call('POST', '/api/requests', { room: 1, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [] });
  const all = (await s.call('GET', '/api/events?since=0')).body;
  const tail = (await s.call('GET', `/api/events?since=${all.events[0].seq}`)).body;
  assert.equal(tail.events.length, all.events.length - 1);
});

test('customer can cancel at any open stage; cancelled requests stay out of metrics denominators', async (t) => {
  const s = await boot();
  t.after(s.close);
  const mkReq = async () => (await s.call('POST', '/api/requests', { room: 2, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: ['waist'] })).body.requestId;

  // (a) cancel before anyone accepts
  const a = await mkReq();
  assert.equal((await s.call('POST', `/api/requests/${a}/cancel`)).status, 200);
  assert.equal((await s.call('POST', `/api/requests/${a}/accept`, { role: 'runner' })).status, 409);
  assert.equal((await s.call('POST', `/api/requests/${a}/cancel`)).status, 409); // twice
  assert.equal((await s.call('POST', `/api/requests/${a}/close`, { outcome: 'left' })).status, 409);

  // (b) cancel after the item is on the way, with a floor pull outstanding
  const b = await mkReq();
  await s.call('POST', `/api/requests/${b}/accept`, { role: 'runner' });
  await s.call('POST', `/api/requests/${b}/confirm`, {});
  const pull = await s.call('POST', `/api/requests/${b}/floor-pull`, {});
  assert.equal((await s.call('POST', `/api/requests/${b}/cancel`)).status, 200);
  let ev = await s.events();
  assert.deepEqual(buildQueue('floor', deriveAll(ev), 0), []); // pull task withdrawn with the request
  assert.equal((await s.call('POST', `/api/tasks/${pull.body.taskId}/accept`)).status, 409);
  const cancelEvents = ev.filter((e) => e.type === 'cancelled');
  assert.deepEqual(cancelEvents.map((e) => [e.actor, e.payload.stage]), [['customer', 'requested'], ['customer', 'on_the_way']]);

  // (c) cannot cancel a closed request
  const c = await mkReq();
  await s.call('POST', `/api/requests/${c}/accept`, { role: 'runner' });
  await s.call('POST', `/api/requests/${c}/close`, { outcome: 'bought_original' });
  assert.equal((await s.call('POST', `/api/requests/${c}/cancel`)).status, 409);
  assert.equal((await s.call('POST', '/api/requests/nope/cancel')).status, 404);

  // metrics: only (c) is closed, so the save rate is 100% and the two cancellations are counted separately
  ev = await s.events();
  const m = computeMetrics(ev);
  assert.deepEqual([m.total, m.closed, m.cancelled, m.saveRate], [3, 1, 2, 1]);
  assert.deepEqual(m.cancelledByStage, { requested: 1, accepted: 0, on_the_way: 1 });
});

test('escalation sweep skips cancelled requests', async (t) => {
  const s = await boot();
  t.after(s.close);
  const { body: { requestId: r } } = await s.call('POST', '/api/requests', { room: 1, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [] });
  await s.call('POST', `/api/requests/${r}/cancel`);
  s.advance(500_000);
  s.sweep();
  assert.equal((await s.events()).filter((e) => e.type === 'escalated').length, 0);
});

test('a still-open request that passes the threshold shows up in openEscalations', async (t) => {
  const s = await boot();
  t.after(s.close);
  const { body: { requestId: r } } = await s.call('POST', '/api/requests', { room: 1, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [] });
  s.advance(130_000);
  s.sweep();
  assert.deepEqual(computeMetrics(await s.events()).openEscalations, [r]);
});

// ---------- not on rack / declined item / assist / demo controls ----------
import { CATALOGUE } from '../shared/catalogue.js';
import { SMALL_CATALOGUE } from './fixtures.js';

const oxReq = async (s, extra = {}) =>
  (await s.call('POST', '/api/requests', { room: 2, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: ['waist'], ...extra })).body.requestId;
const suggestionsOf = async (s, id) => (await s.events()).filter((e) => e.type === 'suggestion_shown' && e.requestId === id).map((e) => e.payload);

test('"not on rack": logs the discrepancy, withdraws the item, shows the next best, and lowers stock for later requests', async (t) => {
  const catalogue = SMALL_CATALOGUE.map((x) => (x.id === 'OX-M-REG' ? { ...x, stock: 1 } : x));
  const s = await boot({ catalogue, config: makeConfig({ BRING_COUNT: '1' }) }); // one item per trip
  t.after(s.close);
  const r = await oxReq(s);
  assert.equal((await s.call('POST', `/api/requests/${r}/next-best`, { cause: 'not_on_rack' })).status, 409); // not accepted yet
  await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' });
  assert.equal((await s.call('POST', `/api/requests/${r}/next-best`, { cause: 'bogus' })).status, 400);
  assert.equal((await s.call('POST', `/api/requests/${r}/next-best`, { cause: 'customer_declined' })).status, 409); // nobody declined
  await s.call('POST', `/api/requests/${r}/confirm`, {});

  assert.equal((await s.call('POST', `/api/requests/${r}/next-best`, { cause: 'not_on_rack' })).status, 200);
  const ev = await s.events();
  const disc = ev.find((e) => e.type === 'inventory_discrepancy');
  assert.deepEqual([disc.requestId, disc.payload.skuId, disc.payload.rack], [r, 'OX-M-REG', 'A4']);
  const [first, second] = await suggestionsOf(s, r);
  assert.equal(first.itemId, 'OX-M-REG');
  assert.equal(second.itemId, 'OX-XL-REG'); // next best
  assert.deepEqual(second.excluded, ['OX-M-REG']);
  const d = deriveAll(ev);
  assert.equal(d.byId[r].status, 'accepted');
  assert.equal(customerSteps(d.byId[r])[2].reached, false); // the customer tracker steps back from "on the way"
  assert.equal(computeMetrics(ev).inventoryDiscrepancies.total, 1);

  // the report lowers stock for everyone: OX-M-REG had 1, so the next customer is no longer sent to it
  const r2 = await oxReq(s, { room: 5 });
  await s.call('POST', `/api/requests/${r2}/accept`, { role: 'runner' });
  assert.equal((await suggestionsOf(s, r2))[0].itemId, 'OX-XL-REG');

  // the next best is missing too -> nothing left, falls to the cross-store message
  await s.call('POST', `/api/requests/${r}/confirm`, {});
  await s.call('POST', `/api/requests/${r}/next-best`, { cause: 'not_on_rack' });
  const last = (await suggestionsOf(s, r)).pop();
  assert.equal(last.kind, 'no_alternative');
  assert.equal(last.itemId, null);
  assert.equal((await s.call('POST', `/api/requests/${r}/next-best`, { cause: 'not_on_rack' })).status, 409); // nothing left to report

  await s.call('POST', `/api/requests/${r}/close`, { outcome: 'cross_store_order' });
  assert.equal((await s.call('POST', `/api/requests/${r}/next-best`, { cause: 'not_on_rack' })).status, 409); // closed
});

test('customer "Not this one": flags the request, then the runner asks for the next best', async (t) => {
  const s = await boot({ catalogue: SMALL_CATALOGUE, config: makeConfig({ BRING_COUNT: '1' }) }); // one item per trip
  t.after(s.close);
  const r = await oxReq(s);
  assert.equal((await s.call('POST', `/api/requests/${r}/decline-item`)).status, 409); // nothing on its way
  await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' });
  assert.equal((await s.call('POST', `/api/requests/${r}/decline-item`)).status, 409); // still only a suggestion
  await s.call('POST', `/api/requests/${r}/confirm`, {});
  assert.equal((await s.call('POST', `/api/requests/${r}/decline-item`)).status, 200);
  assert.equal((await s.call('POST', `/api/requests/${r}/decline-item`)).status, 409); // twice
  let ev = await s.events();
  const declined = ev.find((e) => e.type === 'item_declined');
  assert.deepEqual([declined.actor, declined.payload.itemId], ['customer', 'OX-M-REG']);
  assert.equal(deriveAll(ev).byId[r].itemDeclined.itemId, 'OX-M-REG');
  assert.equal(computeMetrics(ev).itemsDeclined, 1);

  assert.equal((await s.call('POST', `/api/requests/${r}/next-best`, { cause: 'customer_declined' })).status, 200);
  ev = await s.events();
  const req = deriveAll(ev).byId[r];
  assert.equal(req.itemDeclined, null);
  assert.equal(req.status, 'accepted');
  assert.equal(req.suggestion.itemId, 'OX-XL-REG');
  assert.ok(!ev.some((e) => e.type === 'inventory_discrepancy'), 'a declined item is not a stock problem');
});

test('escalated items can be assisted by the other team; assisted requests can be accepted by the assisting role', async (t) => {
  const s = await boot();
  t.after(s.close);
  const r = await oxReq(s);
  assert.equal((await s.call('POST', `/api/items/${r}/assist`, { role: 'floor' })).status, 409); // not escalated yet
  assert.equal((await s.call('POST', `/api/requests/${r}/accept`, { role: 'floor' })).status, 400); // wrong queue, not assisted
  s.advance(121_000);
  s.sweep();
  assert.equal((await s.call('POST', `/api/items/${r}/assist`, { role: 'runner' })).status, 400); // same team
  assert.equal((await s.call('POST', `/api/items/${r}/assist`, { role: 'nobody' })).status, 400);
  assert.equal((await s.call('POST', '/api/items/nope/assist', { role: 'floor' })).status, 404);
  s.advance(4_000);
  assert.equal((await s.call('POST', `/api/items/${r}/assist`, { role: 'floor' })).status, 200);
  assert.equal((await s.call('POST', `/api/items/${r}/assist`, { role: 'floor' })).status, 409); // already assisted
  assert.equal((await s.call('POST', `/api/requests/${r}/accept`, { role: 'floor' })).status, 200); // floor takes it
  const ev = await s.events();
  assert.deepEqual(ev.filter((e) => e.type === 'accepted').map((e) => e.actor), ['floor']);
  const m = computeMetrics(ev);
  assert.equal(m.assists, 1);
  assert.equal(m.medianAssistMs, 4_000);
  assert.equal((await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' })).status, 409); // no double accept
  await s.call('POST', `/api/requests/${r}/confirm`, { role: 'floor' });
  await s.call('POST', `/api/requests/${r}/close`, { outcome: 'bought_original', role: 'floor' });
  const acts = (await s.events()).filter((e) => ['suggestion_confirmed', 'on_the_way', 'closed'].includes(e.type)).map((e) => e.actor);
  assert.deepEqual(acts, ['floor', 'floor', 'floor']); // the team that did the work is the one on record
  assert.equal((await s.call('POST', '/api/items/' + r + '/assist', { role: 'floor' })).status, 409); // finished
});

test('an escalated floor pull can be assisted by a runner, who then accepts and completes it', async (t) => {
  const s = await boot();
  t.after(s.close);
  const r = await oxReq(s);
  await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' });
  const { body: { taskId } } = await s.call('POST', `/api/requests/${r}/floor-pull`, {});
  s.advance(121_000);
  s.sweep();
  assert.equal((await s.call('POST', `/api/tasks/${taskId}/accept`, { role: 'runner' })).status, 400); // not assisted yet
  assert.equal((await s.call('POST', `/api/items/${taskId}/assist`, { role: 'runner' })).status, 200);
  assert.equal((await s.call('POST', `/api/tasks/${taskId}/accept`, { role: 'runner' })).status, 200);
  assert.equal((await s.call('POST', `/api/tasks/${taskId}/done`, { role: 'runner' })).status, 200);
  const acc = (await s.events()).find((e) => e.type === 'accepted' && e.requestId === taskId);
  assert.deepEqual([acc.actor, acc.payload.role], ['runner', 'runner']);
});

test('a system-rule reason (from a stock-discrepancy report) is accepted', async (t) => {
  const s = await boot();
  t.after(s.close);
  const r = await oxReq(s);
  await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' });
  await s.call('POST', `/api/requests/${r}/close`, { outcome: 'left', role: 'runner' });
  const res = await s.call('POST', `/api/requests/${r}/reason`, {
    reason_tag: 'stock_unavailable', summary_en: 'Item reported missing on the rack', evidence_type: 'system-observed', confidence: 1, method: 'system_rule', edited: false,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(computeMetrics(await s.events()).reasons.byEvidence['system-observed'], [{ tag: 'stock_unavailable', count: 1 }]);
});

test('demo controls: off by default; when enabled they force the rule-based fallback and fast timers', async (t) => {
  let aiCalls = 0;
  const llm = async () => {
    aiCalls += 1;
    return { raw: JSON.stringify({ primary_area: 'waist', primary_issue: 'tight', secondary_area: 'other/unknown', secondary_issue: 'other/unknown', summary_en: 'Waist tight', evidence_type: 'customer-stated', confidence: 0.9 }), method: 'ai:fake' };
  };
  llm.model = 'fake';

  const off = await boot({ llm });
  t.after(off.close);
  assert.equal((await off.call('POST', '/api/demo', { forceFallback: true })).status, 403);
  assert.equal((await off.call('GET', '/api/events?since=0')).body.settings.demoControls, false);

  const s = await boot({ llm, demoControls: true });
  t.after(s.close);
  const text = 'kamar pe tight hai';
  const method = async () => (await s.call('POST', '/api/requests', { room: 1, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [], text })).body.method;
  assert.equal(await method(), 'ai:fake');
  const before = aiCalls;

  const forced = await s.call('POST', '/api/demo', { forceFallback: true });
  assert.equal(forced.body.demo.forceFallback, true);
  assert.equal(forced.body.parser.mode, 'forced_fallback');
  assert.equal(await method(), 'rule_fallback');
  assert.equal(aiCalls, before); // the provider was never called
  assert.equal((await s.call('POST', '/api/demo', { forceFallback: false })).body.parser.mode, 'ai');
  assert.equal(await method(), 'ai:fake');

  // fast timers: thresholds drop to 10 s / 20 s, everywhere (settings travel with every poll)
  assert.equal((await s.call('GET', '/api/events?since=0')).body.settings.config.acceptEscalateSeconds, 120);
  await s.call('POST', '/api/demo', { fastTimers: true });
  const cfg = (await s.call('GET', '/api/events?since=0')).body.settings.config;
  assert.deepEqual([cfg.acceptEscalateSeconds, cfg.deliverEscalateSeconds], [20, 20]);
  const before2 = (await s.events()).filter((e) => e.type === 'escalated').length;
  s.advance(25_000);
  s.sweep();
  assert.ok((await s.events()).filter((e) => e.type === 'escalated').length > before2);
  assert.equal((await s.call('POST', '/api/demo', { fastTimers: 'yes' })).status, 400); // booleans only
});

test('fast timers switch themselves off after five minutes, back to the configured 60 s / 120 s', async (t) => {
  const s = await boot({ demoControls: true });
  t.after(s.close);
  const settings = async () => (await s.call('GET', '/api/events?since=0')).body.settings;
  assert.deepEqual([(await settings()).config.acceptEscalateSeconds, (await settings()).config.deliverEscalateSeconds], [120, 120]);
  const on = await s.call('POST', '/api/demo', { fastTimers: true });
  assert.equal(on.body.demo.fastTimers, true);
  assert.ok(on.body.demo.fastTimersUntil > 0);
  s.advance(4 * 60_000);
  assert.equal((await settings()).demo.fastTimers, true); // still on after four minutes
  s.advance(61_000);
  const after = await settings();
  assert.equal(after.demo.fastTimers, false);
  assert.deepEqual([after.config.acceptEscalateSeconds, after.config.deliverEscalateSeconds], [120, 120]);
  // and a request that has been waiting 90 s is not escalated once the normal 120 s threshold is back
  await s.call('POST', '/api/requests', { room: 1, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [] });
  s.advance(90_000);
  s.sweep();
  assert.equal((await s.events()).filter((e) => e.type === 'escalated').length, 0);
});

test('a one-tap reason (method quick_pick) is accepted and lands in the right evidence bucket', async (t) => {
  const s = await boot();
  t.after(s.close);
  const r = await oxReq(s);
  await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' });
  await s.call('POST', `/api/requests/${r}/close`, { outcome: 'saved_for_later', role: 'runner' });
  const res = await s.call('POST', `/api/requests/${r}/reason`, {
    reason_tag: 'price', summary_en: 'Customer was concerned about the price', evidence_type: 'customer-stated', confidence: 1, method: 'quick_pick', edited: false,
  });
  assert.equal(res.status, 200);
  assert.deepEqual(computeMetrics(await s.events()).reasons.byEvidence['customer-stated'], [{ tag: 'price', count: 1 }]);
});

test('"Another style" honours the details the customer asked to change, end to end', async (t) => {
  const s = await boot();
  t.after(s.close);
  const ask = async (styleAxes, sku = 'OX-L-SLIM', issue = 'another_style') =>
    s.call('POST', '/api/requests', { room: 2, skuId: sku, issue, chips: [], styleAxes });
  const suggestionOf = async (id) => {
    await s.call('POST', `/api/requests/${id}/accept`, { role: 'runner' });
    return (await s.events()).filter((e) => e.type === 'suggestion_shown' && e.requestId === id).pop().payload;
  };

  const collar = await ask(['collar']);
  assert.equal(collar.status, 200);
  const created = (await s.events()).find((e) => e.type === 'created');
  assert.deepEqual(created.payload.styleAxes, ['collar']);
  const sug = await suggestionOf(collar.body.requestId);
  assert.equal(sug.kind, 'alternative_style');
  assert.deepEqual(sug.change.changed.map((c) => [c.axis, c.from, c.to]), [['collar', 'Button-down', 'Spread']]);
  assert.deepEqual(sug.change.requested, ['collar']);

  const pattern = await suggestionOf((await ask(['pattern'], 'PL-M-SLIM')).body.requestId);
  assert.deepEqual(pattern.change.changed.map((c) => c.axis), ['pattern']);

  // an axis that means nothing on this garment is ignored, a made-up axis is rejected, and other issues drop the field
  const trousers = await suggestionOf((await ask(['collar', 'front'], 'CH-32-REG')).body.requestId);
  assert.deepEqual(trousers.change.requested, ['front']);
  assert.equal((await ask(['sleeves'])).status, 400);
  assert.equal((await ask('collar')).status, 400);
  const fit = await ask(['collar'], 'OX-L-SLIM', 'too_tight');
  assert.equal(fit.status, 200);
  assert.deepEqual((await s.events()).filter((e) => e.type === 'created').pop().payload.styleAxes, []);
});

// ---------- several best items in one trip ----------
import { suggestionItemIds } from '../shared/fitMatch.js';

test('a trip brings several best items at once; a subset can be confirmed; bad picks are refused', async (t) => {
  const s = await boot();
  t.after(s.close);
  const r = await oxReq(s);
  await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' });
  const sug = (await suggestionsOf(s, r))[0];
  const ids = suggestionItemIds(sug);
  assert.ok(ids.length >= 2 && ids.length <= 3, `expected a range of options, got ${ids.length}`);
  assert.equal(ids[0], sug.itemId);

  assert.equal((await s.call('POST', `/api/requests/${r}/confirm`, { itemIds: [ids[0], 'NOT-A-SKU'] })).status, 409);
  assert.equal((await s.call('POST', `/api/requests/${r}/confirm`, { itemIds: [] })).status, 409);
  assert.equal((await s.call('POST', `/api/requests/${r}/confirm`, {})).status, 200); // default: bring them all
  const ev = await s.events();
  const conf = ev.find((e) => e.type === 'suggestion_confirmed' && e.requestId === r);
  assert.deepEqual(conf.payload.itemIds, ids);
  const way = ev.find((e) => e.type === 'on_the_way' && e.requestId === r);
  assert.deepEqual(way.payload.items.map((i) => i.itemId), ids);
  assert.match(way.payload.itemLabel, new RegExp(`\\+${ids.length - 1} more$`));
  const req = deriveAll(ev).byId[r];
  assert.deepEqual(req.onTheWay.items.map((i) => i.itemId), ids);
  assert.match(customerSteps(req)[2].label, /^On the way to Room 2 \(bringing /);

  // a runner can leave one out
  const r2 = await oxReq(s, { room: 5 });
  await s.call('POST', `/api/requests/${r2}/accept`, { role: 'runner' });
  const ids2 = suggestionItemIds((await suggestionsOf(s, r2))[0]);
  assert.equal((await s.call('POST', `/api/requests/${r2}/confirm`, { itemIds: [ids2[1]] })).status, 200);
  const way2 = (await s.events()).filter((e) => e.type === 'on_the_way' && e.requestId === r2)[0];
  assert.deepEqual(way2.payload.items.map((i) => i.itemId), [ids2[1]]);
  assert.ok(!/more$/.test(way2.payload.itemLabel));
});

test('one item missing from a trip leaves the rest on their way; only the last one triggers a new suggestion', async (t) => {
  const s = await boot();
  t.after(s.close);
  const r = await oxReq(s);
  await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' });
  const ids = suggestionItemIds((await suggestionsOf(s, r))[0]);
  await s.call('POST', `/api/requests/${r}/confirm`, {});
  const shownCount = async () => (await suggestionsOf(s, r)).length;
  const before = await shownCount();

  assert.equal((await s.call('POST', `/api/requests/${r}/next-best`, { cause: 'not_on_rack', itemId: 'NOT-IN-TRIP' })).status, 409);
  assert.equal((await s.call('POST', `/api/requests/${r}/next-best`, { cause: 'not_on_rack', itemId: ids[1] })).status, 200);
  let req = deriveAll(await s.events()).byId[r];
  assert.equal(req.status, 'on_the_way');
  assert.deepEqual(req.onTheWay.items.map((i) => i.itemId), ids.filter((x) => x !== ids[1]));
  assert.equal(await shownCount(), before); // the rest of the trip carries on: no new suggestion

  for (const id of ids.filter((x) => x !== ids[1])) {
    assert.equal((await s.call('POST', `/api/requests/${r}/next-best`, { cause: 'not_on_rack', itemId: id })).status, 200);
  }
  req = deriveAll(await s.events()).byId[r];
  assert.equal(req.status, 'accepted'); // nothing left on its way
  assert.equal(await shownCount(), before + 1); // now a fresh suggestion, without any of the missing items
  const next = (await suggestionsOf(s, r)).pop();
  for (const id of ids) assert.ok(!suggestionItemIds(next).includes(id), `${id} must not be offered again`);
});

test('"none of these" declines the whole trip and the next best never repeats any of it', async (t) => {
  const s = await boot();
  t.after(s.close);
  const r = await oxReq(s);
  await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' });
  const ids = suggestionItemIds((await suggestionsOf(s, r))[0]);
  await s.call('POST', `/api/requests/${r}/confirm`, {});
  assert.equal((await s.call('POST', `/api/requests/${r}/decline-item`)).status, 200);
  const dec = (await s.events()).find((e) => e.type === 'item_declined');
  assert.deepEqual(dec.payload.itemIds, ids);
  assert.equal((await s.call('POST', `/api/requests/${r}/next-best`, { cause: 'customer_declined' })).status, 200);
  const next = suggestionItemIds((await suggestionsOf(s, r)).pop());
  for (const id of ids) assert.ok(!next.includes(id));
});

test('one floor pull covers every item of the trip', async (t) => {
  const s = await boot();
  t.after(s.close);
  const r = await oxReq(s);
  await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' });
  const ids = suggestionItemIds((await suggestionsOf(s, r))[0]);
  await s.call('POST', `/api/requests/${r}/confirm`, {});
  const pull = await s.call('POST', `/api/requests/${r}/floor-pull`, {});
  assert.equal(pull.status, 200);
  const task = deriveAll(await s.events()).byId[pull.body.taskId];
  assert.deepEqual(task.items.map((i) => i.itemId), ids);
  assert.ok(task.items.every((i) => /^[A-E]\d+$/.test(i.rack)));
  assert.equal(task.itemId, ids[0]);
});

// ---------- staffing: sections, primary / secondary, least busy ----------
const SHIRT = 'Men|shirt';
const addStaff = async (s, label, type, primary = [], secondary = []) => {
  const out = await s.call('POST', '/api/staff', { label, type, primary, secondary });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  await s.call('GET', `/api/events?since=0&staff=${out.body.staff.id}`); // the phone is on and polling
  return out.body.staff;
};
const accept = (s, id, who, role = 'runner') => s.call('POST', `/api/requests/${id}/accept`, { role, staffId: who?.id });
const assignedTo = async (s, id) => (await s.events()).filter((e) => e.type === 'assigned' && e.requestId === id).map((e) => `${e.payload.tier}:${e.payload.staffId}`);

test('staff admin: add, change sections, shift, remove; everything is validated', async (t) => {
  const s = await boot();
  t.after(s.close);
  const a = await s.call('POST', '/api/staff', { label: 'Runner 1', type: 'runner', primary: [SHIRT], secondary: ['Men|polo'] });
  assert.equal(a.status, 200);
  assert.match(a.body.staff.code, /^[A-Z2-9]{4}$/);
  assert.equal(a.body.staff.onShift, true);
  for (const bad of [{ label: '', type: 'runner' }, { label: 'X', type: 'boss' }, { label: 'X', type: 'runner', primary: ['nope'] }, { label: 'X', type: 'runner', primary: [SHIRT], secondary: [SHIRT] }]) {
    assert.equal((await s.call('POST', '/api/staff', bad)).status, 400, JSON.stringify(bad));
  }
  const up = await s.call('POST', `/api/staff/${a.body.staff.id}`, { primary: ['Men|polo'], secondary: [], onShift: false });
  assert.equal(up.status, 200);
  const pub = (await s.call('GET', '/api/events?since=0')).body.settings.staff;
  assert.deepEqual(pub.map((x) => [x.label, x.primary, x.secondary, x.onShift]), [['Runner 1', ['Men|polo'], [], false]]);
  assert.ok(!('code' in pub[0]), 'join codes are not sent to ordinary phones');
  assert.match((await s.call('GET', '/api/events?since=0&admin=1')).body.settings.staff[0].code, /^[A-Z2-9]{4}$/);
  assert.equal((await s.call('POST', '/api/staff/nope', { onShift: true })).status, 404);
  assert.equal((await s.call('DELETE', `/api/staff/${a.body.staff.id}`)).status, 200);
  assert.deepEqual((await s.call('GET', '/api/events?since=0')).body.settings.staff, []);
});

test('staff join with a code, and the roster survives a restart', async (t) => {
  const file = (await import('node:path')).join((await import('node:os')).tmpdir(), `frl-staff-${Date.now()}-${Math.random()}.json`);
  t.after(async () => (await import('node:fs/promises')).rm(file, { force: true }));
  const s = await boot({ settingsFile: file });
  t.after(s.close);
  const a = (await s.call('POST', '/api/staff', { label: 'Floor 1', type: 'floor' })).body.staff;
  assert.equal((await s.call('POST', '/api/staff/join', { code: 'WRONG' })).status, 404);
  const ok = await s.call('POST', '/api/staff/join', { code: ` ${a.code.toLowerCase()} ` });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.staff, { id: a.id, label: 'Floor 1', type: 'floor' });
  const s2 = await boot({ settingsFile: file });
  t.after(s2.close);
  assert.deepEqual((await s2.call('GET', '/api/events?since=0')).body.settings.staff.map((x) => x.label), ['Floor 1']);
  assert.equal((await s2.call('POST', '/api/staff/join', { code: a.code })).status, 200);
});

test('seed adds a sample team only when there is no roster', async (t) => {
  const s = await boot();
  t.after(s.close);
  assert.equal((await s.call('POST', '/api/staff/seed')).status, 200);
  const staff = (await s.call('GET', '/api/events?since=0')).body.settings.staff;
  assert.ok(staff.length >= 4 && staff.some((x) => x.type === 'runner') && staff.some((x) => x.type === 'floor'));
  assert.equal((await s.call('POST', '/api/staff/seed')).status, 409);
});

test('with a roster: primary first, then a secondary is added after the wait (the first keeps it), then everyone; first accept wins', async (t) => {
  const s = await boot();
  t.after(s.close);
  const p1 = await addStaff(s, 'Runner 1', 'runner', [SHIRT]);
  const s1 = await addStaff(s, 'Runner 2', 'runner', [], [SHIRT]);
  const other = await addStaff(s, 'Runner 3', 'runner', ['Women|polo']);

  const r = await oxReq(s);
  assert.deepEqual(await assignedTo(s, r), [`primary:${p1.id}`]);               // given to the primary at once
  assert.equal((await accept(s, r, s1)).status, 409);                            // the secondary cannot see it yet
  assert.equal((await accept(s, r, other)).status, 409);

  s.advance(21_000); s.sweep();
  assert.deepEqual(await assignedTo(s, r), [`primary:${p1.id}`, `secondary:${s1.id}`]);
  s.advance(21_000); await s.call('GET', `/api/events?since=0&staff=${other.id}`); s.sweep();
  assert.deepEqual((await assignedTo(s, r)).slice(-1), ['open:null']);

  const win = await accept(s, r, other);                                         // anyone can now take it: first accept wins
  assert.equal(win.status, 200);
  assert.equal((await accept(s, r, p1)).status, 409);                            // the primary was too late
  const acc = (await s.events()).find((e) => e.type === 'accepted');
  assert.deepEqual([acc.payload.staffId, acc.payload.tier], [other.id, 'open']);
});

test('the primary and the secondary both keep it; whoever accepts first serves it', async (t) => {
  const s = await boot();
  t.after(s.close);
  const p1 = await addStaff(s, 'Runner 1', 'runner', [SHIRT]);
  const s1 = await addStaff(s, 'Runner 2', 'runner', [], [SHIRT]);
  const r = await oxReq(s);
  s.advance(21_000); s.sweep();
  assert.equal((await accept(s, r, s1)).status, 200);
  assert.equal((await accept(s, r, p1)).status, 409);
  const acc = (await s.events()).find((e) => e.type === 'accepted');
  assert.deepEqual([acc.payload.staffId, acc.payload.tier], [s1.id, 'secondary']);
});

test('requests go to the least busy person; load counts waiting and accepted work', async (t) => {
  const s = await boot();
  t.after(s.close);
  const a = await addStaff(s, 'Runner A', 'runner', [SHIRT]);
  const b = await addStaff(s, 'Runner B', 'runner', [SHIRT]);
  const r1 = await oxReq(s, { room: 1 });
  const r2 = await oxReq(s, { room: 2 });
  const r3 = await oxReq(s, { room: 3 });
  const who = async (id) => (await assignedTo(s, id))[0].split(':')[1];
  const first = await who(r1);
  assert.notEqual(await who(r2), first);                                          // spread across the two
  assert.equal(await who(r3), first);                                             // then back to the one who got it least recently
  assert.equal((await accept(s, r1, first === a.id ? a : b)).status, 200);
  const r4 = await oxReq(s, { room: 4 });                                         // first now holds r1 (accepted) and r3 (waiting): 2; the other holds r2: 1
  assert.notEqual(await who(r4), first);
});

test('phones that are off, off shift, the wrong type or without the section are skipped', async (t) => {
  const s = await boot();
  t.after(s.close);
  const asleep = (await s.call('POST', '/api/staff', { label: 'Asleep', type: 'runner', primary: [SHIRT] })).body.staff; // never polled
  const off = await addStaff(s, 'Off shift', 'runner', [SHIRT]);
  await s.call('POST', `/api/staff/${off.id}`, { onShift: false });
  const floor = await addStaff(s, 'Floor', 'floor', [SHIRT]);
  const polo = await addStaff(s, 'Polo person', 'runner', ['Men|polo']);
  const ok = await addStaff(s, 'Ready', 'runner', [SHIRT]);
  const r = await oxReq(s);
  assert.deepEqual(await assignedTo(s, r), [`primary:${ok.id}`]);
  s.advance(61_000);                                                              // phones go quiet after a minute
  const r2 = await oxReq(s, { room: 7 });
  assert.deepEqual(await assignedTo(s, r2), ['primary:null', 'secondary:null', 'open:null']); // nobody active: open to all straight away
  assert.ok(asleep && floor && polo);
});

test('accepting needs a joined team member of the right type; wrong or unknown people are refused and nothing is logged', async (t) => {
  const s = await boot();
  t.after(s.close);
  const p1 = await addStaff(s, 'Runner 1', 'runner', [SHIRT]);
  const f1 = await addStaff(s, 'Floor 1', 'floor', [SHIRT]);
  const r = await oxReq(s);
  assert.equal((await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' })).status, 403);              // nobody joined
  assert.equal((await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner', staffId: 'ghost' })).status, 403);
  assert.equal((await accept(s, r, f1, 'runner')).status, 400);                                                     // a floor associate acting as a runner
  assert.ok(!(await s.events()).some((e) => e.type === 'accepted'));
  assert.equal((await accept(s, r, p1)).status, 200);
});

test('an escalated request is open to every team member of the team that can take it', async (t) => {
  const s = await boot();
  t.after(s.close);
  await addStaff(s, 'Runner 1', 'runner', [SHIRT]);
  const outsider = await addStaff(s, 'Runner 2', 'runner', ['Women|polo']);
  const r = await oxReq(s);
  assert.equal((await accept(s, r, outsider)).status, 409);
  s.advance(125_000); await s.call('GET', `/api/events?since=0&staff=${outsider.id}`); s.sweep();
  assert.equal((await accept(s, r, outsider)).status, 200);
});

test('floor pulls are assigned to floor staff by their request\'s section', async (t) => {
  const s = await boot();
  t.after(s.close);
  const run = await addStaff(s, 'Runner 1', 'runner', [SHIRT]);
  const fa = await addStaff(s, 'Floor A', 'floor', [SHIRT]);
  const fb = await addStaff(s, 'Floor B', 'floor', ['Women|polo']);
  const r = await oxReq(s);
  assert.equal((await accept(s, r, run)).status, 200);
  const { body: { taskId } } = await s.call('POST', `/api/requests/${r}/floor-pull`, {});
  assert.deepEqual(await assignedTo(s, taskId), [`primary:${fa.id}`]);
  assert.equal((await s.call('POST', `/api/tasks/${taskId}/accept`, { role: 'floor', staffId: fb.id })).status, 409);
  assert.equal((await s.call('POST', `/api/tasks/${taskId}/accept`, { role: 'floor', staffId: fa.id })).status, 200);
});

test('the primary and secondary waits are admin settings, validated, and fast timers shorten them', async (t) => {
  const s = await boot({ demoControls: true });
  t.after(s.close);
  const get = async () => (await s.call('GET', '/api/events?since=0')).body.settings.config;
  assert.deepEqual([(await get()).primaryWaitSeconds, (await get()).secondaryWaitSeconds], [20, 20]);
  assert.equal((await s.call('POST', '/api/settings', { primaryWaitSeconds: 45, secondaryWaitSeconds: 60 })).status, 200);
  assert.deepEqual([(await get()).primaryWaitSeconds, (await get()).secondaryWaitSeconds], [45, 60]);
  for (const bad of [{ primaryWaitSeconds: 2 }, { secondaryWaitSeconds: 5000 }, { primaryWaitSeconds: 'x' }]) {
    assert.equal((await s.call('POST', '/api/settings', bad)).status, 400, JSON.stringify(bad));
  }
  await s.call('POST', '/api/demo', { fastTimers: true });
  assert.deepEqual([(await get()).primaryWaitSeconds, (await get()).secondaryWaitSeconds], [5, 5]);
  const p1 = await addStaff(s, 'Runner 1', 'runner', [SHIRT]);
  const s1 = await addStaff(s, 'Runner 2', 'runner', [], [SHIRT]);
  const r = await oxReq(s);
  s.advance(6_000); s.sweep();
  assert.deepEqual(await assignedTo(s, r), [`primary:${p1.id}`, `secondary:${s1.id}`]);
});

// ---------- escalation per stage + admin-editable times ----------
test('sweep escalates per stage: not accepted in time, then not delivered in time; accepting clears the first', async (t) => {
  const s = await boot();
  t.after(s.close);
  const { body: { requestId: r } } = await s.call('POST', '/api/requests', { room: 1, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [] });
  s.advance(121_000); s.sweep(); s.sweep();
  let ev = await s.events();
  assert.deepEqual(ev.filter((e) => e.type === 'escalated').map((e) => e.payload.stage), ['accept']);
  assert.deepEqual(computeMetrics(ev).openEscalations, [r]);

  assert.equal((await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' })).status, 200);
  ev = await s.events();
  assert.deepEqual(computeMetrics(ev).openEscalations, []);          // accepted: no longer escalated
  s.advance(100_000); s.sweep();                                      // 100 s into delivery: inside its own 120 s
  assert.equal((await s.events()).filter((e) => e.type === 'escalated').length, 1);
  s.advance(21_000); s.sweep(); s.sweep();                            // 121 s into delivery: its own time is breached
  ev = await s.events();
  assert.deepEqual(ev.filter((e) => e.type === 'escalated').map((e) => e.payload.stage), ['accept', 'deliver']);
  assert.deepEqual(computeMetrics(ev).openEscalations, [r]);

  assert.equal((await s.call('POST', `/api/requests/${r}/confirm`, {})).status, 200); // set off: not yet delivered
  assert.deepEqual(computeMetrics(await s.events()).openEscalations, [r]);
  assert.equal((await s.call('POST', `/api/requests/${r}/deliver`, { role: 'runner' })).status, 200); // handed to the customer
  assert.deepEqual(computeMetrics(await s.events()).openEscalations, []);
  s.advance(500_000); s.sweep();
  assert.equal((await s.events()).filter((e) => e.type === 'escalated').length, 2);   // no third one
});

test('delivery stage escalates on its own limit even if the request was accepted at once', async (t) => {
  const s = await boot({ config: makeConfig({ DELIVER_ESCALATE_SECONDS: '30' }) });
  t.after(s.close);
  const { body: { requestId: r } } = await s.call('POST', '/api/requests', { room: 1, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [] });
  await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' });
  s.advance(31_000); s.sweep();
  assert.deepEqual((await s.events()).filter((e) => e.type === 'escalated').map((e) => e.payload.stage), ['deliver']);
});

test('admin sets the two escalation times; they are validated, apply at once and survive a restart', async (t) => {
  const file = (await import('node:path')).join((await import('node:os')).tmpdir(), `frl-settings-${Date.now()}-${Math.random()}.json`);
  t.after(async () => (await import('node:fs/promises')).rm(file, { force: true }));
  const s = await boot({ settingsFile: file });
  t.after(s.close);
  const get = async () => (await s.call('GET', '/api/events?since=0')).body.settings.config;
  assert.deepEqual([(await get()).acceptEscalateSeconds, (await get()).deliverEscalateSeconds], [120, 120]);
  const ok = await s.call('POST', '/api/settings', { acceptEscalateSeconds: 90, deliverEscalateSeconds: 240 });
  assert.equal(ok.status, 200);
  assert.deepEqual([(await get()).acceptEscalateSeconds, (await get()).deliverEscalateSeconds], [90, 240]);
  for (const bad of [{ acceptEscalateSeconds: 5 }, { deliverEscalateSeconds: 99999 }, { acceptEscalateSeconds: 'x' }, { acceptEscalateSeconds: 90.5 }, { bringCount: 2 }, {}]) {
    assert.equal((await s.call('POST', '/api/settings', bad)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual([(await get()).acceptEscalateSeconds, (await get()).deliverEscalateSeconds], [90, 240]); // rejected edits changed nothing
  // one value alone is fine
  assert.equal((await s.call('POST', '/api/settings', { deliverEscalateSeconds: 300 })).status, 200);
  assert.deepEqual([(await get()).acceptEscalateSeconds, (await get()).deliverEscalateSeconds], [90, 300]);
  // a fresh server reading the same file picks them up
  const s2 = await boot({ settingsFile: file });
  t.after(s2.close);
  const cfg2 = (await s2.call('GET', '/api/events?since=0')).body.settings.config;
  assert.deepEqual([cfg2.acceptEscalateSeconds, cfg2.deliverEscalateSeconds], [90, 300]);
  // the new limit is what the sweep uses
  const { body: { requestId } } = await s.call('POST', '/api/requests', { room: 1, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [] });
  s.advance(91_000); s.sweep();
  assert.deepEqual((await s.events()).filter((e) => e.type === 'escalated' && e.requestId === requestId).length, 1);
});

test('stage-two escalation is offered to the team that is not doing the work, and can be assisted again', async (t) => {
  const s = await boot();
  t.after(s.close);
  const { body: { requestId: r } } = await s.call('POST', '/api/requests', { room: 1, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [] });
  await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' });
  s.advance(121_000); s.sweep();
  assert.equal((await s.call('POST', `/api/items/${r}/assist`, { role: 'runner' })).status, 400); // the owner cannot assist itself
  assert.equal((await s.call('POST', `/api/items/${r}/assist`, { role: 'floor' })).status, 200);
  assert.equal((await s.call('POST', `/api/items/${r}/assist`, { role: 'floor' })).status, 409);  // once per escalation
});

// ---------- several issues for one article ----------
test('a request can carry two compatible fit issues, and the suggested items fix both', async (t) => {
  const s = await boot();
  t.after(s.close);
  const made = await s.call('POST', '/api/requests', { room: 4, skuId: 'OX-M-SLIM', issues: ['too_tight', 'too_short'], chips: ['chest', 'sleeves'] });
  assert.equal(made.status, 200);
  const created = (await s.events()).find((e) => e.type === 'created');
  assert.deepEqual(created.payload.issues, ['too_tight', 'too_short']);
  assert.equal(created.payload.issue, 'too_tight'); // the first stays the main one (routing, labels)
  const r = deriveAll(await s.events()).byId[made.body.requestId];
  assert.deepEqual(r.issues, ['too_tight', 'too_short']);
  assert.equal((await s.call('POST', `/api/requests/${r.id}/accept`, { role: 'runner' })).status, 200);
  const sug = (await s.events()).find((e) => e.type === 'suggestion_shown').payload;
  assert.equal(sug.kind, 'alternative');
  assert.ok(sug.options.length >= 1 && sug.options.every((o) => o.fixesSecondary), 'every option fixes both issues');
});

test('issues are validated: a lone issue still works, and contradictions or mixed kinds are refused', async (t) => {
  const s = await boot();
  t.after(s.close);
  const base = { room: 1, skuId: 'OX-M-SLIM', chips: [] };
  assert.equal((await s.call('POST', '/api/requests', { ...base, issue: 'too_tight' })).status, 200);            // the old shape
  assert.equal((await s.call('POST', '/api/requests', { ...base, issues: ['another_size'] })).status, 200);
  for (const issues of [['too_tight', 'too_loose'], ['too_long', 'too_short'], ['too_tight', 'another_size'], ['too_tight', 'too_long', 'too_short'], [], ['nope']]) {
    assert.equal((await s.call('POST', '/api/requests', { ...base, issues })).status, 400, JSON.stringify(issues));
  }
  assert.equal((await s.call('POST', '/api/requests', base)).status, 400); // neither field
});

test('join codes reach ordinary phones only when demo controls are on (for the one-tap demo join)', async (t) => {
  const off = await boot();
  const on = await boot({ demoControls: true });
  t.after(off.close); t.after(on.close);
  for (const s of [off, on]) await s.call('POST', '/api/staff', { label: 'Runner 1', type: 'runner' });
  assert.ok(!('code' in (await off.call('GET', '/api/events?since=0')).body.settings.staff[0]));
  assert.match((await on.call('GET', '/api/events?since=0')).body.settings.staff[0].code, /^[A-Z2-9]{4}$/);
});

test('a reason is only recorded for a request that did not convert (closed as left or saved for later)', async (t) => {
  const s = await boot();
  t.after(s.close);
  const reason = { reason_tag: 'price', summary_en: 'Customer was concerned about the price', evidence_type: 'customer-stated', confidence: 1, method: 'quick_pick', edited: false };
  const open = await oxReq(s);
  await s.call('POST', `/api/requests/${open}/accept`, { role: 'runner' });
  assert.equal((await s.call('POST', `/api/requests/${open}/reason`, reason)).status, 409); // still open
  const bought = await oxReq(s, { room: 3 });
  await s.call('POST', `/api/requests/${bought}/accept`, { role: 'runner' });
  await s.call('POST', `/api/requests/${bought}/close`, { outcome: 'bought_original', role: 'runner' });
  assert.equal((await s.call('POST', `/api/requests/${bought}/reason`, reason)).status, 409); // a sale needs no "why not"
  const left = await oxReq(s, { room: 4 });
  await s.call('POST', `/api/requests/${left}/accept`, { role: 'runner' });
  await s.call('POST', `/api/requests/${left}/close`, { outcome: 'left', role: 'runner' });
  assert.equal((await s.call('POST', `/api/requests/${left}/reason`, reason)).status, 200);
});

// ---------- confirm + pull in one tap, and cancelling a pull ----------
const confirmed = async (s, r, body = {}) => (await s.call('POST', `/api/requests/${r}/confirm`, body));

test('"confirm and ask floor to pull" does both in one call, for every confirmed item', async (t) => {
  const s = await boot();
  t.after(s.close);
  const r = await oxReq(s);
  await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' });
  const sug = (await s.events()).find((e) => e.type === 'suggestion_shown').payload;
  const out = await confirmed(s, r, { pull: true, role: 'runner' });
  assert.equal(out.status, 200);
  assert.ok(out.body.taskId);
  const d = deriveAll(await s.events());
  assert.equal(d.byId[r].status, 'on_the_way');
  const task = d.byId[out.body.taskId];
  assert.deepEqual(task.items.map((i) => i.itemId), d.byId[r].onTheWay.items.map((i) => i.itemId));
  assert.ok(task.items.length >= 1 && sug.options.length >= task.items.length);
  assert.equal((await confirmed(s, r)).status, 409); // already confirmed
});

test('only one live pull per request; after cancelling it a new one can be requested', async (t) => {
  const s = await boot();
  t.after(s.close);
  const r = await oxReq(s);
  await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' });
  await confirmed(s, r);
  const a = await s.call('POST', `/api/requests/${r}/floor-pull`, {});
  assert.equal(a.status, 200);
  assert.equal((await s.call('POST', `/api/requests/${r}/floor-pull`, {})).status, 409); // one is already on
  assert.equal((await s.call('POST', `/api/tasks/${a.body.taskId}/cancel`, { role: 'runner' })).status, 200);
  assert.equal(deriveAll(await s.events()).byId[a.body.taskId].status, 'cancelled');
  assert.equal((await s.call('POST', `/api/tasks/${a.body.taskId}/cancel`, { role: 'runner' })).status, 409); // already cancelled
  assert.equal((await s.call('POST', `/api/requests/${r}/floor-pull`, {})).status, 200);                      // a fresh one is fine
});

test('a pull can be cancelled while waiting or accepted, but not once it is done', async (t) => {
  const s = await boot();
  t.after(s.close);
  const r = await oxReq(s);
  await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' });
  await confirmed(s, r);
  const p1 = (await s.call('POST', `/api/requests/${r}/floor-pull`, {})).body.taskId;
  await s.call('POST', `/api/tasks/${p1}/accept`, { role: 'floor' });
  assert.equal((await s.call('POST', `/api/tasks/${p1}/cancel`, { role: 'runner' })).status, 200); // the floor associate had accepted
  const p2 = (await s.call('POST', `/api/requests/${r}/floor-pull`, {})).body.taskId;
  await s.call('POST', `/api/tasks/${p2}/accept`, { role: 'floor' });
  await s.call('POST', `/api/tasks/${p2}/done`, { role: 'floor' });
  assert.equal((await s.call('POST', `/api/tasks/${p2}/cancel`, { role: 'runner' })).status, 409);   // handed over already
  assert.equal((await s.call('POST', `/api/requests/${r}/floor-pull`, {})).status, 409);             // and a done pull counts: no second one
  assert.equal((await s.call('POST', '/api/tasks/nope/cancel', { role: 'runner' })).status, 404);
});

test('when the customer declines the items, any live pull for them is cancelled', async (t) => {
  const s = await boot();
  t.after(s.close);
  const r = await oxReq(s);
  await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' });
  const out = await confirmed(s, r, { pull: true, role: 'runner' });
  assert.equal((await s.call('POST', `/api/requests/${r}/decline-item`)).status, 200);
  assert.equal(deriveAll(await s.events()).byId[out.body.taskId].status, 'cancelled');
});

// ---------- delivered, try-on feedback, "try another" ----------
const onTheWayReq = async (s, extra = {}) => {
  const r = await oxReq(s, extra);
  await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' });
  await s.call('POST', `/api/requests/${r}/confirm`, {});
  return r;
};

test('handing the item over: only once it is on its way, once; the request stays open for the try-on', async (t) => {
  const s = await boot();
  t.after(s.close);
  const r = await oxReq(s);
  assert.equal((await s.call('POST', `/api/requests/${r}/deliver`, { role: 'runner' })).status, 409); // not accepted
  await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner' });
  assert.equal((await s.call('POST', `/api/requests/${r}/deliver`, { role: 'runner' })).status, 409); // nothing on its way yet
  await s.call('POST', `/api/requests/${r}/confirm`, {});
  assert.equal((await s.call('POST', `/api/requests/${r}/deliver`, { role: 'runner' })).status, 200);
  assert.equal((await s.call('POST', `/api/requests/${r}/deliver`, { role: 'runner' })).status, 409); // already
  const d = deriveAll(await s.events()).byId[r];
  assert.deepEqual([d.status, d.deliveredTs != null], ['on_the_way', true]);
  assert.equal((await s.call('POST', `/api/requests/${r}/decline-item`)).status, 409);               // too late to say "not this one"
});

test('try-on feedback: only after delivery, once, from the customer; it is a statement, not an outcome', async (t) => {
  const s = await boot();
  t.after(s.close);
  const r = await onTheWayReq(s);
  assert.equal((await s.call('POST', `/api/requests/${r}/try-on`, { result: 'fits' })).status, 409);  // not delivered yet
  await s.call('POST', `/api/requests/${r}/deliver`, { role: 'runner' });
  assert.equal((await s.call('POST', `/api/requests/${r}/try-on`, { result: 'maybe' })).status, 400);
  assert.equal((await s.call('POST', `/api/requests/${r}/try-on`, { result: 'fits' })).status, 200);
  assert.equal((await s.call('POST', `/api/requests/${r}/try-on`, { result: 'fits' })).status, 409);  // once
  const d = deriveAll(await s.events()).byId[r];
  assert.equal(d.tryOn.result, 'fits');
  assert.equal(d.status, 'on_the_way');                  // not closed: the staff close it with the real outcome
  assert.equal(computeMetrics(await s.events()).closed, 0);
});

test('"try another": a follow-up request in the same room continues the first, which is closed as continued', async (t) => {
  const s = await boot();
  t.after(s.close);
  const r = await onTheWayReq(s, { room: 3 });
  await s.call('POST', `/api/requests/${r}/deliver`, { role: 'runner' });
  await s.call('POST', `/api/requests/${r}/try-on`, { result: 'not_right' });
  // validation: wrong room, unknown request, or something not yet delivered
  const body = { skuId: 'OX-L-REG', issue: 'too_loose', chips: [], followsId: r };
  assert.equal((await s.call('POST', '/api/requests', { ...body, room: 4 })).status, 400);
  assert.equal((await s.call('POST', '/api/requests', { ...body, room: 3, followsId: 'nope' })).status, 400);
  const made = await s.call('POST', '/api/requests', { ...body, room: 3 });
  assert.equal(made.status, 200);
  const d = deriveAll(await s.events());
  assert.equal(d.byId[made.body.requestId].followsId, r);
  assert.deepEqual([d.byId[r].status, d.byId[r].outcome], ['closed', 'continued']);
  const m = computeMetrics(await s.events());
  assert.deepEqual([m.closed, m.continued, m.followUps], [0, 1, 1]);
  assert.equal((await s.call('POST', '/api/requests', { ...body, room: 3 })).status, 400); // already continued
});

// ---------- restock tasks from the Manager ----------
const missingOnRackApi = async (s, room = 2, runner = null) => {
  const r = await oxReq(s, { room });
  await s.call('POST', `/api/requests/${r}/accept`, { role: 'runner', staffId: runner?.id });
  const sku = (await s.events()).filter((e) => e.type === 'suggestion_shown').pop().payload.itemId;
  await s.call('POST', `/api/requests/${r}/next-best`, { cause: 'not_on_rack', role: 'runner', itemId: sku });
  return sku;
};

test('dispatching a restock task: only for a live signal, once, and it reaches the floor queue', async (t) => {
  const s = await boot();
  t.after(s.close);
  assert.equal((await s.call('POST', '/api/restock', { skuId: 'OX-M-REG', kind: 'recount' })).status, 409);       // nothing flagged yet
  const sku = await missingOnRackApi(s);
  assert.equal((await s.call('POST', '/api/restock', { skuId: 'nope', kind: 'recount' })).status, 400);
  assert.equal((await s.call('POST', '/api/restock', { skuId: sku, kind: 'burn' })).status, 400);
  assert.equal((await s.call('POST', '/api/restock', { skuId: sku, kind: 'replenish' })).status, 409);            // wrong kind of signal for it
  const out = await s.call('POST', '/api/restock', { skuId: sku, kind: 'recount' });
  assert.equal(out.status, 200);
  assert.equal((await s.call('POST', '/api/restock', { skuId: sku, kind: 'recount' })).status, 409);              // already dispatched
  const d = deriveAll(await s.events());
  assert.deepEqual(buildQueue('floor', d, 0).filter((x) => x.taskType === 'restock').map((x) => x.id), [out.body.taskId]);
  const created = (await s.events()).find((e) => e.type === 'restock_task_created');
  assert.deepEqual([created.actor, created.payload.skuId, created.payload.kind], ['manager', sku, 'recount']);
  assert.ok(!('quantity' in created.payload) && !('qty' in created.payload), 'no invented quantities');
});

test('the floor accepts and finishes a recount; the signal clears and stock is no longer reduced for it', async (t) => {
  const s = await boot();
  t.after(s.close);
  const sku = await missingOnRackApi(s);
  const { body: { taskId } } = await s.call('POST', '/api/restock', { skuId: sku, kind: 'recount' });
  assert.equal((await s.call('POST', `/api/tasks/${taskId}/done`, { role: 'floor' })).status, 409);              // accept it first
  assert.equal((await s.call('POST', `/api/tasks/${taskId}/accept`, { role: 'floor' })).status, 200);
  assert.equal((await s.call('POST', `/api/tasks/${taskId}/done`, { role: 'floor' })).status, 200);
  const ev = await s.events();
  assert.ok(ev.some((e) => e.type === 'restock_task_done' && e.requestId === taskId));
  assert.equal(computeMetrics(ev).signals.some((x) => x.kind === 'inventory'), false);
  assert.equal(deriveAll(ev).discrepancies[sku], 0);
  assert.equal(computeMetrics(ev).floorPullsDone, 0);                                                            // not a customer pull
});

test('restock tasks are assigned to floor staff by the item\'s section, and never escalate', async (t) => {
  const s = await boot();
  t.after(s.close);
  const runner = await addStaff(s, 'Runner', 'runner', ['Men|shirt']);
  const fa = await addStaff(s, 'Floor A', 'floor', ['Men|shirt']);
  await addStaff(s, 'Floor B', 'floor', ['Women|polo']);
  const sku = await missingOnRackApi(s, 2, runner);
  const { body: { taskId } } = await s.call('POST', '/api/restock', { skuId: sku, kind: 'recount' });
  assert.deepEqual(await assignedTo(s, taskId), [`primary:${fa.id}`]);
  s.advance(600_000); s.sweep();
  assert.ok(!(await s.events()).some((e) => e.type === 'escalated' && e.requestId === taskId));
});
