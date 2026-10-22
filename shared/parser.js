// AI-output validation, rule-based fallback, and the parse orchestration.
// Pure: the actual LLM call is injected as `llm(kind, text) -> Promise<{raw, method} | null>`.
import { AREAS, ISSUE_WORDS, REASON_TAGS, EVIDENCE_TYPES, UNKNOWN } from './events.js';

export const FALLBACK_METHOD = 'rule_fallback';
export const FALLBACK_LABEL = 'Rule-based fallback — not AI';
const MAX_SUMMARY = 200;

// ---------- validation ----------
function toObject(raw) {
  let v = raw;
  if (typeof v === 'string') {
    const s = v.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('No JSON object in model output');
    v = JSON.parse(s.slice(start, end + 1));
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Model output is not a JSON object');
  return v;
}

const pick = (v, list, fallback) => (list.includes(v) ? v : fallback);

export function scrub(text) {
  return String(text ?? '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[removed]')
    .replace(/\+?\d[\d\s-]{6,}\d/g, '[removed]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SUMMARY);
}

const clamp01 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export function validateCustomer(raw) {
  const o = toObject(raw);
  return {
    primary_area: pick(o.primary_area, AREAS, UNKNOWN),
    primary_issue: pick(o.primary_issue, ISSUE_WORDS, UNKNOWN),
    secondary_area: pick(o.secondary_area, AREAS, UNKNOWN),
    secondary_issue: pick(o.secondary_issue, ISSUE_WORDS, UNKNOWN),
    summary_en: scrub(o.summary_en),
    evidence_type: pick(o.evidence_type, EVIDENCE_TYPES, 'unknown'),
    confidence: clamp01(o.confidence),
  };
}

export function validateReason(raw) {
  const o = toObject(raw);
  return {
    reason_tag: pick(o.reason_tag, REASON_TAGS, 'other_unknown'),
    summary_en: scrub(o.summary_en),
    evidence_type: pick(o.evidence_type, EVIDENCE_TYPES, 'unknown'),
    confidence: clamp01(o.confidence),
  };
}

// ---------- rule-based fallback ----------
const AREA_WORDS = {
  waist: ['waist', 'kamar', 'kamr', 'कमर'],
  chest: ['chest', 'seena', 'sina', 'chhati', 'सीना', 'छाती'],
  shoulders: ['shoulder', 'shoulders', 'kandha', 'kandhe', 'कंधे', 'कंधा'],
  sleeves: ['sleeve', 'sleeves', 'aastin', 'astin', 'baju', 'bazu', 'आस्तीन', 'बाजू'],
  length: ['length', 'lambai', 'lambayi', 'लंबाई'],
  hips: ['hip', 'hips', 'kulha', 'kulhe', 'कूल्हे'],
};
const ISSUE_KEYWORDS = {
  tight: ['tight', 'kasa', 'kasi', 'kasaa', 'tite', 'टाइट', 'कसा', 'कसी'],
  loose: ['loose', 'dhila', 'dheela', 'dhili', 'dheeli', 'dhile', 'baggy', 'ढीला', 'ढीली'],
  long: ['long', 'lamba', 'lambi', 'lambe', 'लंबा', 'लंबी', 'लंबे'],
  short: ['short', 'chhota', 'chhoti', 'chhote', 'chota', 'choti', 'छोटा', 'छोटी', 'छोटे'],
};
const lookup = (dict) => {
  const m = new Map();
  for (const [k, words] of Object.entries(dict)) words.forEach((w) => m.set(w, k));
  return m;
};
const AREA_LOOKUP = lookup(AREA_WORDS);
const ISSUE_LOOKUP = lookup(ISSUE_KEYWORDS);

export function ruleBasedCustomer(text) {
  const tokens = String(text ?? '').toLowerCase().match(/[a-z\u0900-\u097F]+/g) || [];
  const pairs = [];
  let area = null;
  for (const t of tokens) {
    if (AREA_LOOKUP.has(t)) area = AREA_LOOKUP.get(t);
    else if (ISSUE_LOOKUP.has(t)) {
      pairs.push({ area: area || UNKNOWN, issue: ISSUE_LOOKUP.get(t) });
      area = null;
    }
  }
  const [p, s] = pairs;
  const describe = (x) => `${x.area === UNKNOWN ? 'fit' : x.area} too ${x.issue}`;
  const summary = p
    ? [p, s].filter(Boolean).map(describe).join('; ') + ' (rule-based)'
    : 'No fit issue recognised in the text (rule-based)';
  return {
    primary_area: p?.area ?? UNKNOWN,
    primary_issue: p?.issue ?? UNKNOWN,
    secondary_area: s?.area ?? UNKNOWN,
    secondary_issue: s?.issue ?? UNKNOWN,
    summary_en: summary,
    evidence_type: p ? 'customer-stated' : 'unknown',
    confidence: p ? (s ? 0.5 : 0.35) : 0.1,
  };
}

const TAG_RULES = [
  ['time_constraint', /travel|flight|train|hurry|jaldi|tonight|cannot wait|can't wait|cant wait|no time|short on time|\blate\b/],
  ['alteration_not_wanted', /alteration|hemming|\bhem\b|tailor|darzi/],
  ['price', /price|expensive|costly|discount|budget|mehenga|mahanga|cheaper/],
  ['stock_unavailable', /out of stock|not in stock|no stock|stock nahi|unavailable|not available/],
  ['size_unavailable', /size (not|nahi)|no size|size unavailable/],
  ['colour_unavailable', /colou?r|\brang\b/],
  ['style_not_liked', /style|design|not like|didn't like|did not like|pasand nahi/],
  ['will_return', /come back|return later|will return|baad mein|wapas|later/],
  ['just_browsing', /browsing|just looking|dekh raha|dekh rahi/],
];

export function ruleBasedReason(text) {
  const t = String(text ?? '').toLowerCase();
  const tag = TAG_RULES.find(([, re]) => re.test(t))?.[0] ?? 'other_unknown';
  let evidence = 'unknown';
  if (/\b(system|inventory|pos|app showed|stock showed|showed out)\b/.test(t)) evidence = 'system-observed';
  else if (/\b(i noticed|i saw|i observed|observed|noticed|seemed|looked|dikha|lag raha)\b/.test(t)) evidence = 'associate-observed';
  else if (/\b(customer|she|he|they|said|told|bola|boli|kaha|wants?|cannot|can't)\b/.test(t)) evidence = 'customer-stated';
  return {
    reason_tag: tag,
    summary_en: scrub(text),
    evidence_type: evidence,
    confidence: tag === 'other_unknown' ? 0.2 : 0.5,
  };
}

// ---------- orchestration ----------
async function parseWith(kind, text, llm, validate, rules) {
  const clean = String(text ?? '').trim();
  if (!clean) return { fields: null, method: 'none' };
  if (typeof llm === 'function') {
    try {
      const res = await llm(kind, clean);
      if (res && res.raw != null) return { fields: validate(res.raw), method: res.method };
    } catch {
      /* fall through to rule-based fallback */
    }
  }
  return { fields: rules(clean), method: FALLBACK_METHOD };
}

export const parseCustomerText = (text, llm) => parseWith('customer', text, llm, validateCustomer, ruleBasedCustomer);
export const parseReasonText = (text, llm) => parseWith('reason', text, llm, validateReason, ruleBasedReason);
