// Pure helpers behind the visual components (SLA rings, bullet chart, outcome funnel, rack zones).
// They compute numbers and words only; the screens draw them.

const r1 = (n) => Math.round(n * 10) / 10;

/** A wait in a few words for a customer: "under a minute", "about 2 min". */
export function waitPhrase(ms) {
  if (ms == null) return null;
  if (ms < 45_000) return 'under a minute';
  return `about ${Math.max(1, Math.round(ms / 60_000))} min`;
}

/** Ring fill (0..1 of the escalation threshold) and tone for a card's SLA timer. */
export function slaRing(elapsedMs, cfg, done = false) {
  if (done) return { fraction: 1, tone: 'done' };
  const esc = cfg.escalateSeconds * 1000;
  return {
    fraction: Math.min(1, elapsedMs / esc),
    tone: elapsedMs >= esc ? 'esc' : elapsedMs >= cfg.warnSeconds * 1000 ? 'warn' : 'ok',
  };
}

/** Position of a median against the warning and escalation marks on one axis (percentages of the axis). */
export function bulletScale(valueMs, cfg) {
  if (valueMs == null) return null;
  const v = valueMs / 1000;
  const axis = Math.max(cfg.escalateSeconds * 1.5, v * 1.15);
  return {
    axisSec: axis,
    valuePct: Math.min(100, (v / axis) * 100),
    warnPct: (cfg.warnSeconds / axis) * 100,
    escPct: (cfg.escalateSeconds / axis) * 100,
    tone: v >= cfg.escalateSeconds ? 'esc' : v >= cfg.warnSeconds ? 'warn' : 'ok',
  };
}

const FUNNEL_ORDER = ['bought_alternative', 'bought_original', 'cross_store_order', 'saved_for_later', 'left'];

/**
 * The fate of closed requests as a 100% stacked bar. It is over *closed* requests so that the first three segments
 * add up to the save rate; "saved for later" is deliberately a separate segment, and cancellations are reported apart.
 */
export function outcomeFunnel(metrics) {
  const total = metrics.closed || 0;
  const segments = total
    ? FUNNEL_ORDER.map((key) => ({ key, count: metrics.outcomeMix[key] || 0, pct: ((metrics.outcomeMix[key] || 0) / total) * 100 })).filter((s) => s.count > 0)
    : [];
  return { total, segments, cancelled: metrics.cancelled || 0 };
}

/** Aisle letter and number of a rack code like "A5". */
export const rackZone = (rack) => ({ aisle: rack ? rack[0] : '?', number: rack ? rack.slice(1) : '' });

/**
 * A short, complete name for an item in a trip, relative to the garment the customer has on: its size and cut, plus
 * only what else differs (design, colour). A design change leads, because that is what was asked for.
 */
export function tripItemName(orig, alt) {
  const fit = `${alt.size} ${alt.cut}`;
  const design = alt.name !== orig.name ? `${alt.name} (${alt.styleName})` : (alt.styleName || '') !== (orig.styleName || '') ? alt.styleName : null;
  return [design, fit, alt.colour !== orig.colour ? alt.colour : null].filter(Boolean).join(' · ');
}
