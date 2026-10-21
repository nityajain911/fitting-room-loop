import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeIssue, fitMatch, choiceSummary } from '../shared/fitMatch.js';
import { SMALL_CATALOGUE as CATALOGUE } from './fixtures.js';

const getSku = (id, cat = CATALOGUE) => cat.find((s) => s.id === id) || null;
import { makeConfig } from '../shared/config.js';

const config = makeConfig();
const oxford = getSku('OX-L-SLIM');
const chinos = getSku('CH-32-SLIM');
const demoParsed = {
  primary_area: 'waist', primary_issue: 'tight', secondary_area: 'sleeves', secondary_issue: 'long',
  summary_en: '', evidence_type: 'customer-stated', confidence: 0.9,
};
const run = (sku, args, cfg = config, cat = CATALOGUE) =>
  fitMatch({ sku, issueInfo: mergeIssue({ sku, ...args }), catalogue: cat, config: cfg });

test('demo: Oxford L Slim + waist too tight + sleeves too long -> Regular M', () => {
  const r = run(oxford, { issue: 'too_tight', chips: [], parsed: demoParsed, parseMethod: 'ai:m' });
  assert.equal(r.kind, 'alternative');
  assert.equal(r.itemId, 'OX-M-REG');
  assert.equal(r.fixesSecondary, true);
  const waist = r.drivers.find((d) => d.measure === 'waist');
  const sleeve = r.drivers.find((d) => d.measure === 'sleeve');
  assert.deepEqual([waist.role, waist.delta], ['primary', 6]);
  assert.deepEqual([sleeve.role, sleeve.delta], ['secondary', -2]);
  assert.match(r.reason, /Regular M/);
});

test('mergeIssue labels sources: tapped button, AI-parsed area and secondary', () => {
  const info = mergeIssue({ sku: oxford, issue: 'too_tight', chips: [], parsed: demoParsed, parseMethod: 'ai:m' });
  assert.equal(info.primary.word, 'tight');
  assert.equal(info.primary.wordSource, 'customer_tapped');
  assert.equal(info.primary.area, 'waist');
  assert.equal(info.primary.areaSource, 'ai_parsed');
  assert.equal(info.secondary.area, 'sleeves');
  assert.equal(info.secondary.source, 'ai_parsed');
  const fb = mergeIssue({ sku: oxford, issue: 'too_tight', chips: [], parsed: demoParsed, parseMethod: 'rule_fallback' });
  assert.equal(fb.primary.areaSource, 'rule_fallback');
});

test('secondary-fix preference: XL Regular improves waist more but M Regular wins', () => {
  const r = run(oxford, { issue: 'too_tight', chips: [], parsed: demoParsed, parseMethod: 'ai:m' });
  assert.notEqual(r.itemId, 'OX-XL-REG');
  // without a secondary issue the closest-match rule still prefers M Regular (smaller overall change)
  const r2 = run(oxford, { issue: 'too_tight', chips: ['waist'], parsed: null });
  assert.equal(r2.itemId, 'OX-M-REG');
  assert.equal(r2.fixesSecondary, false);
});

test('tapped chip wins over conflicting AI area, with conflict note', () => {
  const ai = { ...demoParsed, primary_area: 'chest' };
  const info = mergeIssue({ sku: oxford, issue: 'too_tight', chips: ['waist'], parsed: ai, parseMethod: 'ai:m' });
  assert.equal(info.primary.area, 'waist');
  assert.equal(info.primary.areaSource, 'customer_tapped');
  assert.ok(info.conflicts.some((c) => /tapped/i.test(c)));
});

test('AI issue word that disagrees with tapped button adds a conflict; button wins', () => {
  const ai = { ...demoParsed, primary_issue: 'loose', secondary_area: 'unknown', secondary_issue: 'unknown' };
  const info = mergeIssue({ sku: oxford, issue: 'too_tight', chips: [], parsed: ai, parseMethod: 'ai:m' });
  assert.equal(info.primary.word, 'tight');
  assert.ok(info.conflicts.length >= 1);
});

test('no chips and no AI -> garment default area, flagged as assumed', () => {
  const info = mergeIssue({ sku: oxford, issue: 'too_tight', chips: [], parsed: null });
  assert.equal(info.primary.area, 'chest');
  assert.equal(info.primary.areaSource, 'default');
  assert.ok(info.assumptions.length >= 1);
});

test('inapplicable chip (sleeves on chinos) is ignored with a note', () => {
  const info = mergeIssue({ sku: chinos, issue: 'too_tight', chips: ['sleeves'], parsed: null });
  assert.equal(info.primary.area, 'waist');
  assert.ok(info.notes.some((n) => /sleeves/i.test(n)));
});

test('chinos too long and no shorter inseam in stock -> hemming / cross-store message', () => {
  const r = run(chinos, { issue: 'too_long', chips: [], parsed: null });
  assert.equal(r.kind, 'alteration_or_crossstore');
  assert.equal(r.itemId, null);
  assert.equal(
    r.reason,
    'No shorter inseam in stock — eligible for in-store hemming (if the store offers alteration — prototype setting) or cross-store order',
  );
  assert.ok(r.drivers.some((d) => d.measure === 'inseam'));
});

test('out-of-stock shorter inseam (CH-30-SLIM) is never suggested', () => {
  const r = run(chinos, { issue: 'too_long', chips: [], parsed: null });
  assert.notEqual(r.itemId, 'CH-30-SLIM');
});

test('hemming not offered -> falls back to cross-store wording only', () => {
  const r = run(chinos, { issue: 'too_long', chips: [], parsed: null }, makeConfig({ ALTERATION_OFFERED: 'false' }));
  assert.equal(r.kind, 'alteration_or_crossstore');
  assert.ok(!/hemming/.test(r.reason));
  assert.match(r.reason, /cross-store order/);
});

test('shorter inseam in stock is suggested when it exists', () => {
  const cat = CATALOGUE.map((s) => (s.id === 'CH-30-SLIM' ? { ...s, stock: 2 } : s));
  const r = run(chinos, { issue: 'too_long', chips: [], parsed: null }, config, cat);
  assert.equal(r.kind, 'alternative');
  assert.equal(r.itemId, 'CH-30-SLIM');
});

test('nothing improves the problem -> no-alternative message', () => {
  // Chinos too tight at the waist: both in-stock chinos have the same 82 cm waist.
  const r = run(chinos, { issue: 'too_tight', chips: ['waist'], parsed: null });
  assert.equal(r.kind, 'no_alternative');
  assert.equal(r.itemId, null);
  assert.equal(r.reason, 'No in-stock alternative improves this — consider cross-store order');
});

test('improvement below the minimum threshold does not count', () => {
  const r = run(chinos, { issue: 'too_long', chips: [], parsed: null }, makeConfig({ MIN_IMPROVEMENT_CM: '5' }));
  assert.equal(r.kind, 'alteration_or_crossstore');
});

test('result is deterministic', () => {
  const a = run(oxford, { issue: 'too_tight', chips: [], parsed: demoParsed, parseMethod: 'ai:m' });
  const b = run(oxford, { issue: 'too_tight', chips: [], parsed: demoParsed, parseMethod: 'ai:m' });
  assert.deepEqual(a, b);
});

test('another_size picks nearest in-stock size, same cut', () => {
  const r = run(getSku('OX-M-REG'), { issue: 'another_size', chips: [], parsed: null });
  assert.equal(r.kind, 'alternative_size');
  assert.equal(r.itemId, 'OX-XL-REG');
  assert.deepEqual(r.drivers, []);
});

test('another_style picks other cut at the same size, else none', () => {
  const none = run(oxford, { issue: 'another_style', chips: [], parsed: null });
  assert.equal(none.kind, 'no_alternative');
  const cat = [...CATALOGUE, { ...getSku('OX-L-SLIM'), id: 'OX-L-REG', cut: 'Regular', stock: 2 }];
  const r = run(oxford, { issue: 'another_style', chips: [], parsed: null }, config, cat);
  assert.equal(r.kind, 'alternative_style');
  assert.equal(r.itemId, 'OX-L-REG');
});

test('check_stock lists up to 4 in-stock items of same category and fabric, excluding the original', () => {
  const r = run(oxford, { issue: 'check_stock', chips: [], parsed: null });
  assert.equal(r.kind, 'stock_check');
  assert.deepEqual([...r.optionIds].sort(), ['OX-M-REG', 'OX-XL-REG']);
  assert.ok(r.optionIds.length <= 4);
});

import { describeChange } from '../shared/fitMatch.js';

test('describeChange gives customer-friendly wording per measurement and direction', () => {
  assert.equal(describeChange({ measure: 'waist', delta: 6 }), 'a roomier waist');
  assert.equal(describeChange({ measure: 'chest', delta: -2 }), 'a closer-fitting chest');
  assert.equal(describeChange({ measure: 'sleeve', delta: -2 }), 'a shorter sleeve');
  assert.equal(describeChange({ measure: 'sleeve', delta: 2 }), 'a longer sleeve');
  assert.equal(describeChange({ measure: 'length', delta: 2 }), 'a longer body');
  assert.equal(describeChange({ measure: 'inseam', delta: -3 }), 'a shorter inseam');
});

test('choiceSummary joins the drivers, and handles size/style/stock-check kinds', () => {
  const r = run(oxford, { issue: 'too_tight', chips: [], parsed: demoParsed, parseMethod: 'ai:m' });
  assert.equal(choiceSummary(r), 'a roomier waist and a shorter sleeve');
  assert.equal(choiceSummary({ kind: 'alternative_size', drivers: [] }), 'a different size');
  assert.equal(choiceSummary({ kind: 'alternative_style', drivers: [] }), 'a different style');
  assert.equal(choiceSummary({ kind: 'stock_check', drivers: [] }), 'another colour or size');
  assert.equal(choiceSummary({ kind: 'no_alternative', drivers: [] }), null);
  assert.equal(choiceSummary(null), null);
});

test('excludeIds removes reported-missing / declined SKUs and surfaces the next best', () => {
  const info = mergeIssue({ sku: oxford, issue: 'too_tight', chips: [], parsed: demoParsed, parseMethod: 'ai:m' });
  const first = fitMatch({ sku: oxford, issueInfo: info, catalogue: CATALOGUE, config });
  assert.equal(first.itemId, 'OX-M-REG');
  const next = fitMatch({ sku: oxford, issueInfo: info, catalogue: CATALOGUE, config, excludeIds: ['OX-M-REG'] });
  assert.equal(next.itemId, 'OX-XL-REG'); // #2: roomier waist but longer sleeve
  assert.equal(next.fixesSecondary, false);
  assert.deepEqual(next.excluded, ['OX-M-REG']);
  const none = fitMatch({ sku: oxford, issueInfo: info, catalogue: CATALOGUE, config, excludeIds: ['OX-M-REG', 'OX-XL-REG'] });
  assert.equal(none.kind, 'no_alternative');
  assert.equal(none.itemId, null);
});

test('excluding the only shorter inseam still ends in the hemming branch', () => {
  const cat = CATALOGUE.map((s) => (s.id === 'CH-30-SLIM' ? { ...s, stock: 2 } : s));
  const info = mergeIssue({ sku: chinos, issue: 'too_long', chips: [], parsed: null });
  assert.equal(fitMatch({ sku: chinos, issueInfo: info, catalogue: cat, config }).itemId, 'CH-30-SLIM');
  const r = fitMatch({ sku: chinos, issueInfo: info, catalogue: cat, config, excludeIds: ['CH-30-SLIM'] });
  assert.equal(r.kind, 'alteration_or_crossstore');
});

test('stock-check options also honour excludeIds', () => {
  const info = mergeIssue({ sku: oxford, issue: 'check_stock', chips: [], parsed: null });
  const r = fitMatch({ sku: oxford, issueInfo: info, catalogue: CATALOGUE, config, excludeIds: ['OX-M-REG'] });
  assert.deepEqual(r.optionIds, ['OX-XL-REG']);
});

// ---------- colour awareness, jeans, richer stock check ----------
const variant = (id, over) => ({ ...getSku('OX-M-REG'), id, ...over });

test('ties on fit are broken in favour of the original garment\'s colour, not the id', () => {
  const cat = [...CATALOGUE, variant('OX-A-LBL', { colour: 'Light Blue' })]; // identical measurements, sorts before OX-M-REG
  const r = run(oxford, { issue: 'too_tight', chips: [], parsed: demoParsed, parseMethod: 'ai:m' }, config, cat);
  assert.equal(r.itemId, 'OX-M-REG');
  assert.ok(!/Light Blue/.test(r.reason));
});

test('when only another colour fits, it is suggested and the reason says so', () => {
  const cat = [...CATALOGUE.map((s) => (s.id === 'OX-M-REG' ? { ...s, stock: 0 } : s)), variant('OX-M-REG-LBL', { colour: 'Light Blue' })];
  const r = run(oxford, { issue: 'too_tight', chips: [], parsed: demoParsed, parseMethod: 'ai:m' }, config, cat);
  assert.equal(r.itemId, 'OX-M-REG-LBL');
  assert.match(r.reason, /in Light Blue/);
});

test('jeans too long with no shorter inseam in stock also gets the hemming / cross-store message', () => {
  const jean = (id, size, cut, inseam, stock) => ({ id, name: 'Jeans', category: 'jeans', fabric: 'denim', size, cut, colour: 'Dark Indigo', m: { waist: 81, hip: 96, inseam }, stock, rack: 'E1' });
  const cat = [jean('J-A', '32', 'Slim', 81, 2), jean('J-B', '32', 'Regular', 83, 2)];
  const info = mergeIssue({ sku: cat[0], issue: 'too_long', chips: [], parsed: null });
  assert.equal(info.primary.measure, 'inseam');
  const r = fitMatch({ sku: cat[0], issueInfo: info, catalogue: cat, config });
  assert.equal(r.kind, 'alteration_or_crossstore');
  const longer = fitMatch({ sku: cat[1], issueInfo: mergeIssue({ sku: cat[1], issue: 'too_long', chips: [], parsed: null }), catalogue: cat, config });
  assert.equal(longer.itemId, 'J-A'); // the Regular's shorter alternative is the Slim (-2 cm)
});

test('check_stock puts the same size and cut in other colours first, then same size, then same cut', () => {
  const mk = (id, size, cut, colour) => variant(id, { size, cut, colour, stock: 2 });
  const cat = [
    getSku('OX-L-SLIM'),
    mk('S1', 'L', 'Slim', 'Navy'),       // same size + cut, other colour  -> rank 0
    mk('S2', 'M', 'Slim', 'White'),      // same cut, other size           -> rank 2
    mk('S3', 'L', 'Regular', 'White'),   // same size, other cut           -> rank 1
    mk('S4', 'L', 'Slim', 'Light Blue'), // rank 0
    mk('S5', 'XL', 'Regular', 'Navy'),   // rank 3
  ];
  const r = fitMatch({ sku: cat[0], issueInfo: mergeIssue({ sku: cat[0], issue: 'check_stock', chips: [], parsed: null }), catalogue: cat, config });
  assert.deepEqual(r.optionIds, ['S1', 'S4', 'S3', 'S2']); // capped at 4
});

test('another_size and another_style prefer the original colour', () => {
  const mk = (id, size, cut, colour) => variant(id, { size, cut, colour, stock: 2 });
  const sizeCat = [getSku('OX-M-REG'), mk('A-LBL', 'L', 'Regular', 'Light Blue'), mk('Z-WHT', 'L', 'Regular', 'White')];
  assert.equal(fitMatch({ sku: sizeCat[0], issueInfo: mergeIssue({ sku: sizeCat[0], issue: 'another_size', chips: [], parsed: null }), catalogue: sizeCat, config }).itemId, 'Z-WHT');
  const styleCat = [getSku('OX-M-REG'), mk('A-LBL', 'M', 'Slim', 'Light Blue'), mk('Z-WHT', 'M', 'Slim', 'White')];
  assert.equal(fitMatch({ sku: styleCat[0], issueInfo: mergeIssue({ sku: styleCat[0], issue: 'another_style', chips: [], parsed: null }), catalogue: styleCat, config }).itemId, 'Z-WHT');
});

// ---------- hips chip, customer-facing deltas ----------
import { QUICK_REASONS, REASON_TAGS, EVIDENCE_TYPES, CHIPS } from '../shared/events.js';

test('trousers: a "hips" chip drives the hip measurement; tops ignore it with a note', () => {
  const info = mergeIssue({ sku: chinos, issue: 'too_tight', chips: ['hips'], parsed: null });
  assert.equal(info.primary.area, 'hips');
  assert.equal(info.primary.measure, 'hip');
  const r = fitMatch({ sku: chinos, issueInfo: info, catalogue: CATALOGUE, config });
  assert.equal(r.itemId, 'CH-32-REG'); // 102 cm hip vs 98 cm; same waist, so the hip is what changes
  assert.deepEqual(r.drivers.filter((d) => d.role === 'primary').map((d) => [d.measure, d.delta]), [['hip', 4]]);
  const top = mergeIssue({ sku: oxford, issue: 'too_tight', chips: ['hips'], parsed: null });
  assert.equal(top.primary.areaSource, 'default');
  assert.ok(top.notes.some((n) => /hips/i.test(n)));
  assert.ok(CHIPS.includes('hips'));
});

test('one-tap reasons use only the fixed reason tags and evidence types', () => {
  assert.ok(QUICK_REASONS.length >= 5);
  for (const q of QUICK_REASONS) {
    assert.ok(REASON_TAGS.includes(q.tag), q.key);
    assert.ok(EVIDENCE_TYPES.includes(q.evidence), q.key);
    assert.ok(q.label && q.summary, q.key);
  }
  assert.equal(new Set(QUICK_REASONS.map((q) => q.tag)).size, QUICK_REASONS.length); // no duplicates
});

// ---------- "Another style": collar / pattern / fabric (or neckline / front), never the size ----------
import { STYLE_AXES, STYLE_AXIS_LABELS } from '../shared/events.js';

const ATTRS = {
  A: { collar: 'Button-down', pattern: 'Solid', fabric: 'Oxford' },
  B: { collar: 'Spread', pattern: 'Solid', fabric: 'Oxford' },   // collar only
  C: { collar: 'Button-down', pattern: 'Stripe', fabric: 'Oxford' }, // pattern only
  D: { collar: 'Button-down', pattern: 'Solid', fabric: 'Poplin' },  // fabric only
  E: { collar: 'Spread', pattern: 'Stripe', fabric: 'Oxford' },   // collar + pattern
  F: { collar: 'Spread', pattern: 'Stripe', fabric: 'Poplin' },   // all three
};
const mk = (id, line, size, cut, colour = 'White', stock = 2) => ({
  id, line, name: ATTRS[line].fabric === 'Oxford' ? 'Oxford Shirt' : 'Poplin Shirt', category: 'shirt', fabric: ATTRS[line].fabric.toLowerCase(),
  styleName: `${ATTRS[line].collar} · ${ATTRS[line].pattern}`, attrs: ATTRS[line], size, cut, colour, stock, rack: 'X1',
  m: { chest: 112, waist: 98, shoulder: 47, sleeve: 66, length: 77 },
});
const orig = mk('A-L-SLIM', 'A', 'L', 'Slim');
const withLines = (...lines) => [orig, ...lines];
const askStyle = (cat, axes = [], excludeIds = []) =>
  fitMatch({ sku: orig, issueInfo: mergeIssue({ sku: orig, issue: 'another_style', chips: [], styleAxes: axes, parsed: null }), catalogue: cat, config, excludeIds });
const allLines = () => withLines(...['B', 'C', 'D', 'E', 'F'].map((l) => mk(`${l}-L-SLIM`, l, 'L', 'Slim')));

test('asking for a different collar / pattern / fabric picks the SKU that changes exactly that', () => {
  for (const [axis, line, from, to] of [['collar', 'B', 'Button-down', 'Spread'], ['pattern', 'C', 'Solid', 'Stripe'], ['fabric', 'D', 'Oxford', 'Poplin']]) {
    const r = askStyle(allLines(), [axis]);
    assert.equal(r.kind, 'alternative_style', axis);
    assert.equal(r.itemId, `${line}-L-SLIM`, axis);
    assert.deepEqual(r.change.changed, [{ axis, label: STYLE_AXIS_LABELS[axis], from, to }], axis);
    assert.deepEqual([r.change.type, r.change.alsoCut, r.change.unmet], ['design', false, []], axis);
    const alt = allLines().find((s) => s.id === r.itemId);
    assert.deepEqual([alt.size, alt.cut], ['L', 'Slim']); // never a different size or cut here
  }
});

test('asking for two axes needs a SKU that changes both, even if a one-axis change exists', () => {
  const r = askStyle(allLines(), ['collar', 'pattern']);
  assert.equal(r.itemId, 'E-L-SLIM');
  assert.deepEqual(r.change.changed.map((c) => c.axis), ['collar', 'pattern']);
});

test('it changes nothing that was not asked for: collar only beats collar + pattern', () => {
  const r = askStyle(withLines(mk('E-L-SLIM', 'E', 'L', 'Slim'), mk('B-L-SLIM', 'B', 'L', 'Slim')), ['collar']);
  assert.equal(r.itemId, 'B-L-SLIM');
});

test('with no axis chosen it prefers the smallest style change, then colour, then the closest fit', () => {
  const noPref = askStyle(withLines(mk('E-L-SLIM', 'E', 'L', 'Slim'), mk('F-L-SLIM', 'F', 'L', 'Slim'), mk('C-L-SLIM', 'C', 'L', 'Slim', 'Navy')));
  assert.equal(noPref.itemId, 'C-L-SLIM'); // one axis beats two or three
  const colour = askStyle(withLines(mk('B-L-SLIM-NVY', 'B', 'L', 'Slim', 'Navy'), mk('D-L-SLIM', 'D', 'L', 'Slim', 'White')));
  assert.equal(colour.itemId, 'D-L-SLIM'); // both one axis: the original colour wins
  const far = { ...mk('B-L-SLIM', 'B', 'L', 'Slim'), m: { chest: 120, waist: 110, shoulder: 50, sleeve: 70, length: 80 } };
  const near = mk('D-L-SLIM', 'D', 'L', 'Slim');
  assert.equal(askStyle(withLines(far, near)).itemId, 'D-L-SLIM'); // same colour, same axis count: the closer fit
});

test('never a different size', () => {
  const r = askStyle(withLines(mk('B-XL-SLIM', 'B', 'XL', 'Slim'), mk('B-M-SLIM', 'B', 'M', 'Slim')), ['collar']);
  assert.equal(r.kind, 'no_alternative');
});

test('tier 2: if only the other cut has the requested style, it is offered and flagged as also changing the cut', () => {
  const r = askStyle(withLines(mk('B-L-REG', 'B', 'L', 'Regular'), mk('B-L-SLIM', 'B', 'L', 'Slim', 'White', 0)), ['collar']);
  assert.equal(r.itemId, 'B-L-REG');
  assert.equal(r.change.alsoCut, true);
  assert.match(r.reason, /cut changes the fit/i);
});

test('tier 3: if not every requested axis can be met, the partial match says what could not be changed', () => {
  const r = askStyle(withLines(mk('B-L-SLIM', 'B', 'L', 'Slim')), ['collar', 'pattern']);
  assert.equal(r.itemId, 'B-L-SLIM');
  assert.deepEqual(r.change.unmet, ['pattern']);
  assert.match(r.reason, /could not be changed/i);
});

test('tier 4: with no other design in stock, the other cut of the same design is offered and labelled', () => {
  const r = askStyle(withLines(mk('A-L-REG', 'A', 'L', 'Regular')), ['collar']);
  assert.equal(r.itemId, 'A-L-REG');
  assert.deepEqual(r.change, { type: 'cut', from: 'Slim', to: 'Regular' });
  assert.match(r.reason, /No other design/i);
});

test('reported-missing and declined SKUs are never offered again', () => {
  assert.equal(askStyle(allLines(), ['collar']).itemId, 'B-L-SLIM');
  assert.equal(askStyle(allLines(), ['collar'], ['B-L-SLIM']).itemId, 'E-L-SLIM'); // next that still changes the collar
});

test('trousers: front and fabric are the axes, and chinos can lead to jeans', () => {
  const trouser = (id, line, name, category, front, fabric, size = '32', cut = 'Slim', colour = 'Khaki') => ({
    id, line, name, category, fabric: fabric.toLowerCase(), styleName: `${front} front`, attrs: { front, fabric }, size, cut, colour, stock: 2, rack: 'C1',
    m: { waist: 82, hip: 98, inseam: 79 },
  });
  const ch = trouser('CH', 'CH', 'Chinos', 'chinos', 'Flat', 'Twill');
  const cat = [ch, trouser('CP', 'CP', 'Chinos', 'chinos', 'Pleated', 'Twill'), trouser('JN', 'JN', 'Jeans', 'jeans', 'Flat', 'Denim', '32', 'Slim', 'Indigo')];
  const run2 = (axes) => fitMatch({ sku: ch, issueInfo: mergeIssue({ sku: ch, issue: 'another_style', chips: [], styleAxes: axes, parsed: null }), catalogue: cat, config });
  assert.equal(run2(['front']).itemId, 'CP');
  assert.equal(run2(['fabric']).itemId, 'JN');
  const info = mergeIssue({ sku: ch, issue: 'another_style', chips: [], styleAxes: ['collar', 'front'], parsed: null });
  assert.deepEqual(info.styleAxes, ['front']); // a collar means nothing on trousers
  assert.ok(info.notes.some((n) => /collar/i.test(n)));
  assert.deepEqual(STYLE_AXES.trousers, ['front', 'fabric']);
});

test('catalogue rows without style attributes still work: another fabric counts as another design', () => {
  const poplin = { ...getSku('OX-L-SLIM'), id: 'PL-L-SLIM', name: 'Poplin Shirt', fabric: 'poplin' };
  const sku = getSku('OX-L-SLIM');
  const r = fitMatch({ sku, issueInfo: mergeIssue({ sku, issue: 'another_style', chips: [], parsed: null }), catalogue: [...CATALOGUE, poplin], config });
  assert.equal(r.itemId, 'PL-L-SLIM');
  assert.equal(r.change.type, 'design');
});

test('choiceSummary tells the customer which style detail changes', () => {
  assert.equal(choiceSummary({ kind: 'alternative_style', change: { type: 'design', from: 'a', to: 'b', changed: [{ axis: 'collar', label: 'Collar', from: 'Button-down', to: 'Spread' }] } }), 'a different collar (Spread)');
  assert.equal(choiceSummary({ kind: 'alternative_style', change: { type: 'design', changed: [{ axis: 'collar', label: 'Collar', to: 'Spread' }, { axis: 'pattern', label: 'Pattern', to: 'Stripe' }] } }), 'a different collar (Spread) and pattern (Stripe)');
  assert.equal(choiceSummary({ kind: 'alternative_style', change: { type: 'design', from: 'Oxford Shirt', to: 'Poplin Shirt' } }), 'a different style: Poplin Shirt'); // older events
  assert.equal(choiceSummary({ kind: 'alternative_style', change: { type: 'cut', from: 'Slim', to: 'Regular' } }), 'the Regular cut of the same design');
  assert.equal(choiceSummary({ kind: 'alternative_style', drivers: [] }), 'a different style');
});

// ---------- several best items at once ----------
import { suggestionItemIds, optionFor } from '../shared/fitMatch.js';

const topLine = (line, name, cutSizes, colours = ['White'], extra = {}) => cutSizes.flatMap(([size, cut, waist, chest]) => colours.map((colour) => ({
  id: `${line}-${size}-${cut}-${colour}`, line, name, category: 'shirt', fabric: 'oxford', size, cut, colour, stock: 2, rack: 'A1',
  m: { chest, waist, shoulder: 47, sleeve: 66, length: 77 }, ...extra,
})));

test('bringCount is a prototype setting: default 3, env override, kept between 1 and 5', () => {
  assert.equal(makeConfig().bringCount, 3);
  assert.equal(makeConfig({ BRING_COUNT: '2' }).bringCount, 2);
  assert.equal(makeConfig({ BRING_COUNT: '9' }).bringCount, 5);
  assert.equal(makeConfig({ BRING_COUNT: '0' }).bringCount, 3);
  assert.equal(makeConfig({ BRING_COUNT: '2.7' }).bringCount, 2);
});

test('fit: several distinct fits in one trip, best first; the same fit in other colours is not repeated', () => {
  const orig = topLine('A', 'Oxford Shirt', [['L', 'Slim', 98, 112]])[0];
  const cat = [
    orig,
    ...topLine('A', 'Oxford Shirt', [['M', 'Regular', 104, 110], ['L', 'Regular', 108, 115], ['XL', 'Regular', 112, 120], ['XXL', 'Regular', 116, 125]], ['White', 'Light Blue', 'Navy']),
  ];
  const info = mergeIssue({ sku: orig, issue: 'too_tight', chips: ['waist'], parsed: null });
  const r = fitMatch({ sku: orig, issueInfo: info, catalogue: cat, config });
  assert.equal(r.kind, 'alternative');
  assert.equal(r.options.length, 3);
  assert.equal(r.options[0].itemId, r.itemId); // the first option is the best one
  const fits = r.options.map((o) => cat.find((s) => s.id === o.itemId)).map((s) => `${s.size} ${s.cut}`);
  assert.equal(new Set(fits).size, 3); // distinct fits, not three colours of one
  assert.ok(r.options.every((o) => o.drivers.length && o.diffs.length)); // each option carries its own measurements
  const one = fitMatch({ sku: orig, issueInfo: info, catalogue: cat, config: makeConfig({ BRING_COUNT: '1' }) });
  assert.equal(one.options.length, 1);
  assert.equal(one.itemId, r.itemId);
  const five = fitMatch({ sku: orig, issueInfo: info, catalogue: cat, config: makeConfig({ BRING_COUNT: '5' }) });
  assert.ok(five.options.length <= 4); // only four distinct fits exist
});

test('size: the nearest sizes on either side, one per size', () => {
  const orig = topLine('A', 'Oxford Shirt', [['M', 'Regular', 104, 110]])[0];
  const cat = [orig, ...topLine('A', 'Oxford Shirt', [['S', 'Regular', 100, 105], ['L', 'Regular', 108, 115], ['XL', 'Regular', 112, 120]], ['White', 'Navy'])];
  const r = fitMatch({ sku: orig, issueInfo: mergeIssue({ sku: orig, issue: 'another_size', chips: [], parsed: null }), catalogue: cat, config });
  assert.equal(r.kind, 'alternative_size');
  assert.deepEqual(r.options.map((o) => cat.find((s) => s.id === o.itemId).size).sort(), ['L', 'S', 'XL']);
  assert.equal(cat.find((s) => s.id === r.itemId).size === 'L' || cat.find((s) => s.id === r.itemId).size === 'S', true); // nearest first
});

test('style: up to three different designs, one per design, best first', () => {
  const o = mk('A-L-SLIM', 'A', 'L', 'Slim');
  const cat = [o, mk('B-L-SLIM', 'B', 'L', 'Slim'), mk('B-L-SLIM-N', 'B', 'L', 'Slim', 'Navy'), mk('C-L-SLIM', 'C', 'L', 'Slim'), mk('D-L-SLIM', 'D', 'L', 'Slim'), mk('E-L-SLIM', 'E', 'L', 'Slim')];
  const r = fitMatch({ sku: o, issueInfo: mergeIssue({ sku: o, issue: 'another_style', chips: [], styleAxes: [], parsed: null }), catalogue: cat, config });
  assert.equal(r.options.length, 3);
  assert.equal(new Set(r.options.map((x) => cat.find((s) => s.id === x.itemId).line)).size, 3); // three designs
  assert.equal(r.options[0].itemId, r.itemId);
  assert.ok(r.options.every((x) => x.change?.type === 'design'));
});

test('stock check: the in-stock options are the items to bring; nothing to bring when there is no alternative', () => {
  const r = run(oxford, { issue: 'check_stock', chips: [], parsed: null });
  assert.deepEqual(r.options.map((o) => o.itemId), r.optionIds);
  const hem = run(chinos, { issue: 'too_long', chips: [], parsed: null });
  assert.deepEqual(hem.options, []);
  assert.deepEqual(suggestionItemIds(hem), []);
});

test('suggestionItemIds reads options, and older single-item / option-list shapes', () => {
  assert.deepEqual(suggestionItemIds({ itemId: 'A', options: [{ itemId: 'A' }, { itemId: 'B' }] }), ['A', 'B']);
  assert.deepEqual(suggestionItemIds({ itemId: 'A', optionIds: [] }), ['A']);
  assert.deepEqual(suggestionItemIds({ itemId: null, optionIds: ['X', 'Y'] }), ['X', 'Y']);
  assert.deepEqual(suggestionItemIds(null), []);
});

test('optionFor gives the per-item view that choiceSummary can describe', () => {
  const r = run(oxford, { issue: 'too_tight', chips: [], parsed: demoParsed, parseMethod: 'ai:m' });
  const o = optionFor(r, r.itemId);
  assert.equal(o.itemId, r.itemId);
  assert.equal(choiceSummary(o), 'a roomier waist and a shorter sleeve');
  assert.equal(optionFor(r, 'nope'), null);
});
