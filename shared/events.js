// Fixed vocabularies shared by server, browser and tests.
export const EVENT_TYPES = [
  'created', 'routed', 'accepted', 'suggestion_shown', 'suggestion_confirmed',
  'suggestion_rejected', 'on_the_way', 'floor_pull_requested', 'floor_pull_done',
  'escalated', 'closed', 'cancelled', 'reason_added', 'inventory_discrepancy', 'item_declined', 'assisted', 'assigned', 'floor_pull_cancelled', 'delivered', 'tryon_feedback',
];

export const UNKNOWN = 'other/unknown';

export const ISSUES = {
  too_tight: 'Too tight',
  too_loose: 'Too loose',
  too_long: 'Too long',
  too_short: 'Too short',
  another_size: 'Another size',
  another_style: 'Another style',
  check_stock: 'Check if another colour/size is in stock',
};
export const FIT_ISSUES = ['too_tight', 'too_loose', 'too_long', 'too_short'];
const OPPOSITE = { too_tight: 'too_loose', too_loose: 'too_tight', too_long: 'too_short', too_short: 'too_long' };

/**
 * The issues a customer picked for one article. One of any kind, or up to two fit issues that do not contradict
 * (for example too tight and too short). Order is kept; the first is the main one.
 */
export function normaliseIssues(list) {
  if (!Array.isArray(list) || !list.length) throw new Error('Pick an issue');
  if (list.some((k) => !(k in ISSUES))) throw new Error('Unknown issue');
  const issues = [...new Set(list)];
  if (issues.length === 1) return issues;
  if (issues.some((k) => !FIT_ISSUES.includes(k))) throw new Error('Only fit issues can be combined');
  if (issues.length > 2 || issues.some((k) => issues.includes(OPPOSITE[k]))) throw new Error('Those issues contradict each other');
  return issues;
}
export const issuesLabel = (issues) => issues.map((k) => ISSUES[k] || k).join(' + ');
export const oppositeIssue = (k) => OPPOSITE[k] ?? null;

export const ISSUE_TO_WORD = { too_tight: 'tight', too_loose: 'loose', too_long: 'long', too_short: 'short' };
export const WORD_TO_ISSUE = { tight: 'too_tight', loose: 'too_loose', long: 'too_long', short: 'too_short' };

export const CHIPS = ['waist', 'chest', 'shoulders', 'sleeves', 'length', 'hips'];
// Which body-area chips make sense for which garments (the customer is never asked about sleeves on trousers).
export const CHIPS_BY_KIND = { top: ['waist', 'chest', 'shoulders', 'sleeves', 'length'], trousers: ['waist', 'hips', 'length'] };
export const AREAS = [...CHIPS, UNKNOWN];
export const ISSUE_WORDS = ['tight', 'loose', 'long', 'short', UNKNOWN];

export const OUTCOMES = {
  bought_original: 'Bought original',
  bought_alternative: 'Bought alternative',
  cross_store_order: 'Cross-store order',
  saved_for_later: 'Saved for later',
  left: 'Left',
};
// A request that was carried on in a follow-up ("still not right, try another") is closed with this; it is neither a
// sale nor a loss, so it is left out of the closed counts and the follow-up carries the result.
export const CONTINUED = 'continued';
export const OUTCOME_LABELS = { ...OUTCOMES, [CONTINUED]: 'Continued in a follow-up request' };
export const TRYON_RESULTS = ['fits', 'not_right'];
export const SAVE_OUTCOMES = ['bought_original', 'bought_alternative', 'cross_store_order'];

export const ROLES = { runner: 'Fitting-room runner', floor: 'Floor associate' };

export const REASON_TAGS = [
  'time_constraint', 'price', 'style_not_liked', 'size_unavailable', 'colour_unavailable',
  'alteration_not_wanted', 'just_browsing', 'will_return', 'stock_unavailable', 'other_unknown',
];
export const REASON_LABELS = {
  time_constraint: 'Time constraint', price: 'Price', style_not_liked: 'Style not liked',
  size_unavailable: 'Size unavailable', colour_unavailable: 'Colour unavailable',
  alteration_not_wanted: 'Alteration not wanted', just_browsing: 'Just browsing',
  will_return: 'Will return', stock_unavailable: 'Stock unavailable', other_unknown: 'Other / unknown',
};
export const EVIDENCE_TYPES = ['customer-stated', 'associate-observed', 'system-observed', 'unknown'];

// One-tap reasons for the associate. They map straight onto the fixed reason tags, so no AI call is needed.
export const QUICK_REASONS = [
  { key: 'time', label: 'Short on time', tag: 'time_constraint', evidence: 'customer-stated', summary: 'Customer was short on time' },
  { key: 'price', label: 'Price concern', tag: 'price', evidence: 'customer-stated', summary: 'Customer was concerned about the price' },
  { key: 'style', label: 'Style not liked', tag: 'style_not_liked', evidence: 'customer-stated', summary: 'Customer did not like the style' },
  { key: 'return', label: 'Will come back', tag: 'will_return', evidence: 'customer-stated', summary: 'Customer plans to come back later' },
  { key: 'size', label: 'Size not available', tag: 'size_unavailable', evidence: 'system-observed', summary: 'The size needed was not available' },
  { key: 'alteration', label: 'No alteration', tag: 'alteration_not_wanted', evidence: 'customer-stated', summary: 'Customer did not want an alteration' },
];

// "Another style" means a different design. These are the style details a customer can ask to change, per kind of
// garment. Fabric is the product itself (Oxford vs Poplin shirts, chinos vs jeans).
export const STYLE_AXES = { shirt: ['collar', 'pattern', 'fabric'], polo: ['neckline', 'pattern'], trousers: ['front', 'fabric'] };
export const STYLE_AXIS_LABELS = { collar: 'Collar', pattern: 'Pattern', fabric: 'Fabric', neckline: 'Neckline', front: 'Front' };
export const ALL_STYLE_AXES = Object.keys(STYLE_AXIS_LABELS);
/** 'shirt' | 'polo' | 'trousers' (chinos and jeans are one kind). */
export const styleKind = (category) => (['chinos', 'jeans'].includes(category) ? 'trousers' : category);
