import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeIssue, fitMatch } from '../shared/fitMatch.js';
import { makeConfig } from '../shared/config.js';

const config = makeConfig();
const shirt = (id, size, cut, m, over = {}) => ({
  id, line: 'T', department: 'Men', name: 'Test Shirt', category: 'shirt', fabric: 'oxford', styleName: 'Plain', attrs: { fabric: 'oxford' },
  size, cut, colour: 'White', m: { chest: 100, waist: 90, shoulder: 45, sleeve: 64, length: 74, ...m }, stock: 2, rack: 'A1', ...over,
});
const base = shirt('B', 'M', 'Slim', {});
const near = shirt('N', 'L', 'Slim', { chest: 105, waist: 95, shoulder: 46.5, sleeve: 66, length: 76 });            // one size up
const far = shirt('F', 'XXL', 'Slim', { chest: 125, waist: 115, shoulder: 52, sleeve: 70, length: 82 });             // far too big
const wide = shirt('W', 'L', 'Regular', { chest: 104, waist: 112 });                                                  // fixes chest but the waist jumps 22 cm
const run = (stock, args, cfg = config) => {
  const catalogue = [base, ...stock];
  return fitMatch({ sku: base, issueInfo: mergeIssue({ sku: base, ...args }), catalogue, config: cfg });
};
const tightChest = { issue: 'too_tight', chips: ['chest'] };

test('an item that is a sensible step is offered; one that is far off or changes something else too much is not', () => {
  const r = run([near, far, wide], tightChest);
  assert.equal(r.kind, 'alternative');
  assert.deepEqual(r.options.map((o) => o.itemId), ['N']);          // F is 25 cm away, W would change the waist by 22 cm
});

test('when everything in stock is too far off the engine says no, and names the nearest option and the limit it breaks', () => {
  const r = run([far, wide], tightChest);
  assert.equal(r.kind, 'no_alternative');
  assert.ok(!r.options?.length && !r.itemId);
  assert.match(r.reason, /Nothing close enough/i);
  assert.match(r.reason, /waist/i);                                 // the nearest (W) breaks the waist limit...
  assert.match(r.reason, /22/);
  assert.match(r.reason, /12 cm/);                                  // ...which is 12 cm
  assert.equal(r.nearMiss.itemId, 'W');
  const onlyFar = run([far], tightChest);
  assert.equal(onlyFar.kind, 'no_alternative');
  assert.match(onlyFar.reason, /chest/i);
  assert.match(onlyFar.reason, /25/);
});

test('with two issues, an item that fixes one but makes the other clearly worse is not offered', () => {
  const worseLength = shirt('X', 'L', 'Slim', { chest: 105, length: 80 });                  // chest fixed, but 6 cm longer when it was too long
  const bothFixed = shirt('Y', 'L', 'Slim', { chest: 105, length: 72 });
  const args = { issue: 'too_tight', issues: ['too_tight', 'too_long'], chips: ['chest', 'length'] };
  assert.deepEqual(run([worseLength, bothFixed], args).options.map((o) => o.itemId), ['Y']);
  const none = run([worseLength], args);
  assert.equal(none.kind, 'no_alternative');                                               // better to say no than to bring something that worsens it
  assert.match(none.reason, /length/i);
});

test('a small side effect on the second issue is tolerated and labelled', () => {
  const slightly = shirt('S', 'L', 'Slim', { chest: 105, length: 74.5 });                  // length 0.5 cm longer: within the 1 cm tolerance
  const r = run([slightly], { issue: 'too_tight', issues: ['too_tight', 'too_long'], chips: ['chest', 'length'] });
  assert.equal(r.kind, 'alternative');
  assert.match(r.options[0].reason, /does not fix/);
});

test('"another size" offers sizes at most two steps away, and says no when only farther ones are in stock', () => {
  const sizes = ['S', 'M', 'L', 'XL', 'XXL'];
  const lineUp = sizes.map((s, i) => shirt(`S-${s}`, s, 'Slim', { chest: 95 + 5 * i }, s === 'M' ? { stock: 0 } : {}));
  const baseM = lineUp[1];
  const cat = (stock) => [baseM, ...stock];
  const call = (stock) => fitMatch({ sku: baseM, issueInfo: mergeIssue({ sku: baseM, issue: 'another_size', chips: [] }), catalogue: cat(stock), config });
  assert.deepEqual(call([lineUp[2], lineUp[4]]).options.map((o) => o.itemId), ['S-L']);        // XXL is three steps away: left out
  const farOnly = call([lineUp[4]]);
  assert.equal(farOnly.kind, 'no_alternative');
  assert.match(farOnly.reason, /3 sizes? away|3 steps/i);
});

test('a stock check does not list sizes and cuts nobody would consider', () => {
  const sizes = ['S', 'M', 'L', 'XL', 'XXL'];
  const items = sizes.map((s, i) => shirt(`C-${s}`, s, 'Slim', { chest: 95 + 5 * i }));
  const baseM = items[1];
  const farRegular = shirt('C-XXL-R', 'XXL', 'Regular', { chest: 128 }, { colour: 'Navy' });
  const r = fitMatch({ sku: baseM, issueInfo: mergeIssue({ sku: baseM, issue: 'check_stock', chips: [] }), catalogue: [baseM, items[0], items[2], items[4], farRegular], config });
  const ids = r.options.map((o) => o.itemId);
  assert.ok(ids.includes('C-L') && ids.includes('C-S'));
  assert.ok(!ids.includes('C-XXL-R') && !ids.includes('C-XXL'));
});

test('trousers still fall back to hemming when no shorter inseam is close enough', () => {
  const trousers = (id, size, m, over = {}) => ({ id, line: 'CH', department: 'Men', name: 'Chinos', category: 'chinos', fabric: 'cotton', styleName: 'Flat', attrs: { fabric: 'cotton' }, size, cut: 'Slim', colour: 'Khaki', m: { waist: 82, hip: 98, inseam: 79, ...m }, stock: 2, rack: 'C1', ...over });
  const t = trousers('T32', '32', {});
  const r = fitMatch({ sku: t, issueInfo: mergeIssue({ sku: t, issue: 'too_long', chips: [] }), catalogue: [t, trousers('T30', '30', { waist: 78, inseam: 79 })], config });
  assert.equal(r.kind, 'alteration_or_crossstore');
});

test('the limits are prototype settings and shown as such', () => {
  assert.equal(config.maxSizeSteps, 2);
  assert.deepEqual(Object.keys(config.fitLimits).sort(), ['top', 'trousers']);
  assert.ok(config.fitLimits.top.chest > 0 && config.fitLimits.trousers.waist > 0);
});
