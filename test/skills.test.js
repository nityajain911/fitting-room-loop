import test from 'node:test';
import assert from 'node:assert/strict';
import { SKILLS, ALL_SKILLS, skillOf } from '../shared/skills.js';
import { CATALOGUE, getSku } from '../shared/catalogue.js';

test('skills are department x kind of garment, with readable labels', () => {
  assert.deepEqual(SKILLS.map((s) => s.label), ["Men's shirts", "Men's polos", "Men's trousers", "Women's shirts", "Women's polos", "Women's trousers"]);
  assert.equal(ALL_SKILLS.length, 6);
});

test('skillOf: chinos and jeans are both trousers; the department comes from the SKU', () => {
  assert.equal(skillOf(getSku('OX-L-SLIM')), 'Men|shirt');
  assert.equal(skillOf(getSku('PO-L-SLIM')), 'Men|polo');
  assert.equal(skillOf(getSku('CH-32-SLIM')), 'Men|trousers');
  assert.equal(skillOf(getSku('JN-34-REG')), 'Men|trousers');
  const w = CATALOGUE.find((s) => s.department === 'Women' && s.category === 'shirt');
  assert.equal(skillOf(w), 'Women|shirt');
  assert.equal(skillOf({ category: 'shirt' }), 'Men|shirt'); // rows without a department are men's (the original range)
});
