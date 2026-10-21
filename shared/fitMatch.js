// Deterministic fit matching. No AI: the structured issue maps to target measurements,
// and in-stock catalogue items are ranked by explicit rules.
import { CHIPS, FIT_ISSUES, ISSUE_TO_WORD, UNKNOWN, STYLE_AXES, STYLE_AXIS_LABELS, styleKind } from './events.js';
import { MEASURE_LABELS } from './catalogue.js';

const DIR = { tight: +1, loose: -1, long: -1, short: +1 };

const TROUSERS = new Set(['chinos', 'jeans']);
const TOP_AREAS = { chest: 'chest', waist: 'waist', shoulders: 'shoulder', sleeves: 'sleeve', length: 'length' };
const TROUSER_AREAS = { waist: 'waist', hips: 'hip', length: 'inseam' };
const AREA_MEASURE = { shirt: TOP_AREAS, polo: TOP_AREAS, chinos: TROUSER_AREAS, jeans: TROUSER_AREAS };
const measureFor = (category, area) => AREA_MEASURE[category]?.[area] ?? null;

function defaultArea(category, word) {
  const lengthWord = word === 'long' || word === 'short';
  if (TROUSERS.has(category)) return lengthWord ? 'length' : 'waist';
  return lengthWord ? 'length' : 'chest';
}

const label = (m) => (MEASURE_LABELS[m] || m).toLowerCase();

/** Combine the tapped button, tapped chips and parsed fields into one structured issue. */
export function mergeIssue({ sku, issue, issues = null, chips = [], styleAxes = [], parsed = null, parseMethod = null }) {
  const info = { issue, issues: issues?.length ? [...issues] : [issue], primary: null, secondary: null, conflicts: [], notes: [], assumptions: [], styleAxes: [] };
  if (issue === 'another_style') {
    // Which style details the customer asked to change; the ones that do not apply to this garment are ignored.
    const valid = STYLE_AXES[styleKind(sku.category)] || [];
    for (const a of styleAxes) {
      if (valid.includes(a)) { if (!info.styleAxes.includes(a)) info.styleAxes.push(a); }
      else info.notes.push(`"${(STYLE_AXIS_LABELS[a] || a).toLowerCase()}" does not apply to ${sku.name.toLowerCase()} — ignored`);
    }
    return info;
  }
  if (!FIT_ISSUES.includes(issue)) return info;

  if (info.issues.length > 1 && info.issues.every((k) => FIT_ISSUES.includes(k))) return mergeTwoIssues(info, { sku, chips, parsed, parseMethod });

  const word = ISSUE_TO_WORD[issue];
  const parseSource = parseMethod === 'rule_fallback' ? 'rule_fallback' : 'ai_parsed';
  const cat = sku.category;

  const tapped = chips.filter((c) => CHIPS.includes(c));
  const usableChips = [];
  for (const c of tapped) {
    if (measureFor(cat, c)) usableChips.push(c);
    else info.notes.push(`"${c}" does not apply to ${sku.name.toLowerCase()} — ignored`);
  }

  // AI pairs, in the customer's order.
  const pairs = [];
  if (parsed) {
    if (parsed.primary_issue !== UNKNOWN || parsed.primary_area !== UNKNOWN) {
      pairs.push({ area: parsed.primary_area, word: parsed.primary_issue });
    }
    if (parsed.secondary_issue !== UNKNOWN || parsed.secondary_area !== UNKNOWN) {
      pairs.push({ area: parsed.secondary_area, word: parsed.secondary_issue });
    }
  }
  const aiPrimary = parsed && parsed.primary_issue !== UNKNOWN ? parsed.primary_issue : null;
  if (aiPrimary && aiPrimary !== word) {
    info.conflicts.push(`AI read the main issue as "${aiPrimary}", but the customer tapped "${word}" — tapped button wins`);
  }

  // Primary area: tapped chip > AI pair that agrees with the tapped word > garment default.
  const aiMatch = pairs.find((p) => p.word === word && p.area !== UNKNOWN);
  let primaryArea;
  let areaSource;
  if (usableChips.length) {
    primaryArea = usableChips[0];
    areaSource = 'customer_tapped';
    if (aiMatch && aiMatch.area !== primaryArea && !usableChips.includes(aiMatch.area)) {
      info.conflicts.push(`AI parsed "${aiMatch.area}", but the customer tapped "${primaryArea}" — tapped chip wins`);
    }
  } else if (aiMatch && measureFor(cat, aiMatch.area)) {
    primaryArea = aiMatch.area;
    areaSource = parseSource;
  } else {
    primaryArea = defaultArea(cat, word);
    areaSource = 'default';
    info.assumptions.push(`Area assumed: ${primaryArea} (customer did not specify)`);
  }
  info.primary = {
    word, wordSource: 'customer_tapped', area: primaryArea, areaSource,
    measure: measureFor(cat, primaryArea), dir: DIR[word],
  };

  // Secondary: AI pair that is a different issue/area, else an extra tapped chip.
  const aiSecond = pairs.find(
    (p) => p !== aiMatch && p.word !== UNKNOWN && p.area !== UNKNOWN && p.area !== primaryArea,
  );
  if (aiSecond && aiSecond.word !== UNKNOWN && measureFor(cat, aiSecond.area)) {
    info.secondary = {
      word: aiSecond.word, area: aiSecond.area, source: parseSource,
      measure: measureFor(cat, aiSecond.area), dir: DIR[aiSecond.word],
    };
  } else {
    if (aiSecond && !measureFor(cat, aiSecond.area)) {
      info.notes.push(`"${aiSecond.area}" does not apply to ${sku.name.toLowerCase()} — ignored`);
    }
    const extra = usableChips.find((c) => c !== primaryArea);
    if (extra) {
      info.secondary = {
        word, area: extra, source: 'customer_tapped', measure: measureFor(cat, extra), dir: DIR[word],
      };
    }
  }
  return info;
}

const sizeIndex = (sku, catalogue) => {
  const sizes = [...new Set(catalogue.filter((s) => s.category === sku.category).map((s) => s.size))];
  const order = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
  const key = (z) => (order.includes(z) ? order.indexOf(z) : Number(z));
  return (s) => [...sizes].sort((a, b) => key(a) - key(b)).indexOf(s.size);
};

// Total difference over the measurements two garments share: smaller means a closer fit.
const fitGap = (a, b) => Object.keys(a.m).filter((k) => k in b.m).reduce((n, k) => n + Math.abs(a.m[k] - b.m[k]), 0);

// Colour is only ever a tie-break: measurements decide first. When another colour is suggested, the reason says so.
const sameColour = (a, b) => (a.colour === b.colour ? 1 : 0);
const colourNote = (alt, orig) => (alt.colour === orig.colour ? '' : ` in ${alt.colour}`);

// Fit, size and stock-check suggestions stay inside one design (a product line): a roomier waist must not swap the collar.
// Rows without a line (older data) fall back to category + fabric.
const lineOf = (s) => s.line ?? `${s.category}|${s.fabric}`;
const attrsOf = (s) => s.attrs ?? { fabric: s.fabric };
const styleLabel = (s) => (s.styleName ? `${s.name} · ${s.styleName}` : s.name);
const sameFamily = (a, b) => lineOf(a) === lineOf(b);

const base = (sku, issueInfo) => ({
  originalId: sku.id,
  itemId: null,
  optionIds: [],
  options: [], // the best items to bring in one trip, best first; options[0] is also the top-level itemId
  drivers: [],
  diffs: [],
  fixesSecondary: false,
  assumptions: issueInfo.assumptions,
  conflicts: issueInfo.conflicts,
  notes: issueInfo.notes,
});

const NO_ALT = 'No in-stock alternative improves this — consider cross-store order';

function diffsFor(sku, alt, primary, secondary) {
  return Object.keys(sku.m)
    .filter((k) => k in alt.m)
    .map((k) => ({
      measure: k,
      original: sku.m[k],
      alt: alt.m[k],
      delta: Math.round((alt.m[k] - sku.m[k]) * 10) / 10,
      role: k === primary?.measure ? 'primary' : k === secondary?.measure ? 'secondary' : 'other',
    }));
}

/** First n items of a ranked list, one per key (so three colours of the same fit count once). */
const distinctBy = (list, keyFn, n) => {
  const seen = new Set();
  const picked = [];
  for (const x of list) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    picked.push(x);
    if (picked.length >= n) break;
  }
  return picked;
};

// Areas that are about girth (how roomy) and areas that are about length. Two issues usually sit in one of each.
export const GIRTH_AREAS = ['chest', 'waist', 'shoulders', 'hips'];
const kindOfWord = (word) => (word === 'long' || word === 'short' ? 'length' : 'girth');
const inKind = (area, kind) => (kind === 'length' ? !GIRTH_AREAS.includes(area) : GIRTH_AREAS.includes(area));

/**
 * Two fit issues for one article, for example "too tight" and "too short". Each issue gets its own area: the tapped
 * chip of its kind, else the area the AI read for that word, else the garment's default. The first issue is the
 * primary target and the second the secondary one, so the matcher can look for items that fix both.
 */
function mergeTwoIssues(info, { sku, chips, parsed, parseMethod }) {
  const cat = sku.category;
  const parseSource = parseMethod === 'rule_fallback' ? 'rule_fallback' : 'ai_parsed';
  const usable = [];
  for (const c of chips.filter((x) => CHIPS.includes(x))) {
    if (measureFor(cat, c)) usable.push(c);
    else info.notes.push(`"${c}" does not apply to ${sku.name.toLowerCase()} — ignored`);
  }
  const pairs = [];
  if (parsed) {
    for (const k of ['primary', 'secondary']) {
      if (parsed[`${k}_issue`] !== UNKNOWN && parsed[`${k}_area`] !== UNKNOWN) pairs.push({ area: parsed[`${k}_area`], word: parsed[`${k}_issue`] });
    }
  }
  const words = info.issues.map((k) => ISSUE_TO_WORD[k]);
  const aiPrimary = parsed && parsed.primary_issue !== UNKNOWN ? parsed.primary_issue : null;
  if (aiPrimary && !words.includes(aiPrimary)) {
    info.conflicts.push(`AI read the main issue as "${aiPrimary}", but the customer tapped ${words.map((w) => `"${w}"`).join(' and ')} — tapped buttons win`);
  }
  const targets = words.map((word) => {
    const kind = kindOfWord(word);
    const mine = usable.filter((c) => inKind(c, kind));
    const ai = pairs.find((p) => p.word === word && measureFor(cat, p.area) && inKind(p.area, kind));
    let area; let source;
    if (mine.length) { area = mine[0]; source = 'customer_tapped'; if (mine.length > 1) info.notes.push(`"${mine[1]}" was also tapped for ${word}, only "${mine[0]}" is used`); }
    else if (ai) { area = ai.area; source = parseSource; }
    else { area = defaultArea(cat, word); source = 'default'; info.assumptions.push(`Area assumed for "${word}": ${area} (customer did not specify)`); }
    return { word, area, source, measure: measureFor(cat, area), dir: DIR[word] };
  });
  info.primary = { ...targets[0], wordSource: 'customer_tapped', areaSource: targets[0].source };
  delete info.primary.source;
  info.secondary = { ...targets[1], wordSource: 'customer_tapped', areaSource: targets[1].source };
  return info;
}

export function fitMatch({ sku, issueInfo, catalogue, config, excludeIds = [] }) {
  const K = Math.min(5, Math.max(1, Math.floor(config.bringCount ?? 3)));
  const out = { ...base(sku, issueInfo), excluded: [...excludeIds] };
  const stocked = catalogue.filter((s) => s.stock > 0 && s.id !== sku.id && sameFamily(s, sku) && !excludeIds.includes(s.id));

  if (issueInfo.issue === 'another_size') {
    const idx = sizeIndex(sku, catalogue);
    const cands = stocked
      .filter((s) => s.cut === sku.cut && s.size !== sku.size)
      .sort((a, b) => Math.abs(idx(a) - idx(sku)) - Math.abs(idx(b) - idx(sku)) || sameColour(b, sku) - sameColour(a, sku) || (a.id < b.id ? -1 : 1));
    if (!cands.length) return { ...out, kind: 'no_alternative', reason: NO_ALT };
    return {
      ...out, kind: 'alternative_size', itemId: cands[0].id,
      options: distinctBy(cands, (s) => s.size, K).map((s) => ({ itemId: s.id })),
      reason: `Nearest in-stock size in ${sku.cut}: ${cands[0].size}${colourNote(cands[0], sku)} — no measurement driver, customer asked for a different size`,
    };
  }
  if (issueInfo.issue === 'another_style') {
    // "Style" means design, never size. The customer may ask for particular details to change (collar, pattern,
    // fabric / neckline / front). Rules, in order: same size, same kind of garment, a different design (product line);
    // it must differ on every requested detail and change as little else as possible; same cut first, then the
    // original colour, then the closest fit. Fallbacks are labelled: other cut, partial match, and finally the
    // other cut of the same design.
    const kind = styleKind(sku.category);
    const axes = STYLE_AXES[kind] || [];
    const asked = (issueInfo.styleAxes || []).filter((a) => axes.includes(a));
    const dept = (s) => s.department ?? 'Men'; // a men's customer is never offered a women's design, or the reverse
    const pool = catalogue.filter((s) => s.stock > 0 && s.id !== sku.id && s.size === sku.size && !excludeIds.includes(s.id) && styleKind(s.category) === kind && dept(s) === dept(sku));
    const designs = pool.filter((s) => lineOf(s) !== lineOf(sku)).map((s) => {
      const diff = axes.filter((a) => attrsOf(s)[a] !== attrsOf(sku)[a]);
      return { s, diff, extra: diff.filter((a) => !asked.includes(a)), hit: diff.filter((a) => asked.includes(a)) };
    }).filter((c) => c.diff.length);
    const meetsAll = (c) => (asked.length ? asked.every((a) => c.diff.includes(a)) : true);
    const rank = (a, b) => (asked.length ? a.extra.length - b.extra.length : a.diff.length - b.diff.length)
      || sameColour(b.s, sku) - sameColour(a.s, sku) || fitGap(a.s, sku) - fitGap(b.s, sku) || (a.s.id < b.s.id ? -1 : 1);
    const tier1 = designs.filter((c) => c.s.cut === sku.cut && meetsAll(c)).sort(rank);
    const tier2 = designs.filter((c) => c.s.cut !== sku.cut && meetsAll(c)).sort(rank);
    const tier3 = asked.length ? designs.filter((c) => c.s.cut === sku.cut && !meetsAll(c) && c.hit.length).sort((a, b) => b.hit.length - a.hit.length || rank(a, b)) : [];
    const styleOption = (pick) => {
      const alt = pick.s;
      const changed = pick.diff.map((axis) => ({ axis, label: STYLE_AXIS_LABELS[axis], from: attrsOf(sku)[axis], to: attrsOf(alt)[axis] }));
      const unmet = asked.filter((a) => !pick.diff.includes(a));
      const alsoCut = alt.cut !== sku.cut;
      const what = changed.map((c) => c.label.toLowerCase()).join(' and ');
      const moves = changed.map((c) => `${c.from} → ${c.to}`).join(', ');
      let reason = `A different style (${what}): ${moves}${colourNote(alt, sku)}`;
      if (unmet.length) reason += `. The ${unmet.map((a) => STYLE_AXIS_LABELS[a].toLowerCase()).join(' and ')} could not be changed in size ${sku.size}`;
      reason += alsoCut
        ? `. No matching design was in stock in ${sku.cut}, so this is the ${alt.cut} cut and the cut changes the fit`
        : `, in your size and cut (${sku.size} ${sku.cut})`;
      reason += ' — no measurement driver, customer asked for a different style';
      return {
        itemId: alt.id,
        change: { type: 'design', from: styleLabel(sku), to: styleLabel(alt), alsoCut, axes: pick.diff, changed, requested: asked, unmet },
        reason,
      };
    };
    const ranked = distinctBy([...tier1, ...tier2, ...tier3], (c) => lineOf(c.s), K); // one per design, best tier first
    if (ranked.length) {
      const options = ranked.map(styleOption);
      return { ...out, kind: 'alternative_style', ...options[0], options };
    }
    const sameDesign = pool.filter((s) => lineOf(s) === lineOf(sku) && s.cut !== sku.cut)
      .sort((a, b) => sameColour(b, sku) - sameColour(a, sku) || (a.id < b.id ? -1 : 1));
    if (sameDesign.length) {
      const alt = sameDesign[0];
      const only = {
        itemId: alt.id,
        change: { type: 'cut', from: sku.cut, to: alt.cut },
        reason: `No other design in stock in size ${sku.size}. Only the ${alt.cut} cut of the same ${sku.name}${colourNote(alt, sku)} is available: it is the same style and changes how roomy the fit is`,
      };
      return { ...out, kind: 'alternative_style', ...only, options: [only] };
    }
    return { ...out, kind: 'no_alternative', reason: NO_ALT };
  }
  if (issueInfo.issue === 'check_stock') {
    // Same size and cut in other colours first (that is what "another colour" means), then same size, then same cut.
    const closeness = (s) => (s.size === sku.size && s.cut === sku.cut ? 0 : s.size === sku.size ? 1 : s.cut === sku.cut ? 2 : 3);
    const cands = stocked
      .sort((a, b) => closeness(a) - closeness(b) || sameColour(b, sku) - sameColour(a, sku) || (a.id < b.id ? -1 : 1))
      .slice(0, Math.max(K, 4)); // a stock check may show a few more than the trip carries
    if (!cands.length) return { ...out, kind: 'no_alternative', reason: 'Nothing else in this style is in stock — consider cross-store order' };
    return {
      ...out, kind: 'stock_check', optionIds: cands.map((s) => s.id), options: cands.slice(0, K).map((s) => ({ itemId: s.id })),
      reason: `${cands.length} other colour/size option${cands.length > 1 ? 's' : ''} in stock — pick one to bring`,
    };
  }

  // ----- fit issues -----
  const { primary, secondary } = issueInfo;
  const min = config.minImprovementCm;
  const gain = (alt, t) => (t?.measure && t.measure in alt.m && t.measure in sku.m ? (alt.m[t.measure] - sku.m[t.measure]) * t.dir : -Infinity);

  // With two issues, an item may fix both, only one, or neither. Items that fix both come first and, when any exist,
  // are the only ones offered; otherwise the best partial fits are shown and the issue left unfixed is named.
  const two = !!secondary && (issueInfo.issues?.length ?? 1) > 1;
  const fixes = (alt, t) => !!t && gain(alt, t) >= min - 1e-9;
  const scored = stocked
    .filter((s) => fixes(s, primary) || (two && fixes(s, secondary)))
    .map((s) => {
      const fixesPrimary = fixes(s, primary);
      const fixesSecondary = fixes(s, secondary);
      const others = Object.keys(sku.m).filter((k) => k in s.m && k !== primary.measure && k !== secondary?.measure);
      const otherDiff = others.reduce((sum, k) => sum + Math.abs(s.m[k] - sku.m[k]), 0);
      const jump = primary.measure in s.m && primary.measure in sku.m ? Math.abs(s.m[primary.measure] - sku.m[primary.measure]) : Infinity;
      return { s, fixesPrimary, fixesSecondary, otherDiff, jump };
    });
  const bothFixed = scored.filter((c) => c.fixesPrimary && c.fixesSecondary);
  const candidates = (two && bothFixed.length ? bothFixed : scored)
    .sort((a, b) => (b.fixesPrimary + b.fixesSecondary) - (a.fixesPrimary + a.fixesSecondary) || (b.fixesPrimary - a.fixesPrimary)
      || a.otherDiff - b.otherDiff || a.jump - b.jump
      || sameColour(b.s, sku) - sameColour(a.s, sku) || (a.s.id < b.s.id ? -1 : 1));

  if (candidates.length) {
    const phrase = (d) => `${Math.abs(d.delta)} cm ${d.delta > 0 ? 'more' : 'less'} ${label(d.measure)}`;
    const hemNote = (t) => (config.alterationOffered && TROUSERS.has(sku.category) && t.measure === 'inseam' && t.dir < 0 ? ' — the length can be hemmed in store' : '');
    const fitOption = (c) => {
      const diffs = diffsFor(sku, c.s, primary, secondary);
      const drivers = diffs.filter((d) => (d.role === 'primary' && c.fixesPrimary) || (d.role === 'secondary' && c.fixesSecondary));
      const parts = drivers.map(phrase);
      let reason = `${c.s.cut} ${c.s.size}${colourNote(c.s, sku)} has ${parts.join(' and ')} than ${sku.cut} ${sku.size}`;
      if (secondary && !c.fixesSecondary) reason += `; does not fix ${label(secondary.measure)}${hemNote(secondary)}`;
      if (!c.fixesPrimary) reason += `; does not fix ${label(primary.measure)}${hemNote(primary)}`;
      return { itemId: c.s.id, drivers, diffs, fixesSecondary: c.fixesSecondary, reason };
    };
    // Bring a range in one trip: the best fit first, then the next distinct fits (one per size and cut).
    const options = distinctBy(candidates, (c) => `${c.s.size}|${c.s.cut}`, K).map(fitOption);
    return { ...out, kind: 'alternative', ...options[0], options };
  }

  const driverOnly = primary.measure && primary.measure in sku.m
    ? [{ measure: primary.measure, original: sku.m[primary.measure], alt: null, delta: null, role: 'primary' }]
    : [];
  const hemTarget = [primary, secondary].find((t) => t && TROUSERS.has(sku.category) && t.measure === 'inseam' && t.dir < 0);
  if (hemTarget) {
    const reason = config.alterationOffered
      ? 'No shorter inseam in stock — eligible for in-store hemming (if the store offers alteration — prototype setting) or cross-store order'
      : 'No shorter inseam in stock — consider cross-store order';
    return { ...out, kind: 'alteration_or_crossstore', drivers: driverOnly, reason };
  }
  return { ...out, kind: 'no_alternative', drivers: driverOnly, reason: NO_ALT };
}

/** Customer-facing wording for one measurement change, e.g. {waist, +6} -> "a roomier waist". */
export function describeChange({ measure, delta }) {
  const up = delta > 0;
  switch (measure) {
    case 'chest': case 'waist': case 'hip': return `a ${up ? 'roomier' : 'closer-fitting'} ${measure}`;
    case 'shoulder': return `${up ? 'roomier' : 'closer-fitting'} shoulders`;
    case 'sleeve': return `a ${up ? 'longer' : 'shorter'} sleeve`;
    case 'length': return `a ${up ? 'longer' : 'shorter'} body`;
    case 'inseam': return `a ${up ? 'longer' : 'shorter'} inseam`;
    default: return null;
  }
}

/** One short phrase on why the item was chosen, safe to show the customer. Null when there is nothing to say. */
export function choiceSummary(s) {
  if (!s) return null;
  switch (s.kind) {
    case 'alternative': {
      const parts = (s.drivers || []).filter((d) => d.delta != null).map(describeChange).filter(Boolean);
      return parts.length ? parts.join(' and ') : null;
    }
    case 'alternative_size': return 'a different size';
    case 'alternative_style':
      if (s.change?.type === 'design') {
        if (s.change.changed?.length) return `a different ${s.change.changed.map((c) => `${c.label.toLowerCase()} (${c.to})`).join(' and ')}`;
        return `a different style: ${s.change.to}`;
      }
      if (s.change?.type === 'cut') return `the ${s.change.to} cut of the same design`;
      return 'a different style';
    case 'stock_check': return 'another colour or size';
    default: return null;
  }
}

/** Every item a suggestion proposes to bring, best first. Reads older shapes (single item, or a list of choices). */
export function suggestionItemIds(s) {
  if (!s) return [];
  if (s.options?.length) return s.options.map((o) => o.itemId);
  return [s.itemId, ...(s.optionIds || [])].filter(Boolean);
}

/** The per-item view of a suggestion (its drivers, change and reason), or null if the item is not part of it. */
export function optionFor(s, itemId) {
  if (!s) return null;
  const o = (s.options || []).find((x) => x.itemId === itemId);
  return o ? { kind: s.kind, ...o } : null;
}
