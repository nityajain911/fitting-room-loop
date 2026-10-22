import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createStore } from './store.js';
import { makeLlm } from './llm.js';
import { makeConfig } from '../shared/config.js';
import { CATALOGUE, CATALOGUE_LABEL, getSku, skuLabel } from '../shared/catalogue.js';
import { computeMetrics } from '../shared/metrics.js';
import { CHIPS, OUTCOMES, TRYON_RESULTS, RESTOCK_KINDS, RESTOCK_SIGNAL, ROLES, ALL_STYLE_AXES, SAVE_OUTCOMES, normaliseIssues } from '../shared/events.js';
import { routeFor } from '../shared/routing.js';
import { deriveAll, isOpen, effectiveCatalogue, suggestionExclusions, stageOf, stageStart, stageLimits, ownerRole } from '../shared/derive.js';
import { normaliseStaff, MAX_STAFF, nextAssignment, accessFor } from '../shared/staffing.js';
import { mergeIssue, fitMatch, combineSuggestions, optionFor, suggestionItemIds } from '../shared/fitMatch.js';
import { parseCustomerText, parseReasonText, validateReason } from '../shared/parser.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rid = (p) => `${p}_${randomUUID().slice(0, 6)}`;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);
const missing = (m) => new HttpError(404, m);
const conflict = (m) => new HttpError(409, m);

/** Allow N LLM calls per minute per IP; beyond that we just use the rule-based fallback. */
function makeLimiter(max = 20, windowMs = 60_000, now = Date.now) {
  const hits = new Map();
  return (ip) => {
    const t = now();
    const recent = (hits.get(ip) || []).filter((x) => t - x < windowMs);
    if (recent.length >= max) { hits.set(ip, recent); return false; }
    recent.push(t);
    hits.set(ip, recent);
    return true;
  };
}

export function createApp({ store, llm = null, config: baseConfig = makeConfig(), now = Date.now, catalogue = CATALOGUE, demoControls = false, settingsFile = null } = {}) {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '10kb' }));
  const allowLlm = makeLimiter(20, 60_000, now);

  // Demo controls (only reachable when DEMO_CONTROLS is on). They change settings, never the event log.
  // Fast timers are a short-lived presenter aid: they switch themselves off so they cannot be left on by mistake.
  // Times set on the Admin page (escalation per stage, and the primary and secondary waits), and the team roster.
  // They live beside the log (not in it) and survive a restart; "Clear demo data" leaves them alone.
  const EDITABLE = { acceptEscalateSeconds: [10, 3600], deliverEscalateSeconds: [10, 3600], primaryWaitSeconds: [5, 3600], secondaryWaitSeconds: [5, 3600], roomSessionMinutes: [1, 240] };
  let config = { ...baseConfig };
  let staff = []; // { id, label, type, primary, secondary, onShift, code }
  if (settingsFile) {
    try {
      const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      for (const [k, [lo, hi]] of Object.entries(EDITABLE)) if (Number.isInteger(saved[k]) && saved[k] >= lo && saved[k] <= hi) config[k] = saved[k];
      if (Array.isArray(saved.staff)) staff = saved.staff.filter((x) => x && typeof x.id === 'string' && typeof x.code === 'string');
    } catch { /* no saved settings yet */ }
  }
  const persist = () => {
    if (!settingsFile) return;
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ ...Object.fromEntries(Object.keys(EDITABLE).map((k) => [k, config[k]])), staff }));
  };
  const FAST_TIMERS_MS = 5 * 60_000;
  let fastUntil = 0;
  const fastOn = () => now() < fastUntil;
  const demo = { forceFallback: false };
  const cfg = () => (fastOn()
    ? {
      ...config,
      acceptEscalateSeconds: Math.min(config.acceptEscalateSeconds, 20), deliverEscalateSeconds: Math.min(config.deliverEscalateSeconds, 20),
      primaryWaitSeconds: Math.min(config.primaryWaitSeconds, 5), secondaryWaitSeconds: Math.min(config.secondaryWaitSeconds, 5),
    }
    : config);
  // A team member's phone counts as on while it keeps polling (in memory: nothing about it is logged).
  const lastSeen = new Map();
  const touch = (id) => { if (id && staff.some((x) => x.id === id)) lastSeen.set(id, now()); };
  const isActive = (id) => now() - (lastSeen.get(id) ?? -Infinity) < cfg().staffActiveSeconds * 1000;
  // Join codes go only to the Admin page, not to every phone's poll (demo controls on: also to phones, for a one-tap join).
  const staffView = (withCodes) => staff.map(({ code, ...x }) => ({ ...x, active: isActive(x.id), ...(withCodes ? { code } : {}) }));
  const llmFor = (req) => (llm && !demo.forceFallback && allowLlm(req.ip) ? llm : null);
  const parserInfo = () => (llm ? { mode: demo.forceFallback ? 'forced_fallback' : 'ai', model: llm.model } : { mode: 'fallback' });
  const settings = ({ admin = false } = {}) => ({
    config: cfg(), saved: Object.fromEntries(Object.keys(EDITABLE).map((k) => [k, config[k]])), // `saved` is what the Admin form edits: not the temporary fast-timer values
    parser: parserInfo(), demoControls, staff: staffView(admin || demoControls),
    demo: { forceFallback: demo.forceFallback, fastTimers: fastOn(), fastTimersUntil: fastOn() ? fastUntil : null },
  });

  const derived = () => deriveAll(store.all(), catalogue);
  const append = (requestId, type, actor, payload = {}) => store.append({ requestId, type, actor, payload });

  /** Who did the work: the acting team if the client says so (an assisting team), else the routed team. */
  const actorOf = (req, r) => (req.body?.role in ROLES ? req.body.role : r.route.role);

  /**
   * Who may take a request, enforced here so it cannot be bypassed from the UI. With no roster there is no
   * restriction. Otherwise the person must have joined, be the right type, and be able to see the item now
   * (assigned to them, opened to everyone, or escalated). Returns who took it and in which capacity.
   */
  const takeAccess = (req, item, role) => {
    if (!staff.length) return {};
    const who = staff.find((x) => x.id === req.body?.staffId);
    if (!who) throw new HttpError(403, 'Join as a team member first');
    if (who.type !== role) throw bad(`${who.label} is a ${ROLES[who.type]}, not a ${ROLES[role]}`);
    const access = accessFor(item, who, staff);
    if (!access.visible) throw conflict('This request is not assigned to you yet');
    touch(who.id);
    return { staffId: who.id, tier: access.tier };
  };

  /**
   * Give waiting requests and floor pulls to people: primary now, a secondary after the primary wait (the first keeps
   * it), everyone after the secondary wait. Idempotent; runs on every new request and on every sweep.
   */
  function assignPending() {
    if (!staff.length) return;
    const c = cfg();
    const waiting = () => { const d = derived(); return { d, ids: [...d.requests, ...d.tasks].filter((x) => x.status === 'requested' && isOpen(x)).map((x) => x.id) }; };
    for (let pass = 0; pass < 3; pass += 1) {
      let any = false;
      for (const id of waiting().ids) {
        const d = derived();
        const next = nextAssignment(d.byId[id], { roster: staff, derived: d, now: now(), isActive, primaryWaitMs: c.primaryWaitSeconds * 1000, secondaryWaitMs: c.secondaryWaitSeconds * 1000 });
        if (next) { append(id, 'assigned', 'system', next); any = true; }
      }
      if (!any) break;
    }
  }

  const getRequest = (id) => {
    const x = derived().byId[id];
    if (!x || x.kind !== 'request') throw missing('Request not found');
    return x;
  };
  const getTask = (id) => {
    const x = derived().byId[id];
    if (!x || x.kind !== 'task') throw missing('Task not found');
    return x;
  };

  /** Fit suggestion for a request: stock reflects "not on rack" reports, and anything missing/declined is excluded. */
  const suggest = (id) => {
    const d = derived();
    const r = d.byId[id];
    const cur = r.cur; // the attempt in progress: its items and what is wrong with them
    const live = effectiveCatalogue(catalogue, d.discrepancies);
    const excludeIds = suggestionExclusions(r, catalogue); // missing on the rack, declined, and (from the second attempt) everything already tried, in every colour
    const perItem = cur.skuIds.map((baseId) => {
      const sku = getSku(baseId, catalogue);
      const issueInfo = mergeIssue({ sku, issue: cur.issue, issues: cur.issues, chips: cur.chips, styleAxes: cur.styleAxes, parsed: cur.parsed, parseMethod: cur.method });
      return { baseId, s: fitMatch({ sku, issueInfo, catalogue: live, config: cfg(), excludeIds }) };
    });
    return combineSuggestions(perItem, Math.min(5, Math.max(1, Math.floor(cfg().bringCount ?? 3))));
  };

  app.get('/health', (_req, res) => res.send('ok'));

  app.get('/api/config', (_req, res) => {
    res.json({ ...settings(), catalogueLabel: CATALOGUE_LABEL });
  });

  app.post('/api/demo', (req, res) => {
    if (!demoControls) throw new HttpError(403, 'Demo controls are switched off (set DEMO_CONTROLS=true)');
    for (const k of ['forceFallback', 'fastTimers']) {
      const v = req.body?.[k];
      if (v === undefined) continue;
      if (typeof v !== 'boolean') throw bad(`${k} must be true or false`);
      if (k === 'fastTimers') fastUntil = v ? now() + FAST_TIMERS_MS : 0;
      else demo[k] = v;
    }
    res.json(settings());
  });

  // The escalation times and the primary / secondary waits (whole seconds). Nothing else is editable here.
  app.post('/api/settings', (req, res) => {
    const body = req.body || {};
    const keys = Object.keys(body);
    if (!keys.length || keys.some((k) => !(k in EDITABLE))) throw bad(`Only ${Object.keys(EDITABLE).join(', ')} can be set`);
    for (const k of keys) {
      const [lo, hi] = EDITABLE[k];
      if (!Number.isInteger(body[k]) || body[k] < lo || body[k] > hi) throw bad(`${k} must be a whole number of seconds from ${lo} to ${hi}`);
    }
    for (const k of keys) config[k] = body[k];
    persist();
    res.json(settings());
  });

  // ---- team roster (Admin) and joining (associate phones) ----
  const newCode = () => {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (;;) {
      const code = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('');
      if (!staff.some((x) => x.code === code)) return code;
    }
  };
  const addStaff = (fields) => {
    if (staff.length >= MAX_STAFF) throw bad(`At most ${MAX_STAFF} team members`);
    const person = { id: rid('s'), ...fields, onShift: true, code: newCode() };
    staff.push(person);
    return person;
  };
  const checked = (fn) => { try { return fn(); } catch (e) { throw e instanceof HttpError ? e : bad(e.message); } };
  const roster = (res, person) => { persist(); assignPending(); res.json({ staff: person ? { ...person, active: isActive(person.id) } : undefined, settings: settings({ admin: true }) }); };

  app.post('/api/staff', (req, res) => {
    roster(res, addStaff(checked(() => normaliseStaff(req.body || {}))));
  });

  // A ready-made team for a demo. Only when there is no roster yet.
  app.post('/api/staff/seed', (_req, res) => {
    if (staff.length) throw conflict('There is already a team');
    const M = (k) => `Men|${k}`;
    const W = (k) => `Women|${k}`;
    [
      ['Runner 1', 'runner', [M('shirt'), M('polo')], [M('trousers')]],
      ['Runner 2', 'runner', [W('shirt'), W('polo'), W('trousers')], [M('shirt')]],
      ['Runner 3', 'runner', [M('trousers')], [M('polo'), W('shirt')]],
      ['Floor 1', 'floor', [M('shirt'), M('polo'), M('trousers')], [W('shirt')]],
      ['Floor 2', 'floor', [W('shirt'), W('polo'), W('trousers')], [M('shirt')]],
    ].forEach(([label, type, primary, secondary]) => addStaff({ label, type, primary, secondary }));
    roster(res);
  });

  app.post('/api/staff/join', (req, res) => {
    const code = String(req.body?.code ?? '').trim().toUpperCase();
    const person = staff.find((x) => x.code === code);
    if (!person) throw missing('Unknown code');
    touch(person.id);
    res.json({ staff: { id: person.id, label: person.label, type: person.type } });
  });

  app.post('/api/staff/:id', (req, res) => {
    const person = staff.find((x) => x.id === req.params.id);
    if (!person) throw missing('Team member not found');
    Object.assign(person, checked(() => normaliseStaff({ ...person, ...(req.body || {}) })));
    roster(res, person);
  });

  app.delete('/api/staff/:id', (req, res) => {
    if (!staff.some((x) => x.id === req.params.id)) throw missing('Team member not found');
    staff = staff.filter((x) => x.id !== req.params.id);
    lastSeen.delete(req.params.id);
    roster(res);
  });

  app.get('/api/events', (req, res) => {
    const since = Number(req.query.since) || 0;
    touch(req.query.staff); // the phone's heartbeat
    res.json({ events: store.since(since), lastSeq: store.lastSeq, serverNow: now(), epoch: store.epoch, settings: settings({ admin: req.query.admin === '1' }) });
  });

  // ---- customer ----
  /** The fields every new request needs, checked once: one issue or a list, body areas, style details, a short note. */
  const readRequestFields = (body) => {
    const { chips = [], styleAxes = [], text = '' } = body || {};
    const picked = body?.issues ?? (body?.issue ? [body.issue] : []); // one issue (older clients) or a list
    const issues = (() => { try { return normaliseIssues(picked); } catch (e) { throw bad(e.message); } })();
    if (!Array.isArray(chips) || chips.some((c) => !CHIPS.includes(c))) throw bad('Unknown body-area chip');
    if (!Array.isArray(styleAxes) || styleAxes.some((a) => !ALL_STYLE_AXES.includes(a))) throw bad('Unknown style detail');
    if (typeof text !== 'string' || text.length > 500) throw bad('text must be a string of at most 500 characters');
    return { issues, chips, styleAxes, text };
  };

  /** Append `created` and `routed` for one request. The first issue is the main one: routing and labels use it. */
  const createRequest = ({ roomNum, skuId, issues, chips, styleAxes, parsed }) => {
    const id = rid('r');
    const issue = issues[0];
    append(id, 'created', 'customer', {
      room: roomNum, skuId, issue, issues, chips: [...new Set(chips)], parsed: parsed.fields, method: parsed.method,
      styleAxes: issue === 'another_style' ? [...new Set(styleAxes)] : [], // style details only mean something for "Another style"
    });
    const route = routeFor(issue);
    append(id, 'routed', 'system', { role: route.role, rule: route.rule });
    return id;
  };

  app.post('/api/requests', async (req, res) => {
    const roomNum = Number(req.body?.room);
    const { skuId } = req.body || {};
    if (!Number.isInteger(roomNum) || roomNum < 1 || roomNum > 99) throw bad('room must be a number 1-99');
    if (!getSku(skuId, catalogue)) throw bad('Unknown garment');
    const fields = readRequestFields(req.body);
    // The raw text is parsed and dropped; only the structured result is logged.
    const parsed = await parseCustomerText(fields.text, llmFor(req));
    const id = createRequest({ roomNum, skuId, ...fields, parsed });
    assignPending();
    res.json({ requestId: id, method: parsed.method });
  });

  // "Still not right": the SAME request starts another attempt. The customer says which of the items they tried came
  // closest and what was still off with it; that one item is the starting point for the next suggestion (everything
  // already brought is left out, in every colour). Nothing new is created to track: one request, one timeline, one
  // outcome. It goes back to waiting (to the same runner first), with its own clocks. The runner can open it too, from
  // the door, when the customer says it aloud: then it is theirs at once, with the suggestion ready.
  app.post('/api/requests/:id/rounds', async (req, res) => {
    const r = derived().byId[req.params.id];
    if (!r || r.kind !== 'request') throw missing('Request not found');
    if (r.status !== 'on_the_way' || r.deliveredTs == null) throw conflict('Items can be reported once they have been handed over');
    const staffRole = req.body?.role in ROLES ? req.body.role : null; // set by the associate screens, never by the customer's
    if (!staffRole && ['fits', 'no_more', 'none_close'].includes(r.tryOn?.result)) throw conflict('You already told us');
    const item = req.body?.item;
    if (typeof item !== 'string' || !(r.onTheWay?.items || []).some((i) => i.itemId === item)) throw bad('Pick the item that came closest, from the ones we brought');
    const fields = readRequestFields(req.body);
    let taken = {};
    if (staffRole) {
      if (staffRole !== r.route?.role) throw bad(`This request is with the ${r.route?.role} team`);
      if (staff.length) {
        const who = staff.find((x) => x.id === req.body?.staffId);
        if (!who) throw new HttpError(403, 'Join as a team member first');
        if (who.type !== staffRole) throw bad(`${who.label} is a ${ROLES[who.type]}, not a ${ROLES[staffRole]}`);
        touch(who.id);
        taken = { staffId: who.id, tier: 'primary' }; // they are at the door with the customer: it is theirs
      }
    }
    const actor = staffRole || 'customer';
    const parsed = await parseCustomerText(fields.text, llmFor(req));
    if (!r.tryOn) append(r.id, 'tryon_feedback', actor, { result: 'not_right' }); // saying so answers the try-on question too
    append(r.id, 'round_opened', actor, {
      baselineIds: [item], issue: fields.issues[0], issues: fields.issues, chips: [...new Set(fields.chips)], parsed: parsed.fields, method: parsed.method,
      styleAxes: fields.issues[0] === 'another_style' ? [...new Set(fields.styleAxes)] : [], by: actor,
    });
    if (staffRole) {
      append(r.id, 'accepted', staffRole, { role: staffRole, ...taken });
      append(r.id, 'suggestion_shown', staffRole, suggest(r.id));
    }
    assignPending();
    res.json({ ok: true, round: derived().byId[r.id].round, method: parsed.method });
  });

  // "I'm done with this room": ends the visit. Anything still open from the room is withdrawn, so nobody carries items to
  // an empty room, and the next customer there starts a fresh session (no carryover from the one before).
  app.post('/api/rooms/:n/release', (req, res) => {
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 1 || n > 99) throw bad('room must be a number 1-99');
    const d = derived();
    const current = d.requests.filter((r) => r.room === n && r.sessionStartTs === (d.rooms[n]?.releasedTs ?? 0));
    if (!current.length) return res.json({ ok: true, noop: true });
    const open = current.filter(isOpen);
    for (const r of open) append(r.id, 'cancelled', 'customer', { stage: r.status });
    append(`room:${n}`, 'room_released', 'customer', { room: n, by: 'customer', cancelled: open.length });
    return res.json({ ok: true, cancelled: open.length });
  });

  app.post('/api/requests/:id/cancel', (req, res) => {
    const r = getRequest(req.params.id);
    if (r.status === 'closed') throw conflict('Request already closed');
    if (r.status === 'cancelled') throw conflict('Request already cancelled');
    append(r.id, 'cancelled', 'customer', { stage: r.status });
    res.json({ ok: true });
  });

  // ---- associates ----
  app.post('/api/requests/:id/accept', (req, res) => {
    const r = getRequest(req.params.id);
    const role = req.body?.role;
    // routed role, or the other team once it has picked up an escalated request
    if (role !== r.route.role && !(role in ROLES && r.assistedBy === role)) throw bad(`This request is routed to the ${r.route.role} queue`);
    if (r.status !== 'requested') throw conflict('Request already accepted or closed');
    const taken = takeAccess(req, r, role);
    append(r.id, 'accepted', role, { role, ...taken });
    append(r.id, 'suggestion_shown', role, suggest(r.id));
    res.json({ ok: true });
  });

  app.post('/api/requests/:id/next-best', (req, res) => {
    const r = getRequest(req.params.id);
    if (r.status !== 'accepted' && r.status !== 'on_the_way') throw conflict('Request must be accepted and open');
    if (!r.suggestion) throw conflict('No suggestion yet');
    const actor = req.body?.role in ROLES ? req.body.role : r.route.role;
    const cause = req.body?.cause;
    if (cause === 'not_on_rack') {
      if (!['shown', 'confirmed'].includes(r.suggestionState)) throw conflict('No suggested item to report');
      if (r.deliveredTs != null) throw conflict('The customer already has the items'); // reporting one now would withdraw a trip being tried on
      // After confirming, the item reported is one of the trip; before, one of the suggested options.
      const inTrip = r.onTheWay?.items?.map((i) => i.itemId) || [];
      const candidates = inTrip.length ? inTrip : suggestionItemIds(r.suggestion);
      const itemId = req.body?.itemId || candidates[0];
      if (!itemId || !candidates.includes(itemId)) throw conflict('That item is not part of the suggestion');
      append(r.id, 'inventory_discrepancy', actor, { skuId: itemId, rack: getSku(itemId, catalogue).rack });
      if (derived().byId[r.id].onTheWay?.items?.length) { // the rest of the trip carries on
        return res.json({ ok: true, remaining: derived().byId[r.id].onTheWay.items.length });
      }
    } else if (cause === 'customer_declined') {
      if (!r.itemDeclined) throw conflict('The customer has not declined an item');
    } else {
      throw bad('cause must be not_on_rack or customer_declined');
    }
    append(r.id, 'suggestion_shown', actor, suggest(r.id));
    res.json({ ok: true });
  });

  app.post('/api/requests/:id/decline-item', (req, res) => {
    const r = getRequest(req.params.id);
    if (r.status !== 'on_the_way' || !r.onTheWay?.items?.length) throw conflict('No item is on its way');
    if (r.deliveredTs != null) throw conflict('The item has already been handed over');
    if (r.itemDeclined) throw conflict('You already told us you do not want these');
    const ids = r.onTheWay.items.map((i) => i.itemId);
    append(r.id, 'item_declined', 'customer', { itemId: ids[0], itemIds: ids });
    // Nobody should fetch items the customer has just turned down.
    for (const id of r.floorTaskIds) {
      if (['requested', 'accepted'].includes(derived().byId[id]?.status)) append(id, 'floor_pull_cancelled', 'system', { byRole: 'system', reason: 'customer_declined' });
    }
    res.json({ ok: true });
  });

  app.post('/api/items/:id/assist', (req, res) => {
    const x = derived().byId[req.params.id];
    if (!x) throw missing('Not found');
    const role = req.body?.role;
    if (!(role in ROLES)) throw bad('role must be runner or floor');
    if (!isOpen(x)) throw conflict('Already finished');
    if (!x.escalated) throw conflict('Only escalated items can be assisted');
    if (role === ownerRole(x)) throw bad('Assistance comes from the other team');
    if (x.assistedNow) throw conflict('Already being assisted');
    append(x.id, 'assisted', role, { byRole: role });
    res.json({ ok: true });
  });

  app.post('/api/requests/:id/confirm', (req, res) => {
    const r = getRequest(req.params.id);
    if (r.status !== 'accepted' || r.suggestionState !== 'shown') throw conflict('No pending suggestion to confirm');
    const options = suggestionItemIds(r.suggestion);
    // Default: bring every suggested item in one trip. The runner can leave some out (itemIds), or pick one (itemId).
    let ids = Array.isArray(req.body?.itemIds) ? req.body.itemIds : req.body?.itemId ? [req.body.itemId] : options;
    ids = [...new Set(ids)];
    if (!ids.length || ids.some((id) => !options.includes(id))) throw conflict('Those items are not part of the suggestion');
    const items = ids.map((id) => ({ itemId: id, itemLabel: skuLabel(getSku(id, catalogue)), forId: optionFor(r.suggestion, id)?.forId ?? r.cur.skuIds[0] }));
    const itemLabel = items.length > 1 ? `${items[0].itemLabel} +${items.length - 1} more` : items[0].itemLabel;
    append(r.id, 'suggestion_confirmed', actorOf(req, r), { itemId: ids[0], itemIds: ids });
    append(r.id, 'on_the_way', actorOf(req, r), { room: r.room, itemId: ids[0], itemLabel, items });
    // "Confirm and ask floor to pull": one tap, and the pull covers every confirmed item.
    const taskId = req.body?.pull === true ? requestPull(r, ids.map((id) => getSku(id, catalogue)), actorOf(req, r)) : undefined;
    res.json({ ok: true, taskId });
  });

  // Not these: the whole suggestion is turned down (never as a stock problem) and the engine is asked again, leaving out
  // everything rejected so far, in every colour. When it has nothing left, the request is in the "nothing fits" state.
  app.post('/api/requests/:id/more-options', (req, res) => {
    const r = getRequest(req.params.id);
    if (r.status !== 'accepted' || r.suggestionState !== 'shown') throw conflict('There is no suggestion to replace');
    const ids = suggestionItemIds(r.suggestion);
    if (!ids.length) throw conflict('There was nothing suggested to replace');
    append(r.id, 'suggestion_rejected', actorOf(req, r), { itemId: ids[0], itemIds: ids, reason: 'more_options' });
    const next = suggest(r.id);
    append(r.id, 'suggestion_shown', actorOf(req, r), next);
    res.json({ ok: true, found: suggestionItemIds(next).length });
  });

  // Nothing in stock fits this customer: the associate says so. The customer is told, and the request moves to the outcomes
  // that make sense (cross-store order, save for later, left, or keeping what they have).
  app.post('/api/requests/:id/no-match', (req, res) => {
    const r = getRequest(req.params.id);
    if (r.status !== 'accepted' || r.suggestionState !== 'shown') throw conflict('There is no suggestion to turn down');
    const ids = suggestionItemIds(r.suggestion);
    if (!ids.length) throw conflict('Nothing was suggested: that already means nothing fits');
    append(r.id, 'suggestion_rejected', actorOf(req, r), { itemId: ids[0], itemIds: ids, reason: 'no_match' });
    append(r.id, 'no_match', actorOf(req, r), {});
    res.json({ ok: true });
  });

  app.post('/api/requests/:id/reject', (req, res) => {
    const r = getRequest(req.params.id);
    if (r.status !== 'accepted' || r.suggestionState !== 'shown') throw conflict('No pending suggestion to reject');
    if (!suggestionItemIds(r.suggestion).length) throw conflict('Nothing was suggested');
    append(r.id, 'suggestion_rejected', actorOf(req, r), { itemId: r.suggestion.itemId });
    res.json({ ok: true });
  });

  /** One floor pull for the given items of a request. The floor associates see it straight away. */
  const requestPull = (r, skus, actor) => {
    const taskId = rid('t');
    append(r.id, 'floor_pull_requested', actor, {
      taskId, itemId: skus[0].id, rack: skus[0].rack, items: skus.map((x) => ({ itemId: x.id, rack: x.rack })),
    });
    assignPending();
    return taskId;
  };

  app.post('/api/requests/:id/floor-pull', (req, res) => {
    const r = getRequest(req.params.id);
    if (!isOpen(r) || r.status === 'requested') throw conflict('Request must be accepted and open');
    if (r.deliveredTs != null) throw conflict('The items have already been handed to the customer');
    // One live pull at a time: cancel it first to ask again.
    if (r.floorTaskIds.some((id) => ['requested', 'accepted', 'done'].includes(derived().byId[id]?.status))) throw conflict('A floor pull is already requested for this request');
    // One pull covers every item of the trip unless the runner names some.
    const wanted = Array.isArray(req.body?.itemIds) ? req.body.itemIds
      : req.body?.itemId ? [req.body.itemId]
        : r.onTheWay?.items?.map((i) => i.itemId) || [r.confirmedItemId || r.suggestion?.itemId].filter(Boolean);
    const skus = [...new Set(wanted)].map((id) => getSku(id, catalogue));
    if (!skus.length || skus.some((x) => !x)) throw conflict('No item to pull');
    res.json({ taskId: requestPull(r, skus, actorOf(req, r)) });
  });

  // Withdraw a pull that is not finished yet (waiting for a floor associate, or already accepted).
  app.post('/api/tasks/:id/cancel', (req, res) => {
    const t = getTask(req.params.id);
    if (t.status === 'done' || t.status === 'cancelled') throw conflict('This pull is already finished');
    append(t.id, 'floor_pull_cancelled', req.body?.role in ROLES ? req.body.role : 'runner', { byRole: req.body?.role in ROLES ? req.body.role : 'runner' });
    res.json({ ok: true });
  });

  const taskRole = (req, t) => {
    const role = req.body?.role in ROLES ? req.body.role : 'floor';
    if (role !== 'floor' && t.assistedBy !== role) throw bad('This pull is in the floor queue');
    return role;
  };

  app.post('/api/tasks/:id/accept', (req, res) => {
    const t = getTask(req.params.id);
    const role = taskRole(req, t);
    if (t.status !== 'requested') throw conflict('Task already accepted or done');
    const taken = takeAccess(req, t, role);
    append(t.id, 'accepted', role, { role, ...taken });
    res.json({ ok: true });
  });

  // The manager turns a signal on the dashboard into a task for the floor team. Only for a signal that exists right now
  // (so the rule, not the caller, decides what is worth doing), once at a time, and never with a quantity.
  app.post('/api/restock', (req, res) => {
    const { skuId, kind } = req.body || {};
    if (!(kind in RESTOCK_KINDS)) throw bad('kind must be recount or replenish');
    if (!getSku(skuId, catalogue)) throw bad('Unknown item');
    const signal = computeMetrics(store.all(), catalogue, cfg()).signals.find((x) => x.kind === RESTOCK_SIGNAL[kind] && x.skuId === skuId);
    if (!signal) throw conflict('There is no open signal for that item');
    if (signal.dispatched) throw conflict('Already sent to the floor team');
    const taskId = rid('t');
    append(taskId, 'restock_task_created', 'manager', { taskId, skuId, kind, rack: signal.dispatch.rack, signalKind: signal.kind });
    assignPending();
    res.json({ taskId });
  });

  app.post('/api/tasks/:id/done', (req, res) => {
    const t = getTask(req.params.id);
    const role = taskRole(req, t);
    if (t.status === 'cancelled') throw conflict(t.cancelReason === 'handed_over' ? 'The items were already handed to the customer' : 'This pull was cancelled');
    if (t.status !== 'accepted') throw conflict('Task must be accepted first');
    append(t.id, t.taskType === 'restock' ? 'restock_task_done' : 'floor_pull_done', role, {});
    // Handing the pulled items over is handing them to the customer: the request is delivered, and the runner's own
    // "Handed to customer" is no longer offered.
    const parent = t.parentId ? derived().byId[t.parentId] : null;
    if (parent && parent.status === 'on_the_way' && parent.deliveredTs == null) append(parent.id, 'delivered', role, {});
    res.json({ ok: true });
  });

  app.post('/api/requests/:id/close', (req, res) => {
    const r = getRequest(req.params.id);
    const outcome = req.body?.outcome;
    if (!(outcome in OUTCOMES)) throw bad('Unknown outcome');
    // Which of the brought items was kept, for a purchase of an alternative.
    const kept = req.body?.itemId;
    if (kept != null && (outcome !== 'bought_alternative' || !r.keepable.includes(kept))) throw bad('That item cannot be recorded as the one kept'); // any item brought and not reported, from any attempt
    if (r.status === 'closed') throw conflict('Request already closed');
    if (r.status === 'cancelled') throw conflict('Request was cancelled by the customer');
    if (r.status === 'requested') throw conflict('Accept the request before closing it');
    if (outcome === 'bought_alternative' && !r.keepable.length) throw conflict('Nothing was brought, so no alternative can have been bought');
    append(r.id, 'closed', actorOf(req, r), { outcome, ...(kept != null ? { itemId: kept } : {}) });
    res.json({ ok: true });
  });

  // The runner hands the item over: the delivery stage ends and the customer tries it on.
  app.post('/api/requests/:id/deliver', (req, res) => {
    const r = getRequest(req.params.id);
    if (r.status !== 'on_the_way' || !r.onTheWay?.items?.length) throw conflict('Nothing is on its way to hand over');
    if (r.deliveredTs != null) throw conflict('Already handed over');
    if (r.itemDeclined) throw conflict('The customer has declined these items: show the next best first');
    append(r.id, 'delivered', actorOf(req, r), {});
    // One hand-over, whoever does it: a floor pull still in progress has nothing left to hand over, so it is withdrawn.
    for (const id of r.floorTaskIds) {
      if (['requested', 'accepted'].includes(derived().byId[id]?.status)) append(id, 'floor_pull_cancelled', 'system', { byRole: 'system', reason: 'handed_over' });
    }
    res.json({ ok: true });
  });

  // The customer says how the item fits. A statement only: the staff still close the request with the real outcome.
  app.post('/api/requests/:id/try-on', (req, res) => {
    const r = getRequest(req.params.id);
    const result = req.body?.result;
    if (!TRYON_RESULTS.includes(result)) throw bad('Unknown try-on answer');
    if (r.status !== 'on_the_way' || r.deliveredTs == null) throw conflict('The item has not been handed over yet');
    // "Still not right" is sent the moment it is tapped; "none came close" on the next screen may refine it.
    if (r.tryOn && !(result === 'none_close' && r.tryOn.result === 'not_right')) throw conflict('You already told us');
    append(r.id, 'tryon_feedback', 'customer', { result });
    res.json({ ok: true });
  });

  app.post('/api/parse/reason', async (req, res) => {
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 500) throw bad('text is required (max 500 characters)');
    res.json(await parseReasonText(text, llmFor(req))); // nothing is logged here
  });

  app.post('/api/requests/:id/reason', (req, res) => {
    const r = getRequest(req.params.id);
    const { method, edited = false } = req.body || {};
    if (typeof method !== 'string' || !(method === 'rule_fallback' || method === 'system_rule' || method === 'quick_pick' || method.startsWith('ai:'))) throw bad('Invalid method');
    let fields;
    try { fields = validateReason(req.body); } catch { throw bad('Invalid reason'); }
    if (r.status !== 'closed' || SAVE_OUTCOMES.includes(r.outcome)) throw conflict('A reason is recorded only for a request that did not convert');
    append(r.id, 'reason_added', actorOf(req, r), { ...fields, method, edited: !!edited });
    res.json({ ok: true });
  });

  app.post('/api/reset', (_req, res) => {
    store.reset();
    res.json({ ok: true, epoch: store.epoch });
  });

  // ---- static ----
  app.use('/shared', express.static(path.join(ROOT, 'shared')));
  app.use(express.static(path.join(ROOT, 'public')));

  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err?.type === 'entity.parse.failed' || err?.status === 400) return res.status(400).json({ error: 'Bad JSON' });
    if (err?.status === 413) return res.status(413).json({ error: 'That is too large to send' });
    console.error('Unhandled error:', err?.message);
    return res.status(500).json({ error: 'Server error' });
  });

  /**
   * Append one `escalated` event per stage when an open request/task has been in that stage longer than its own
   * limit: waiting to be accepted, or accepted but not yet delivered. Accepting clears the first escalation.
   */
  /** A room with nothing open and no activity for the session time is empty again: the next customer starts fresh. */
  function releaseIdleRooms() {
    const d = derived();
    const limit = cfg().roomSessionMinutes * 60_000;
    for (const room of new Set(d.requests.map((r) => r.room))) {
      const current = d.requests.filter((r) => r.room === room && r.sessionStartTs === (d.rooms[room]?.releasedTs ?? 0));
      if (!current.length || current.some(isOpen)) continue;
      if (now() - Math.max(...current.map((r) => r.lastTs)) >= limit) append(`room:${room}`, 'room_released', 'system', { room, by: 'system' });
    }
  }

  function sweep() {
    releaseIdleRooms();
    assignPending();
    const t = now();
    const d = derived();
    for (const x of [...d.requests, ...d.tasks]) {
      const stage = stageOf(x);
      if (!stage || x.escalated || x.escalations.some((e) => e.stage === stage && (e.round ?? 1) === (x.round ?? 1))) continue; // once per stage, per attempt
      const { escalateSeconds } = stageLimits(cfg(), stage);
      if (t - stageStart(x, stage) >= escalateSeconds * 1000) {
        append(x.id, 'escalated', 'system', { level: 1, stage, thresholdSec: escalateSeconds });
      }
    }
  }

  return { app, sweep };
}

function lanUrls(port) {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${port}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env file */ }
  const env = process.env;
  const dataFile = path.resolve(ROOT, env.DATA_FILE || 'data/events.jsonl');
  const store = createStore({ file: dataFile });
  const llm = makeLlm(env);
  const config = makeConfig(env);
  const demoControls = ['true', '1', 'yes'].includes(String(env.DEMO_CONTROLS).toLowerCase());
  const { app, sweep } = createApp({ store, llm, config, demoControls, settingsFile: path.join(path.dirname(dataFile), 'settings.json') });
  setInterval(sweep, 2000).unref();
  const port = Number(env.PORT) || 3000;
  app.listen(port, '0.0.0.0', () => {
    console.log(`Fitting-Room Request Loop on http://localhost:${port}`);
    for (const u of lanUrls(port)) console.log(`  on your Wi-Fi: ${u}`);
    if (demoControls) console.log('Demo controls: ON (Manager screen) — switch off with DEMO_CONTROLS=false before sharing a public URL');
    console.log(llm ? `AI parser: Cerebras model "${llm.model}"` : 'AI parser: OFF (no CEREBRAS_API_KEY) — rule-based fallback will be used');
  });
}
