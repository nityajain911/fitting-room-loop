import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveAll, timerState, cardState, customerSteps, stageOf, stageLimits, timerFor, ownerRole } from '../shared/derive.js';
import { routeFor, buildQueue, recentlyClosed } from '../shared/routing.js';
import { makeConfig } from '../shared/config.js';
import { demoLog, makeLog } from './helpers.js';

const config = makeConfig();

test('status progresses from events only', () => {
  const { events, add } = makeLog();
  add(0, 'r1', 'created', { room: 2, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [], parsed: null, method: 'none' });
  add(0, 'r1', 'routed', { role: 'runner', rule: 'x' });
  assert.equal(deriveAll(events).byId.r1.status, 'requested');
  add(5000, 'r1', 'accepted', { role: 'runner' });
  assert.equal(deriveAll(events).byId.r1.status, 'accepted');
  add(9000, 'r1', 'on_the_way', { room: 2, itemId: 'OX-M-REG', itemLabel: 'Oxford' });
  assert.equal(deriveAll(events).byId.r1.status, 'on_the_way');
  add(12000, 'r1', 'closed', { outcome: 'left' });
  const r = deriveAll(events).byId.r1;
  assert.equal(r.status, 'closed');
  assert.equal(r.outcome, 'left');
  assert.equal(r.acceptedTs, 5000);
  assert.equal(r.closedTs, 12000);
});

test('floor-pull tasks are derived and linked to the parent', () => {
  const d = deriveAll(demoLog());
  assert.equal(d.tasks.length, 1);
  assert.equal(d.tasks[0].parentId, 'r1');
  assert.equal(d.tasks[0].status, 'done');
  assert.deepEqual(d.byId.r1.floorTaskIds, ['f1']);
  assert.equal(d.requests.length, 2);
});

test('timer states: normal, warn, escalated (by threshold or event)', () => {
  const lim = stageLimits(config, 'accept');
  assert.deepEqual(lim, { warnSeconds: 60, escalateSeconds: 120 });
  assert.equal(timerState(59_000, lim), 'normal');
  assert.equal(timerState(60_000, lim), 'warn');
  assert.equal(timerState(120_000, lim), 'escalated');
  const { events, add } = makeLog();
  add(0, 'r1', 'created', { room: 1, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [], parsed: null, method: 'none' });
  add(0, 'r1', 'routed', { role: 'runner', rule: 'x' });
  const open = deriveAll(events).byId.r1;
  assert.equal(cardState(open, 30_000, config), 'normal');
  assert.equal(cardState(open, 70_000, config), 'warn');
  add(125_000, 'r1', 'escalated', { level: 1, thresholdSec: 120 });
  assert.equal(cardState(deriveAll(events).byId.r1, 126_000, config), 'escalated');
  add(130_000, 'r1', 'closed', { outcome: 'left' });
  assert.equal(cardState(deriveAll(events).byId.r1, 999_000, config), 'closed');
});

test('customer steps mirror the log', () => {
  const log = demoLog();
  const r1 = deriveAll(log).byId.r1;
  const steps = customerSteps(r1);
  assert.deepEqual(steps.map((s) => s.reached), [true, true, true, true]);
  assert.match(steps[2].label, /On the way to Room 2 \(bringing Oxford Shirt/);

  const { events, add } = makeLog();
  add(0, 'r9', 'created', { room: 7, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [], parsed: null, method: 'none' });
  add(1, 'r9', 'accepted', { role: 'runner' });
  const mid = customerSteps(deriveAll(events).byId.r9);
  assert.deepEqual(mid.map((s) => s.reached), [true, true, false, false]);
  assert.equal(mid[1].label, 'Accepted (checking stock…)');
});

test('routing rules: type decides the role, never spend', () => {
  assert.equal(routeFor('too_tight').role, 'runner');
  assert.equal(routeFor('another_size').role, 'runner');
  assert.equal(routeFor('another_style').role, 'runner');
  assert.equal(routeFor('check_stock').role, 'floor');
  assert.ok(routeFor('too_tight').rank < routeFor('another_size').rank);
  assert.ok(routeFor('another_size').rank < routeFor('another_style').rank);
});

test('queue: only open items for the role, ordered by type rank then waiting time', () => {
  const { events, add } = makeLog();
  const mk = (id, ts, issue, role) => {
    add(ts, id, 'created', { room: 1, skuId: 'OX-L-SLIM', issue, chips: [], parsed: null, method: 'none' });
    add(ts, id, 'routed', { role, rule: 'x' });
  };
  mk('a', 1000, 'another_style', 'runner');
  mk('b', 2000, 'too_tight', 'runner');
  mk('c', 3000, 'too_long', 'runner');
  mk('d', 500, 'check_stock', 'floor');
  add(4000, 'a', 'accepted', { role: 'runner' });
  add(5000, 'c', 'closed', { outcome: 'left' });
  const runner = buildQueue('runner', deriveAll(events), 10_000).map((i) => i.id);
  assert.deepEqual(runner, ['b', 'a']); // fit issue first, then style; closed 'c' excluded
  assert.deepEqual(buildQueue('floor', deriveAll(events), 10_000).map((i) => i.id), ['d']);
});

test('floor queue: pull tasks rank above stock checks; recentlyClosed lists closed requests', () => {
  const { events, add } = makeLog();
  add(0, 'sc', 'created', { room: 1, skuId: 'OX-L-SLIM', issue: 'check_stock', chips: [], parsed: null, method: 'none' });
  add(0, 'sc', 'routed', { role: 'floor', rule: 'x' });
  add(1000, 'q', 'created', { room: 2, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [], parsed: null, method: 'none' });
  add(1000, 'q', 'routed', { role: 'runner', rule: 'x' });
  add(2000, 'q', 'floor_pull_requested', { taskId: 't1', itemId: 'OX-M-REG', rack: 'A4' });
  assert.deepEqual(buildQueue('floor', deriveAll(events), 5000).map((i) => i.id), ['t1', 'sc']);
  add(3000, 'q', 'closed', { outcome: 'left' });
  assert.deepEqual(recentlyClosed('runner', deriveAll(events)).map((i) => i.id), ['q']);
});

// ---------- cancellation ----------
const mkReq = (add, id, ts, extra = {}) => {
  add(ts, id, 'created', { room: 2, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [], parsed: null, method: 'none', ...extra });
  add(ts, id, 'routed', { role: 'runner', rule: 'x' });
};

test('cancelled: status, stage, not open, excluded from queues, timer card state', () => {
  const { events, add } = makeLog();
  mkReq(add, 'r1', 0);
  mkReq(add, 'r2', 1000);
  add(5000, 'r1', 'accepted', { role: 'runner' });
  add(9000, 'r1', 'cancelled', { stage: 'accepted' });
  const d = deriveAll(events);
  assert.equal(d.byId.r1.status, 'cancelled');
  assert.equal(d.byId.r1.cancelledTs, 9000);
  assert.equal(d.byId.r1.cancelStage, 'accepted');
  assert.deepEqual(buildQueue('runner', d, 10_000).map((x) => x.id), ['r2']);
  assert.equal(cardState(d.byId.r1, 999_000, config), 'cancelled');
  assert.equal(d.byId.r1.status === 'cancelled' && customerSteps(d.byId.r1)[1].reached, true);
});

test('later events do not resurrect a cancelled request', () => {
  const { events, add } = makeLog();
  mkReq(add, 'r1', 0);
  add(1000, 'r1', 'cancelled', { stage: 'requested' });
  add(2000, 'r1', 'accepted', { role: 'runner' });
  add(3000, 'r1', 'on_the_way', { room: 2, itemId: 'OX-M-REG', itemLabel: 'x' });
  assert.equal(deriveAll(events).byId.r1.status, 'cancelled');
});

test('floor tasks of a cancelled request leave the floor queue', () => {
  const { events, add } = makeLog();
  mkReq(add, 'r1', 0);
  add(1000, 'r1', 'accepted', { role: 'runner' });
  add(2000, 'r1', 'floor_pull_requested', { taskId: 't1', itemId: 'OX-M-REG', rack: 'A4' });
  assert.deepEqual(buildQueue('floor', deriveAll(events), 3000).map((x) => x.id), ['t1']);
  add(4000, 'r1', 'cancelled', { stage: 'accepted' });
  const d = deriveAll(events);
  assert.equal(d.byId.t1.status, 'cancelled');
  assert.deepEqual(buildQueue('floor', d, 5000), []);
});

test('recentlyClosed also lists cancelled requests', () => {
  const { events, add } = makeLog();
  mkReq(add, 'r1', 0);
  add(1000, 'r1', 'cancelled', { stage: 'requested' });
  assert.deepEqual(recentlyClosed('runner', deriveAll(events)).map((x) => x.id), ['r1']);
});

test('queue items expose escalated flag for the "flagged to manager" banner', () => {
  const { events, add } = makeLog();
  mkReq(add, 'r1', 0);
  add(130_000, 'r1', 'escalated', { level: 1, thresholdSec: 120 });
  assert.equal(buildQueue('runner', deriveAll(events), 131_000)[0].escalated, true);
});

// ---------- inventory discrepancy, declined item, assist ----------
import { effectiveCatalogue, excludedIds } from '../shared/derive.js';
import { buildAssistQueue } from '../shared/routing.js';
import { CATALOGUE } from '../shared/catalogue.js';

const onTheWay = (add, id, ts) => {
  add(ts, id, 'accepted', { role: 'runner' });
  add(ts, id, 'suggestion_shown', { kind: 'alternative', itemId: 'OX-M-REG', drivers: [] });
  add(ts + 1, id, 'suggestion_confirmed', { itemId: 'OX-M-REG' });
  add(ts + 1, id, 'on_the_way', { room: 2, itemId: 'OX-M-REG', itemLabel: 'Oxford' });
};

test('inventory_discrepancy withdraws the confirmed item and counts against stock', () => {
  const { events, add } = makeLog();
  mkReq(add, 'r1', 0);
  onTheWay(add, 'r1', 1000);
  add(5000, 'r1', 'inventory_discrepancy', { skuId: 'OX-M-REG', rack: 'A4' });
  let d = deriveAll(events);
  assert.equal(d.byId.r1.status, 'accepted');
  assert.equal(d.byId.r1.onTheWay, null);
  assert.equal(d.byId.r1.confirmedItemId, null);
  assert.equal(d.byId.r1.suggestionState, 'withdrawn');
  assert.deepEqual(d.byId.r1.discrepancies.map((x) => x.skuId), ['OX-M-REG']);
  assert.deepEqual(d.discrepancies, { 'OX-M-REG': 1 });
  assert.deepEqual(excludedIds(d.byId.r1), ['OX-M-REG']);
  assert.equal(customerSteps(d.byId.r1)[2].reached, false);
  add(5001, 'r1', 'suggestion_shown', { kind: 'alternative', itemId: 'OX-XL-REG', drivers: [] });
  d = deriveAll(events);
  assert.equal(d.byId.r1.suggestionState, 'shown');
  assert.equal(d.byId.r1.suggestion.itemId, 'OX-XL-REG');
});

test('effectiveCatalogue subtracts reports from sample stock, never below zero', () => {
  const eff = effectiveCatalogue(CATALOGUE, { 'OX-XL-REG': 5, 'OX-M-REG': 1 });
  assert.equal(eff.find((s) => s.id === 'OX-XL-REG').stock, 0);
  assert.equal(eff.find((s) => s.id === 'OX-M-REG').stock, 2);
  assert.equal(eff.find((s) => s.id === 'PO-L-SLIM').stock, 4); // untouched
  assert.equal(CATALOGUE.find((s) => s.id === 'OX-M-REG').stock, 3); // original not mutated
});

test('item_declined flags the request until a new suggestion is shown', () => {
  const { events, add } = makeLog();
  mkReq(add, 'r1', 0);
  onTheWay(add, 'r1', 1000);
  add(6000, 'r1', 'item_declined', { itemId: 'OX-M-REG' });
  let r = deriveAll(events).byId.r1;
  assert.deepEqual(r.itemDeclined, { itemId: 'OX-M-REG', itemIds: ['OX-M-REG'], ts: 6000 });
  assert.equal(r.status, 'on_the_way'); // still on the way until the runner acts
  assert.deepEqual(excludedIds(r), ['OX-M-REG']);
  add(7000, 'r1', 'suggestion_shown', { kind: 'alternative', itemId: 'OX-XL-REG', drivers: [] });
  r = deriveAll(events).byId.r1;
  assert.equal(r.itemDeclined, null);
  assert.equal(r.status, 'accepted'); // the declined item is no longer on its way
  assert.equal(r.onTheWay, null);
  assert.deepEqual(excludedIds(r), ['OX-M-REG']); // and is never offered again
});

test('assist queue: escalated items are offered to the other role, then show as assisting', () => {
  const { events, add } = makeLog();
  mkReq(add, 'r1', 0);                       // runner request
  add(0, 'sc', 'created', { room: 4, skuId: 'OX-L-SLIM', issue: 'check_stock', chips: [], parsed: null, method: 'none' });
  add(0, 'sc', 'routed', { role: 'floor', rule: 'x' }); // floor request
  mkReq(add, 'r2', 0);                       // not escalated
  add(130_000, 'r1', 'escalated', { level: 1 });
  add(130_000, 'sc', 'escalated', { level: 1 });
  let d = deriveAll(events);
  assert.deepEqual(buildAssistQueue('floor', d).offer.map((x) => x.id), ['r1']);   // runner's escalated card -> floor
  assert.deepEqual(buildAssistQueue('runner', d).offer.map((x) => x.id), ['sc']);  // and vice versa
  assert.deepEqual(buildAssistQueue('floor', d).assisting, []);

  add(131_000, 'r1', 'assisted', { byRole: 'floor' });
  d = deriveAll(events);
  assert.equal(d.byId.r1.assistedBy, 'floor');
  assert.equal(d.byId.r1.assistedTs, 131_000);
  assert.deepEqual(buildAssistQueue('floor', d).offer, []);
  assert.deepEqual(buildAssistQueue('floor', d).assisting.map((x) => x.id), ['r1']);
  assert.deepEqual(buildQueue('runner', d, 140_000).map((x) => x.id).sort(), ['r1', 'r2']); // runner still owns it

  add(140_000, 'r1', 'closed', { outcome: 'left' });
  assert.deepEqual(buildAssistQueue('floor', deriveAll(events)).assisting, []);
});

test('escalated floor pulls are offered to runners', () => {
  const { events, add } = makeLog();
  mkReq(add, 'r1', 0);
  add(1000, 'r1', 'accepted', { role: 'runner' });
  add(2000, 'r1', 'floor_pull_requested', { taskId: 't1', itemId: 'OX-M-REG', rack: 'A4' });
  add(140_000, 't1', 'escalated', { level: 1 });
  assert.deepEqual(buildAssistQueue('runner', deriveAll(events)).offer.map((x) => x.id), ['t1']);
});

test('a request remembers which style details the customer asked to change', () => {
  const { events, add } = makeLog();
  add(0, 'r1', 'created', { room: 2, skuId: 'OX-L-SLIM', issue: 'another_style', chips: [], styleAxes: ['collar', 'pattern'], parsed: null, method: 'none' });
  add(0, 'r1', 'routed', { role: 'runner', rule: 'x' });
  add(1, 'r2', 'created', { room: 3, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [], parsed: null, method: 'none' }); // older shape: no styleAxes
  const d = deriveAll(events);
  assert.deepEqual(d.byId.r1.styleAxes, ['collar', 'pattern']);
  assert.deepEqual(d.byId.r2.styleAxes, []);
});

// ---------- several items in one trip ----------
const trip = (add, id, ts, ids) => {
  add(ts, id, 'accepted', { role: 'runner' });
  add(ts, id, 'suggestion_shown', { kind: 'alternative', itemId: ids[0], options: ids.map((x) => ({ itemId: x })) });
  add(ts + 1, id, 'suggestion_confirmed', { itemId: ids[0], itemIds: ids });
  add(ts + 1, id, 'on_the_way', { room: 2, itemId: ids[0], itemLabel: 'First +2 more', items: ids.map((x) => ({ itemId: x, itemLabel: `Label ${x}` })) });
};

test('a trip carries several items; the customer steps use the short label', () => {
  const { events, add } = makeLog();
  mkReq(add, 'r1', 0);
  trip(add, 'r1', 1000, ['A', 'B', 'C']);
  const r = deriveAll(events).byId.r1;
  assert.deepEqual(r.confirmedItemIds, ['A', 'B', 'C']);
  assert.equal(r.confirmedItemId, 'A');
  assert.deepEqual(r.onTheWay.items.map((i) => i.itemId), ['A', 'B', 'C']);
  assert.match(customerSteps(r)[2].label, /bringing First \+2 more/);
});

test('older single-item events still derive a one-item trip', () => {
  const { events, add } = makeLog();
  mkReq(add, 'r1', 0);
  add(1000, 'r1', 'accepted', { role: 'runner' });
  add(1000, 'r1', 'suggestion_confirmed', { itemId: 'A' });
  add(1000, 'r1', 'on_the_way', { room: 2, itemId: 'A', itemLabel: 'Label A' });
  const r = deriveAll(events).byId.r1;
  assert.deepEqual(r.confirmedItemIds, ['A']);
  assert.deepEqual(r.onTheWay.items, [{ itemId: 'A', itemLabel: 'Label A' }]);
});

test('one item reported missing leaves the rest of the trip on its way; the last one withdraws it', () => {
  const { events, add } = makeLog();
  mkReq(add, 'r1', 0);
  trip(add, 'r1', 1000, ['A', 'B', 'C']);
  add(5000, 'r1', 'inventory_discrepancy', { skuId: 'B', rack: 'A4' });
  let r = deriveAll(events).byId.r1;
  assert.equal(r.status, 'on_the_way');
  assert.equal(r.suggestionState, 'confirmed');
  assert.deepEqual(r.onTheWay.items.map((i) => i.itemId), ['A', 'C']);
  assert.deepEqual(r.confirmedItemIds, ['A', 'C']);
  add(5100, 'r1', 'inventory_discrepancy', { skuId: 'A', rack: 'A5' });
  r = deriveAll(events).byId.r1;
  assert.equal(r.onTheWay.itemId, 'C'); // the trip's first item moves on
  add(5200, 'r1', 'inventory_discrepancy', { skuId: 'C', rack: 'A6' });
  r = deriveAll(events).byId.r1;
  assert.equal(r.status, 'accepted'); // nothing left to bring: back to checking stock
  assert.equal(r.onTheWay, null);
  assert.equal(r.suggestionState, 'withdrawn');
  assert.deepEqual(excludedIds(r).sort(), ['A', 'B', 'C']);
});

test('declining a trip excludes every item in it', () => {
  const { events, add } = makeLog();
  mkReq(add, 'r1', 0);
  trip(add, 'r1', 1000, ['A', 'B']);
  add(6000, 'r1', 'item_declined', { itemId: 'A', itemIds: ['A', 'B'] });
  const r = deriveAll(events).byId.r1;
  assert.deepEqual(r.itemDeclined.itemIds, ['A', 'B']);
  assert.deepEqual(excludedIds(r).sort(), ['A', 'B']);
});

test('a floor pull can cover several items', () => {
  const { events, add } = makeLog();
  mkReq(add, 'r1', 0);
  add(1000, 'r1', 'accepted', { role: 'runner' });
  add(2000, 'r1', 'floor_pull_requested', { taskId: 't1', itemId: 'A', rack: 'A4', items: [{ itemId: 'A', rack: 'A4' }, { itemId: 'B', rack: 'A5' }] });
  add(2000, 'r1', 'floor_pull_requested', { taskId: 't2', itemId: 'C', rack: 'B1' }); // older shape
  const d = deriveAll(events);
  assert.deepEqual(d.byId.t1.items.map((i) => i.rack), ['A4', 'A5']);
  assert.deepEqual(d.byId.t2.items, [{ itemId: 'C', rack: 'B1' }]);
});

// ---------- staffing ----------
test('each request has a skill from its garment, and tasks inherit their request\'s', () => {
  const { events, add } = makeLog();
  add(0, 'r1', 'created', { room: 2, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [], parsed: null, method: 'none' });
  add(0, 'r1', 'routed', { role: 'runner', rule: 'x' });
  add(0, 'r2', 'created', { room: 3, skuId: 'WX-M-REG', issue: 'too_tight', chips: [], parsed: null, method: 'none' });
  add(0, 'r3', 'created', { room: 4, skuId: 'CH-32-SLIM', issue: 'too_long', chips: [], parsed: null, method: 'none' });
  add(7000, 'r1', 'floor_pull_requested', { taskId: 't1', itemId: 'OX-M-REG', rack: 'A4' });
  const d = deriveAll(events);
  assert.deepEqual([d.byId.r1.skill, d.byId.r2.skill, d.byId.r3.skill, d.byId.t1.skill], ['Men|shirt', 'Women|shirt', 'Men|trousers', 'Men|shirt']);
});

test('assigned events build the assignment list; "open" opens the request to everyone; accepts record who and which tier', () => {
  const { events, add } = makeLog();
  add(0, 'r1', 'created', { room: 2, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [], parsed: null, method: 'none' });
  add(0, 'r1', 'routed', { role: 'runner', rule: 'x' });
  add(0, 'r1', 'assigned', { tier: 'primary', staffId: 's_a' });
  let r = deriveAll(events).byId.r1;
  assert.deepEqual(r.assignments, [{ tier: 'primary', staffId: 's_a', ts: 0 }]);
  assert.equal(r.openToAll, false);
  add(20_000, 'r1', 'assigned', { tier: 'secondary', staffId: 's_b' });
  add(40_000, 'r1', 'assigned', { tier: 'open', staffId: null });
  r = deriveAll(events).byId.r1;
  assert.deepEqual(r.assignments.map((a) => a.tier), ['primary', 'secondary', 'open']);
  assert.equal(r.openToAll, true);
  add(41_000, 'r1', 'accepted', { role: 'runner', staffId: 's_b', tier: 'secondary' });
  r = deriveAll(events).byId.r1;
  assert.deepEqual([r.acceptedStaffId, r.acceptedTier], ['s_b', 'secondary']);
  const { events: old, add: addOld } = makeLog();
  addOld(0, 'r2', 'created', { room: 3, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [], parsed: null, method: 'none' });
  addOld(5, 'r2', 'accepted', { role: 'runner' }); // an accept from before staffing existed
  const o = deriveAll(old).byId.r2;
  assert.deepEqual([o.acceptedStaffId, o.acceptedTier, o.assignments], [null, null, []]);
});

// ---------- escalation per stage ----------
const mk = (add, id = 'r1') => {
  add(0, id, 'created', { room: 1, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [], parsed: null, method: 'none' });
  add(0, id, 'routed', { role: 'runner', rule: 'x' });
};
const cfg2 = makeConfig({ ACCEPT_ESCALATE_SECONDS: '120', DELIVER_ESCALATE_SECONDS: '60' });

test('each stage has its own limits; warn is half of the stage time', () => {
  assert.deepEqual(stageLimits(cfg2, 'accept'), { warnSeconds: 60, escalateSeconds: 120 });
  assert.deepEqual(stageLimits(cfg2, 'deliver'), { warnSeconds: 30, escalateSeconds: 60 });
});

test('stage: waiting to be accepted, then waiting to be delivered, then none', () => {
  const { events, add } = makeLog();
  mk(add);
  assert.equal(stageOf(deriveAll(events).byId.r1), 'accept');
  add(30_000, 'r1', 'accepted', { role: 'runner' });
  assert.equal(stageOf(deriveAll(events).byId.r1), 'deliver');
  add(50_000, 'r1', 'on_the_way', { room: 1, itemId: 'OX-M-REG', itemLabel: 'x' });
  assert.equal(stageOf(deriveAll(events).byId.r1), 'deliver'); // set off, not yet handed over
  add(60_000, 'r1', 'delivered', {}, 'runner');
  assert.equal(stageOf(deriveAll(events).byId.r1), null);
});

test('the delivery clock starts at accept, not at creation', () => {
  const { events, add } = makeLog();
  mk(add);
  add(100_000, 'r1', 'accepted', { role: 'runner' });
  const r = deriveAll(events).byId.r1;
  assert.equal(cardState(r, 130_000, cfg2), 'warn');       // 30 s into a 60 s delivery stage
  assert.equal(cardState(r, 160_000, cfg2), 'escalated');  // 60 s in, although 160 s since creation
  const t = timerFor(r, 130_000, cfg2);
  assert.deepEqual([t.stage, t.startTs, t.endTs, t.warnSeconds, t.escalateSeconds], ['deliver', 100_000, null, 30, 60]);
});

test('an escalation clears when the request is accepted, and the next stage escalates on its own clock', () => {
  const { events, add } = makeLog();
  mk(add);
  add(125_000, 'r1', 'escalated', { level: 1, stage: 'accept' });
  let r = deriveAll(events).byId.r1;
  assert.equal(r.escalated, true);
  assert.equal(r.escalatedStage, 'accept');
  add(130_000, 'r1', 'accepted', { role: 'runner' });
  r = deriveAll(events).byId.r1;
  assert.equal(r.escalated, false);                         // no longer shown as escalated
  assert.equal(cardState(r, 150_000, cfg2), 'normal');      // 20 s into the delivery stage
  assert.deepEqual(r.escalations.map((x) => x.stage), ['accept']); // but the history is kept
  add(195_000, 'r1', 'escalated', { level: 1, stage: 'deliver' });
  r = deriveAll(events).byId.r1;
  assert.equal(r.escalated, true);
  assert.equal(r.escalatedStage, 'deliver');
  assert.deepEqual(r.escalations.map((x) => x.stage), ['accept', 'deliver']);
  add(200_000, 'r1', 'on_the_way', { room: 1, itemId: 'OX-M-REG', itemLabel: 'x' });
  assert.equal(deriveAll(events).byId.r1.escalated, true);  // set off is not delivered: still escalated
  add(205_000, 'r1', 'delivered', {}, 'runner');
  assert.equal(deriveAll(events).byId.r1.escalated, false); // handed over: clear again
});

test('legacy escalated events without a stage are placed by the status at the time', () => {
  const { events, add } = makeLog();
  mk(add);
  add(125_000, 'r1', 'escalated', { level: 1 });
  assert.equal(deriveAll(events).byId.r1.escalatedStage, 'accept');
});

test('floor pulls have the same two stages (accept, then handed over)', () => {
  const { events, add } = makeLog();
  mk(add);
  add(10, 'r1', 'accepted', { role: 'runner' });
  add(20, 'r1', 'floor_pull_requested', { taskId: 't1', itemId: 'OX-M-REG', rack: 'A4' });
  add(30, 't1', 'escalated', { level: 1, stage: 'accept' });
  assert.equal(deriveAll(events).byId.t1.escalated, true);
  add(40, 't1', 'accepted', { role: 'floor' });
  assert.equal(deriveAll(events).byId.t1.escalated, false);
  assert.equal(stageOf(deriveAll(events).byId.t1), 'deliver');
  add(50, 't1', 'floor_pull_done', {});
  assert.equal(stageOf(deriveAll(events).byId.t1), null);
});

test('assist is per escalation: a second escalation can be assisted again, by the team that is not working it', () => {
  const { events, add } = makeLog();
  mk(add);
  add(125_000, 'r1', 'escalated', { level: 1, stage: 'accept' });
  add(126_000, 'r1', 'assisted', { byRole: 'floor' });
  add(127_000, 'r1', 'accepted', { role: 'floor' });
  let r = deriveAll(events).byId.r1;
  assert.equal(ownerRole(r), 'floor');
  assert.equal(r.assistedNow, false);                        // escalation cleared
  assert.equal(r.assistedBy, 'floor');                       // still the one working it
  add(200_000, 'r1', 'escalated', { level: 1, stage: 'deliver' });
  r = deriveAll(events).byId.r1;
  assert.equal(r.assistedNow, false);
  const d = deriveAll(events);
  assert.deepEqual(buildAssistQueue('runner', d).offer.map((x) => x.id), ['r1']); // runner is offered it now
  assert.deepEqual(buildAssistQueue('floor', d).offer, []);                        // not the team that owns it
  add(201_000, 'r1', 'assisted', { byRole: 'runner' });
  r = deriveAll(events).byId.r1;
  assert.deepEqual([r.assistedBy, r.assistedNow], ['runner', true]);
  assert.equal(r.assistLog.length, 2);
});

// ---------- cancelling a floor pull ----------
test('a cancelled floor pull is not open, is not done, and keeps its parent', () => {
  const { events, add } = makeLog();
  add(0, 'r1', 'created', { room: 1, skuId: 'OX-M-SLIM', issue: 'too_tight', chips: [], parsed: null, method: 'none' });
  add(0, 'r1', 'routed', { role: 'runner', rule: 'x' });
  add(1, 'r1', 'accepted', { role: 'runner' });
  add(2, 'r1', 'floor_pull_requested', { taskId: 't1', itemId: 'OX-M-REG', rack: 'A4' });
  add(3, 't1', 'floor_pull_cancelled', { byRole: 'runner' });
  const d = deriveAll(events);
  assert.equal(d.byId.t1.status, 'cancelled');
  assert.equal(d.byId.t1.cancelledTs, 3);
  assert.deepEqual(d.byId.r1.floorTaskIds, ['t1']);
  assert.deepEqual(buildQueue('floor', d, 10), []); // gone from the floor queue
  add(4, 't1', 'floor_pull_done', {}); // a late event cannot revive it
  assert.equal(deriveAll(events).byId.t1.status, 'cancelled');
});

// ---------- delivered, try-on feedback, follow-ups ----------
const onWay = (add, id = 'r1') => {
  add(0, id, 'created', { room: 1, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [], parsed: null, method: 'none' });
  add(0, id, 'routed', { role: 'runner', rule: 'x' });
  add(10_000, id, 'accepted', { role: 'runner' });
  add(20_000, id, 'on_the_way', { room: 1, itemId: 'OX-M-REG', itemLabel: 'Oxford' });
};

test('the delivery stage lasts until the item is handed to the customer, not until the runner sets off', () => {
  const { events, add } = makeLog();
  onWay(add);
  assert.equal(stageOf(deriveAll(events).byId.r1), 'deliver');         // on the way, not yet handed over
  const lim = makeConfig({ DELIVER_ESCALATE_SECONDS: '60' });
  assert.equal(cardState(deriveAll(events).byId.r1, 75_000, lim), 'escalated'); // 65 s since accept
  add(30_000, 'r1', 'delivered', {}, 'runner');
  const r = deriveAll(events).byId.r1;
  assert.equal(r.deliveredTs, 30_000);
  assert.equal(r.status, 'on_the_way');                                // the request stays open: the customer is trying it on
  assert.equal(stageOf(r), null);
  const t = timerFor(r, 999_000, config);
  assert.deepEqual([t.startTs, t.endTs], [10_000, 30_000]);            // frozen at the delivery time
});

test('an escalation of the delivery stage clears when the item is handed over, not when it is confirmed', () => {
  const { events, add } = makeLog();
  onWay(add);
  add(130_000, 'r1', 'escalated', { level: 1, stage: 'deliver' });
  assert.equal(deriveAll(events).byId.r1.escalated, true);
  add(140_000, 'r1', 'delivered', {}, 'runner');
  assert.equal(deriveAll(events).byId.r1.escalated, false);
});

test('a withdrawn trip is not delivered; try-on feedback and follow-ups are derived', () => {
  const { events, add } = makeLog();
  onWay(add);
  add(30_000, 'r1', 'delivered', {}, 'runner');
  add(60_000, 'r1', 'tryon_feedback', { result: 'not_right' }, 'customer');
  add(70_000, 'r2', 'created', { room: 1, skuId: 'OX-M-REG', issue: 'too_loose', chips: [], parsed: null, method: 'none', followsId: 'r1' }, 'customer');
  const d = deriveAll(events);
  assert.deepEqual([d.byId.r1.tryOn.result, d.byId.r1.tryOn.ts], ['not_right', 60_000]);
  assert.equal(d.byId.r2.followsId, 'r1');
  assert.equal(d.byId.r1.tryOn && d.byId.r2.tryOn, null);
  add(80_000, 'r1', 'inventory_discrepancy', { skuId: 'OX-M-REG', rack: 'A4' });
  assert.equal(deriveAll(events).byId.r1.deliveredTs, null);           // nothing is on its way any more
});

test('the customer steps say Delivered once the item has been handed over', () => {
  const { events, add } = makeLog();
  onWay(add);
  assert.match(customerSteps(deriveAll(events).byId.r1)[2].label, /^On the way to Room 1/);
  add(30_000, 'r1', 'delivered', {}, 'runner');
  assert.match(customerSteps(deriveAll(events).byId.r1)[2].label, /^Delivered to Room 1/);
});

// ---------- restock tasks (dispatched from the Manager) ----------
const restock = (add, ts, taskId, skuId, kind, rack) => add(ts, taskId, 'restock_task_created', { taskId, skuId, kind, rack, signalKind: kind === 'recount' ? 'inventory' : 'high_demand' }, 'manager');

test('a restock task is a floor task with no request behind it, ranked below customer work, and never escalated', () => {
  const { events, add } = makeLog();
  mkReq(add, 'r1', 0);
  add(1, 'r1', 'accepted', { role: 'runner' });
  add(2, 'r1', 'floor_pull_requested', { taskId: 'pull', itemId: 'OX-M-REG', rack: 'A4' });
  restock(add, 3, 'rs1', 'OX-M-REG', 'recount', 'A4');
  const d = deriveAll(events);
  const t = d.byId.rs1;
  assert.deepEqual([t.kind, t.taskType, t.restockKind, t.skuId, t.parentId, t.room, t.status], ['task', 'restock', 'recount', 'OX-M-REG', null, null, 'requested']);
  assert.deepEqual(t.route, { role: 'floor', rule: 'restock task -> floor associate' });
  assert.equal(t.skill, 'Men|shirt');
  assert.deepEqual(buildQueue('floor', d, 10).map((x) => x.id), ['pull', 'rs1']); // the customer's pull first
  assert.equal(stageOf(t), null);                                                 // no escalation clock
  assert.equal(cardState(t, 9_999_999, config), 'normal');
});

test('finishing a recount clears the earlier "not on rack" reports for that item; a replenish clears earlier demand', () => {
  const { events, add } = makeLog();
  mkReq(add, 'r1', 0);
  add(1, 'r1', 'accepted', { role: 'runner' });
  add(2, 'r1', 'suggestion_shown', { kind: 'alternative', itemId: 'OX-M-REG' });
  add(3, 'r1', 'inventory_discrepancy', { skuId: 'OX-M-REG', rack: 'A4' });
  assert.equal(deriveAll(events).discrepancies['OX-M-REG'], 1);
  restock(add, 4, 'rs1', 'OX-M-REG', 'recount', 'A4');
  add(5, 'rs1', 'accepted', { role: 'floor' }, 'floor');
  assert.equal(deriveAll(events).discrepancies['OX-M-REG'], 1);   // not cleared until the recount is done
  add(6, 'rs1', 'restock_task_done', {}, 'floor');
  const d = deriveAll(events);
  assert.equal(d.byId.rs1.status, 'done');
  assert.equal(d.discrepancies['OX-M-REG'], 0);
  assert.equal(d.recounts['OX-M-REG'], 6);
  restock(add, 7, 'rs2', 'OX-L-REG', 'replenish', 'A5');
  add(8, 'rs2', 'accepted', { role: 'floor' }, 'floor'); add(9, 'rs2', 'restock_task_done', {}, 'floor');
  assert.equal(deriveAll(events).replenished['OX-L-REG'], 9);
});

// ---------- room sessions and the kept item ----------
test('a room release starts a new session for later requests, and requests remember their last activity', () => {
  const { events, add } = makeLog();
  mkReq(add, 'r1', 0);
  add(5_000, 'r1', 'accepted', { role: 'runner' });
  add(9_000, 'room:2', 'room_released', { room: 2, by: 'customer' }, 'customer');
  mkReq(add, 'r2', 10_000);
  const d = deriveAll(events);
  assert.deepEqual([d.byId.r1.sessionStartTs, d.byId.r2.sessionStartTs], [0, 9_000]);
  assert.equal(d.byId.r1.lastTs, 5_000);
  assert.equal(d.rooms[2].releasedTs, 9_000);
  assert.equal(d.byId.r2.lastTs, 10_000);
});

test('the kept item comes from the close, or is the only item of a single-item trip', () => {
  const { events, add } = makeLog();
  mkReq(add, 'r1', 0); add(1, 'r1', 'accepted', { role: 'runner' });
  add(2, 'r1', 'on_the_way', { room: 1, itemId: 'OX-M-REG', itemLabel: 'a', items: [{ itemId: 'OX-M-REG', itemLabel: 'a' }, { itemId: 'OX-XL-REG', itemLabel: 'b' }] });
  add(3, 'r1', 'closed', { outcome: 'bought_alternative', itemId: 'OX-XL-REG' });
  mkReq(add, 'r2', 0); add(1, 'r2', 'accepted', { role: 'runner' });
  add(2, 'r2', 'on_the_way', { room: 1, itemId: 'OX-M-REG', itemLabel: 'a', items: [{ itemId: 'OX-M-REG', itemLabel: 'a' }] });
  add(3, 'r2', 'closed', { outcome: 'bought_alternative' });
  mkReq(add, 'r3', 0); add(1, 'r3', 'accepted', { role: 'runner' });
  add(2, 'r3', 'on_the_way', { room: 1, itemId: 'OX-M-REG', itemLabel: 'a', items: [{ itemId: 'OX-M-REG', itemLabel: 'a' }, { itemId: 'OX-XL-REG', itemLabel: 'b' }] });
  add(3, 'r3', 'closed', { outcome: 'bought_alternative' });
  mkReq(add, 'r4', 0); add(1, 'r4', 'accepted', { role: 'runner' }); add(3, 'r4', 'closed', { outcome: 'left' });
  const d = deriveAll(events);
  assert.deepEqual([d.byId.r1.keptItemId, d.byId.r2.keptItemId, d.byId.r3.keptItemId, d.byId.r4.keptItemId], ['OX-XL-REG', 'OX-M-REG', null, null]);
});

// ---------- one hand-over, whoever does it ----------
test('who handed the items over is remembered, and a pull cancelled because of it says why', () => {
  const { events, add } = makeLog();
  onWay(add);
  add(25_000, 'r1', 'floor_pull_requested', { taskId: 't1', itemId: 'OX-M-REG', rack: 'A4' }, 'runner');
  add(30_000, 'r1', 'delivered', {}, 'floor');
  add(30_001, 't1', 'floor_pull_cancelled', { byRole: 'system', reason: 'handed_over' }, 'system');
  const d = deriveAll(events);
  assert.equal(d.byId.r1.deliveredBy, 'floor');
  assert.deepEqual([d.byId.t1.status, d.byId.t1.cancelReason], ['cancelled', 'handed_over']);
});
