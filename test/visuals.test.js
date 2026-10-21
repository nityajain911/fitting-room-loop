import test from 'node:test';
import assert from 'node:assert/strict';
import { slaRing, bulletScale, outcomeFunnel, rackZone, tripItemName } from '../shared/visuals.js';
import { makeConfig } from '../shared/config.js';
import { stageLimits } from '../shared/derive.js';

const cfg = stageLimits(makeConfig(), 'accept'); // 60 s warn, 120 s escalate

test('slaRing fills towards the escalation threshold and changes tone at the warning and escalation marks', () => {
  assert.deepEqual(slaRing(0, cfg), { fraction: 0, tone: 'ok' });
  assert.equal(slaRing(30_000, cfg).fraction, 0.25);
  assert.equal(slaRing(59_000, cfg).tone, 'ok');
  assert.equal(slaRing(60_000, cfg).tone, 'warn');
  assert.deepEqual(slaRing(120_000, cfg), { fraction: 1, tone: 'esc' });
  assert.equal(slaRing(500_000, cfg).fraction, 1); // never overflows
  assert.deepEqual(slaRing(40_000, cfg, true), { fraction: 1, tone: 'done' });
});

test('bulletScale places a median against the warning and escalation marks on one axis', () => {
  const b = bulletScale(19_000, cfg);
  assert.equal(b.tone, 'ok');
  assert.ok(b.warnPct < b.escPct && b.escPct < 100);
  assert.ok(b.valuePct < b.warnPct);
  assert.equal(bulletScale(75_000, cfg).tone, 'warn');
  assert.equal(bulletScale(200_000, cfg).tone, 'esc');
  assert.ok(bulletScale(400_000, cfg).valuePct <= 100);
  assert.equal(bulletScale(null, cfg), null);
});

test('outcomeFunnel is over closed requests, so its green segments add up to the save rate; cancelled stay separate', () => {
  const m = { closed: 10, cancelled: 2, outcomeMix: { bought_original: 1, bought_alternative: 4, cross_store_order: 1, saved_for_later: 1, left: 3 } };
  const f = outcomeFunnel(m);
  assert.equal(f.total, 10);
  assert.equal(f.cancelled, 2);
  assert.deepEqual(f.segments.map((s) => s.key), ['bought_alternative', 'bought_original', 'cross_store_order', 'saved_for_later', 'left']);
  assert.equal(f.segments.find((s) => s.key === 'bought_alternative').pct, 40);
  const saved = f.segments.filter((s) => ['bought_alternative', 'bought_original', 'cross_store_order'].includes(s.key)).reduce((n, s) => n + s.pct, 0);
  assert.equal(saved, 60); // = (4 + 1 + 1) / 10, the save rate; "saved for later" is deliberately not part of it
  assert.equal(f.segments.reduce((n, s) => n + s.pct, 0), 100);
  assert.deepEqual(outcomeFunnel({ closed: 0, cancelled: 0, outcomeMix: {} }), { total: 0, segments: [], cancelled: 0 });
});

test('rackZone reads the aisle letter and rack number', () => {
  assert.deepEqual(rackZone('A5'), { aisle: 'A', number: '5' });
  assert.deepEqual(rackZone('D23'), { aisle: 'D', number: '23' });
  assert.deepEqual(rackZone(undefined), { aisle: '?', number: '' });
});

test('tripItemName reads as a complete fit in a list, adding only what else differs from the garment worn', () => {
  const o = { name: 'Oxford Shirt', styleName: 'Button-down · Solid', colour: 'White', size: 'L', cut: 'Slim' };
  assert.equal(tripItemName(o, { ...o, cut: 'Regular' }), 'L Regular');
  assert.equal(tripItemName(o, { ...o, size: 'XL' }), 'XL Slim');
  assert.equal(tripItemName(o, { ...o, size: 'M', cut: 'Regular' }), 'M Regular');
  assert.equal(tripItemName(o, { ...o, colour: 'Light Blue' }), 'L Slim · Light Blue');
  assert.equal(tripItemName(o, { ...o, styleName: 'Spread · Solid' }), 'Spread · Solid · L Slim');
  assert.equal(tripItemName(o, { ...o, name: 'Poplin Shirt', styleName: 'Spread · Solid', colour: 'Sky Blue' }), 'Poplin Shirt (Spread · Solid) · L Slim · Sky Blue');
  assert.equal(tripItemName(o, { ...o }), 'L Slim'); // never empty
});
