// Every dashboard number is computed here from the event list. Nothing is hardcoded or stored.
import { deriveAll, isOpen } from './derive.js';
import { CATALOGUE, getSku, skuLabel } from './catalogue.js';
import { mergeIssue } from './fitMatch.js';
import { OUTCOMES, CONTINUED, SAVE_OUTCOMES, EVIDENCE_TYPES, ISSUES, FIT_ISSUES } from './events.js';
import { DEFAULTS } from './config.js';

export function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const ratio = (n, d) => (d > 0 ? n / d : null);

export function computeMetrics(events, catalogue = CATALOGUE, cfg = DEFAULTS) {
  const { requests, tasks, discrepancies } = deriveAll(events);

  const continuedReqs = requests.filter((r) => r.status === 'closed' && r.outcome === CONTINUED);
  const closedReqs = requests.filter((r) => r.status === 'closed' && r.outcome !== CONTINUED);
  const saves = closedReqs.filter((r) => SAVE_OUTCOMES.includes(r.outcome)).length;
  const deferred = closedReqs.filter((r) => r.outcome === 'saved_for_later').length;

  const outcomeMix = Object.fromEntries(Object.keys(OUTCOMES).map((k) => [k, 0]));
  for (const r of closedReqs) if (r.outcome in outcomeMix) outcomeMix[r.outcome] += 1;

  const confirmed = requests.filter((r) => r.suggestionState === 'confirmed').length;
  const rejected = requests.filter((r) => r.suggestionState === 'rejected').length;

  // Latest reason per request, for requests that did not convert (a sale needs no "why not").
  const byEvidence = Object.fromEntries(EVIDENCE_TYPES.map((t) => [t, new Map()]));
  let reasonTotal = 0;
  for (const r of requests) {
    const last = r.reasons[r.reasons.length - 1];
    if (!last || (r.status === 'closed' && SAVE_OUTCOMES.includes(r.outcome))) continue;
    const ev = EVIDENCE_TYPES.includes(last.evidence_type) ? last.evidence_type : 'unknown';
    byEvidence[ev].set(last.reason_tag, (byEvidence[ev].get(last.reason_tag) || 0) + 1);
    reasonTotal += 1;
  }
  const reasonLists = Object.fromEntries(
    Object.entries(byEvidence).map(([ev, m]) => [
      ev,
      [...m.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1)),
    ]),
  );

  const parseMethods = { ai: 0, fallback: 0, none: 0 };
  for (const r of requests) {
    if (r.method === 'none') parseMethods.none += 1;
    else if (r.method === 'rule_fallback') parseMethods.fallback += 1;
    else parseMethods.ai += 1;
  }

  const cancelledReqs = requests.filter((r) => r.status === 'cancelled');
  const cancelledByStage = { requested: 0, accepted: 0, on_the_way: 0 };
  for (const r of cancelledReqs) if (r.cancelStage in cancelledByStage) cancelledByStage[r.cancelStage] += 1;

  // "Not on rack" reports, per SKU
  const missing = new Map();
  for (const r of requests) {
    for (const d of r.discrepancies) {
      const m = missing.get(d.skuId) || { skuId: d.skuId, count: 0, racks: new Set() };
      m.count += 1;
      m.racks.add(d.rack);
      missing.set(d.skuId, m);
    }
  }
  const inventoryDiscrepancies = {
    total: [...missing.values()].reduce((n, m) => n + m.count, 0),
    bySku: [...missing.values()]
      .map((m) => ({ skuId: m.skuId, count: m.count, racks: [...m.racks].sort() }))
      .sort((a, b) => b.count - a.count || (a.skuId < b.skuId ? -1 : 1)),
  };
  const everyItem = [...requests, ...tasks];
  const assistLog = everyItem.flatMap((x) => x.assistLog);
  const escalationLog = everyItem.flatMap((x) => x.escalations);
  const sku = bySku(requests, catalogue, discrepancies);
  // Replacements actually brought to the fitting room: the item currently on its way. Withdrawn items
  // (not on rack, declined) and cancelled requests do not count.
  const deliveries = {};
  for (const r of requests) {
    if (r.onTheWay && r.status !== 'cancelled') for (const i of r.onTheWay.items) deliveries[i.itemId] = (deliveries[i.itemId] || 0) + 1;
  }

  return {
    total: requests.length,
    open: requests.filter((r) => r.status === 'requested').length,
    accepted: requests.filter((r) => r.status === 'accepted' || r.status === 'on_the_way').length,
    closed: closedReqs.length,
    cancelled: cancelledReqs.length,
    cancelledByStage,
    saves,
    deferred,
    saveRate: ratio(saves, closedReqs.length),
    deferredRate: ratio(deferred, closedReqs.length),
    medianAcceptMs: median(requests.filter((r) => r.acceptedTs != null).map((r) => r.acceptedTs - r.createdTs)),
    medianDeliverMs: median(requests.filter((r) => r.acceptedTs != null && r.deliveredTs != null).map((r) => r.deliveredTs - r.acceptedTs)),
    medianDispatchMs: median(requests.filter((r) => r.acceptedTs != null && r.onTheWayTs != null).map((r) => r.onTheWayTs - r.acceptedTs)),
    medianTryOnMs: median(closedReqs.filter((r) => r.deliveredTs != null).map((r) => r.closedTs - r.deliveredTs)),
    delivered: requests.filter((r) => r.deliveredTs != null).length,
    tryOn: { fits: requests.filter((r) => r.tryOn?.result === 'fits').length, notRight: requests.filter((r) => r.tryOn?.result === 'not_right').length },
    continued: continuedReqs.length,
    followUps: requests.filter((r) => r.followsId).length,
    medianCloseMs: median(closedReqs.map((r) => r.closedTs - r.createdTs)),
    escalations: requests.filter((r) => r.escalations.length).length,
    floorTaskEscalations: tasks.filter((t) => t.escalations.length).length,
    escalationsByStage: { accept: escalationLog.filter((e) => e.stage === 'accept').length, deliver: escalationLog.filter((e) => e.stage === 'deliver').length },
    openEscalations: [...requests, ...tasks].filter((x) => isOpen(x) && x.escalated).map((x) => x.id),
    outcomeMix,
    confirmed,
    rejected,
    suggestionAcceptance: ratio(confirmed, confirmed + rejected),
    reasons: { total: reasonTotal, byEvidence: reasonLists },
    floorPullsRequested: tasks.filter((t) => t.status !== 'cancelled').length,
    floorPullsCancelled: tasks.filter((t) => t.status === 'cancelled').length,
    floorPullsDone: tasks.filter((t) => t.status === 'done').length,
    parseMethods,
    bySku: sku,
    inventoryDiscrepancies,
    itemsDeclined: requests.reduce((n, r) => n + r.declinedIds.length, 0),
    assists: assistLog.length,
    medianAssistMs: median(assistLog.map((a) => a.ts - a.escalatedTs)),
    signals: buildSignals(sku, inventoryDiscrepancies, cfg, catalogue, deliveries),
    heatmap: buildHeatmap(requests, catalogue),
    routing: buildRouting(requests),
  };
}

const NO_ALT_KINDS = ['no_alternative', 'alteration_or_crossstore'];

/** Per garment+size+cut roll-up for merchandising decisions. Areas are only reported when someone actually stated them. */
function bySku(requests, catalogue, discrepancies = {}) {
  const groups = new Map();
  for (const r of requests) {
    const sku = getSku(r.skuId, catalogue);
    if (!sku) continue;
    if (!groups.has(sku.id)) groups.set(sku.id, { skuId: sku.id, n: 0, cancelled: 0, closed: 0, saves: 0, suggested: 0, noAlternative: 0, declined: 0, issues: new Map() });
    const g = groups.get(sku.id);
    g.n += 1;
    g.declined += r.declinedIds.length;
    if (r.status === 'cancelled') g.cancelled += 1;
    if (r.status === 'closed') { g.closed += 1; if (SAVE_OUTCOMES.includes(r.outcome)) g.saves += 1; }
    if (r.suggestion) { g.suggested += 1; if (NO_ALT_KINDS.includes(r.suggestion.kind)) g.noAlternative += 1; }
    const info = mergeIssue({ sku, issue: r.issue, issues: r.issues, chips: r.chips, parsed: r.parsed, parseMethod: r.method });
    // One count per issue the customer named; a request with two issues counts under both.
    const named = info.issues.length > 1 ? [[info.issues[0], info.primary], [info.issues[1], info.secondary]] : [[r.issue, info.primary]];
    for (const [issue, t] of named) {
      const area = t && (t.areaSource ?? t.source) !== 'default' ? t.area : null;
      const key = `${issue}|${area ?? ''}`;
      const cur = g.issues.get(key) || { issue, area, count: 0 };
      cur.count += 1;
      g.issues.set(key, cur);
    }
  }
  return [...groups.values()]
    .map((g) => {
      const issueCounts = [...g.issues.values()].sort((a, b) => b.count - a.count || (`${a.issue}${a.area}` < `${b.issue}${b.area}` ? -1 : 1));
      return {
        skuId: g.skuId, n: g.n, cancelled: g.cancelled, closed: g.closed, saves: g.saves,
        saveRate: ratio(g.saves, g.closed), suggested: g.suggested, noAlternative: g.noAlternative,
        declined: g.declined, missing: discrepancies[g.skuId] || 0,
        topIssue: issueCounts[0] ?? null, issueCounts,
      };
    })
    .sort((a, b) => b.n - a.n || (a.skuId < b.skuId ? -1 : 1));
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);
const label = (id, catalogue) => { const s = getSku(id, catalogue); return s ? skuLabel(s) : id; };

/**
 * Deterministic store signals. They are observations with their evidence, not instructions: the counts come from
 * the log, the thresholds are prototype settings, and shares are "share of requests" (only customers who asked
 * for help are counted, so this is not a defect rate).
 */
function buildSignals(groups, inventory, cfg, catalogue, deliveries = {}) {
  const out = [];
  for (const m of inventory.bySku) {
    if (m.count >= cfg.signalMinMisses) {
      out.push({
        kind: 'inventory', skuId: m.skuId, count: m.count, of: null,
        action: { label: `Audit rack ${m.racks.join(', ')}: stock record reported wrong`, severity: 'high' },
        text: `${label(m.skuId, catalogue)}: reported missing on the rack ${m.count} ${m.count === 1 ? 'time' : 'times'} (rack ${m.racks.join(', ')}) — recount the rack; the stock record may be overstated`,
      });
    }
  }
  for (const g of groups) {
    const top = g.topIssue;
    if (top && FIT_ISSUES.includes(top.issue) && g.n >= cfg.signalMinN && top.count / g.n >= cfg.signalMinShare) {
      const what = `${ISSUES[top.issue]}${top.area ? ` · ${cap(top.area)}` : ''}`;
      out.push({
        kind: 'fit', skuId: g.skuId, count: top.count, of: g.n,
        action: { label: 'Flag fit to the buying team', severity: 'medium' },
        text: `${label(g.skuId, catalogue)}: ${top.count} of ${g.n} requests were "${what}" — worth reviewing size grading / fit with the buying team`,
      });
    }
  }
  for (const g of groups) {
    if (g.suggested >= cfg.signalMinN && g.noAlternative / g.suggested >= cfg.signalMinShare) {
      out.push({
        kind: 'stock_gap', skuId: g.skuId, count: g.noAlternative, of: g.suggested,
        action: { label: 'Review stock depth for this garment', severity: 'medium' },
        text: `${label(g.skuId, catalogue)}: no in-stock alternative in ${g.noAlternative} of ${g.suggested} suggestions — review stock depth or cross-store replenishment`,
      });
    }
  }
  for (const [skuId, count] of Object.entries(deliveries).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
    if (count >= cfg.signalMinPulls) {
      out.push({
        kind: 'high_demand', skuId, count, of: null,
        action: { label: 'Keep a buffer near the fitting rooms', severity: 'low' },
        text: `${label(skuId, catalogue)}: brought to the fitting room ${count} times as a replacement`,
      });
    }
  }
  return out;
}

export const HEATMAP_AREAS = ['waist', 'chest', 'shoulders', 'sleeves', 'length', 'hips'];
export const HEATMAP_COLUMNS = [...HEATMAP_AREAS, 'general']; // "general": the customer named the issue but no body area

/**
 * Fit issues by garment+cut and body area. "more" = the customer needed more room or length (too tight / too short),
 * "less" = needed less (too loose / too long). Only areas someone actually stated are plotted; requests that only have
 * a default area are counted in the "general" column, so every fit request is accounted for.
 */
function buildHeatmap(requests, catalogue) {
  const rows = new Map();
  for (const r of requests) {
    if (!FIT_ISSUES.includes(r.issue)) continue;
    const sku = getSku(r.skuId, catalogue);
    if (!sku) continue;
    const info = mergeIssue({ sku, issue: r.issue, issues: r.issues, chips: r.chips, parsed: r.parsed, parseMethod: r.method });
    const targets = (info.issues.length > 1 ? [info.primary, info.secondary] : [info.primary]).filter(Boolean);
    const label = `${sku.name} · ${sku.cut}`;
    if (!rows.has(label)) rows.set(label, { label, cells: Object.fromEntries(HEATMAP_COLUMNS.map((a) => [a, { more: 0, less: 0 }])), total: 0 });
    const row = rows.get(label);
    for (const t of targets) {
      // An area that was only assumed is not plotted as if it were stated: it goes to the "general" column.
      const column = (t.areaSource ?? t.source) === 'default' ? 'general' : t.area;
      row.cells[column][['tight', 'short'].includes(t.word) ? 'more' : 'less'] += 1;
      row.total += 1;
    }
  }
  const list = [...rows.values()].sort((a, b) => b.total - a.total || (a.label < b.label ? -1 : 1));
  const max = list.reduce((m, r) => Math.max(m, ...Object.values(r.cells).map((c) => c.more + c.less)), 0);
  return { areas: HEATMAP_COLUMNS, rows: list, max };
}

/** How requests were taken: by their primary person, a secondary, or after they opened to everyone. */
function buildRouting(requests) {
  const groups = { primary: [], secondary: [], open: [] };
  for (const r of requests) if (r.acceptedTs != null && groups[r.acceptedTier]) groups[r.acceptedTier].push(r);
  const summary = (rs) => {
    const closed = rs.filter((r) => r.status === 'closed');
    const saves = closed.filter((r) => SAVE_OUTCOMES.includes(r.outcome)).length;
    return {
      n: rs.length,
      medianAcceptMs: median(rs.map((r) => r.acceptedTs - r.createdTs)),
      closed: closed.length, saves, saveRate: closed.length ? saves / closed.length : null,
    };
  };
  const recorded = groups.primary.length + groups.secondary.length + groups.open.length;
  return {
    primary: summary(groups.primary), secondary: summary(groups.secondary), open: summary(groups.open),
    unassigned: summary(requests.filter((r) => r.acceptedTs != null && !groups[r.acceptedTier])), // taken before any team existed
    recorded, primaryShare: recorded ? groups.primary.length / recorded : null,
  };
}
