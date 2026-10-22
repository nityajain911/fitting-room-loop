import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeIssue, fitMatch } from '../shared/fitMatch.js';
import { makeConfig, DEFAULTS } from '../shared/config.js';
import { priceWithDelta, declinedPricier } from '../shared/pricing.js';
import { heatCellText } from '../shared/visuals.js';
import { computeMetrics } from '../shared/metrics.js';
import { QUICK_REASONS, REASON_LABELS } from '../shared/events.js';
import { makeLog } from './helpers.js';

const config = makeConfig();

// ---------- the price band ----------
const ATTRS = {
  A: { collar: 'Button-down', pattern: 'Solid', fabric: 'Oxford' },
  B: { collar: 'Spread', pattern: 'Solid', fabric: 'Oxford' },
  C: { collar: 'Button-down', pattern: 'Stripe', fabric: 'Oxford' },
  D: { collar: 'Button-down', pattern: 'Solid', fabric: 'Poplin' },
};
const mk = (id, line, price, colour = 'White') => ({
  id, line, name: 'Shirt', category: 'shirt', fabric: ATTRS[line].fabric.toLowerCase(), styleName: `${ATTRS[line].collar} · ${ATTRS[line].pattern}`,
  attrs: ATTRS[line], size: 'L', cut: 'Slim', colour, stock: 2, rack: 'X1', price, m: { chest: 112, waist: 98, shoulder: 47, sleeve: 66, length: 77 },
});
const style = (cat, cfg = config) => {
  const sku = cat[0];
  return fitMatch({ sku, issueInfo: mergeIssue({ sku, issue: 'another_style', chips: [], styleAxes: [], parsed: null }), catalogue: cat, config: cfg });
};

test('the price band is a prototype setting: ±₹500 by default, changeable', () => {
  assert.equal(DEFAULTS.maxPriceDelta, 500);
  assert.equal(makeConfig().maxPriceDelta, 500);
  assert.equal(makeConfig({ MAX_PRICE_DELTA: '800' }).maxPriceDelta, 800);
});

test('an alternative style outside the band is not suggested while one inside it exists', () => {
  const r = style([mk('A', 'A', 5000), mk('B', 'B', 5500), mk('C', 'C', 5800), mk('D', 'D', 4600)]);
  const ids = r.options.map((o) => o.itemId);
  assert.deepEqual(ids.sort(), ['B', 'D']);                               // 5500 is exactly +500 and 4600 is −400: inside; 5800 (+800) is outside
  assert.ok(r.options.every((o) => !o.outsideBand));
});

test('with nothing inside the band, the nearest outside it is offered and says so', () => {
  const r = style([mk('A', 'A', 5000), mk('B', 'B', 6200), mk('C', 'C', 5700)]);
  assert.equal(r.kind, 'alternative_style');
  assert.deepEqual(r.options.map((o) => [o.itemId, o.outsideBand]), [['C', true], ['B', true]]);   // closest price first
});

test('equally good designs: the closer in price comes first, before colour and measurements', () => {
  const near = mk('C', 'C', 5100);   // later in the alphabet, so only the price can put it first
  const far = mk('B', 'B', 5400);
  const r = style([mk('A', 'A', 5000), far, near]);
  assert.equal(r.itemId, 'C');
  assert.deepEqual(r.options.map((o) => o.itemId), ['C', 'B']);
});

test('without prices (older data) nothing changes', () => {
  const noPrice = (x) => { const { price, ...rest } = x; return rest; };
  const r = style([mk('A', 'A', 5000), mk('B', 'B', 5100), mk('C', 'C', 9000)].map(noPrice));
  assert.equal(r.options.length, 2);
  assert.ok(r.options.every((o) => !o.outsideBand));
});

test('fit issues: the price tie-break never beats fixing the issue', () => {
  const base = { ...mk('A', 'A', 5000), size: 'L', cut: 'Slim' };
  const alt = (id, price, waist) => ({ ...mk(id, 'A', price), size: id, cut: 'Regular', m: { ...base.m, waist } });
  const cat = [base, alt('M', 5000, 99), alt('XL', 5400, 106)];  // XL fixes "too tight" far better but costs more (inside the band)
  const sku = cat[0];
  const r = fitMatch({ sku, issueInfo: mergeIssue({ sku, issue: 'too_tight', chips: ['waist'], parsed: null }), catalogue: cat, config });
  assert.ok(r.options.length >= 1);
  assert.ok(r.options.every((o) => o.diffs.find((d) => d.measure === 'waist').delta >= 1));   // everything offered fixes it
});

// ---------- how a price reads ----------
test('a price with its difference from what the customer has', () => {
  assert.equal(priceWithDelta({ price: 4999 }, { price: 4999 }), '₹4,999 (Same price)');
  assert.equal(priceWithDelta({ price: 5299 }, { price: 4999 }), '₹5,299 (+₹300)');
  assert.equal(priceWithDelta({ price: 4699 }, { price: 4999 }), '₹4,699 (−₹300)');
  assert.equal(priceWithDelta({ price: 12999 }, { price: 4999 }), '₹12,999 (+₹8,000)');
  assert.equal(priceWithDelta({ price: 4999 }, null), '₹4,999');
  assert.equal(priceWithDelta({}, { price: 4999 }), '');
});

test('declining an alternative that costs more than what the customer started with', () => {
  const sku = { 'A': { price: 5000 }, 'B': { price: 5300 }, 'C': { price: 4700 } };
  const get = (id) => sku[id] ?? null;
  assert.equal(declinedPricier({ skuId: 'A', declinedIds: ['B'], baseOf: {} }, get), true);
  assert.equal(declinedPricier({ skuId: 'A', declinedIds: ['C'], baseOf: {} }, get), false);
  assert.equal(declinedPricier({ skuId: 'A', declinedIds: ['B'], baseOf: { B: 'C' } }, get), true);   // compared with the item it was brought for
  assert.equal(declinedPricier({ skuId: 'A', declinedIds: [], baseOf: {} }, get), false);
});

test('the one-tap reason is called "Price difference"', () => {
  assert.equal(QUICK_REASONS.find((q) => q.tag === 'price').label, 'Price difference');
  assert.equal(REASON_LABELS.price, 'Price difference');
  assert.equal(QUICK_REASONS.find((q) => q.tag === 'price').evidence, 'customer-stated');
});

// ---------- the heatmap cell ----------
test('a heatmap cell: a dash when empty, else the count with only the directions that exist', () => {
  assert.deepEqual(heatCellText({ more: 0, less: 0 }, 'waist'), { main: '—', sub: '' });
  assert.deepEqual(heatCellText({ more: 1, less: 0 }, 'waist'), { main: '1', sub: '1 tight' });
  assert.deepEqual(heatCellText({ more: 0, less: 2 }, 'chest'), { main: '2', sub: '2 loose' });
  assert.deepEqual(heatCellText({ more: 1, less: 1 }, 'waist'), { main: '2', sub: '1 tight · 1 loose' });
  assert.deepEqual(heatCellText({ more: 1, less: 2 }, 'length'), { main: '3', sub: '1 short · 2 long' });
});

// ---------- rupees ----------
test('rupees saved: what converted requests came to, and the value in every outcome', () => {
  const { events, add } = makeLog();
  const req = (id, sku, outcome, extra = {}) => {
    add(0, id, 'created', { room: 1, skuId: sku, issue: 'too_tight', issues: ['too_tight'], chips: [], parsed: null, method: 'none' }, 'customer');
    add(1, id, 'accepted', { role: 'runner' }, 'runner');
    add(9, id, 'closed', { outcome, ...extra }, 'runner');
  };
  req('a', 'OX-M-SLIM', 'bought_original');                           // 4,999
  req('b', 'OX-M-SLIM', 'bought_alternative', { itemId: 'OS-M-SLIM' }); // a different style: 5,499
  req('c', 'PL-M-SLIM', 'cross_store_order');                         // 4,499 (what the customer wanted)
  req('d', 'PO-M-SLIM', 'left');                                      // 3,499 at stake, not saved
  const m = computeMetrics(events);
  assert.equal(m.savedValue, 14997);
  assert.deepEqual(m.outcomeValue, { bought_original: 4999, bought_alternative: 5499, cross_store_order: 4499, saved_for_later: 0, left: 3499 });
  assert.equal(computeMetrics([]).savedValue, 0);
});
