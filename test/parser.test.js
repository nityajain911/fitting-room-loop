import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCustomer, validateReason, ruleBasedCustomer, ruleBasedReason,
  parseCustomerText, parseReasonText,
} from '../shared/parser.js';

const goodCustomer = {
  primary_area: 'waist', primary_issue: 'tight', secondary_area: 'sleeves', secondary_issue: 'long',
  summary_en: 'Waist is tight and sleeves are long.', evidence_type: 'customer-stated', confidence: 0.9,
};

test('validateCustomer accepts valid JSON string and object', () => {
  assert.deepEqual(validateCustomer(JSON.stringify(goodCustomer)), goodCustomer);
  assert.deepEqual(validateCustomer(goodCustomer), goodCustomer);
});

test('validateCustomer strips markdown code fences', () => {
  const out = validateCustomer('```json\n' + JSON.stringify(goodCustomer) + '\n```');
  assert.equal(out.primary_area, 'waist');
});

test('validateCustomer maps off-list values to other/unknown', () => {
  const out = validateCustomer({ ...goodCustomer, primary_area: 'belly', secondary_issue: 'baggy', evidence_type: 'vibes' });
  assert.equal(out.primary_area, 'other/unknown');
  assert.equal(out.secondary_issue, 'other/unknown');
  assert.equal(out.evidence_type, 'unknown');
});

test('validateCustomer clamps confidence and defaults bad values', () => {
  assert.equal(validateCustomer({ ...goodCustomer, confidence: 7 }).confidence, 1);
  assert.equal(validateCustomer({ ...goodCustomer, confidence: -2 }).confidence, 0);
  assert.equal(validateCustomer({ ...goodCustomer, confidence: 'high' }).confidence, 0);
});

test('validateCustomer throws on garbage', () => {
  assert.throws(() => validateCustomer('sorry I cannot help'));
  assert.throws(() => validateCustomer('[1,2]'));
  assert.throws(() => validateCustomer(null));
});

test('summaries are trimmed and scrubbed of phone numbers and emails', () => {
  const out = validateCustomer({
    ...goodCustomer,
    summary_en: 'Call me on +91 98765 43210 or a.b@x.com ' + 'x'.repeat(300),
  });
  assert.ok(!/98765/.test(out.summary_en));
  assert.ok(!/@/.test(out.summary_en));
  assert.ok(out.summary_en.length <= 200);
});

test('validateReason enforces fixed tag list', () => {
  const ok = validateReason({ reason_tag: 'time_constraint', summary_en: 'Travelling tonight', evidence_type: 'customer-stated', confidence: 0.8 });
  assert.equal(ok.reason_tag, 'time_constraint');
  const bad = validateReason({ reason_tag: 'mood', summary_en: 'x', evidence_type: 'guess', confidence: 0.5 });
  assert.equal(bad.reason_tag, 'other_unknown');
  assert.equal(bad.evidence_type, 'unknown');
});

test('ruleBasedCustomer parses the Hinglish demo phrase', () => {
  const f = ruleBasedCustomer('kamar pe tight hai, sleeves thodi lambi');
  assert.equal(f.primary_area, 'waist');
  assert.equal(f.primary_issue, 'tight');
  assert.equal(f.secondary_area, 'sleeves');
  assert.equal(f.secondary_issue, 'long');
  assert.equal(f.evidence_type, 'customer-stated');
});

test('ruleBasedCustomer handles English and Devanagari, and no match', () => {
  const en = ruleBasedCustomer('The shoulders feel loose');
  assert.equal(en.primary_area, 'shoulders');
  assert.equal(en.primary_issue, 'loose');
  const hi = ruleBasedCustomer('कमर टाइट है');
  assert.equal(hi.primary_area, 'waist');
  assert.equal(hi.primary_issue, 'tight');
  const none = ruleBasedCustomer('I love this colour');
  assert.equal(none.primary_area, 'other/unknown');
  assert.equal(none.evidence_type, 'unknown');
});

test('ruleBasedReason maps the demo reason to time_constraint, customer-stated', () => {
  const r = ruleBasedReason('Customer travelling tonight, cannot wait for alteration');
  assert.equal(r.reason_tag, 'time_constraint');
  assert.equal(r.evidence_type, 'customer-stated');
});

test('ruleBasedReason evidence types and unknown tag', () => {
  assert.equal(ruleBasedReason('I noticed the price tag put her off').evidence_type, 'associate-observed');
  assert.equal(ruleBasedReason('System showed out of stock').evidence_type, 'system-observed');
  assert.equal(ruleBasedReason('System showed out of stock').reason_tag, 'stock_unavailable');
  assert.equal(ruleBasedReason('hmm').reason_tag, 'other_unknown');
  assert.equal(ruleBasedReason('hmm').evidence_type, 'unknown');
});

test('parseCustomerText uses the LLM result when valid', async () => {
  const llm = async () => ({ raw: JSON.stringify(goodCustomer), method: 'ai:test-model' });
  const out = await parseCustomerText('anything', llm);
  assert.equal(out.method, 'ai:test-model');
  assert.equal(out.fields.primary_area, 'waist');
});

test('parseCustomerText falls back: no llm, null, throw, invalid output', async () => {
  const text = 'kamar pe tight hai, sleeves thodi lambi';
  for (const llm of [undefined, null, async () => null, async () => { throw new Error('HTTP 500'); },
    async () => ({ raw: 'not json', method: 'ai:x' })]) {
    const out = await parseCustomerText(text, llm);
    assert.equal(out.method, 'rule_fallback');
    assert.equal(out.fields.primary_area, 'waist');
  }
});

test('parseCustomerText with empty text returns method none and no fields', async () => {
  const out = await parseCustomerText('   ', async () => { throw new Error('should not be called'); });
  assert.deepEqual(out, { fields: null, method: 'none' });
});

test('parseReasonText: AI success and fallback', async () => {
  const reason = { reason_tag: 'time_constraint', summary_en: 'Customer travelling tonight', evidence_type: 'customer-stated', confidence: 0.9 };
  const ok = await parseReasonText('x', async () => ({ raw: JSON.stringify(reason), method: 'ai:m' }));
  assert.equal(ok.method, 'ai:m');
  const fb = await parseReasonText('Customer travelling tonight, cannot wait for alteration', async () => { throw new Error('down'); });
  assert.equal(fb.method, 'rule_fallback');
  assert.equal(fb.fields.reason_tag, 'time_constraint');
});

test('"hips" is a recognised area (English and Hinglish) and survives AI validation', () => {
  assert.equal(ruleBasedCustomer('hips pe tight hai').primary_area, 'hips');
  assert.equal(ruleBasedCustomer('kulhe tight hain').primary_area, 'hips');
  assert.equal(validateCustomer({ ...goodCustomer, primary_area: 'hips' }).primary_area, 'hips');
});
