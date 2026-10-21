import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOGUE, garments, getSku, skuLabel } from '../shared/catalogue.js';
import { mergeIssue, fitMatch } from '../shared/fitMatch.js';
import { makeConfig } from '../shared/config.js';
import { STYLE_AXES, styleKind } from '../shared/events.js';

const config = makeConfig();
const TOPS = ['shirt', 'polo'];
const dept = (s) => s.department;
const KEYS = { shirt: ['chest', 'waist', 'shoulder', 'sleeve', 'length'], polo: ['chest', 'waist', 'shoulder', 'sleeve', 'length'], chinos: ['waist', 'hip', 'inseam'], jeans: ['waist', 'hip', 'inseam'] };
const group = (fn) => { const m = new Map(); for (const s of CATALOGUE) { const k = fn(s); m.set(k, [...(m.get(k) || []), s]); } return m; };
const run = (sku, issue, extra = {}) => fitMatch({ sku, issueInfo: mergeIssue({ sku, issue, chips: [], parsed: null, ...extra }), catalogue: CATALOGUE, config });

test('sample catalogue is rich: several garments, style variants, colours, sizes and both cuts', () => {
  assert.ok(CATALOGUE.length >= 450, `only ${CATALOGUE.length} SKUs`);
  assert.deepEqual(garments(), ['Oxford Shirt', 'Poplin Shirt', 'Polo', 'Chinos', 'Jeans']);
  for (const [name, items] of group((s) => s.name)) {
    assert.ok(new Set(items.map((s) => s.colour)).size >= 2, `${name}: needs at least two colours`);
    assert.ok(new Set(items.map((s) => s.size)).size >= 5, `${name}: needs at least five sizes`);
    assert.deepEqual([...new Set(items.map((s) => s.cut))].sort(), ['Regular', 'Slim']);
  }
  for (const [name, n] of [['Oxford Shirt', 3], ['Poplin Shirt', 3], ['Polo', 3], ['Chinos', 2], ['Jeans', 1]]) {
    assert.ok(new Set(CATALOGUE.filter((s) => s.name === name).map((s) => s.line)).size >= n, `${name}: needs ${n}+ style variants`);
  }
});

test('every SKU is well formed: unique id, line, style name and attributes, all measurements, whole stock, a rack', () => {
  assert.equal(new Set(CATALOGUE.map((s) => s.id)).size, CATALOGUE.length);
  for (const s of CATALOGUE) {
    assert.deepEqual(Object.keys(s.m).sort(), [...KEYS[s.category]].sort(), s.id);
    for (const v of Object.values(s.m)) assert.ok(Number.isFinite(v) && v > 0, `${s.id} measurement`);
    assert.ok(Number.isInteger(s.stock) && s.stock >= 0, `${s.id} stock`);
    assert.match(s.rack, /^[A-H]\d+$/, `${s.id} rack`);
    assert.ok(['Men', 'Women'].includes(s.department), `${s.id} department`);
    assert.ok(s.line && s.styleName, `${s.id} line / style name`);
    assert.deepEqual(Object.keys(s.attrs).sort(), [...STYLE_AXES[styleKind(s.category)]].sort(), `${s.id} style attributes`);
  }
});

test('each style variant is a distinct design, and its attributes are shared by every size, cut and colour', () => {
  const lines = group((s) => s.line);
  const designs = new Set();
  for (const [line, items] of lines) {
    const a = items[0].department + JSON.stringify(items[0].attrs) + items[0].name;
    for (const s of items) assert.equal(s.department + JSON.stringify(s.attrs) + s.name, a, `${line}: one design per line`);
    designs.add(a);
  }
  assert.equal(designs.size, lines.size, 'no two lines are the same design');
});

test('every line offers the full size x cut grid for each of its colours', () => {
  for (const [, items] of group((s) => `${s.line}|${s.colour}`)) {
    const sizes = [...new Set(items.map((s) => s.size))];
    const cuts = [...new Set(items.map((s) => s.cut))];
    assert.equal(items.length, sizes.length * cuts.length, items[0].line + ' ' + items[0].colour);
  }
});

test('sizing is coherent: bigger sizes are bigger, Slim is trimmer than Regular, colours share measurements', () => {
  const order = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
  for (const [, items] of group((s) => `${s.line}|${s.colour}|${s.cut}`)) {
    const ordered = [...items].sort((a, b) => (TOPS.includes(a.category) ? order.indexOf(a.size) - order.indexOf(b.size) : Number(a.size) - Number(b.size)));
    for (let i = 1; i < ordered.length; i += 1) {
      assert.ok(ordered[i].m.waist > ordered[i - 1].m.waist, `${ordered[i].id} waist grows with size`);
      if (TOPS.includes(ordered[i].category)) assert.ok(ordered[i].m.chest > ordered[i - 1].m.chest, `${ordered[i].id} chest grows with size`);
    }
  }
  for (const s of CATALOGUE.filter((x) => x.cut === 'Slim')) {
    const reg = CATALOGUE.find((x) => x.cut === 'Regular' && x.line === s.line && x.colour === s.colour && x.size === s.size);
    const k = TOPS.includes(s.category) ? 'waist' : 'hip';
    assert.ok(s.m[k] < reg.m[k], `${s.id} is trimmer (${k}) than ${reg.id}`);
  }
  // The only deliberate exception: the out-of-stock short-leg 30 Slim chino that makes the hemming demo honest.
  const exceptions = [];
  for (const [, items] of group((s) => `${s.line}|${s.size}|${s.cut}`)) {
    for (const s of items) if (JSON.stringify(s.m) !== JSON.stringify(items[items.length - 1].m)) exceptions.push(s.id);
  }
  assert.deepEqual(exceptions, ['CH-30-SLIM'], 'colour variants of one style share measurements');
  assert.equal(getSku('CH-30-SLIM').stock, 0);
});

test('every style axis can be changed on its own: for each garment kind there is a pair of designs differing in exactly that axis', () => {
  const lines = [...group((s) => s.line).values()].map((items) => items[0]);
  for (const kind of ['shirt', 'polo', 'trousers']) for (const d of ['Men', 'Women']) {
    const ofKind = lines.filter((l) => styleKind(l.category) === kind && l.department === d);
    for (const axis of STYLE_AXES[kind]) {
      const found = ofKind.some((a) => ofKind.some((b) => a !== b && STYLE_AXES[kind].every((x) => (x === axis) === (a.attrs[x] !== b.attrs[x]))));
      assert.ok(found, `${d} ${kind}: no pair of designs differs only in ${axis}`);
    }
  }
});

test('demo guarantee 1: Oxford L Slim, waist too tight + sleeves too long -> Regular M, roomier waist and shorter sleeve', () => {
  const sku = getSku('OX-L-SLIM');
  const parsed = { primary_area: 'waist', primary_issue: 'tight', secondary_area: 'sleeves', secondary_issue: 'long', summary_en: '', evidence_type: 'customer-stated', confidence: 1 };
  const r = fitMatch({ sku, issueInfo: mergeIssue({ sku, issue: 'too_tight', chips: [], parsed, parseMethod: 'ai:x' }), catalogue: CATALOGUE, config });
  assert.equal(r.itemId, 'OX-M-REG');
  assert.deepEqual(r.drivers.map((d) => [d.measure, d.delta]), [['waist', 6], ['sleeve', -2]]);
});

test('fit fixes stay inside one style: a roomier waist never swaps the collar or pattern', () => {
  for (const sku of CATALOGUE.filter((s) => s.stock > 0 && s.category !== 'polo')) {
    const r = run(sku, 'too_tight');
    if (r.itemId) assert.equal(getSku(r.itemId).line, sku.line, `${sku.id} -> ${r.itemId}`);
    const o = run(sku, 'another_size');
    if (o.itemId) assert.equal(getSku(o.itemId).line, sku.line, `${sku.id} size -> ${o.itemId}`);
  }
});

test('demo guarantee 2: Chinos 32 Slim, too long -> no shorter inseam in stock (hemming / cross-store)', () => {
  const sku = getSku('CH-32-SLIM');
  const r = run(sku, 'too_long');
  assert.equal(r.kind, 'alteration_or_crossstore');
  assert.ok(CATALOGUE.some((s) => s.category === 'chinos' && s.stock === 0 && s.m.inseam < sku.m.inseam), 'a shorter inseam exists but is out of stock');
});

test('customers rarely hit a dead end: "too tight / too loose" fails only at the extremes of a design\'s size range', () => {
  const sizesOf = (sku) => CATALOGUE.filter((x) => x.line === sku.line && x.cut === sku.cut).map((x) => x.size);
  const order = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
  const rank = (z) => (order.includes(z) ? order.indexOf(z) : Number(z));
  let total = 0;
  const dead = [];
  for (const sku of CATALOGUE.filter((x) => x.stock > 0)) {
    for (const issue of ['too_tight', 'too_loose']) {
      total += 1;
      if (run(sku, issue).kind !== 'no_alternative') continue;
      const sorted = sizesOf(sku).sort((a, b) => rank(a) - rank(b));
      // Slim can always go roomier by becoming Regular, so only the biggest Regular (tight) and smallest Slim (loose) can dead-end
      const extreme = issue === 'too_tight' ? sku.size === sorted[sorted.length - 1] : sku.size === sorted[0];
      if (!extreme) dead.push(`${sku.id}/${issue}`);
    }
  }
  assert.deepEqual(dead, [], `unexpected dead ends: ${dead.slice(0, 8).join(', ')} of ${total}`);
});

test('every in-stock garment can get "another size", "another style" and a stock check', () => {
  for (const sku of CATALOGUE.filter((s) => s.stock > 0)) {
    for (const issue of ['another_size', 'another_style', 'check_stock']) {
      assert.notEqual(run(sku, issue).kind, 'no_alternative', `${sku.id}/${issue}`);
    }
  }
});

test('"Another style" on the real catalogue never changes size, and is a genuinely different design', () => {
  const bad = [];
  for (const sku of CATALOGUE.filter((s) => s.stock > 0)) {
    const r = run(sku, 'another_style');
    if (r.kind !== 'alternative_style') continue;
    const alt = getSku(r.itemId);
    if (alt.size !== sku.size) bad.push(`${sku.id}->${alt.id} changed size`);
    if (r.change.type === 'design' && alt.line === sku.line) bad.push(`${sku.id}->${alt.id} is the same design`);
    if (r.change.type === 'design' && !r.change.changed?.length) bad.push(`${sku.id}->${alt.id} names no change`);
  }
  assert.deepEqual(bad, []);
});

test('asking for one axis is honoured on the real catalogue (collar, pattern, fabric / neckline / front) for most garments', () => {
  let asked = 0; let met = 0; const detail = [];
  for (const sku of CATALOGUE.filter((s) => s.stock > 0)) {
    for (const axis of STYLE_AXES[styleKind(sku.category)]) {
      asked += 1;
      const r = run(sku, 'another_style', { styleAxes: [axis] });
      const ok = r.kind === 'alternative_style' && r.change.type === 'design' && r.change.changed.some((c) => c.axis === axis);
      if (ok) met += 1; else detail.push(`${sku.id}/${axis}`);
    }
  }
  assert.ok(met / asked >= 0.8, `${met} of ${asked} honoured; misses: ${detail.slice(0, 12).join(', ')}`);
});

test('worked examples: the Poplin M Slim from the bug report, and the Oxford demo shirt', () => {
  const pop = getSku('PL-M-SLIM'); // Poplin, spread collar, solid, Sky Blue
  const collar = run(pop, 'another_style', { styleAxes: ['collar'] });
  assert.equal(getSku(collar.itemId).line, 'PB');
  assert.deepEqual(collar.change.changed.map((c) => [c.axis, c.from, c.to]), [['collar', 'Spread', 'Button-down']]);
  assert.deepEqual([getSku(collar.itemId).size, getSku(collar.itemId).cut], ['M', 'Slim']);
  const pattern = run(pop, 'another_style', { styleAxes: ['pattern'] });
  assert.equal(getSku(pattern.itemId).line, 'PC');
  const ox = getSku('OX-L-SLIM');
  assert.equal(getSku(run(ox, 'another_style', { styleAxes: ['collar'] }).itemId).line, 'OS');
  assert.equal(getSku(run(ox, 'another_style', { styleAxes: ['pattern'] }).itemId).line, 'OT');
  assert.equal(getSku(run(ox, 'another_style', { styleAxes: ['fabric'] }).itemId).line, 'PB');
});

test('labels name the style variant so two Oxford shirts are never ambiguous', () => {
  assert.match(skuLabel(getSku('OX-L-SLIM')), /Oxford Shirt \(Button-down · Solid\) · White · L Slim/);
  assert.notEqual(skuLabel(getSku('OS-L-SLIM')), skuLabel(getSku('OX-L-SLIM')));
});

test('the women\'s range exists for shirts, polos and trousers, with its own designs', () => {
  for (const kind of ['shirt', 'polo', 'trousers']) {
    const lines = new Set(CATALOGUE.filter((x) => x.department === 'Women' && styleKind(x.category) === kind).map((x) => x.line));
    assert.ok(lines.size >= 3, `Women's ${kind}: ${lines.size} designs`);
  }
  assert.match(skuLabel(CATALOGUE.find((x) => x.department === 'Women')), /^Women's /);
  assert.ok(!/^Men's /.test(skuLabel(getSku('OX-L-SLIM')))); // the original men's labels are unchanged
});

test('nothing is ever suggested across departments: not a fit, a size, a style or a stock check', () => {
  for (const sku of CATALOGUE.filter((x) => x.stock > 0)) {
    for (const issue of ['too_tight', 'too_loose', 'another_size', 'another_style', 'check_stock']) {
      const r = run(sku, issue);
      for (const o of r.options) assert.equal(getSku(o.itemId).department, sku.department, `${sku.id}/${issue} -> ${o.itemId}`);
    }
  }
});
