import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOGUE, getSku } from '../shared/catalogue.js';
import { mergeIssue, fitMatch } from '../shared/fitMatch.js';
import { normaliseIssues, issuesLabel, toggleIssue } from '../shared/events.js';
import { deriveAll } from '../shared/derive.js';
import { computeMetrics } from '../shared/metrics.js';
import { makeConfig } from '../shared/config.js';
import { makeLog } from './helpers.js';

const config = makeConfig();
const sku = (id) => getSku(id);
const run = (id, args) => {
  const s = sku(id);
  return fitMatch({ sku: s, issueInfo: mergeIssue({ sku: s, ...args }), catalogue: CATALOGUE, config });
};

test('normaliseIssues: one or two fit issues that do not contradict; anything else stays on its own', () => {
  assert.deepEqual(normaliseIssues(['too_tight']), ['too_tight']);
  assert.deepEqual(normaliseIssues(['too_tight', 'too_long']), ['too_tight', 'too_long']);
  assert.deepEqual(normaliseIssues(['too_short', 'too_loose', 'too_short']), ['too_short', 'too_loose']); // de-duplicated, order kept
  assert.deepEqual(normaliseIssues(['another_size']), ['another_size']);
  assert.throws(() => normaliseIssues([]), /issue/i);
  assert.throws(() => normaliseIssues(['nope']), /unknown/i);
  assert.throws(() => normaliseIssues(['too_tight', 'too_loose']), /contradict|opposite/i);
  assert.throws(() => normaliseIssues(['too_long', 'too_short']), /contradict|opposite/i);
  assert.throws(() => normaliseIssues(['too_tight', 'another_size']), /fit issues/i);
  assert.throws(() => normaliseIssues(['too_tight', 'too_long', 'too_short']), /two|contradict/i);
  assert.equal(issuesLabel(['too_tight', 'too_long']), 'Too tight + Too long');
});

test('mergeIssue with two issues: each gets its own area, from the tapped chip of its kind, else a default', () => {
  const both = mergeIssue({ sku: sku('OX-M-SLIM'), issue: 'too_tight', issues: ['too_tight', 'too_short'], chips: ['shoulders', 'sleeves'] });
  assert.deepEqual([both.primary.word, both.primary.area, both.primary.measure, both.primary.dir], ['tight', 'shoulders', 'shoulder', 1]);
  assert.deepEqual([both.secondary.word, both.secondary.area, both.secondary.measure, both.secondary.dir], ['short', 'sleeves', 'sleeve', 1]);
  assert.deepEqual(both.issues, ['too_tight', 'too_short']);

  const defaults = mergeIssue({ sku: sku('OX-M-SLIM'), issue: 'too_tight', issues: ['too_tight', 'too_short'], chips: [] });
  assert.deepEqual([defaults.primary.area, defaults.primary.areaSource, defaults.secondary.area, defaults.secondary.source], ['chest', 'default', 'length', 'default']);

  const trousers = mergeIssue({ sku: sku('CH-32-SLIM'), issue: 'too_tight', issues: ['too_tight', 'too_long'], chips: ['hips'] });
  assert.deepEqual([trousers.primary.area, trousers.primary.measure, trousers.secondary.area, trousers.secondary.measure], ['hips', 'hip', 'length', 'inseam']);

  const extra = mergeIssue({ sku: sku('OX-M-SLIM'), issue: 'too_tight', issues: ['too_tight', 'too_short'], chips: ['chest', 'waist'] });
  assert.equal(extra.primary.area, 'chest');
  assert.ok(extra.notes.some((n) => /waist/.test(n)), 'the extra area of the same kind is mentioned, not silently dropped');
});

test('a single issue behaves exactly as before', () => {
  const one = mergeIssue({ sku: sku('OX-M-SLIM'), issue: 'too_tight', issues: ['too_tight'], chips: ['chest', 'waist'] });
  assert.equal(one.secondary.area, 'waist'); // the old "extra chip" rule
  assert.equal(mergeIssue({ sku: sku('OX-M-SLIM'), issue: 'too_tight', chips: [] }).issues?.[0] ?? 'too_tight', 'too_tight');
});

test('tight + short: every suggested item gives more room AND more length', () => {
  const s = sku('OX-M-SLIM');
  const r = run('OX-M-SLIM', { issue: 'too_tight', issues: ['too_tight', 'too_short'], chips: [] });
  assert.equal(r.kind, 'alternative');
  assert.ok(r.options.length >= 1);
  for (const o of r.options) {
    const alt = sku(o.itemId);
    assert.ok(alt.m.chest > s.m.chest, `${o.itemId} has more chest`);
    assert.ok(alt.m.length > s.m.length, `${o.itemId} is longer`);
    assert.equal(o.fixesSecondary, true);
    assert.match(o.reason, /chest/);
    assert.match(o.reason, /length/);
    assert.doesNotMatch(o.reason, /does not fix/);
  }
});

test('loose + long: smaller on both', () => {
  const s = sku('OX-L-REG');
  const r = run('OX-L-REG', { issue: 'too_loose', issues: ['too_loose', 'too_long'], chips: [] });
  assert.equal(r.kind, 'alternative');
  for (const o of r.options) {
    const alt = sku(o.itemId);
    assert.ok(alt.m.chest < s.m.chest && alt.m.length < s.m.length, o.itemId);
  }
});

test('when no item fixes both, items that fix the first issue are shown and the one left unfixed is named', () => {
  const r = run('OX-L-SLIM', { issue: 'too_tight', issues: ['too_tight', 'too_long'], chips: [] }); // chest and length grow together
  assert.equal(r.kind, 'alternative');
  assert.ok(r.options.length >= 1);
  for (const o of r.options) {
    assert.equal(o.fixesSecondary, false);
    assert.match(o.reason, /does not fix body length/);
  }
});

test('trousers: tight waist + too long with no shorter pair in stock mentions hemming', () => {
  const r = run('CH-32-SLIM', { issue: 'too_tight', issues: ['too_tight', 'too_long'], chips: [] });
  assert.equal(r.kind, 'alternative');
  assert.ok(r.options.every((o) => /hemm/i.test(o.reason)), 'hemming is offered for the length');
  const off = fitMatch({ sku: sku('CH-32-SLIM'), issueInfo: mergeIssue({ sku: sku('CH-32-SLIM'), issue: 'too_tight', issues: ['too_tight', 'too_long'], chips: [] }), catalogue: CATALOGUE, config: makeConfig({ ALTERATION_OFFERED: 'false' }) });
  assert.ok(off.options.every((o) => !/hemm/i.test(o.reason)));
});

test('derive: issues come from the event; older events have just the one issue', () => {
  const { events, add } = makeLog();
  add(0, 'r1', 'created', { room: 1, skuId: 'OX-M-SLIM', issue: 'too_tight', issues: ['too_tight', 'too_short'], chips: [], parsed: null, method: 'none' });
  add(0, 'r2', 'created', { room: 2, skuId: 'OX-M-SLIM', issue: 'too_loose', chips: [], parsed: null, method: 'none' });
  const d = deriveAll(events);
  assert.deepEqual(d.byId.r1.issues, ['too_tight', 'too_short']);
  assert.equal(d.byId.r1.issue, 'too_tight');
  assert.deepEqual(d.byId.r2.issues, ['too_loose']);
});

test('metrics: a request with two issues counts in both of its areas on the heatmap', () => {
  const { events, add } = makeLog();
  add(0, 'r1', 'created', { room: 1, skuId: 'OX-M-SLIM', issue: 'too_tight', issues: ['too_tight', 'too_short'], chips: ['chest', 'sleeves'], parsed: null, method: 'none' });
  add(0, 'r1', 'routed', { role: 'runner', rule: 'x' });
  const m = computeMetrics(events);
  const row = m.heatmap.rows[0];
  assert.equal(row.cells.chest.more, 1);   // too tight
  assert.equal(row.cells.sleeves.more, 1); // too short: needed more length
  assert.equal(row.total, 2);
  const top = m.bySku[0].issueCounts.map((c) => `${c.issue}|${c.area}`).sort();
  assert.deepEqual(top, ['too_short|sleeves', 'too_tight|chest']);
});

test('toggleIssue: fit issues add up to two, the opposite swaps in, and anything else stands alone', () => {
  assert.deepEqual(toggleIssue([], 'too_tight'), ['too_tight']);
  assert.deepEqual(toggleIssue(['too_tight'], 'too_long'), ['too_tight', 'too_long']);
  assert.deepEqual(toggleIssue(['too_tight', 'too_long'], 'too_tight'), ['too_long']);          // tapping again removes it
  assert.deepEqual(toggleIssue(['too_tight', 'too_long'], 'too_loose'), ['too_long', 'too_loose']); // the opposite replaces
  assert.deepEqual(toggleIssue(['too_tight'], 'another_size'), ['another_size']);
  assert.deepEqual(toggleIssue(['another_size'], 'too_short'), ['too_short']);
  assert.deepEqual(toggleIssue(['too_tight'], 'check_stock'), ['check_stock']);
});
