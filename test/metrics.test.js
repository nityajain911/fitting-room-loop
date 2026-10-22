import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics } from '../shared/metrics.js';
import { demoLog, makeLog } from './helpers.js';

test('no events -> no invented numbers', () => {
  const m = computeMetrics([]);
  assert.equal(m.closed, 0);
  assert.equal(m.saveRate, null);
  assert.equal(m.deferredRate, null);
  assert.equal(m.medianAcceptMs, null);
  assert.equal(m.suggestionAcceptance, null);
});

test('save rate is 100% after the first request is bought_alternative, then 50% after a "left"', () => {
  const log = demoLog();
  const firstOnly = log.filter((e) => e.requestId === 'r1' || e.requestId === 'f1');
  assert.equal(computeMetrics(firstOnly).saveRate, 1);
  const m = computeMetrics(log);
  assert.equal(m.saveRate, 0.5);
  assert.equal(m.saves, 1);
  assert.equal(m.closed, 2);
});

test('counts, medians, outcome mix, acceptance, escalations', () => {
  const m = computeMetrics(demoLog());
  assert.deepEqual([m.open, m.accepted, m.closed, m.total], [0, 0, 2, 2]);
  assert.equal(m.medianAcceptMs, 15000); // (10000 + 20000) / 2
  assert.equal(m.medianCloseMs, 60000); // (70000 + 50000) / 2
  assert.deepEqual(m.outcomeMix, { bought_original: 0, bought_alternative: 1, cross_store_order: 0, saved_for_later: 0, left: 1 });
  assert.equal(m.suggestionAcceptance, 0.5); // 1 confirmed, 1 rejected
  assert.equal(m.escalations, 0);
  assert.equal(m.floorPullsRequested, 1);
  assert.equal(m.floorPullsDone, 1);
});

test('floor tasks are excluded from request counts', () => {
  const m = computeMetrics(demoLog());
  assert.equal(m.total, 2);
});

test('saved_for_later is reported as deferred, separate from the save rate', () => {
  const { events, add } = makeLog();
  const mk = (id, outcome) => {
    add(0, id, 'created', { room: 1, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [], parsed: null, method: 'none' });
    add(1, id, 'routed', { role: 'runner', rule: 'x' });
    add(2, id, 'closed', { outcome });
  };
  mk('a', 'bought_original');
  mk('b', 'saved_for_later');
  mk('c', 'cross_store_order');
  mk('d', 'left');
  const m = computeMetrics(events);
  assert.equal(m.saveRate, 0.5); // original + cross-store out of 4
  assert.equal(m.deferredRate, 0.25);
});

test('reasons are grouped by evidence type, latest reason per request wins', () => {
  const log = demoLog();
  assert.deepEqual(computeMetrics(log).reasons.byEvidence['customer-stated'], [{ tag: 'time_constraint', count: 1 }]);
  assert.deepEqual(computeMetrics(log).reasons.byEvidence['system-observed'], []);
  log.push({ seq: 99, id: 'e99', ts: 170000, requestId: 'r2', type: 'reason_added', actor: 'runner',
    payload: { reason_tag: 'price', summary_en: 'x', evidence_type: 'associate-observed', confidence: 0.4, method: 'rule_fallback', edited: true } });
  const m = computeMetrics(log);
  assert.deepEqual(m.reasons.byEvidence['customer-stated'], []);
  assert.deepEqual(m.reasons.byEvidence['associate-observed'], [{ tag: 'price', count: 1 }]);
  assert.equal(m.reasons.total, 1);
});

test('escalations count requests, floor-task escalations are separate', () => {
  const log = demoLog();
  log.push({ seq: 100, id: 'e100', ts: 1, requestId: 'r1', type: 'escalated', actor: 'system', payload: { level: 1 } });
  log.push({ seq: 101, id: 'e101', ts: 1, requestId: 'f1', type: 'escalated', actor: 'system', payload: { level: 1 } });
  const m = computeMetrics(log);
  assert.equal(m.escalations, 1);
  assert.equal(m.floorTaskEscalations, 1);
});

test('parse methods are counted from created events', () => {
  const m = computeMetrics(demoLog());
  assert.deepEqual(m.parseMethods, { ai: 0, fallback: 1, none: 1 });
});

// ---------- cancellation, escalations, per-SKU breakdown ----------
const mk = (add, id, ts, over = {}) => {
  add(ts, id, 'created', { room: 2, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [], parsed: null, method: 'none', ...over });
  add(ts, id, 'routed', { role: 'runner', rule: 'x' });
};

test('cancelled requests are counted separately and never enter the save-rate denominator', () => {
  const { events, add } = makeLog();
  mk(add, 'a', 0); add(1, 'a', 'accepted', { role: 'runner' }); add(2, 'a', 'closed', { outcome: 'bought_original' });
  mk(add, 'b', 10); add(11, 'b', 'cancelled', { stage: 'requested' });
  mk(add, 'c', 20); add(21, 'c', 'accepted', { role: 'runner' }); add(22, 'c', 'cancelled', { stage: 'accepted' });
  mk(add, 'd', 30);
  const m = computeMetrics(events);
  assert.equal(m.total, 4);
  assert.equal(m.closed, 1);
  assert.equal(m.saveRate, 1);
  assert.equal(m.cancelled, 2);
  assert.deepEqual(m.cancelledByStage, { requested: 1, accepted: 1, on_the_way: 0 });
  assert.equal(m.open, 1);
  assert.equal(m.open + m.accepted + m.closed + m.cancelled, m.total);
  assert.equal(m.outcomeMix.left, 0);
});

test('openEscalations lists open escalated requests and floor tasks only', () => {
  const { events, add } = makeLog();
  mk(add, 'a', 0); add(100, 'a', 'escalated', { level: 1 });
  mk(add, 'b', 0); add(100, 'b', 'escalated', { level: 1 }); add(150, 'b', 'accepted', { role: 'runner' }); add(200, 'b', 'closed', { outcome: 'left' });
  mk(add, 'c', 0); add(100, 'c', 'escalated', { level: 1 }); add(150, 'c', 'cancelled', { stage: 'requested' });
  mk(add, 'd', 0); add(50, 'd', 'accepted', { role: 'runner' });
  add(60, 'd', 'floor_pull_requested', { taskId: 't1', itemId: 'OX-M-REG', rack: 'A4' });
  add(500, 't1', 'escalated', { level: 1 });
  const m = computeMetrics(events);
  assert.deepEqual([...m.openEscalations].sort(), ['a', 't1']);
  assert.equal(m.escalations, 3); // a, b, c — all customer requests that ever escalated
});

const skuLog = () => {
  const { events, add } = makeLog();
  // 3 requests on the Oxford L Slim: two "too tight, waist tapped", one "too long" with no area
  mk(add, 'a', 0, { chips: ['waist'] });
  add(1, 'a', 'accepted', { role: 'runner' });
  add(2, 'a', 'suggestion_shown', { kind: 'alternative', itemId: 'OX-M-REG' });
  add(3, 'a', 'closed', { outcome: 'bought_alternative' });
  mk(add, 'b', 10, { chips: ['waist'] });
  add(11, 'b', 'accepted', { role: 'runner' });
  add(12, 'b', 'suggestion_shown', { kind: 'no_alternative', itemId: null });
  add(13, 'b', 'closed', { outcome: 'left' });
  mk(add, 'c', 20, { issue: 'too_long' });
  add(21, 'c', 'cancelled', { stage: 'requested' });
  // 1 request on chinos
  mk(add, 'd', 30, { skuId: 'CH-32-SLIM', issue: 'too_long' });
  add(31, 'd', 'accepted', { role: 'runner' });
  add(32, 'd', 'suggestion_shown', { kind: 'alteration_or_crossstore', itemId: null });
  return events;
};

test('bySku groups by garment+size+cut with top issue/area, save rate and stock-gap signal', () => {
  const m = computeMetrics(skuLog());
  assert.deepEqual(m.bySku.map((s) => s.skuId), ['OX-L-SLIM', 'CH-32-SLIM']); // sorted by request count
  const ox = m.bySku[0];
  assert.equal(ox.n, 3);
  assert.equal(ox.cancelled, 1);
  assert.equal(ox.closed, 2);
  assert.equal(ox.saveRate, 0.5);
  assert.deepEqual(ox.topIssue, { issue: 'too_tight', area: 'waist', count: 2 });
  assert.equal(ox.suggested, 2);
  assert.equal(ox.noAlternative, 1);
  const ch = m.bySku[1];
  assert.equal(ch.saveRate, null); // nothing closed yet
  assert.equal(ch.noAlternative, 1);
});

test('bySku never invents an area: defaulted areas are reported without one', () => {
  const ch = computeMetrics(skuLog()).bySku.find((s) => s.skuId === 'CH-32-SLIM');
  assert.deepEqual(ch.topIssue, { issue: 'too_long', area: null, count: 1 });
});

test('bySku is empty with no events', () => {
  assert.deepEqual(computeMetrics([]).bySku, []);
  assert.deepEqual(computeMetrics([]).openEscalations, []);
  assert.equal(computeMetrics([]).cancelled, 0);
});

// ---------- friction metrics and store signals ----------
import { makeConfig } from '../shared/config.js';
const cfg = makeConfig();

const frictionLog = () => {
  const { events, add } = makeLog();
  // 4 Oxford L Slim requests, 3 of them "too tight · waist" (tapped)
  for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) {
    mk(add, id, i * 10, id === 'd' ? { issue: 'too_long' } : { chips: ['waist'] });
    add(i * 10 + 1, id, 'accepted', { role: 'runner' });
    add(i * 10 + 2, id, 'suggestion_shown', { kind: id === 'a' || id === 'b' ? 'alternative' : 'no_alternative', itemId: id === 'a' || id === 'b' ? 'OX-M-REG' : null });
  }
  add(50, 'a', 'inventory_discrepancy', { skuId: 'OX-M-REG', rack: 'A4' });
  add(51, 'a', 'suggestion_shown', { kind: 'no_alternative', itemId: null });
  add(52, 'b', 'item_declined', { itemId: 'OX-M-REG' });
  add(60, 'a', 'escalated', { level: 1 });
  add(70, 'a', 'assisted', { byRole: 'floor' });
  add(80, 'b', 'escalated', { level: 1 });
  return events;
};

test('friction metrics: discrepancies, declined items, assists and time-to-assist', () => {
  const m = computeMetrics(frictionLog(), undefined, cfg);
  assert.deepEqual(m.inventoryDiscrepancies, { total: 1, bySku: [{ skuId: 'OX-M-REG', count: 1, racks: ['A4'] }] });
  assert.equal(m.itemsDeclined, 1);
  assert.equal(m.assists, 1);
  assert.equal(m.medianAssistMs, 10); // assisted at 70, escalated at 60
  assert.equal(m.escalations, 2);
});

test('bySku carries per-SKU stock-accuracy and declined counts', () => {
  const ox = computeMetrics(frictionLog(), undefined, cfg).bySku.find((s) => s.skuId === 'OX-L-SLIM');
  assert.equal(ox.n, 4);
  assert.equal(ox.declined, 1);
  assert.equal(ox.missing, 0); // the missing SKU is the alternative (OX-M-REG), not the requested garment
  const alt = computeMetrics(frictionLog(), undefined, cfg).inventoryDiscrepancies.bySku[0];
  assert.equal(alt.skuId, 'OX-M-REG');
});

test('signals fire only above the prototype thresholds and read as observations', () => {
  const m = computeMetrics(frictionLog(), undefined, cfg);
  const kinds = m.signals.map((s) => s.kind);
  assert.deepEqual(kinds, ['inventory', 'fit', 'stock_gap']);
  const fit = m.signals.find((s) => s.kind === 'fit');
  assert.equal(fit.skuId, 'OX-L-SLIM');
  assert.deepEqual([fit.count, fit.of], [3, 4]);
  assert.match(fit.text, /3 of 4 requests/);
  assert.match(fit.text, /Too tight · Waist/);
  const inv = m.signals.find((s) => s.kind === 'inventory');
  assert.equal(inv.skuId, 'OX-M-REG');
  assert.match(inv.text, /reported missing on the rack 1 time/);
  const gap = m.signals.find((s) => s.kind === 'stock_gap');
  assert.deepEqual([gap.count, gap.of], [3, 4]);   // 'a' (re-suggested after the discrepancy), 'c' and 'd'
});

test('signals stay quiet below thresholds (small n, low share) and never invent a number', () => {
  const quiet = computeMetrics(frictionLog(), undefined, makeConfig({ SIGNAL_MIN_N: '5', SIGNAL_MIN_SHARE: '0.9', SIGNAL_MIN_MISSES: '2' }));
  assert.deepEqual(quiet.signals, []);
  assert.deepEqual(computeMetrics([], undefined, cfg).signals, []);
  assert.ok(!frictionTexts().some((t) => /move \d+ units/i.test(t)));
});
const frictionTexts = () => computeMetrics(frictionLog(), undefined, cfg).signals.map((s) => s.text);

test('non-fit issues (another size/style) never produce a fit signal', () => {
  const { events, add } = makeLog();
  for (const id of ['a', 'b', 'c']) mk(add, id, 0, { issue: 'another_size' });
  assert.deepEqual(computeMetrics(events, undefined, cfg).signals, []);
});

// ---------- recommended actions and the high-demand signal ----------
test('every signal carries a concrete, quantity-free recommended action with a severity', () => {
  const m = computeMetrics(frictionLog(), undefined, cfg);
  const by = Object.fromEntries(m.signals.map((s) => [s.kind, s.action]));
  assert.deepEqual(by.inventory, { label: 'Audit rack A4: stock record reported wrong', severity: 'high' });
  assert.deepEqual(by.fit, { label: 'Flag fit to the buying team', severity: 'medium' });
  assert.equal(by.stock_gap.severity, 'medium');
  assert.match(by.stock_gap.label, /stock depth/i);
  for (const s of m.signals) assert.ok(!/\d+\s*(units|pieces)/i.test(s.action.label), 'no invented quantities');
});

test('a replacement brought to the fitting room at least twice raises a high-demand signal', () => {
  const { events, add } = makeLog();
  const brought = (id, item, t) => {
    mk(add, id, t);
    add(t + 1, id, 'accepted', { role: 'runner' });
    add(t + 2, id, 'suggestion_shown', { kind: 'alternative', itemId: item });
    add(t + 3, id, 'suggestion_confirmed', { itemId: item });
    add(t + 3, id, 'on_the_way', { room: 2, itemId: item, itemLabel: 'x' });
  };
  brought('a', 'OX-M-REG', 0);
  assert.ok(!computeMetrics(events, undefined, cfg).signals.some((s) => s.kind === 'high_demand')); // once is not a pattern
  brought('b', 'OX-M-REG', 10);
  brought('c', 'PO-M-REG', 20);
  const sig = computeMetrics(events, undefined, cfg).signals.filter((s) => s.kind === 'high_demand');
  assert.equal(sig.length, 1);
  assert.deepEqual([sig[0].skuId, sig[0].count], ['OX-M-REG', 2]);
  assert.match(sig[0].text, /brought to the fitting room 2 times/);
  assert.equal(sig[0].action.label, 'Keep a buffer near the fitting rooms');
  assert.equal(sig[0].action.severity, 'low');
});

test('an item that was withdrawn (not on rack) or on a cancelled request is not counted as brought', () => {
  const { events, add } = makeLog();
  for (const [id, t] of [['a', 0], ['b', 10]]) {
    mk(add, id, t);
    add(t + 1, id, 'accepted', { role: 'runner' });
    add(t + 2, id, 'suggestion_shown', { kind: 'alternative', itemId: 'OX-M-REG' });
    add(t + 3, id, 'suggestion_confirmed', { itemId: 'OX-M-REG' });
    add(t + 3, id, 'on_the_way', { room: 2, itemId: 'OX-M-REG', itemLabel: 'x' });
  }
  add(30, 'a', 'inventory_discrepancy', { skuId: 'OX-M-REG', rack: 'A4' }); // never actually delivered
  add(31, 'b', 'cancelled', { stage: 'on_the_way' });
  assert.ok(!computeMetrics(events, undefined, cfg).signals.some((s) => s.kind === 'high_demand'));
});

// ---------- garment x body-area fit heatmap ----------
test('heatmap counts fit issues by garment+cut and body area, split into "needed more" and "needed less"', () => {
  const { events, add } = makeLog();
  const req = (id, sku, issue, chips) => { mk(add, id, 0, { skuId: sku, issue, chips }); };
  req('a', 'PL-M-SLIM', 'too_tight', ['waist']);
  req('b', 'PL-M-SLIM', 'too_tight', ['waist']);
  req('c', 'PL-M-SLIM', 'too_loose', ['waist']);
  req('d', 'PL-M-SLIM', 'too_short', ['sleeves']);
  req('e', 'OX-L-SLIM', 'too_long', ['length']);
  req('f', 'OX-L-SLIM', 'too_tight', []);          // no area stated -> plotted in the "not specified" column, never hidden
  req('g', 'OX-L-SLIM', 'another_size', []);        // not a fit issue
  req('h', 'CH-32-SLIM', 'too_tight', ['hips']);
  const h = computeMetrics(events, undefined, cfg).heatmap;
  const pl = h.rows.find((r) => r.label === 'Poplin Shirt · Slim');
  assert.deepEqual(pl.cells.waist, { more: 2, less: 1 });
  assert.deepEqual(pl.cells.sleeves, { more: 1, less: 0 }); // "too short" means it needed more length
  assert.equal(h.rows.find((r) => r.label === 'Oxford Shirt · Slim').cells.length.less, 1); // "too long" -> needed less
  assert.deepEqual(h.rows.find((r) => r.label === 'Chinos · Slim').cells.hips, { more: 1, less: 0 });
  assert.deepEqual(h.rows.find((r) => r.label === 'Oxford Shirt · Slim').cells.general, { more: 1, less: 0 });
  assert.ok(h.areas.includes('general'));
  assert.equal(h.rows.find((r) => r.label === 'Oxford Shirt · Slim').total, 2);
  // every fit request is in the matrix: the cells add up to the fit requests (a, b, c, d, e, f, h)
  assert.equal(h.rows.reduce((n, r) => n + r.total, 0), 7);
  assert.equal(h.max, 3);
  assert.equal(h.rows[0].label, 'Poplin Shirt · Slim'); // busiest row first
});

test('heatmap is empty with no events, and never invents an area', () => {
  const h = computeMetrics([], undefined, cfg).heatmap;
  assert.deepEqual([h.rows.length, h.max], [0, 0]);
});

test('every item brought in a trip counts as delivered, so a high-demand signal sees all of them', () => {
  const { events, add } = makeLog();
  for (const [id, t] of [['a', 0], ['b', 10]]) {
    mk(add, id, t);
    add(t + 1, id, 'accepted', { role: 'runner' });
    add(t + 2, id, 'suggestion_shown', { kind: 'alternative', itemId: 'OX-M-REG' });
    add(t + 3, id, 'suggestion_confirmed', { itemId: 'OX-M-REG', itemIds: ['OX-M-REG', 'OX-XL-REG'] });
    add(t + 3, id, 'on_the_way', { room: 2, itemId: 'OX-M-REG', itemLabel: 'x +1 more', items: [{ itemId: 'OX-M-REG', itemLabel: 'a' }, { itemId: 'OX-XL-REG', itemLabel: 'b' }] });
  }
  const high = computeMetrics(events, undefined, cfg).signals.filter((s) => s.kind === 'high_demand').map((s) => s.skuId).sort();
  assert.deepEqual(high, ['OX-M-REG', 'OX-XL-REG']);
});

// ---------- staffing ----------
test('routing: time to accept and save rate by which tier took the request (primary / secondary / open)', () => {
  const { events, add } = makeLog();
  const one = (id, t, tier, acceptAfter, outcome) => {
    mk(add, id, t);
    add(t + acceptAfter, id, 'accepted', { role: 'runner', staffId: 's1', tier });
    if (outcome) add(t + acceptAfter + 1000, id, 'closed', { outcome });
  };
  one('a', 0, 'primary', 4000, 'bought_alternative');
  one('b', 100, 'primary', 8000, 'bought_original');
  one('c', 200, 'secondary', 26000, 'left');
  one('d', 300, 'open', 50000, 'bought_alternative');
  mk(add, 'e', 400); add(401, 'e', 'accepted', { role: 'runner' }); // an accept from before staffing existed
  const m = computeMetrics(events, undefined, cfg).routing;
  assert.deepEqual([m.primary.n, m.secondary.n, m.open.n], [2, 1, 1]);
  assert.equal(m.primary.medianAcceptMs, 6000);
  assert.equal(m.open.medianAcceptMs, 50000);
  assert.deepEqual([m.primary.closed, m.primary.saves, m.primary.saveRate], [2, 2, 1]);
  assert.equal(m.secondary.saveRate, 0);
  assert.equal(m.open.saveRate, 1);
  assert.equal(m.recorded, 4); // the accept with no tier is not counted as a tier...
  assert.equal(m.unassigned.n, 1); // ...but it is accounted for: taken from the shared queue, before any team was set up
  assert.equal(m.primaryShare, 0.5);
});

test('routing is empty and honest with no data', () => {
  const m = computeMetrics([], undefined, cfg).routing;
  assert.deepEqual([m.primary.n, m.recorded, m.primaryShare], [0, 0, null]);
  assert.equal(m.primary.saveRate, null);
  assert.equal(m.primary.medianAcceptMs, null);
});

test('"why requests did not convert" ignores reasons on requests that did convert (older logs)', () => {
  const { events, add } = makeLog();
  mk(add, 'sale', 0); add(1, 'sale', 'accepted', { role: 'runner' }); add(2, 'sale', 'closed', { outcome: 'bought_alternative' });
  add(3, 'sale', 'reason_added', { reason_tag: 'price', summary_en: 'x', evidence_type: 'customer-stated', confidence: 1, method: 'quick_pick' });
  mk(add, 'lost', 0); add(1, 'lost', 'accepted', { role: 'runner' }); add(2, 'lost', 'closed', { outcome: 'left' });
  add(3, 'lost', 'reason_added', { reason_tag: 'price', summary_en: 'x', evidence_type: 'customer-stated', confidence: 1, method: 'quick_pick' });
  const m = computeMetrics(events, undefined, cfg);
  assert.equal(m.reasons.total, 1);
  assert.deepEqual(m.reasons.byEvidence['customer-stated'], [{ tag: 'price', count: 1 }]);
});

test('floor pulls: cancelled ones are counted apart, not as requested or done', () => {
  const { events, add } = makeLog();
  mk(add, 'a', 0); add(1, 'a', 'accepted', { role: 'runner' });
  add(2, 'a', 'floor_pull_requested', { taskId: 't1', itemId: 'OX-M-REG', rack: 'A4' });
  add(3, 'a', 'floor_pull_requested', { taskId: 't2', itemId: 'OX-M-REG', rack: 'A4' });
  add(4, 't1', 'floor_pull_cancelled', { byRole: 'runner' });
  add(5, 't2', 'accepted', { role: 'floor' }); add(6, 't2', 'floor_pull_done', {});
  const m = computeMetrics(events);
  assert.deepEqual([m.floorPullsRequested, m.floorPullsDone, m.floorPullsCancelled], [1, 1, 1]);
});

// ---------- delivered / try-on / follow-ups ----------
test('delivery is accept to handed over; set-off and try-on times are separate; try-on feedback is counted', () => {
  const { events, add } = makeLog();
  const trip = (id, accepted, onWayAt, deliveredAt, closedAt, tryOn) => {
    mk(add, id, 0); add(accepted, id, 'accepted', { role: 'runner' });
    add(onWayAt, id, 'on_the_way', { room: 2, itemId: 'OX-M-REG', itemLabel: 'x' });
    if (deliveredAt) add(deliveredAt, id, 'delivered', {}, 'runner');
    if (tryOn) add(deliveredAt + 1, id, 'tryon_feedback', { result: tryOn }, 'customer');
    if (closedAt) add(closedAt, id, 'closed', { outcome: 'bought_alternative' });
  };
  trip('a', 10_000, 20_000, 50_000, 170_000, 'fits');
  trip('b', 0, 10_000, 70_000, 250_000, 'not_right');
  trip('c', 5_000, 8_000, null, null, null);                     // set off but not handed over yet
  const m = computeMetrics(events);
  assert.equal(m.medianDeliverMs, 55_000);                       // accept -> handed over: 40 s and 70 s
  assert.equal(m.medianDispatchMs, 10_000);                      // accept -> on the way: 10 s, 10 s, 3 s
  assert.equal(m.medianTryOnMs, 150_000);                        // delivered -> closed: 120 s and 180 s
  assert.deepEqual(m.tryOn, { fits: 1, notRight: 1 });
  assert.equal(m.delivered, 2);
});


// ---------- restock tasks and signals ----------
const missingOnRack = (add, id, ts, skuId = 'OX-M-REG', rack = 'A4') => {
  mk(add, id, ts); add(ts + 1, id, 'accepted', { role: 'runner' });
  add(ts + 2, id, 'suggestion_shown', { kind: 'alternative', itemId: skuId });
  add(ts + 3, id, 'inventory_discrepancy', { skuId, rack });
};

test('an inventory signal can be dispatched as a recount; the signal shows it is dispatched, and finishing it clears the signal', () => {
  const { events, add } = makeLog();
  missingOnRack(add, 'a', 0);
  let m = computeMetrics(events, undefined, cfg);
  const sig = m.signals.find((x) => x.kind === 'inventory');
  assert.deepEqual(sig.dispatch, { kind: 'recount', skuId: 'OX-M-REG', rack: 'A4' });
  assert.equal(sig.dispatched, null);
  add(10, 'rs1', 'restock_task_created', { taskId: 'rs1', skuId: 'OX-M-REG', kind: 'recount', rack: 'A4', signalKind: 'inventory' }, 'manager');
  m = computeMetrics(events, undefined, cfg);
  assert.deepEqual(m.signals.find((x) => x.kind === 'inventory').dispatched, { taskId: 'rs1', status: 'requested' });
  add(11, 'rs1', 'accepted', { role: 'floor' }, 'floor');
  assert.equal(computeMetrics(events, undefined, cfg).signals.find((x) => x.kind === 'inventory').dispatched.status, 'accepted');
  add(12, 'rs1', 'restock_task_done', {}, 'floor');
  m = computeMetrics(events, undefined, cfg);
  assert.equal(m.signals.some((x) => x.kind === 'inventory'), false);   // the recount closed it
  assert.equal(m.inventoryDiscrepancies.total, 0);
  missingOnRack(add, 'b', 20);                                           // missing again after the recount: a new signal
  assert.equal(computeMetrics(events, undefined, cfg).signals.some((x) => x.kind === 'inventory'), true);
});

test('high demand is dispatched as a replenish; finishing it resets the count from then on', () => {
  const { events, add } = makeLog();
  for (const [id, t] of [['a', 0], ['b', 10]]) {
    mk(add, id, t); add(t + 1, id, 'accepted', { role: 'runner' });
    add(t + 2, id, 'on_the_way', { room: 2, itemId: 'OX-M-REG', itemLabel: 'x' });
  }
  let m = computeMetrics(events, undefined, cfg);
  assert.deepEqual(m.signals.find((x) => x.kind === 'high_demand').dispatch, { kind: 'replenish', skuId: 'OX-M-REG', rack: getSkuRack('OX-M-REG') });
  add(30, 'rs1', 'restock_task_created', { taskId: 'rs1', skuId: 'OX-M-REG', kind: 'replenish', rack: getSkuRack('OX-M-REG'), signalKind: 'high_demand' }, 'manager');
  add(31, 'rs1', 'accepted', { role: 'floor' }, 'floor'); add(32, 'rs1', 'restock_task_done', {}, 'floor');
  assert.equal(computeMetrics(events, undefined, cfg).signals.some((x) => x.kind === 'high_demand'), false);
});

test('restock tasks are counted apart from customer floor pulls', () => {
  const { events, add } = makeLog();
  mk(add, 'a', 0); add(1, 'a', 'accepted', { role: 'runner' });
  add(2, 'a', 'floor_pull_requested', { taskId: 'p1', itemId: 'OX-M-REG', rack: 'A4' });
  add(3, 'rs1', 'restock_task_created', { taskId: 'rs1', skuId: 'OX-M-REG', kind: 'recount', rack: 'A4', signalKind: 'inventory' }, 'manager');
  add(4, 'rs1', 'accepted', { role: 'floor' }, 'floor'); add(5, 'rs1', 'restock_task_done', {}, 'floor');
  add(6, 'rs2', 'restock_task_created', { taskId: 'rs2', skuId: 'OX-L-REG', kind: 'replenish', rack: 'A5', signalKind: 'high_demand' }, 'manager');
  const m = computeMetrics(events, undefined, cfg);
  assert.deepEqual([m.floorPullsRequested, m.floorPullsDone], [1, 0]);
  assert.deepEqual(m.restock, { requested: 2, done: 1, open: 1 });
});

import { getSku as getCatalogueSku } from '../shared/catalogue.js';
const getSkuRack = (id) => getCatalogueSku(id).rack;

test('hand-overs are counted by who did them', () => {
  const { events, add } = makeLog();
  const trip = (id, who) => { mk(add, id, 0); add(1, id, 'accepted', { role: 'runner' }); add(2, id, 'on_the_way', { room: 2, itemId: 'OX-M-REG', itemLabel: 'x' }); add(3, id, 'delivered', {}, who); };
  trip('a', 'runner'); trip('b', 'floor'); trip('c', 'floor');
  assert.deepEqual(computeMetrics(events).deliveredBy, { runner: 1, floor: 2 });
});

// ---------- attempts (rounds) ----------
const twoRounds = (add, id, close = true) => {
  mk(add, id, 0); add(10_000, id, 'accepted', { role: 'runner' });
  add(20_000, id, 'on_the_way', { room: 2, itemId: 'OX-M-REG', itemLabel: 'a', items: [{ itemId: 'OX-M-REG', itemLabel: 'a', forId: 'OX-L-SLIM' }, { itemId: 'OX-XL-SLIM', itemLabel: 'b', forId: 'OX-L-SLIM' }] });
  add(40_000, id, 'delivered', {}, 'runner');
  add(50_000, id, 'tryon_feedback', { result: 'not_right' }, 'customer');
  add(60_000, id, 'round_opened', { baselineIds: ['OX-M-REG'], issue: 'too_loose', issues: ['too_loose'], chips: ['waist'], styleAxes: [], parsed: null, method: 'none' }, 'customer');
  add(100_000, id, 'accepted', { role: 'runner' });
  add(110_000, id, 'on_the_way', { room: 2, itemId: 'OX-L-REG', itemLabel: 'c', items: [{ itemId: 'OX-L-REG', itemLabel: 'c', forId: 'OX-M-REG' }] });
  add(150_000, id, 'delivered', {}, 'floor');
  if (close) add(200_000, id, 'closed', { outcome: 'bought_alternative', itemId: 'OX-L-REG' });
};

test('the headline times come from the first attempt; later attempts are counted separately', () => {
  const { events, add } = makeLog();
  twoRounds(add, 'a');
  const m = computeMetrics(events);
  assert.equal(m.medianAcceptMs, 10_000);        // created -> first accept
  assert.equal(m.medianDeliverMs, 30_000);       // first attempt: accept 10 s -> handed over 40 s
  assert.equal(m.medianDispatchMs, 10_000);      // accept 10 s -> on the way 20 s
  assert.deepEqual([m.total, m.closed, m.saves, m.saveRate], [1, 1, 1, 1]);   // one request, one outcome
  assert.deepEqual([m.retried, m.savedAfterRetry, m.rounds], [1, 1, 2]);
  assert.deepEqual(m.deliveredBy, { runner: 1, floor: 1 });
  assert.deepEqual(m.tryOn, { fits: 0, notRight: 1 });
  assert.equal(m.medianTryOnMs, 50_000);         // last handed over 150 s -> closed 200 s
});

test('every attempt counts: items brought in either one are demand, and fit reports of later baselines are plotted', () => {
  const { events, add } = makeLog();
  twoRounds(add, 'a'); twoRounds(add, 'b');
  const m = computeMetrics(events, undefined, cfg);
  const high = m.signals.filter((x) => x.kind === 'high_demand').map((x) => x.skuId).sort();
  assert.deepEqual(high, ['OX-L-REG', 'OX-M-REG', 'OX-XL-SLIM']);              // each brought twice, across both attempts
  const rows = m.heatmap.rows.map((r) => r.label);
  assert.ok(rows.includes('Oxford Shirt · Regular'));                          // the second attempt's baseline (M Regular) too loose
  const reg = m.heatmap.rows.find((r) => r.label === 'Oxford Shirt · Regular');
  assert.deepEqual(reg.cells.waist, { more: 0, less: 2 });
});

test('a request that is still in its second attempt is open, not closed, and counted once', () => {
  const { events, add } = makeLog();
  twoRounds(add, 'a', false);
  const m = computeMetrics(events);
  assert.deepEqual([m.total, m.closed, m.retried, m.savedAfterRetry], [1, 0, 1, 0]);
});
