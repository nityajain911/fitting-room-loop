// Everything about a request — status, timers, who accepted — is derived from the event list.
// Nothing is stored separately.

import { CATALOGUE, getSku } from './catalogue.js';
import { skillOf } from './skills.js';

/** An attempt as it stands (used to freeze it when the next one opens, and to read all attempts uniformly). */
const snapshotOf = (r) => ({
  n: r.round, openedTs: r.roundStartTs, baselineIds: [...r.cur.skuIds], issue: r.cur.issue, issues: [...r.cur.issues], chips: r.cur.chips, styleAxes: r.cur.styleAxes,
  parsed: r.cur.parsed, method: r.cur.method, reportedBy: r.cur.reportedBy, acceptedTs: r.roundAcceptedTs, onTheWayTs: r.onTheWayTs, deliveredTs: r.deliveredTs, deliveredBy: r.deliveredBy,
  items: (r.onTheWay?.items || []).map((i) => i.itemId), tryOn: r.tryOn, acceptedStaffId: r.acceptedStaffId,
});

/** Every attempt of a request, in order, the current one last. */
export const roundsOf = (r) => [...r.pastRounds, snapshotOf(r)];

/**
 * Everything the next suggestion must leave out. From the second attempt on this includes what was already tried in EVERY
 * colour: items of the same line, size and cut have the same measurements, so another colour of something that did not
 * fit will not fit either. A rack report or a declined item is about that one SKU only.
 */
export function suggestionExclusions(req, catalogue = CATALOGUE) {
  const out = new Set(excludedIds(req));
  if (req.round > 1) {
    const fit = (s) => `${s.line ?? `${s.category}|${s.fabric}`}|${s.size}|${s.cut}`;
    const tried = new Set(req.triedIds.map((id) => getSku(id, catalogue)).filter(Boolean).map(fit));
    for (const s of catalogue) if (tried.has(fit(s))) out.add(s.id);
  }
  return [...out];
}

/** Items the customer may still be told were kept: what is on its way now, and what was delivered and not reported. */
function keepableOf(r) {
  return [...new Set([...(r.onTheWay?.items || []).map((i) => i.itemId), ...r.deliveredIds.filter((id) => !r.reportedIds.includes(id))])];
}

export function deriveAll(events, catalogue = CATALOGUE) {
  const requests = [];
  const tasks = [];
  const byId = {};
  const discrepancies = {}; // skuId -> number of "not on rack" reports (all requests) since the last recount
  const recounts = {}; // skuId -> when a recount task was last finished
  const replenished = {}; // skuId -> when a restock task was last finished
  const rooms = {}; // room -> { releasedTs, by }: when the customer (or the clock) last ended that room's visit

  const get = (id) => byId[id];
  const clearEscalation = (x) => { x.escalated = false; x.escalatedTs = null; x.escalatedStage = null; x.assistedNow = false; };
  for (const e of events) {
    const p = e.payload || {};
    switch (e.type) {
      case 'created': {
        const r = {
          kind: 'request', id: e.requestId, room: p.room, skuId: p.skuId, issue: p.issue, issues: p.issues?.length ? p.issues : [p.issue],
          chips: p.chips || [], styleAxes: p.styleAxes || [], parsed: p.parsed || null, method: p.method || 'none',
          createdTs: e.ts, sessionStartTs: rooms[p.room]?.releasedTs ?? 0, lastTs: e.ts, keptItemId: null, route: null, status: 'requested', acceptedTs: null, acceptedBy: null,
          // Attempts ("rounds"): one request carries the customer through several tries. The fields above are the first attempt;
          // `cur` is the description of the attempt in progress, and everything about it (status, suggestion, trip, try-on)
          // is the current attempt's. Earlier attempts are kept, frozen, in `pastRounds`.
          round: 1, roundStartTs: e.ts, roundAcceptedTs: null,
          cur: { skuIds: [p.skuId], issue: p.issue, issues: p.issues?.length ? p.issues : [p.issue], chips: p.chips || [], styleAxes: p.styleAxes || [], parsed: p.parsed || null, method: p.method || 'none', reportedBy: 'customer' },
          pastRounds: [], triedIds: [p.skuId], deliveredIds: [], reportedIds: [], reportable: [], keepable: [], baseOf: {}, previousOwnerStaffId: null,
          skill: null, assignments: [], openToAll: false, acceptedStaffId: null, acceptedTier: null,
          closedTs: null, outcome: null, cancelledTs: null, cancelStage: null,
          escalated: false, escalatedTs: null, escalatedStage: null, escalations: [], assistLog: [], assistedNow: false,
          suggestion: null, suggestionState: null, confirmedItemId: null, confirmedItemIds: [],
          onTheWay: null, onTheWayTs: null, deliveredTs: null, deliveredBy: null, tryOn: null, reasons: [], floorTaskIds: [],
          discrepancies: [], declinedIds: [], itemDeclined: null, assistedBy: null, assistedTs: null,
        };
        const sku = getSku(p.skuId, catalogue);
        r.skill = sku ? skillOf(sku) : null; // which kind of specialist the garment calls for
        byId[r.id] = r;
        requests.push(r);
        break;
      }
      case 'routed': {
        const r = get(e.requestId);
        if (r) r.route = { role: p.role, rule: p.rule };
        break;
      }
      case 'accepted': {
        const x = get(e.requestId);
        if (!x) break;
        if (x.kind === 'request') { if (x.acceptedTs == null) x.acceptedTs = e.ts; x.roundAcceptedTs = e.ts; } // the first accept is the headline; each attempt has its own
        else x.acceptedTs = e.ts;
        x.acceptedBy = p.role;
        x.acceptedStaffId = p.staffId ?? null;
        x.acceptedTier = p.tier ?? null;
        if (x.kind === 'task') { if (x.status === 'requested') x.status = 'accepted'; }
        else if (x.status === 'requested') x.status = 'accepted';
        clearEscalation(x); // stage 1 is over; the delivery stage runs on its own clock
        break;
      }
      case 'assigned': {
        const x = get(e.requestId);
        if (!x) break;
        x.assignments.push({ tier: p.tier, staffId: p.staffId ?? null, ts: e.ts });
        if (p.tier === 'open') x.openToAll = true;
        break;
      }
      case 'suggestion_shown': {
        const r = get(e.requestId);
        if (!r) break;
        r.suggestion = p;
        r.suggestionState = 'shown';
        if (r.itemDeclined) { // the customer declined the previous item: it is no longer on its way
          r.itemDeclined = null; r.onTheWay = null; r.onTheWayTs = null; r.deliveredTs = null; r.deliveredBy = null; r.confirmedItemId = null;
          if (r.status === 'on_the_way') r.status = 'accepted';
        }
        break;
      }
      case 'suggestion_confirmed': {
        const r = get(e.requestId);
        if (r) { r.suggestionState = 'confirmed'; r.confirmedItemId = p.itemId; r.confirmedItemIds = p.itemIds || [p.itemId]; }
        break;
      }
      case 'suggestion_rejected': {
        const r = get(e.requestId);
        if (r) r.suggestionState = 'rejected';
        break;
      }
      case 'on_the_way': {
        const r = get(e.requestId);
        if (r) {
          r.onTheWay = { room: p.room, itemId: p.itemId, itemLabel: p.itemLabel, items: p.items || [{ itemId: p.itemId, itemLabel: p.itemLabel }] };
          r.onTheWayTs = e.ts;
          r.deliveredTs = null;
          for (const it of r.onTheWay.items) r.baseOf[it.itemId] = it.forId ?? r.cur.skuIds[0]; // which item of theirs each was brought for
          if (r.status !== 'closed' && r.status !== 'cancelled') r.status = 'on_the_way';
        }
        break;
      }
      case 'delivered': {
        const r = get(e.requestId);
        if (r && r.kind === 'request' && r.status === 'on_the_way') {
          r.deliveredTs = e.ts; r.deliveredBy = e.actor ?? null; clearEscalation(r);
          for (const it of r.onTheWay?.items || []) { // the customer now has these to try: they are tried, and can be reported
            if (!r.deliveredIds.includes(it.itemId)) r.deliveredIds.push(it.itemId);
            if (!r.triedIds.includes(it.itemId)) r.triedIds.push(it.itemId);
          }
        }
        break;
      }
      case 'round_opened': {
        // "Still not right": the same request starts another attempt for the items the customer picked.
        const r = get(e.requestId);
        if (!r || r.kind !== 'request' || r.status !== 'on_the_way' || r.deliveredTs == null) break;
        r.pastRounds.push(snapshotOf(r));
        r.reportedIds.push(...p.baselineIds.filter((id) => !r.reportedIds.includes(id)));
        r.previousOwnerStaffId = r.acceptedStaffId;
        r.round += 1; r.roundStartTs = e.ts; r.roundAcceptedTs = null;
        r.cur = { skuIds: [...p.baselineIds], issue: p.issue, issues: p.issues?.length ? p.issues : [p.issue], chips: p.chips || [], styleAxes: p.styleAxes || [], parsed: p.parsed || null, method: p.method || 'none', reportedBy: p.by ?? 'customer' }; // who heard it: the customer, or the runner at the door
        r.status = 'requested'; r.acceptedStaffId = null; r.acceptedTier = null;
        r.suggestion = null; r.suggestionState = null; r.confirmedItemId = null; r.confirmedItemIds = [];
        r.onTheWay = null; r.onTheWayTs = null; r.deliveredTs = null; r.deliveredBy = null; r.tryOn = null; r.itemDeclined = null;
        r.assignments = []; r.openToAll = false; // handed out afresh (the previous person first)
        clearEscalation(r);
        break;
      }
      case 'tryon_feedback': {
        const r = get(e.requestId);
        if (r && r.kind === 'request' && r.deliveredTs != null) r.tryOn = { result: p.result, ts: e.ts };
        break;
      }
      case 'floor_pull_requested': {
        const parent = get(e.requestId);
        const t = {
          kind: 'task', id: p.taskId, parentId: e.requestId, itemId: p.itemId, rack: p.rack, items: p.items || [{ itemId: p.itemId, rack: p.rack }],
          room: parent?.room, createdTs: e.ts, route: { role: 'floor', rule: 'floor pull -> floor associate' },
          status: 'requested', acceptedTs: null, acceptedBy: null, doneTs: null, cancelledTs: null,
          escalated: false, escalatedTs: null, escalatedStage: null, escalations: [], assistLog: [], assistedNow: false,
          assistedBy: null, assistedTs: null, skill: parent?.skill ?? null, assignments: [], openToAll: false, acceptedStaffId: null, acceptedTier: null,
        };
        byId[t.id] = t;
        tasks.push(t);
        parent?.floorTaskIds.push(t.id);
        break;
      }
      case 'room_released': {
        rooms[p.room] = { releasedTs: e.ts, by: p.by ?? null };
        break;
      }
      case 'restock_task_created': {
        const sku = getSku(p.skuId, catalogue);
        const t = {
          kind: 'task', taskType: 'restock', restockKind: p.kind, id: p.taskId || e.requestId, parentId: null, skuId: p.skuId, itemId: p.skuId,
          rack: p.rack, items: [{ itemId: p.skuId, rack: p.rack }], room: null, createdTs: e.ts,
          route: { role: 'floor', rule: 'restock task -> floor associate' },
          status: 'requested', acceptedTs: null, acceptedBy: null, doneTs: null, cancelledTs: null,
          escalated: false, escalatedTs: null, escalatedStage: null, escalations: [], assistLog: [], assistedNow: false,
          assistedBy: null, assistedTs: null, skill: sku ? skillOf(sku) : null, assignments: [], openToAll: false, acceptedStaffId: null, acceptedTier: null,
        };
        byId[t.id] = t;
        tasks.push(t);
        break;
      }
      case 'restock_task_done': {
        const t = get(e.requestId);
        if (!t || t.taskType !== 'restock' || t.status === 'done' || t.status === 'cancelled') break;
        t.status = 'done'; t.doneTs = e.ts;
        if (t.restockKind === 'recount') { recounts[t.skuId] = e.ts; discrepancies[t.skuId] = 0; } // the rack was recounted
        else replenished[t.skuId] = e.ts;
        break;
      }
      case 'floor_pull_done': {
        const t = get(e.requestId);
        if (t && t.status !== 'cancelled') { t.status = 'done'; t.doneTs = e.ts; clearEscalation(t); }
        break;
      }
      case 'floor_pull_cancelled': {
        const t = get(e.requestId);
        if (t && t.kind === 'task' && t.status !== 'done' && t.status !== 'cancelled') { t.status = 'cancelled'; t.cancelledTs = e.ts; t.cancelReason = p.reason ?? null; clearEscalation(t); }
        break;
      }
      case 'escalated': {
        const x = get(e.requestId);
        if (x && !x.escalated) {
          const stage = p.stage || (x.status === 'requested' ? 'accept' : 'deliver'); // events from before stages existed
          x.escalated = true; x.escalatedTs = e.ts; x.escalatedStage = stage; x.assistedNow = false;
          x.escalations.push({ stage, ts: e.ts, round: x.round ?? 1 });
        }
        break;
      }
      case 'closed': {
        const r = get(e.requestId);
        if (r && r.status !== 'cancelled') {
          r.status = 'closed'; r.closedTs = e.ts; r.outcome = p.outcome;
          // which of the brought items the customer kept: named at the close, or the only one there is
          if (p.outcome === 'bought_alternative') { const k = keepableOf(r); r.keptItemId = p.itemId ?? (k.length === 1 ? k[0] : null); }
        }
        break;
      }
      case 'inventory_discrepancy': {
        const r = get(e.requestId);
        if (!r || r.kind !== 'request') break;
        r.discrepancies.push({ skuId: p.skuId, rack: p.rack, ts: e.ts });
        discrepancies[p.skuId] = (discrepancies[p.skuId] || 0) + 1;
        const rest = r.onTheWay ? r.onTheWay.items.filter((i) => i.itemId !== p.skuId) : [];
        if (rest.length) {
          // other items of the trip are still on their way: drop only the missing one
          r.onTheWay = { ...r.onTheWay, items: rest, itemId: rest[0].itemId, itemLabel: rest[0].itemLabel };
          r.confirmedItemIds = r.confirmedItemIds.filter((id) => id !== p.skuId);
          r.confirmedItemId = r.confirmedItemIds[0] ?? rest[0].itemId;
        } else {
          // nothing left to bring: withdraw until a new suggestion is shown
          r.onTheWay = null; r.onTheWayTs = null; r.deliveredTs = null; r.deliveredBy = null; r.confirmedItemId = null; r.confirmedItemIds = []; r.suggestionState = 'withdrawn';
          if (r.status === 'on_the_way') r.status = 'accepted';
        }
        break;
      }
      case 'item_declined': {
        const r = get(e.requestId);
        if (!r || r.kind !== 'request') break;
        const ids = p.itemIds || [p.itemId];
        r.itemDeclined = { itemId: ids[0], itemIds: ids, ts: e.ts };
        r.declinedIds.push(...ids);
        break;
      }
      case 'assisted': {
        const x = get(e.requestId);
        if (x && x.escalated && !x.assistedNow) { // one assist per escalation
          x.assistedBy = p.byRole; x.assistedTs = e.ts; x.assistedNow = true;
          x.assistLog.push({ byRole: p.byRole, ts: e.ts, escalatedTs: x.escalatedTs });
        }
        break;
      }
      case 'cancelled': {
        const r = get(e.requestId);
        if (r && r.kind === 'request' && r.status !== 'closed' && r.status !== 'cancelled') {
          r.status = 'cancelled'; r.cancelledTs = e.ts; r.cancelStage = p.stage || null;
        }
        break;
      }
      case 'reason_added': {
        const r = get(e.requestId);
        if (r) r.reasons.push({ ...p, ts: e.ts });
        break;
      }
      default:
        break;
    }
    const touched = byId[e.requestId]; // last activity, for the empty-room timeout (a pull's activity counts for its request)
    if (touched) { touched.lastTs = e.ts; if (touched.parentId && byId[touched.parentId]) byId[touched.parentId].lastTs = e.ts; }
  }
  for (const r of requests) { r.reportable = r.deliveredIds.filter((id) => !r.reportedIds.includes(id)); r.keepable = keepableOf(r); }
  // A cancelled request takes its unfinished floor pulls with it.
  for (const t of tasks) {
    const parent = byId[t.parentId];
    if (parent?.status === 'cancelled' && t.status !== 'done') { t.status = 'cancelled'; t.cancelledTs = parent.cancelledTs; }
  }
  return { requests, tasks, byId, discrepancies, recounts, replenished, rooms };
}

export const isOpen = (x) => !['done', 'closed', 'cancelled'].includes(x.status);
const endTs = (x) => (x.kind === 'task' ? x.doneTs : x.closedTs) ?? x.cancelledTs ?? null;

export const elapsedMs = (x, now) => Math.max(0, (endTs(x) ?? now) - x.createdTs);

/** Which escalation clock an open item is on: 'accept' (waiting for someone), 'deliver' (accepted, not yet handed to the customer) or none. */
export function stageOf(x) {
  if (!isOpen(x) || x.taskType === 'restock') return null; // a restock task is housekeeping: no escalation clock
  if (x.status === 'requested') return 'accept';
  if (x.status === 'accepted') return 'deliver';
  if (x.status === 'on_the_way' && x.deliveredTs == null) return 'deliver'; // on the way, not yet handed to the customer
  return null;
}

export const STAGE_LABEL = { accept: 'Not accepted in time', deliver: 'Not delivered in time' };

/** When a stage's clock started. */
export const stageStart = (x, stage) => (stage === 'deliver' ? x.roundAcceptedTs ?? x.acceptedTs ?? x.createdTs : x.roundStartTs ?? x.createdTs);

/** Warn and escalate marks (seconds) for a stage. Amber is a share of the stage time. */
export function stageLimits(config, stage) {
  const escalateSeconds = stage === 'deliver' ? config.deliverEscalateSeconds : config.acceptEscalateSeconds;
  return { warnSeconds: escalateSeconds * (config.warnShare ?? 0.5), escalateSeconds };
}

/** The team that currently holds an item: whoever accepted it, else the team it was routed to. */
export const ownerRole = (x) => (x.status === 'requested' ? x.route?.role : x.acceptedBy || x.route?.role);

/**
 * What a card's timer and ring should show. Open items time their current stage; once the item is on its way the
 * timer freezes at the delivery time; closed items show the total.
 */
export function timerFor(x, now, config) {
  if (x.taskType === 'restock') return { stage: null, startTs: x.createdTs, endTs: x.doneTs ?? null, warnSeconds: 1e9, escalateSeconds: 1e9 }; // never amber or red
  const stage = stageOf(x);
  if (stage) return { stage, startTs: stageStart(x, stage), endTs: null, ...stageLimits(config, stage) };
  if (x.status === 'on_the_way') return { stage: null, startTs: x.roundAcceptedTs ?? x.acceptedTs ?? x.createdTs, endTs: x.deliveredTs ?? now, ...stageLimits(config, 'deliver') };
  return { stage: null, startTs: x.createdTs, endTs: endTs(x) ?? now, ...stageLimits(config, 'accept') };
}

export function timerState(ms, limits) {
  if (ms >= limits.escalateSeconds * 1000) return 'escalated';
  if (ms >= limits.warnSeconds * 1000) return 'warn';
  return 'normal';
}

/** 'closed' | 'normal' | 'warn' | 'escalated' — what colour the card's timer should be. */
export function cardState(x, now, config) {
  if (!isOpen(x)) return x.status === 'cancelled' ? 'cancelled' : 'closed';
  const stage = stageOf(x);
  if (!stage) return 'normal';
  if (x.escalated) return 'escalated';
  return timerState(now - stageStart(x, stage), stageLimits(config, stage));
}

export function customerSteps(req) {
  const s = req.status;
  const reachedAccepted = req.roundAcceptedTs != null; // this attempt's
  const reachedWay = !!req.onTheWay;
  const resolved = s === 'closed';
  return [
    { key: 'requested', label: 'Requested', reached: true },
    {
      key: 'accepted',
      label: s === 'accepted' ? 'Accepted (checking stock…)' : 'Accepted',
      reached: reachedAccepted,
    },
    {
      key: 'on_the_way',
      label: reachedWay
        ? (req.deliveredTs != null ? `Delivered to Room ${req.onTheWay.room} (${req.onTheWay.itemLabel})` : `On the way to Room ${req.onTheWay.room} (bringing ${req.onTheWay.itemLabel})`)
        : 'On the way',
      reached: reachedWay,
    },
    { key: 'resolved', label: 'Resolved', reached: resolved },
  ];
}

/** Catalogue with stock reduced by "not on rack" reports (never below 0). The input is not mutated. */
export const effectiveCatalogue = (catalogue, counts) =>
  catalogue.map((s) => (counts[s.id] ? { ...s, stock: Math.max(0, s.stock - counts[s.id]) } : s));

/** SKUs this request must not be offered again: reported missing on the rack, declined, and (from the second attempt) everything already tried. */
export const excludedIds = (req) => [...new Set([...req.discrepancies.map((d) => d.skuId), ...req.declinedIds, ...(req.round > 1 ? req.triedIds : [])])];
