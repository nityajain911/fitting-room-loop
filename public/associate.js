// Screen 2 — associate (fitting-room runner / floor associate).
import {
  S, hooks, handlers, api, act, esc, now, toast, timerHtml, fmtDur, outcomeLabel, itemName,
  methodLabel, reasonLabel, roleLabel, issuesText, openAttr, STAGE_TEXT, ringHtml, rackPill,
  pairedId, setPaired, rosterOn, me,
} from './core.js';
import { tripItemName } from '/shared/visuals.js';
import { skillLabel } from '/shared/skills.js';
import { accessFor } from '/shared/staffing.js';
import { suggestionItemIds, optionFor, choiceSummary } from '/shared/fitMatch.js';
import { buildQueue, buildAssistQueue, recentlyClosed } from '/shared/routing.js';
import { isOpen, ownerRole, STAGE_LABEL, effectiveCatalogue } from '/shared/derive.js';
import { mergeIssue } from '/shared/fitMatch.js';
import { CATALOGUE, getSku, priceLabel, MEASURE_LABELS } from '/shared/catalogue.js';
import { carryoverFor } from '/shared/carryover.js';
import { priceWithDelta, declinedPricier } from '/shared/pricing.js';
import { STYLE_AXIS_LABELS, styleKind, ISSUES, FIT_ISSUES, CHIPS_BY_KIND, toggleIssue } from '/shared/events.js';
import { RESTOCK_KINDS, SAVE_OUTCOMES, OUTCOMES, REASON_TAGS, REASON_LABELS, EVIDENCE_TYPES, QUICK_REASONS } from '/shared/events.js';

const drafts = {}; // requestId -> { fields, method, original } (AI-structured reason being edited)
const picks = {};  // requestId -> { sig, ids: Set } the items ticked for the trip (default: all suggested items)
let lastRole = 'runner';
const moreOpen = {}; // requestId -> the step the bar's secondary actions were opened at
const closing = {};  // requestId -> the step the bar's outcome buttons were opened at
/** The bar's menu and outcome panel belong to one step of one attempt: they close themselves when the request moves on. */
const stepKey = (x) => `${x.status}|${x.suggestionState ?? ''}|${x.deliveredTs ?? ''}|${x.round ?? ''}|${x.itemDeclined ? 1 : 0}`;
const picked = {};   // requestId -> Set of item ids ticked off while walking the racks

/** Who is acting, for the server: the team member this phone joined as (none when there is no roster). */
const withStaff = (body) => (pairedId() ? { ...body, staffId: pairedId() } : body);

const go = (hash) => { location.hash = hash; };
const post = (path, body) => act(() => api('POST', path, body));
const rerender = () => hooks.render();

handlers['a-more-toggle'] = (el) => {
  const x = S.derived.byId[el.dataset.v];
  if (!x) return;
  moreOpen[x.id] = moreOpen[x.id] === stepKey(x) ? null : stepKey(x);
  rerender();
};
handlers['a-close-open'] = (el) => {
  const x = S.derived.byId[el.dataset.v];
  if (!x) return;
  closing[x.id] = stepKey(x); moreOpen[x.id] = null;
  rerender();
};
handlers['a-close-cancel'] = (el) => { delete closing[el.dataset.v]; rerender(); };
handlers['a-pick'] = (el) => {
  const set = (picked[el.dataset.id] ||= new Set());
  if (set.has(el.dataset.v)) set.delete(el.dataset.v); else set.add(el.dataset.v);
  rerender();
};
handlers['a-open'] = (el) => go(`#associate/${lastRole}/${el.dataset.v}`);
handlers['a-back'] = () => go(`#associate/${lastRole}`);
handlers['a-accept'] = (el) => post(`/api/requests/${el.dataset.v}/accept`, withStaff({ role: el.dataset.role }));
const joinWith = async (code) => {
  const out = await post('/api/staff/join', { code });
  if (!out) return;
  setPaired(out.staff.id);
  toast(`Joined as ${out.staff.label}`);
  go(`#associate/${out.staff.type}`);
  rerender();
};
handlers['a-join'] = () => {
  const code = (document.getElementById('join-code')?.value || '').trim();
  return code ? joinWith(code) : toast('Enter your code');
};
handlers['a-join-code'] = (el) => joinWith(el.dataset.v); // demo shortcut
handlers['a-signout'] = () => { setPaired(null); rerender(); };
handlers['a-confirm'] = (el) => {
  const r = S.derived.byId[el.dataset.v];
  const ids = [...selection(r)];
  if (!ids.length) return toast('Tick at least one item to bring');
  // data-pull: "confirm and ask the floor to pull" is one tap that does both
  return post(`/api/requests/${r.id}/confirm`, { role: lastRole, itemIds: ids, ...(el.dataset.pull ? { pull: true } : {}) });
};
handlers['a-toggle'] = (el) => {
  const set = selection(S.derived.byId[el.dataset.id]);
  if (set.has(el.dataset.v)) set.delete(el.dataset.v); else set.add(el.dataset.v);
  rerender();
};
// Not these: reject the whole suggestion (not a stock problem) and ask the engine again, leaving out everything rejected.
handlers['a-more'] = async (el) => {
  const out = await post(`/api/requests/${el.dataset.v}/more-options`, { role: lastRole });
  if (out) toast(out.found ? 'Here are other options.' : 'Nothing else in stock is close enough.');
};
// Nothing in stock fits this customer: the customer is told, and the outcomes that make sense are offered.
handlers['a-nomatch'] = (el) => post(`/api/requests/${el.dataset.v}/no-match`, { role: lastRole });
handlers['a-reject'] = (el) => post(`/api/requests/${el.dataset.v}/reject`, { role: lastRole });
// The customer says it aloud at the door ("the M Regular is still tight on my waist"): the runner opens the next attempt here.
const door = {}; // requestId -> { open, item, issues, chips } while the runner fills it in
const doorOf = (id) => (door[id] ||= { open: false, item: null, issues: [], chips: new Set() });
handlers['a-door-open'] = (el) => { const d = doorOf(el.dataset.v); d.open = !d.open; rerender(); };
handlers['a-door-item'] = (el) => { doorOf(el.dataset.id).item = el.dataset.v; rerender(); };
handlers['a-door-issue'] = (el) => {
  const d = doorOf(el.dataset.id);
  d.issues = toggleIssue(d.issues, el.dataset.v);
  if (!d.issues.some((x) => FIT_ISSUES.includes(x))) d.chips = new Set();
  rerender();
};
handlers['a-door-chip'] = (el) => {
  const d = doorOf(el.dataset.id);
  if (d.chips.has(el.dataset.v)) d.chips.delete(el.dataset.v); else d.chips.add(el.dataset.v);
  rerender();
};
handlers['a-door-send'] = async (el) => {
  const d = doorOf(el.dataset.v);
  if (!d.item || !d.issues.length) return toast('Pick the item and what was off');
  const out = await post(`/api/requests/${el.dataset.v}/rounds`, withStaff({ role: lastRole, item: d.item, issues: d.issues, chips: [...d.chips] }));
  if (out) { delete door[el.dataset.v]; toast('Attempt opened. The suggestion is ready.'); }
};
handlers['a-deliver'] = (el) => post(`/api/requests/${el.dataset.v}/deliver`, { role: lastRole });
handlers['a-pull-cancel'] = (el) => post(`/api/tasks/${el.dataset.v}/cancel`, { role: lastRole });
handlers['a-pull'] = (el) => post(`/api/requests/${el.dataset.v}/floor-pull`, { role: lastRole });
handlers['a-close'] = (el) => { delete closing[el.dataset.v]; return post(`/api/requests/${el.dataset.v}/close`, { outcome: el.dataset.outcome, role: lastRole, ...(el.dataset.item ? { itemId: el.dataset.item } : {}) }); };
handlers['a-left-early'] = (el) => {
  if (!confirm('Close this request as "Left"?')) return null;
  delete closing[el.dataset.v];
  return post(`/api/requests/${el.dataset.v}/close`, { outcome: 'left', role: lastRole });
};
handlers['a-quick-reason'] = (el) => {
  const q = QUICK_REASONS.find((x) => x.key === el.dataset.key);
  if (!q) return null;
  return post(`/api/requests/${el.dataset.v}/reason`, {
    reason_tag: q.tag, summary_en: q.summary, evidence_type: q.evidence, confidence: 1, method: 'quick_pick', edited: false, role: lastRole,
  });
};
handlers['a-task-accept'] = (el) => post(`/api/tasks/${el.dataset.v}/accept`, withStaff({ role: lastRole }));
handlers['a-task-done'] = (el) => post(`/api/tasks/${el.dataset.v}/done`, { role: lastRole });
handlers['a-assist'] = (el) => post(`/api/items/${el.dataset.v}/assist`, { role: lastRole });
handlers['a-next-best'] = async (el) => {
  const id = el.dataset.v;
  const body = { cause: el.dataset.cause, role: lastRole };
  if (el.dataset.item) body.itemId = el.dataset.item; // which item of the trip is missing
  const out = await post(`/api/requests/${id}/next-best`, body);
  if (!out) return;
  // Make the change impossible to miss: say where to walk now, and flash the fallback card once.
  const next = S.derived.byId[id]?.suggestion;
  const alt = next?.itemId ? getSku(next.itemId) : null;
  toast(alt ? `Fallback: now go to Rack ${alt.rack}` : 'No in-stock alternative. See the options below.');
  document.querySelector('.fallback-card')?.classList.add('flash');
};
handlers['a-reason-nomatch'] = (el) => post(`/api/requests/${el.dataset.v}/reason`, {
  reason_tag: 'stock_unavailable', summary_en: 'No suitable item in stock', evidence_type: 'system-observed', confidence: 1,
  method: 'system_rule', edited: false, role: lastRole,
});
handlers['a-reason-system'] = (el) => post(`/api/requests/${el.dataset.v}/reason`, {
  reason_tag: 'stock_unavailable', summary_en: 'Item was reported missing on the rack (stock record wrong)',
  evidence_type: 'system-observed', confidence: 1, method: 'system_rule', edited: false, role: lastRole,
});

handlers['a-reason-parse'] = async (el) => {
  const id = el.dataset.v;
  const ta = document.getElementById('reason-text');
  const text = (ta?.value || '').trim();
  if (!text) return toast('Type the reason first');
  const out = await act(() => api('POST', '/api/parse/reason', { text }));
  if (out) { drafts[id] = { fields: out.fields, method: out.method, original: { ...out.fields } }; rerender(); }
};
handlers['a-reason-cancel'] = (el) => { delete drafts[el.dataset.v]; rerender(); };
handlers['a-reason-confirm'] = async (el) => { // "Looks right"
  const id = el.dataset.v;
  const d = drafts[id];
  if (!d) return;
  const fields = {
    reason_tag: document.getElementById('rs-tag').value,
    summary_en: document.getElementById('rs-sum').value,
    evidence_type: document.getElementById('rs-ev').value,
    confidence: d.fields.confidence,
  };
  const edited = ['reason_tag', 'summary_en', 'evidence_type'].some((k) => fields[k] !== d.original[k]);
  const out = await post(`/api/requests/${id}/reason`, { ...fields, method: d.method, edited, role: lastRole });
  if (out) {
    delete drafts[id];
    const ta = document.getElementById('reason-text');
    if (ta) ta.value = '';
    rerender();
  }
};

/** What needs this phone's owner right now (for the alert sound): requests waiting for them, and escalations. */
export function attention() {
  const on = rosterOn();
  const who = on ? me() : null;
  if (on && !who) return null;
  const role = who ? who.type : lastRole;
  const map = new Map();
  for (const x of buildQueue(role, S.derived, now())) {
    if (who && !accessFor(x, who, S.roster).visible) continue;
    if (x.status === 'requested') map.set(x.id, !!x.escalated);
  }
  for (const x of buildAssistQueue(role, S.derived).offer) map.set(x.id, true);
  return map;
}

export function render({ args }) {
  const on = rosterOn();
  const who = on ? me() : null;
  if (on && !who) return joinScreen();
  const role = who ? who.type : args[0] === 'floor' ? 'floor' : 'runner';
  lastRole = role;
  // With a roster the person is fixed by their code: no role tabs, and their sections are shown, not editable.
  const header = who ? identityBar(who) : `
    <div class="seg" role="tablist">
      <a href="#associate/runner" class="${role === 'runner' ? 'on' : ''}">Fitting-room runner</a>
      <a href="#associate/floor" class="${role === 'floor' ? 'on' : ''}">Floor associate</a>
    </div>`;
  const id = args[1];
  if (id) {
    const x = S.derived.byId[id];
    if (!x) return header + `<button class="back" data-action="a-back">‹ Back to queue</button><p class="muted">${S.loaded ? 'Not found.' : 'Loading…'}</p>`;
    return header + `<button class="back" data-action="a-back">‹ Back to queue</button>` + (x.kind === 'task' ? taskDetail(x) : requestDetail(x, role));
  }
  return header + queue(role, who);
}

function joinScreen() {
  return `<h1>Join your team</h1>
    <p class="muted">Enter the 4-character code your manager gave you. It sets your role and sections.</p>
    <div class="card stack">
      <input type="text" id="join-code" data-keep="join-code" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD" class="code-input" aria-label="Join code">
      <button class="btn primary block" data-action="a-join">Join</button>
    </div>
    ${S.demo.enabled && S.roster.some((x) => x.code) ? `<h2>Quick join <span class="muted" style="text-transform:none;letter-spacing:0">(demo only)</span></h2>
      <div class="opts">${S.roster.filter((x) => x.code).map((x) => `<button type="button" class="opt" data-action="a-join-code" data-v="${esc(x.code)}">${esc(x.label)} · ${esc(x.code)}</button>`).join('')}</div>` : ''}`;
}

const sectionList = (keys) => keys.map(skillLabel).join(', ');
function identityBar(who) {
  return `<div class="whoami"><div><strong>${esc(who.label)}</strong> · ${esc(roleLabel(who.type))}
      <div class="small muted">Primary: ${esc(who.primary.length ? sectionList(who.primary) : 'none')}${who.secondary.length ? ` · Backup: ${esc(sectionList(who.secondary))}` : ''}</div></div>
    <button class="link-btn" data-action="a-signout">Not you?</button></div>`;
}

const statusPill = (x) => {
  if (x.status === 'cancelled') return x.kind === 'task' ? '<span class="pill danger">Cancelled</span>' : '<span class="pill danger">Cancelled by customer</span>';
  if (x.kind === 'task') return x.status === 'done' ? '<span class="pill ok">Done</span>' : x.status === 'accepted' ? '<span class="pill ok">Accepted</span>' : '<span class="pill accent">New</span>';
  return { requested: '<span class="pill accent">New</span>', accepted: '<span class="pill ok">Accepted</span>', on_the_way: x.deliveredTs != null ? '<span class="pill ok">Trying on</span>' : '<span class="pill ok">On the way</span>', closed: `<span class="pill">${esc(outcomeLabel(x.outcome))}</span>` }[x.status];
};

/** What the attempt in progress is about: the items the customer named, and what is wrong with them. */
const issuesNow = (x) => ((x.cur ?? x).issues || []).includes('check_stock') ? 'Check stock' : issuesText(x.cur ?? x); // a task for the floor, not the customer's own phrase
const itemNow = (x) => (x.cur?.skuIds ?? [x.skuId]).map(itemName).join(' + ');
const curSku = (x) => getSku((x.cur?.skuIds ?? [x.skuId])[0]);
const attemptPill = (x) => (x.round > 1 ? `<span class="pill accent">Attempt ${x.round}</span>` : '');
/** The item of the customer's that a brought item was chosen for. */
const baseFor = (r, o, s = r.suggestion) => getSku(s ? optionFor(s, o.id)?.forId : null) || getSku(r.baseOf?.[o.id]) || curSku(r);
/** An item's price beside what the customer has on, and a note when it is outside the usual price band. */
const priceNote = (r, o, s = r.suggestion) => `<span class="price">${esc(priceWithDelta(o, baseFor(r, o, s)))}</span>${s && optionFor(s, o.id)?.outsideBand ? ' <span class="pill warn">Outside usual price range</span>' : ''}`;
/** The customer's own items with their prices, for the header. */
const itemPriced = (x) => (x.cur?.skuIds ?? [x.skuId]).map((id) => `${itemName(id)}${getSku(id)?.price ? ` · ${priceLabel(getSku(id))}` : ''}`).join(' + ');


function assistCard(x) {
  const what = x.kind === 'task' ? 'Floor stock pull' : `${issuesNow(x)} · ${itemNow(x)}`;
  return `<div class="card urgent qcard">${ringHtml(x, 52)}<div class="qmain">
    <div class="row"><strong>Room ${esc(x.room)}</strong>${timerHtml(x, 'plain')}</div>
    <div class="small">${esc(what)}</div>
    <button class="btn primary block pulse" style="margin-top:8px" data-action="a-assist" data-v="${esc(x.id)}">Assist — Room ${esc(x.room)}</button>
  </div></div>`;
}

/** An escalated item in your own queue: only who, where and how long. Tap to act. */
function urgentCard(x) {
  const what = x.kind === 'task' ? `Floor pull · ${(x.items || []).length > 1 ? `${x.items.length} items` : itemName(x.itemId)}` : `${issuesNow(x)} · ${itemNow(x)}`;
  return `<div class="card tap urgent qcard" data-action="a-open" data-v="${esc(x.id)}">${ringHtml(x, 52)}<div class="qmain">
    <div class="row"><strong>Room ${esc(x.room)}</strong>${timerHtml(x, 'plain')}</div>
    <div class="small">${esc(what)} <span class="muted">· ${esc(stageText(x))}</span></div>${roomBadge(x) ? `<div class="pills">${roomBadge(x)}</div>` : ''}</div><span class="open-cta">Open ›</span></div>`;
}

/** A small tag for how this item reached this person: as backup, or because it opened to everyone. */
const tierPill = (x, who) => {
  if (!who || x.escalated) return '';
  const { tier } = accessFor(x, who, S.roster);
  return tier === 'secondary' ? '<span class="pill">Backup</span>' : tier === 'open' ? '<span class="pill">Open to all</span>' : '';
};

/** A hurried runner should not take one item for a room and miss that the room needs another. */
const roomBadge = (x) => {
  if (x.kind !== 'request') return '';
  const n = S.derived.requests.filter((r) => r.room === x.room && isOpen(r)).length;
  return n >= 2 ? `<span class="pill warn">Room ${esc(x.room)}: ${n} open items — take together</span>` : '';
};

function queue(role, who) {
  const all = buildQueue(role, S.derived, now());
  const items = who ? all.filter((x) => accessFor(x, who, S.roster).visible) : all;
  const withTeammates = all.length - items.length;
  const closed = recentlyClosed(role, S.derived);
  const { offer, assisting } = buildAssistQueue(role, S.derived);
  return `
    ${offer.length ? `<h2 style="color:var(--danger)">Can you help?</h2>${offer.map(assistCard).join('')}` : ''}
    ${assisting.length ? `<h2>You're assisting</h2>${assisting.map(queueCard).join('')}` : ''}
    ${items.some((x) => x.escalated) ? `<h2 style="color:var(--danger)">Needs you now</h2>${items.filter((x) => x.escalated).map(urgentCard).join('')}` : ''}
    <h1>${esc(roleLabel(role))} queue</h1>
    ${withTeammates ? `<div class="banner info">${withTeammates} with teammates first</div>` : ''}
    ${items.some((x) => !x.escalated) ? items.filter((x) => !x.escalated).map(queueCard).join('') : (items.length ? '' : '<div class="card muted">Nothing waiting</div>')}
    ${closed.length ? `<h2>Recently finished</h2>${closed.map((r) => `
      <div class="card tap" data-action="a-open" data-v="${esc(r.id)}">
        <div class="row"><span>Room ${esc(r.room)} · ${esc(issuesNow(r))}</span>${statusPill(r)}</div>
        <div class="small muted">${r.status === 'cancelled' ? `Customer cancelled ${esc(STAGE_TEXT[r.cancelStage] || '')}` : SAVE_OUTCOMES.includes(r.outcome) ? 'Sale saved' : r.reasons.length ? 'Reason recorded' : 'Tap to add why it did not convert'}</div>
      </div>`).join('')}` : ''}`;
}

const otherRole = (x) => (ownerRole(x) === 'runner' ? 'floor' : 'runner');
const stageText = (x) => STAGE_LABEL[x.escalatedStage] || 'Escalated';
const escPill = (x) => {
  const declined = x.itemDeclined ? '<span class="pill danger">Customer declined item</span> ' : '';
  if (!x.escalated) return declined;
  return declined + (x.assistedNow
    ? `<span class="pill warn">${esc(stageText(x))} — assisted by ${esc(roleLabel(x.assistedBy))}</span> `
    : `<span class="pill danger">${esc(stageText(x))} — other team alerted</span> `);
};
const escBanner = (x) => (x.escalated ? `<div class="small muted">${esc(stageText(x))} · ${x.assistedNow ? `${esc(roleLabel(x.assistedBy))} is assisting` : `offered to ${esc(roleLabel(otherRole(x)))} to assist`}</div>` : '');

function queueCard(x) {
  const cls = x.escalated ? 'esc' : '';
  if (x.kind === 'task') {
    const racks = [...new Set((x.items || []).map((i) => i.rack))].sort();
    return `<div class="card tap qcard ${cls}" data-action="a-open" data-v="${esc(x.id)}">${ringHtml(x)}<div class="qmain">
      <div class="row"><strong>${x.taskType === 'restock' ? esc(taskTitle(x)) : `Pull → Room ${esc(x.room)}`}</strong>${timerHtml(x, 'plain')}</div>
      <div class="small muted">${(x.items || []).length > 1 ? `${x.items.length} items` : esc(itemName(x.itemId))}</div>
      <div class="pills">${x.taskType === 'restock' ? '<span class="pill accent">From the manager</span>' : ''}${racks.map((k) => rackPill(k)).join('')}${tierPill(x, me())}${escPill(x)}${statusPill(x)}</div></div></div>`;
  }
  const target = x.suggestion?.itemId ? getSku(x.suggestion.itemId) : null;
  return `<div class="card tap qcard ${cls}" data-action="a-open" data-v="${esc(x.id)}">${ringHtml(x)}<div class="qmain">
    <div class="row"><strong>${esc(issuesNow(x))}</strong>${timerHtml(x, 'plain')}</div>
    <div class="small muted">${esc(itemNow(x))}</div>
    <div class="pills">${roomBadge(x)}${attemptPill(x)}${carryover(x) ? '<span class="pill accent">💡 Fit carryover</span>' : ''}${target ? rackPill(target.rack) : ''}${tierPill(x, me())}${escPill(x)}${statusPill(x)}</div></div></div>`;
}

// ---------- floor task ----------
const CANCEL_REASON = {
  handed_over: 'Already handed to the customer.',
  customer_declined: 'The customer declined these.',
};
const taskTitle = (x) => (x.taskType === 'restock' ? RESTOCK_KINDS[x.restockKind] || 'Restock' : 'Floor stock pull');
const RESTOCK_HELP = {
  recount: 'Count the rack and correct the record. Customers found it missing.',
  replenish: 'Top up the rack nearest the fitting rooms.',
};
const RESTOCK_DONE = { recount: 'Recounted — record corrected', replenish: 'Restocked' };

/** The one thing to do next, pinned to the bottom of the screen. Anything else sits behind "⋯". */
const bar = (x, primary, more = []) => { const open = moreOpen[x.id] === stepKey(x); return `<div class="actionbar">
  ${more.length && open ? `<div class="bar-more">${more.join('')}</div>` : ''}
  <div class="bar-row">${primary}${more.length ? `<button class="btn bar-dots" data-action="a-more-toggle" data-v="${esc(x.id)}" aria-label="More actions" aria-expanded="${open}">⋯</button>` : ''}</div></div>`; };
const barBtn = (action, id, label, extra = '', cls = 'primary') => `<button class="btn ${cls} xl" data-action="${action}" data-v="${esc(id)}" ${extra}>${label}</button>`;
const moreBtn = (action, id, label, extra = '') => `<button class="btn block ${extra.includes('danger') ? 'danger' : ''}" data-action="${action}" data-v="${esc(id)}" ${extra.replace('danger', '')}>${label}</button>`;

function taskBar(t, doneLabel) {
  if (t.status === 'requested') return bar(t, barBtn('a-task-accept', t.id, 'Accept'));
  if (t.status === 'accepted') return bar(t, barBtn('a-task-done', t.id, doneLabel));
  return '';
}

function restockDetail(t) {
  return `
    <div class="head">${ringHtml(t, 56)}<div><h1>${esc(taskTitle(t))}</h1>${timerHtml(t, 'plain')}</div></div>
    <div class="card stack">
      <div class="optrow"><div class="optmain"><div class="bring-line"><strong>${esc(itemName(t.skuId))}</strong>${rackPill(t.rack)}</div></div></div>
      <div class="small">${esc(RESTOCK_HELP[t.restockKind] || '')}</div>
      ${statusPill(t)}
    </div>${taskBar(t, esc(RESTOCK_DONE[t.restockKind] || 'Done'))}`;
}

function taskDetail(t) {
  if (t.taskType === 'restock') return restockDetail(t);
  return `
    <div class="head">${ringHtml(t, 56)}<div><h1>Floor stock pull</h1>${timerHtml(t, 'plain')}</div></div>
    <div class="card stack">
      ${[...(t.items || [])].sort((a, b) => String(a.rack).localeCompare(String(b.rack))).map((i) => `<div class="optrow"><div class="optmain"><div class="bring-line"><strong>${esc(itemName(i.itemId))}</strong>${rackPill(i.rack)}</div></div></div>`).join('')}
      <div>Take to Room ${esc(t.room)}</div>
      ${t.escalated ? `<span class="esc-tag">ESCALATED</span> <span class="small muted">${esc(stageText(t))}</span>` : ''}${statusPill(t)}
      ${t.status === 'cancelled' ? `<div class="banner info">${esc(CANCEL_REASON[t.cancelReason] || 'Cancelled.')}</div>` : ''}
    </div>${taskBar(t, 'Handed over')}`;
}

// ---------- request detail ----------
const pullState = (r, role) => {
  const tripItems = r.onTheWay?.items?.map((i) => i.itemId) || [];
  const pulls = r.floorTaskIds.map((id) => S.derived.byId[id]).filter(Boolean);
  const open = r.status === 'accepted' || r.status === 'on_the_way';
  // Offered once the items are confirmed, and only while no pull is live or done; cancelling a pull offers it again.
  const show = role === 'runner' && open && tripItems.length > 0 && r.deliveredTs == null && !pulls.some((t) => ['requested', 'accepted', 'done'].includes(t.status));
  return { tripItems, pulls, show };
};

/** What to do next for this request, pinned to the bottom. Same shape for every step. */
function requestBar(r, role) {
  if (!isOpen(r)) return '';
  const left = moreBtn('a-left-early', r.id, 'Customer left');
  if (closing[r.id] === stepKey(r)) return `<div class="actionbar"><div class="bar-out">${outcomeButtons(r)}</div><button class="link-btn bar-cancel" data-action="a-close-cancel" data-v="${esc(r.id)}">Back</button></div>`;
  if (r.status === 'requested') return bar(r, barBtn('a-accept', r.id, 'Accept', `data-role="${esc(r.assistedBy === role ? role : r.route.role)}"`));
  if (r.itemDeclined) return bar(r, barBtn('a-next-best', r.id, 'Show next best', 'data-cause="customer_declined"'), [left]);
  const opts = suggestionItemIds(r.suggestion).map((id) => getSku(id)).filter(Boolean);
  const pull = pullState(r, role);
  const pullBtn = pull.show ? [moreBtn('a-pull', r.id, `Ask floor to pull${pull.tripItems.length > 1 ? ` all ${pull.tripItems.length}` : ''}`)] : [];
  if (r.status === 'accepted' && r.suggestionState === 'shown' && opts.length) {
    const n = selection(r).size;
    return bar(r, barBtn('a-confirm', r.id, `Bring ${n === opts.length && n > 1 ? 'all ' : ''}${n}`, n ? '' : 'disabled'), [
      ...(role === 'runner' ? [moreBtn('a-confirm', r.id, 'Bring &amp; ask floor to pull', `data-pull="1" ${n ? '' : 'disabled'}`)] : []),
      moreBtn('a-more', r.id, 'Other options'),
      moreBtn('a-nomatch', r.id, 'Nothing fits', 'danger'),
      left,
    ]);
  }
  if (r.status === 'on_the_way' && r.deliveredTs == null) return bar(r, barBtn('a-deliver', r.id, 'Handed to customer'), [...pullBtn, left]);
  const door = r.status === 'on_the_way' && r.onTheWay?.items?.length ? [moreBtn('a-door-open', r.id, '🔄 Another size')] : [];
  // Right after the hand-over the customer is still trying things on: closing is quiet until they have answered.
  const waiting = r.status === 'on_the_way' && !r.tryOn;
  return bar(r, barBtn('a-close-open', r.id, 'Close…', '', waiting ? '' : 'primary'), [...door, left]);
}

function requestDetail(r, role) {
  const sku = curSku(r);
  const info = mergeIssue({ sku, issue: r.cur.issue, issues: r.cur.issues, chips: r.cur.chips, styleAxes: r.cur.styleAxes, parsed: r.cur.parsed, parseMethod: r.cur.method });
  const onWay = r.status === 'on_the_way';
  // Why it did not convert is only asked once the request has closed without a sale (not for sales or cancellations).
  const showReason = r.status === 'closed' && !SAVE_OUTCOMES.includes(r.outcome);
  const p = r.cur.parsed;
  const c = carryover(r);
  const n = r.deliveredIds.length;
  return `
    <div class="head">${ringHtml(r, 56)}<div><h1>Room ${esc(r.room)}</h1>${timerHtml(r, 'plain')}${isOpen(r) && r.escalated ? ' <span class="esc-tag">ESCALATED</span>' : ''}</div></div>
    <div class="summary"><strong>${esc(issuesNow(r))}</strong> · ${esc(itemPriced(r))} ${attemptPill(r)}${info.conflicts.length ? ' <span class="pill warn">⚠ Check</span>' : ''}${statusPill(r)}</div>
    ${p ? `<div class="small muted">${r.cur.method === 'rule_fallback' ? '⚙' : '✨'} “${esc(p.summary_en)}”</div>` : ''}
    ${escBanner(r)}
    ${r.round > 1 ? `<div class="banner info">Still not right after attempt ${r.round - 1}. Earlier items are left out.</div>` : ''}
    ${r.round > 1 && n && ['accepted', 'on_the_way'].includes(r.status) && r.deliveredTs == null ? `<div class="banner info">♻️ Swap the ${n} earlier item${n === 1 ? '' : 's'} in the room.</div>` : ''}
    ${c ? `<div class="banner info">💡 ${esc(c.text)}</div>` : ''}
    ${r.itemDeclined ? `<div class="banner alert">Customer said no to ${esc(itemName(r.itemDeclined.itemId))}. Show the next best.</div>` : ''}
    ${r.status === 'cancelled' ? `<div class="banner alert">Customer cancelled ${esc(STAGE_TEXT[r.cancelStage] || '')}. Nothing more to do.</div>` : ''}
    ${r.suggestion ? suggestionBlock(r, sku, role, onWay && !r.itemDeclined) : ''}
    ${onWay ? tripEnd(r) : ''}
    ${r.status === 'closed' ? `<div class="banner good">${esc(outcomeLabel(r.outcome))} · ${esc(fmtDur(r.closedTs - r.createdTs))}</div>` : ''}
    ${showReason ? reasonBlock(r) : ''}
    ${issueSection(r, info)}
    ${requestBar(r, role)}`;
}

/** Structured issue, one tap away. The line above it already says what matters. */
function issueSection(r, info) {
  const key = `issue:${r.id}`;
  return `<details class="sec" data-sec="${esc(key)}" ${openAttr(key, false)}>
    <summary>Details</summary>${issuePanel(r, info)}</details>`;
}

// Compact provenance badges; the legend at the foot of the panel gives the full wording.
const BADGES = {
  customer_tapped: '<span class="badge" title="Customer tapped">👤 Tap</span>',
  ai_parsed: '<span class="badge ai" title="Parsed by AI from the customer\'s text">✨ AI</span>',
  rule_fallback: '<span class="badge rule" title="Rule-based fallback — not AI">⚙ Rule</span>',
  default: '<span class="badge" title="Assumed default">~ Assumed</span>',
};
const badge = (...srcs) => [...new Set(srcs)].map((x) => BADGES[x] || '').join(' ');

function issuePanel(r, info) {
  const c = r.cur; // the attempt in progress
  const chipTxt = c.chips.length ? c.chips.join(', ') : 'none';
  const p = c.parsed;
  const parseSrc = c.method === 'rule_fallback' ? 'rule_fallback' : 'ai_parsed';
  const pairRow = (label, area, word) => `<div class="row"><span>${label}: <strong>${esc(area)} · ${esc(word)}</strong></span>${badge(parseSrc)}</div>`;
  const used = (t, name) => !t ? '' : `<div class="row"><span>${name}: <strong>${esc(t.area)} — ${esc(t.word)}</strong></span>
    <span>${t.wordSource ? badge(t.wordSource, t.areaSource) : badge(t.source)}</span></div>`;
  return `<div class="card stack">
    ${p ? `<div class="${c.method === 'rule_fallback' ? 'src fallback' : 'src'}">${esc(methodLabel(c.method))}</div>` : ''}
    <div class="row"><span>${c.issues.length > 1 ? 'Issues' : 'Issue'}: <strong>${esc(issuesText(c))}</strong></span>${badge('customer_tapped')}</div>
    ${c.issue === 'another_style'
      ? `<div class="row"><span>Style details asked: <strong>${c.styleAxes.length ? esc(c.styleAxes.map((a) => STYLE_AXIS_LABELS[a]).join(', ')) : 'any'}</strong></span>${badge('customer_tapped')}</div>`
      : `<div class="row"><span>Body-area chips: <strong>${esc(chipTxt)}</strong></span>${badge('customer_tapped')}</div>`}
    ${p ? `${pairRow('Main', p.primary_area, p.primary_issue)}
           ${p.secondary_area !== 'other/unknown' || p.secondary_issue !== 'other/unknown' ? pairRow('Also', p.secondary_area, p.secondary_issue) : ''}
           <div class="small muted">“${esc(p.summary_en)}” · confidence ${Math.round(p.confidence * 100)}%</div>`
      : '<div class="small muted">No free text from customer.</div>'}
    ${info.primary ? `<hr style="border:0;border-top:1px solid var(--border);width:100%">
      <div class="small muted">Used for matching</div>${used(info.primary, 'Main')}${used(info.secondary, 'Also')}` : ''}
    ${info.conflicts.map((c) => `<div class="banner alert">Conflict: ${esc(c)}</div>`).join('')}
    ${info.assumptions.map((a) => `<div class="banner info">${esc(a)}</div>`).join('')}
    ${info.notes.map((a) => `<div class="small muted">${esc(a)}</div>`).join('')}
    <div class="legend-line">👤 customer tapped · ✨ parsed by AI · ⚙ rule-based fallback, not AI · ~ assumed</div>
  </div>`;
}

const onRecord = (id) => getSku(id)?.stock ?? 0;
const reported = (id) => S.derived.discrepancies?.[id] || 0;
const stockNow = (id) => Math.max(0, onRecord(id) - reported(id));

/** Say plainly what kind of change this is, so a style change cannot be mistaken for a size change (or the reverse). */
const cap1 = (t) => t.charAt(0).toUpperCase() + t.slice(1);

function changeBanner(s, sku, alt) {
  if (s.kind === 'alternative_style' && s.change?.type === 'design') {
    const c = s.change;
    const changed = (c.changed || []).map((x) => `<strong>${esc(x.label.toLowerCase())}</strong>: ${esc(x.from)} → ${esc(x.to)}`).join('; ');
    return `<div class="banner info"><strong>Different style:</strong> ${changed || `${esc(c.from)} → ${esc(c.to)}`}.${(c.unmet || []).length ? ` Could not change ${esc(c.unmet.map((a) => STYLE_AXIS_LABELS[a].toLowerCase()).join(' and '))}.` : ''}${c.alsoCut ? ` ${esc(alt.cut)} cut, so the fit changes.` : ''}</div>`;
  }
  if (s.kind === 'alternative_style' && s.change?.type === 'cut') {
    return `<div class="banner info"><strong>Same design, ${esc(alt.cut)} cut.</strong> It fits differently.</div>`;
  }
  if (s.kind === 'alternative_size') {
    return `<div class="banner info"><strong>Size ${esc(sku.size)} → ${esc(alt.size)}</strong></div>`;
  }
  return '';
}

/** The items ticked for the trip. Defaults to every suggested item; resets whenever the suggestion changes. */
function selection(r) {
  const ids = suggestionItemIds(r.suggestion);
  const sig = ids.join('|');
  if (!picks[r.id] || picks[r.id].sig !== sig) picks[r.id] = { sig, ids: new Set(ids) };
  return picks[r.id].ids;
}

const optionName = (sku, alt) => tripItemName(sku, alt);

/** One comparison table per item of the customer's that something was chosen for (usually just one). */
function comparisons(r, s, opts, sku) {
  const groups = new Map();
  for (const o of opts) {
    const base = baseFor(r, o, s) || sku;
    if (!groups.has(base.id)) groups.set(base.id, { base, list: [] });
    groups.get(base.id).list.push(o);
  }
  return [...groups.values()].map(({ base, list }) => `${groups.size > 1 ? `<div class="small muted" style="margin-top:8px">Compared with ${esc(itemName(base.id))}</div>` : ''}${comparisonTable(base, list, { diffs: optionFor(s, list[0].id)?.diffs ?? s.diffs })}`).join('');
}

/** Every measurement of what the customer has on beside every item to bring. Nothing is singled out as "the" change. */
function comparisonTable(sku, opts, s) {
  const roles = Object.fromEntries((s.diffs || []).map((d) => [d.measure, d.role]));
  const keys = Object.keys(sku.m).filter((k) => opts.some((o) => k in o.m));
  return `<table class="cmp"><thead><tr><th>cm</th><th>Now<br><span class="muted" style="font-weight:400">${esc(priceLabel(sku))}</span></th>${opts.map((o) => `<th>${esc(`${o.size} ${o.cut}`)}${o.colour !== sku.colour ? `<br><span class="muted" style="font-weight:400">${esc(o.colour)}</span>` : ''}<br><span class="muted" style="font-weight:400">${esc(priceWithDelta(o, sku))}</span></th>`).join('')}</tr></thead><tbody>
    ${keys.map((k) => `<tr class="${roles[k] === 'primary' || roles[k] === 'secondary' ? 'hl' : ''}"><td>${esc(MEASURE_LABELS[k] || k)}${roles[k] === 'primary' ? '<span class="tag">MAIN</span>' : roles[k] === 'secondary' ? '<span class="tag">ALSO</span>' : ''}</td>
      <td>${sku.m[k]}</td>${opts.map((o) => `<td>${o.m[k] ?? '–'}</td>`).join('')}</tr>`).join('')}
  </tbody></table>
`;
}

/** What to do when nothing in stock fits: the outcomes that make sense, in plain words. The customer has been told. */
function noMatchHelp(r, s) {
  const alteration = s?.kind === 'alteration_or_crossstore';
  return `<div class="card stack" style="margin-top:8px">
    <div class="small">${alteration ? 'Offer a hem or a cross-store order.' : 'Offer a cross-store order or save it for later.'}</div>
  </div>`;
}

function suggestionBlock(r, sku, role, compact = false) {
  const s = r.suggestion;
  const ids = suggestionItemIds(s);
  const opts = ids.map((id) => getSku(id)).filter(Boolean);
  const hasItem = opts.length > 0 && r.suggestionState !== 'no_match'; // once nothing fits, the items are no longer on offer
  const isOpenReq = r.status === 'accepted' || r.status === 'on_the_way';
  const canAct = r.status === 'accepted' && r.suggestionState === 'shown' && hasItem && !r.itemDeclined;
  const sel = hasItem ? selection(r) : new Set();
  let body = '';

  if (hasItem) {
    if (opts.length === 1) body += changeBanner(s, baseFor(r, opts[0], s) || sku, opts[0]);
    for (const n of (s.perBaseline || []).filter((x) => (s.baselines || []).length > 1 && !['alternative', 'alternative_size', 'alternative_style', 'stock_check'].includes(x.kind))) {
      body += `<div class="banner info"><strong>${esc(itemName(n.forId))}:</strong> ${esc(n.reason)}</div>`; // a picked item with nothing in stock
    }
    body += opts.map((o) => {
      const why = choiceSummary(optionFor(s, o.id));
      return `<div class="optrow ${canAct && !sel.has(o.id) ? 'off' : ''}">
        ${canAct ? `<input type="checkbox" class="optbox" aria-label="Bring ${esc(optionName(baseFor(r, o, s) || sku, o))}" data-action="a-toggle" data-id="${esc(r.id)}" data-v="${esc(o.id)}" ${sel.has(o.id) ? 'checked' : ''}>` : ''}
        <div class="optmain"><div class="bring-line"><span><strong>${esc(optionName(baseFor(r, o, s) || sku, o))}</strong> ${priceNote(r, o, s)}</span>${rackPill(o.rack, `${stockNow(o.id)} left`)}</div>
          ${reported(o.id) ? `<div class="small muted">${reported(o.id)} reported missing</div>` : ''}
          ${why && opts.length > 1 ? `<div class="small">${esc(cap1(why))}</div>` : ''}</div>
        ${isOpenReq && !r.itemDeclined && r.deliveredTs == null && ['shown', 'confirmed'].includes(r.suggestionState) ? `<button class="btn small-btn" data-action="a-next-best" data-v="${esc(r.id)}" data-cause="not_on_rack" data-item="${esc(o.id)}">Not on rack</button>` : ''}
      </div>`;
    }).join('');
    if (opts.length > 1 && s.kind === 'alternative_style') {
      body += '<div class="small muted">Each is a different design.</div>';
    }
    body += `<details class="sec" data-sec="cmp:${esc(r.id)}" ${openAttr(`cmp:${r.id}`, false)}><summary>Measurements</summary>${comparisons(r, s, opts, sku)}</details>`;
  } else {
    body += r.suggestionState === 'no_match'
      ? `<div class="banner alert">Nothing in stock fits.</div>`
      : `<div class="banner ${s.kind === 'alteration_or_crossstore' ? 'info' : 'alert'}">${esc(s.reason)}</div>`;
    if (r.noMatch) body += noMatchHelp(r, s);
  }

  // Items already ruled out for this request, struck through, so a rushed associate sees what changed.
  const struck = [
    ...r.discrepancies.map((d) => `<span class="chip struck">❌ <s>${esc(itemName(d.skuId))}</s> <span>(not on rack)</span></span>`),
    ...r.declinedIds.map((id) => `<span class="chip struck">❌ <s>${esc(itemName(id))}</s> <span>(declined)</span></span>`),
  ];
  // "Fallback #n": how many items were reported missing on the rack or declined before this suggestion (not what was merely tried).
  const fallbackN = new Set([...r.discrepancies.map((d) => d.skuId), ...r.declinedIds]).size + 1;
  const isFallback = fallbackN > 1;
  const fallbackHead = isFallback
    ? `<div class="fallback-head">Fallback #${fallbackN}: ${hasItem ? `<strong>${esc(opts.map((o) => optionName(baseFor(r, o, s) || sku, o)).join(' · '))}</strong> ${rackPill(opts[0].rack, `${stockNow(opts[0].id)} left`)}` : 'no in-stock alternative'}</div>` : '';
  const struckHtml = struck.length ? `<div class="chips-struck">${struck.join('')}</div>` : '';

  const { pulls } = pullState(r, role);
  const tasks = pulls
    .map((t) => `<div class="row small" style="margin-top:8px"><span>Floor pull ${(t.items || []).map((i) => rackPill(i.rack)).join(' ')}</span><span>${statusPill(t)}${['requested', 'accepted'].includes(t.status) && role === 'runner' ? ` <button class="link-btn" data-action="a-pull-cancel" data-v="${esc(t.id)}">Cancel</button>` : ''}</span></div>`).join('');

  // Step 2: the trip is on its way. One summary; the table stays one tap away.
  if (compact) {
    // In walking order (by rack), each ticked off as it is picked.
    const trip = (r.onTheWay?.items || []).map((i) => getSku(i.itemId)).filter(Boolean).sort((a, b) => String(a.rack).localeCompare(String(b.rack)));
    const got = picked[r.id] || new Set();
    const key = `sugg:${r.id}`;
    return `<h2>${r.deliveredTs != null ? 'Brought' : 'On the way'}</h2><div class="card ${isFallback ? 'fallback-card' : ''}">
      ${fallbackHead}
      ${trip.map((o) => `<div class="optrow ${r.deliveredTs == null && got.has(o.id) ? 'off' : ''}">${r.deliveredTs == null ? `<input type="checkbox" class="optbox" aria-label="Picked ${esc(optionName(baseFor(r, o, s) || sku, o))}" data-action="a-pick" data-id="${esc(r.id)}" data-v="${esc(o.id)}" ${got.has(o.id) ? 'checked' : ''}>` : ''}<div class="optmain"><div class="bring-line"><span><strong>${esc(optionName(baseFor(r, o, s) || sku, o))}</strong> ${priceNote(r, o, s)}</span>${rackPill(o.rack)}</div>
</div>
        ${r.deliveredTs == null ? `<button class="btn small-btn" data-action="a-next-best" data-v="${esc(r.id)}" data-cause="not_on_rack" data-item="${esc(o.id)}">Not on rack</button>` : ''}</div>`).join('')}
      ${struckHtml}
      <details class="sec" data-sec="${esc(key)}" ${openAttr(key, false)}><summary>Measurements</summary>${trip.length ? comparisons(r, s, trip, sku) : ''}</details>
      ${tasks}
    </div>`;
  }

  return `<h2>${hasItem ? 'Bring' : 'Result'}</h2><div class="card ${isFallback ? 'fallback-card' : ''}">
      ${fallbackHead}${struckHtml}${body}
      ${tasks}
    </div>`;
}

/**
 * After the hand-over: the customer's own word on the fit (the staff still close the request), and the door form.
 * The hand-over and the outcome themselves are in the bar.
 */
function tripEnd(r) {
  if (r.deliveredTs == null) return '';
  const by = r.deliveredBy ? `<div class="small muted">Handed over by the ${esc(roleLabel(r.deliveredBy).toLowerCase())}</div>` : '';
  const say = !r.tryOn ? `${by}<div class="small muted">Trying it on…</div>`
    : r.tryOn.result === 'no_more' ? `${by}<div class="banner info">Customer: all set 👋</div>`
    : r.tryOn.result === 'fits' ? `${by}<div class="banner good">Customer: it fits 👍</div>`
    : r.tryOn.result === 'none_close' ? `${by}<div class="banner alert">Customer: none came close. Go and talk it through.</div>`
      : `${by}<div class="banner info">Customer: still not right 🔄 A follow-up is coming.</div>`;
  return `${say}${doorBlock(r)}`;
}

/** "Customer asked for another size": which item came closest and what was off, entered by the runner at the door. */
function doorBlock(r) {
  const d = doorOf(r.id);
  const items = (r.onTheWay?.items || []).map((i) => i.itemId).filter((id) => getSku(id));
  if (!items.length || !d.open) return '';
  const name = (id) => { const b = getSku(r.baseOf?.[id]) || getSku(r.skuId); return b ? tripItemName(b, getSku(id)) : itemName(id); };
  const kind = styleKind(getSku(d.item || items[0]).category);
  const optBtn = (action, v, label, on) => `<button type="button" class="opt ${on ? 'on' : ''}" data-action="${action}" data-id="${esc(r.id)}" data-v="${esc(v)}" aria-pressed="${on}">${esc(label)}</button>`;
  const chips = FIT_ISSUES.some((k) => d.issues.includes(k)) ? `<div class="small muted" style="margin-top:8px">Where?</div><div class="opts">${CHIPS_BY_KIND[kind === 'trousers' ? 'trousers' : 'top'].map((c) => optBtn('a-door-chip', c, c.charAt(0).toUpperCase() + c.slice(1), d.chips.has(c))).join('')}</div>` : '';
  return `<div class="card stack" style="margin-top:10px">
    <strong>Closest item</strong>
    <div class="opts">${items.map((id) => optBtn('a-door-item', id, name(id), d.item === id)).join('')}</div>
    ${d.item ? `<strong>Still off</strong><div class="opts">${Object.entries(ISSUES).map(([k, v]) => optBtn('a-door-issue', k, v, d.issues.includes(k))).join('')}</div>${chips}` : ''}
    <button class="btn primary block" data-action="a-door-send" data-v="${esc(r.id)}" ${d.item && d.issues.length ? '' : 'disabled'}>Next attempt</button>
    <button class="link-btn" data-action="a-door-open" data-v="${esc(r.id)}">Cancel</button>
  </div>`;
}

/** The outcome buttons, shown in the bar. When several items could be the one kept, "bought alternative" names it. */
function outcomeButtons(r) {
  const kept = r.keepable.filter((id) => getSku(id));
  const label = (id) => { const b = getSku(r.baseOf?.[id]) || getSku(r.skuId); return b ? tripItemName(b, getSku(id)) : itemName(id); };
  const buttons = Object.entries(OUTCOMES).flatMap(([k, v]) => (k === 'bought_alternative' && !kept.length ? [] // nothing was brought
    : k === 'bought_alternative' && kept.length > 1
      ? kept.map((id) => `<button class="btn" data-action="a-close" data-v="${esc(r.id)}" data-outcome="${k}" data-item="${esc(id)}">Bought ${esc(label(id))}</button>`)
      : [`<button class="btn" data-action="a-close" data-v="${esc(r.id)}" data-outcome="${k}">${esc(v)}</button>`]));
  return `<div class="btn-grid">${buttons.join('')}</div>`;
}

/** What an earlier purchase in the same room visit suggests for this request (a hint, never a decision). */
const carryover = (r) => (r.kind === 'request' && r.round === 1 && ['requested', 'accepted'].includes(r.status)
  ? carryoverFor(r, S.derived, effectiveCatalogue(CATALOGUE, S.derived.discrepancies), S.config || {}) : null);

function reasonBlock(r) {
  const d = drafts[r.id];
  const last = r.reasons[r.reasons.length - 1];
  const aiMode = S.parser?.mode === 'ai';
  const rkey = `reason:${r.id}`;
  return `<details class="sec" data-sec="${esc(rkey)}" ${openAttr(rkey, true)}><summary>Why no sale?</summary><div class="card stack">
    ${(!last && r.status === 'closed' && ['left', 'saved_for_later'].includes(r.outcome) && r.hadNoMatch) ? `<div class="banner info">
      Nothing in stock fitted this customer.
      <button class="btn block" style="margin-top:8px" data-action="a-reason-nomatch" data-v="${esc(r.id)}">Record reason: no suitable item in stock</button></div>` : ''}
    ${(!last && r.status === 'closed' && ['left', 'saved_for_later'].includes(r.outcome) && r.discrepancies.length) ? `<div class="banner info">
      An item was reported missing on the rack for this request.
      <button class="btn block" style="margin-top:8px" data-action="a-reason-system" data-v="${esc(r.id)}">Record reason: stock record wrong (system-observed)</button></div>` : ''}
    ${last ? `<div class="banner good">Recorded: <strong>${esc(reasonLabel(last.reason_tag))}</strong> · ${esc(last.evidence_type)}<br>
      <span class="small">“${esc(last.summary_en)}” · ${esc(methodLabel(last.method))}${last.edited ? ' · edited by associate' : ''}</span></div>` : ''}
    <div class="small muted">One tap</div>
    <div class="opts">${QUICK_REASONS.filter((q) => q.key !== 'price' || declinedPricier(r, getSku) || last?.reason_tag === 'price').map((q) => `<button class="opt ${last?.method === 'quick_pick' && last.reason_tag === q.tag ? 'on' : ''}" data-action="a-quick-reason" data-v="${esc(r.id)}" data-key="${q.key}">${esc(q.label)}</button>`).join('')}</div>
    <label class="field" for="reason-text">Or type it in any language</label>
    <textarea id="reason-text" data-keep="reason-text" maxlength="500" placeholder="e.g. Customer travelling tonight, cannot wait for alteration"></textarea>
    <button class="btn" data-action="a-reason-parse" data-v="${esc(r.id)}">${aiMode ? 'Structure with AI' : 'Structure (rule-based fallback — not AI)'}</button>
    ${d ? `<div class="stack">
      <div class="${d.method === 'rule_fallback' ? 'src fallback' : 'src'}">${esc(methodLabel(d.method))} · confidence ${Math.round(d.fields.confidence * 100)}%. Check it, edit if needed.</div>
      <label class="field" for="rs-tag">Reason</label>
      <select id="rs-tag" data-keep="rs-tag-${esc(r.id)}">${REASON_TAGS.map((t) => `<option value="${t}" ${t === d.fields.reason_tag ? 'selected' : ''}>${esc(REASON_LABELS[t])}</option>`).join('')}</select>
      <label class="field" for="rs-ev">Evidence type</label>
      <select id="rs-ev" data-keep="rs-ev-${esc(r.id)}">${EVIDENCE_TYPES.map((t) => `<option value="${t}" ${t === d.fields.evidence_type ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <label class="field" for="rs-sum">Summary</label>
      <input type="text" id="rs-sum" data-keep="rs-sum-${esc(r.id)}" maxlength="200" value="${esc(d.fields.summary_en)}">
      <div class="btn-grid"><button class="btn primary" data-action="a-reason-confirm" data-v="${esc(r.id)}">Looks right</button>
      <button class="btn" data-action="a-reason-cancel" data-v="${esc(r.id)}">Discard</button></div>
    </div>` : ''}
  </div></details>`;
}
