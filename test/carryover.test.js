import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOGUE } from '../shared/catalogue.js';
import { deriveAll } from '../shared/derive.js';
import { carryoverFor } from '../shared/carryover.js';
import { makeConfig } from '../shared/config.js';
import { makeLog } from './helpers.js';

const cfg = makeConfig();
const req = (add, id, ts, skuId, room = 3, over = {}) => {
  add(ts, id, 'created', { room, skuId, issue: 'too_tight', chips: [], parsed: null, method: 'none', ...over }, 'customer');
  add(ts, id, 'routed', { role: 'runner', rule: 'x' });
};
// A request whose customer kept `keptId`: confirmed, on its way, handed over, closed as bought_alternative.
const kept = (add, id, ts, skuId, keptId, room = 3) => {
  req(add, id, ts, skuId, room);
  add(ts + 1, id, 'accepted', { role: 'runner' });
  add(ts + 2, id, 'on_the_way', { room, itemId: keptId, itemLabel: 'x', items: [{ itemId: keptId, itemLabel: 'x' }, { itemId: 'OX-M-REG', itemLabel: 'y' }] });
  add(ts + 3, id, 'closed', { outcome: 'bought_alternative', itemId: keptId });
};
const run = (events, id, catalogue = CATALOGUE) => carryoverFor(deriveAll(events).byId[id], deriveAll(events), catalogue, cfg);

test('sized up on a poplin shirt, so an oxford shirt in the same room suggests the matching step up', () => {
  const { events, add } = makeLog();
  kept(add, 'a', 0, 'PL-M-SLIM', 'PL-L-REG');
  req(add, 'b', 100_000, 'OX-M-SLIM');
  const c = run(events, 'b');
  assert.equal(c.suggestedId, 'OX-L-REG');                      // chest +8, waist +13 and the rest, carried across
  assert.deepEqual([c.fromId, c.keptId], ['PL-M-SLIM', 'PL-L-REG']);
  assert.ok(c.deltas.some((d) => d.measure === 'waist' && d.delta === 13));
  assert.match(c.text, /Poplin Shirt/);
  assert.match(c.text, /OX-L-REG|L Regular/);
});

test('nothing is carried across rooms, past a release, from non-purchases, or when the kept item is unknown', () => {
  let { events, add } = makeLog();
  kept(add, 'a', 0, 'PL-M-SLIM', 'PL-L-REG', 4);
  req(add, 'b', 100_000, 'OX-M-SLIM', 3);
  assert.equal(run(events, 'b'), null);                          // another room

  ({ events, add } = makeLog());
  kept(add, 'a', 0, 'PL-M-SLIM', 'PL-L-REG');
  add(50_000, 'room:3', 'room_released', { room: 3, by: 'customer' }, 'customer');
  req(add, 'b', 100_000, 'OX-M-SLIM');
  assert.equal(run(events, 'b'), null);                          // the visit ended: the next customer starts clean

  ({ events, add } = makeLog());
  req(add, 'a', 0, 'PL-M-SLIM'); add(1, 'a', 'accepted', { role: 'runner' });
  add(2, 'a', 'on_the_way', { room: 3, itemId: 'PL-L-REG', itemLabel: 'x', items: [{ itemId: 'PL-L-REG', itemLabel: 'x' }] });
  add(3, 'a', 'closed', { outcome: 'left' });
  req(add, 'b', 100_000, 'OX-M-SLIM');
  assert.equal(run(events, 'b'), null);                          // they walked away, so nothing was learned

  ({ events, add } = makeLog());
  req(add, 'a', 0, 'PL-M-SLIM'); add(1, 'a', 'accepted', { role: 'runner' });
  add(2, 'a', 'on_the_way', { room: 3, itemId: 'PL-L-REG', itemLabel: 'x', items: [{ itemId: 'PL-L-REG', itemLabel: 'x' }, { itemId: 'PL-L-SLIM', itemLabel: 'y' }] });
  add(3, 'a', 'closed', { outcome: 'bought_alternative' });      // two items were brought and nobody said which was kept
  req(add, 'b', 100_000, 'OX-M-SLIM');
  assert.equal(run(events, 'b'), null);
});

test('a single-item trip that ended in a purchase counts as the kept item, even without being named', () => {
  const { events, add } = makeLog();
  req(add, 'a', 0, 'PL-M-SLIM'); add(1, 'a', 'accepted', { role: 'runner' });
  add(2, 'a', 'on_the_way', { room: 3, itemId: 'PL-L-REG', itemLabel: 'x', items: [{ itemId: 'PL-L-REG', itemLabel: 'x' }] });
  add(3, 'a', 'closed', { outcome: 'bought_alternative' });
  req(add, 'b', 100_000, 'OX-M-SLIM');
  assert.equal(run(events, 'b').keptId, 'PL-L-REG');
});

test('only like with like: same department and the same kind of measurements; and only a real change is worth a hint', () => {
  let { events, add } = makeLog();
  kept(add, 'a', 0, 'PL-M-SLIM', 'PL-L-REG');
  req(add, 'b', 100_000, 'CH-32-SLIM');                          // chinos: other measurements
  assert.equal(run(events, 'b'), null);

  ({ events, add } = makeLog());
  kept(add, 'a', 0, 'PL-M-SLIM', 'PL-M-REG');                    // same size, other cut: a small step
  req(add, 'b', 100_000, 'OX-M-SLIM');
  const c = run(events, 'b');
  assert.ok(c === null || c.suggestedId !== 'OX-M-SLIM');        // never "bring what they already asked for"
});

test('the suggested item has to be in stock; the next closest fit is used when the best is not', () => {
  const { events, add } = makeLog();
  kept(add, 'a', 0, 'PL-M-SLIM', 'PL-L-REG');
  req(add, 'b', 100_000, 'OX-M-SLIM');
  const noBest = CATALOGUE.map((s) => (s.id === 'OX-L-REG' ? { ...s, stock: 0 } : s));
  const c = run(events, 'b', noBest);
  assert.notEqual(c?.suggestedId, 'OX-L-REG');
  assert.ok(c === null || noBest.find((s) => s.id === c.suggestedId).stock > 0);
});

test('the most recent purchase in the visit is the one carried across', () => {
  const { events, add } = makeLog();
  kept(add, 'a', 0, 'PL-M-SLIM', 'PL-L-REG');
  kept(add, 'b', 50_000, 'PL-L-REG', 'PL-L-SLIM');
  req(add, 'c', 100_000, 'OX-M-SLIM');
  assert.equal(run(events, 'c').fromId, 'PL-L-REG');
});
