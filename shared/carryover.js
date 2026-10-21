// Session fit carryover, 100% deterministic and derived from the log: nothing is stored about a person.
// If a customer in a room kept a different size or cut than the one they asked about (they "sized up"), that is a
// measured change. When a second request comes from the same visit, show the associate what the same change would
// mean for the new garment, using the measurements in the catalogue. A hint for the associate, never a decision.
import { getSku, MEASURE_LABELS } from './catalogue.js';

const lineOf = (s) => s.line ?? `${s.category}|${s.fabric}`;
const dept = (s) => s.department ?? 'Men';
const round = (n) => Math.round(n * 10) / 10;
const phrase = ({ measure, delta }) => `${delta > 0 ? '+' : '−'}${Math.abs(delta)} cm ${(MEASURE_LABELS[measure] || measure).toLowerCase()}`;

/**
 * For a request, what the earlier purchase in the same room visit suggests, or null.
 * The most recent purchase of a different item than the one first asked about is used. Only like with like: the
 * same department and garments measured the same way. The suggested item comes from the new garment's own line,
 * must be in stock, and must be closer to the carried-over change than the garment they asked for.
 */
export function carryoverFor(request, derived, catalogue, cfg = {}) {
  const cur = getSku(request.skuId, catalogue);
  if (!cur) return null;
  const earlier = derived.requests
    .filter((r) => r.id !== request.id && r.room === request.room && r.sessionStartTs === request.sessionStartTs
      && r.createdTs < request.createdTs && r.status === 'closed' && r.outcome === 'bought_alternative'
      && r.keptItemId && r.keptItemId !== r.skuId)
    .sort((a, b) => b.closedTs - a.closedTs);
  const prior = earlier[0];
  if (!prior) return null;
  const from = getSku(prior.skuId, catalogue);
  const kept = getSku(prior.keptItemId, catalogue);
  if (!from || !kept || dept(from) !== dept(cur)) return null;
  const keys = Object.keys(from.m).filter((k) => k in kept.m && k in cur.m);
  if (keys.length < 3) return null; // not measured the same way (shirt against trousers)
  const delta = Object.fromEntries(keys.map((k) => [k, round(kept.m[k] - from.m[k])]));
  const stay = keys.reduce((n, k) => n + Math.abs(delta[k]), 0);
  if (stay < (cfg.minImprovementCm ?? 1)) return null;
  const best = catalogue
    .filter((s) => s.stock > 0 && s.id !== cur.id && lineOf(s) === lineOf(cur))
    .map((s) => ({ s, miss: keys.reduce((n, k) => n + Math.abs((s.m[k] - cur.m[k]) - delta[k]), 0) }))
    .filter((c) => c.miss < stay - 1e-9) // closer to the carried-over change than the garment they asked for
    .sort((a, b) => a.miss - b.miss || (a.s.id < b.s.id ? -1 : 1))[0];
  if (!best) return null;
  const deltas = keys.map((measure) => ({ measure, delta: delta[measure] })).filter((d) => d.delta !== 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const top = deltas.slice(0, 3).map(phrase).join(', ');
  return {
    fromId: from.id, keptId: kept.id, suggestedId: best.s.id, deltas,
    text: `Room ${request.room}: the customer went from ${from.name} ${from.size} ${from.cut} to ${kept.size} ${kept.cut} (${top}). Consider bringing ${best.s.size} ${best.s.cut} ${cur.name} alongside.`,
  };
}
