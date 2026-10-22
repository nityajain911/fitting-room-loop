import test from 'node:test';
import assert from 'node:assert/strict';
import { combineSuggestions } from '../shared/fitMatch.js';
import { deriveAll } from '../shared/derive.js';
import { pickAssignee } from '../shared/staffing.js';
import { makeLog } from './helpers.js';

const sug = (originalId, ids, extra = {}) => ({ kind: 'alternative', originalId, itemId: ids[0], options: ids.map((itemId) => ({ itemId, reason: `for ${originalId}` })), reason: `r-${originalId}`, ...extra });

test('one picked item: the suggestion is the engine\'s, with every option tagged with its baseline', () => {
  const out = combineSuggestions([{ baseId: 'A', s: sug('A', ['a1', 'a2']) }], 3);
  assert.deepEqual(out.options.map((o) => [o.itemId, o.forId]), [['a1', 'A'], ['a2', 'A']]);
  assert.deepEqual([out.kind, out.itemId, out.originalId], ['alternative', 'a1', 'A']);
});

test('several picked items: the best option for each first, then the next best of each, capped at the trip size', () => {
  const a = sug('A', ['a1', 'a2', 'a3']);
  const b = sug('B', ['b1', 'a2']);                                  // b's second choice is something a already offered
  assert.deepEqual(combineSuggestions([{ baseId: 'A', s: a }, { baseId: 'B', s: b }], 3).options.map((o) => [o.itemId, o.forId]), [['a1', 'A'], ['b1', 'B'], ['a2', 'A']]);
  assert.deepEqual(combineSuggestions([{ baseId: 'A', s: a }, { baseId: 'B', s: b }], 5).options.map((o) => o.itemId), ['a1', 'b1', 'a2', 'a3']); // no item twice
  assert.deepEqual(combineSuggestions([{ baseId: 'A', s: a }, { baseId: 'B', s: b }], 1).options.map((o) => o.itemId), ['a1']);
  const out = combineSuggestions([{ baseId: 'A', s: a }, { baseId: 'B', s: b }], 3);
  assert.deepEqual([out.kind, out.itemId, out.originalId, out.baselines], ['alternative', 'a1', 'A', ['A', 'B']]);
  assert.deepEqual(out.perBaseline.map((x) => [x.forId, x.kind]), [['A', 'alternative'], ['B', 'alternative']]);
});

test('a picked item with nothing in stock does not block the others, and is reported', () => {
  const none = { kind: 'no_alternative', originalId: 'B', reason: 'Nothing else in stock' };
  const out = combineSuggestions([{ baseId: 'A', s: sug('A', ['a1']) }, { baseId: 'B', s: none }], 3);
  assert.deepEqual(out.options.map((o) => o.itemId), ['a1']);
  assert.deepEqual(out.perBaseline.map((x) => [x.forId, x.kind]), [['A', 'alternative'], ['B', 'no_alternative']]);
  assert.match(out.reason, /B/);                                       // the associate is told which item had nothing
});

test('nothing for any picked item: the first reason is kept (hemming, cross-store, none) with no items', () => {
  const out = combineSuggestions([
    { baseId: 'A', s: { kind: 'alteration_or_crossstore', originalId: 'A', reason: 'No shorter inseam; hemming', drivers: [] } },
    { baseId: 'B', s: { kind: 'no_alternative', originalId: 'B', reason: 'Nothing' } },
  ], 3);
  assert.equal(out.kind, 'alteration_or_crossstore');
  assert.deepEqual(out.options ?? [], []);
  assert.equal(out.itemId, undefined);
});

// ---- the previous owner gets the new attempt first
const person = (id, over = {}) => ({ id, label: id, type: 'runner', primary: ['Men|shirt'], secondary: [], onShift: true, ...over });
const makeItem = (over = {}) => {
  const { events, add } = makeLog();
  add(0, 'r1', 'created', { room: 1, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [], parsed: null, method: 'none' }, 'customer');
  add(0, 'r1', 'routed', { role: 'runner', rule: 'x' });
  add(1, 'r1', 'accepted', { role: 'runner', staffId: over.owner ?? 's_busy', tier: 'primary' }, 'runner');
  add(2, 'r1', 'on_the_way', { room: 1, itemId: 'OX-M-REG', itemLabel: 'a', items: [{ itemId: 'OX-M-REG', itemLabel: 'a', forId: 'OX-L-SLIM' }] }, 'runner');
  add(3, 'r1', 'delivered', {}, 'runner');
  add(4, 'r1', 'round_opened', { baselineIds: ['OX-M-REG'], issue: 'too_loose', issues: ['too_loose'], chips: [], styleAxes: [], parsed: null, method: 'none' }, 'customer');
  const d = deriveAll(events);
  return { d, item: d.byId.r1 };
};
const ctx = (roster, d) => ({ roster, derived: d, now: 10, isActive: () => true, primaryWaitMs: 20_000, secondaryWaitMs: 20_000 });

test('the new attempt goes to the same person first, even if somebody else is less busy', () => {
  const { d, item } = makeItem();
  const roster = [person('s_busy'), person('s_free')];
  // s_busy holds nothing now (the request is waiting again) but was the one who took it; s_free was never given anything either
  assert.equal(pickAssignee(item, 'primary', ctx(roster, d)).id, 's_busy');
});

test('if the same person is off shift or on another team, it is assigned the normal way', () => {
  const { d, item } = makeItem();
  assert.equal(pickAssignee(item, 'primary', ctx([person('s_busy', { onShift: false }), person('s_free')], d)).id, 's_free');
  assert.equal(pickAssignee(item, 'primary', ctx([person('s_busy', { type: 'floor' }), person('s_free')], d)).id, 's_free');
  assert.equal(pickAssignee(item, 'primary', { ...ctx([person('s_busy'), person('s_free')], d), isActive: (id) => id !== 's_busy' }).id, 's_free');
});

test('the preference also holds when the previous owner does not cover the section, but never for a request in its first attempt', () => {
  const { d, item } = makeItem();
  assert.equal(pickAssignee(item, 'primary', ctx([person('s_busy', { primary: [] }), person('s_free')], d)).id, 's_busy');
  const { events, add } = makeLog();
  add(0, 'r9', 'created', { room: 1, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [], parsed: null, method: 'none' }, 'customer');
  add(0, 'r9', 'routed', { role: 'runner', rule: 'x' });
  const first = deriveAll(events);
  assert.equal(pickAssignee(first.byId.r9, 'primary', ctx([person('s_busy', { primary: [] }), person('s_free')], first)).id, 's_free');
});
