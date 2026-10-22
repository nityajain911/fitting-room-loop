// Screen 2 — associate (fitting-room runner / floor associate).
import {
  S, hooks, handlers, api, act, esc, now, toast, timerHtml, fmtDur, issueLabel, outcomeLabel, itemName,
  methodLabel, reasonLabel, roleLabel, issuesText, openAttr, sections, STAGE_TEXT, ringHtml, rackPill,
  pairedId, setPaired, rosterOn, me,
} from './core.js';
import { tripItemName } from '/shared/visuals.js';
import { skillLabel } from '/shared/skills.js';
import { accessFor } from '/shared/staffing.js';
import { suggestionItemIds, optionFor, choiceSummary } from '/shared/fitMatch.js';
import { buildQueue, buildAssistQueue, recentlyClosed } from '/shared/routing.js';
import { isOpen, ownerRole, STAGE_LABEL, effectiveCatalogue } from '/shared/derive.js';
import { mergeIssue } from '/shared/fitMatch.js';
import { CATALOGUE, getSku, skuLabel, MEASURE_LABELS } from '/shared/catalogue.js';
import { carryoverFor } from '/shared/carryover.js';
import { STYLE_AXES, STYLE_AXIS_LABELS, styleKind, ISSUES, FIT_ISSUES, CHIPS_BY_KIND, toggleIssue } from '/shared/events.js';
import { RESTOCK_KINDS, SAVE_OUTCOMES, OUTCOMES, REASON_TAGS, REASON_LABELS, EVIDENCE_TYPES, QUICK_REASONS } from '/shared/events.js';

const drafts = {}; // requestId -> { fields, method, original } (AI-structured reason being edited)
const picks = {};  // requestId -> { sig, ids: Set } the items ticked for the trip (default: all suggested items)
let lastRole = 'runner';

/** Who is acting, for the server: the team member this phone joined as (none when there is no roster). */
const withStaff = (body) => (pairedId() ? { ...body, staffId: pairedId() } : body);

const go = (hash) => { location.hash = hash; };
const post = (path, body) => act(() => api('POST', path, body));
const rerender = () => hooks.render();

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
handlers['a-close'] = (el) => post(`/api/requests/${el.dataset.v}/close`, { outcome: el.dataset.outcome, role: lastRole, ...(el.dataset.item ? { itemId: el.dataset.item } : {}) });
handlers['a-left-early'] = (el) => {
  if (!confirm('Close this request as "Left"?')) return null;
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
const issuesNow = (x) => issuesText(x.cur ?? x);
const itemNow = (x) => (x.cur?.skuIds ?? [x.skuId]).map(itemName).join(' + ');
const curSku = (x) => getSku((x.cur?.skuIds ?? [x.skuId])[0]);
const attemptPill = (x) => (x.round > 1 ? `<span class="pill accent">Attempt ${x.round}</span>` : '');
/** The item of the customer's that a brought item was chosen for. */
const baseFor = (r, o, s = r.suggestion) => getSku(s ? optionFor(s, o.id)?.forId : null) || getSku(r.baseOf?.[o.id]) || curSku(r);

/** From the second attempt on, the earlier items are still in the room: remind the runner to swap them. */
const collectBadge = (r) => (r.round > 1 && r.deliveredIds.length && ['accepted', 'on_the_way'].includes(r.status) && r.deliveredTs == null
  ? `<div class="banner info">♻️ Room ${esc(r.room)} may still have ${r.deliveredIds.length} item${r.deliveredIds.length === 1 ? '' : 's'} from earlier attempts. Collect ${r.deliveredIds.length === 1 ? 'it' : 'them'} when you swap, and return ${r.deliveredIds.length === 1 ? 'it' : 'them'} to the rack.</div>` : '');

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
    ${offer.length ? `<h2 style="color:var(--danger)">Escalated — can you assist?</h2>${offer.map(assistCard).join('')}` : ''}
    ${assisting.length ? `<h2>You're assisting</h2>${assisting.map(queueCard).join('')}` : ''}
    ${items.some((x) => x.escalated) ? `<h2 style="color:var(--danger)">Needs you now</h2>${items.filter((x) => x.escalated).map(urgentCard).join('')}` : ''}
    <h1>${esc(roleLabel(role))} queue</h1>
    <p class="muted small">Ordered by request type, then waiting time. Not by spend.</p>
    ${withTeammates ? `<div class="banner info">${withTeammates} ${withTeammates === 1 ? 'request is' : 'requests are'} with teammates first. ${withTeammates === 1 ? 'It opens' : 'They open'} to you if not picked up.</div>` : ''}
    ${items.some((x) => !x.escalated) ? items.filter((x) => !x.escalated).map(queueCard).join('') : (items.length ? '' : '<div class="card muted">No open requests. New ones appear here automatically.</div>')}
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
    return `<div class="card tap qcard ${cls}" data-action="a-open" data-v="${esc(x.id)}">${ringHtml(x)}<div class="qmain">
      <div class="row"><strong>${esc(taskTitle(x))}</strong>${timerHtml(x, 'plain')}</div>
      <div class="small muted">${(x.items || []).length > 1 ? `${x.items.length} items` : esc(itemName(x.itemId))}</div>
      <div class="pills">${x.taskType === 'restock' ? '<span class="pill accent">From the manager</span>' : ''}${(x.items || []).map((i) => rackPill(i.rack)).join('')}${tierPill(x, me())}${escPill(x)}${statusPill(x)}</div></div></div>`;
  }
  const target = x.suggestion?.itemId ? getSku(x.suggestion.itemId) : null;
  return `<div class="card tap qcard ${cls}" data-action="a-open" data-v="${esc(x.id)}">${ringHtml(x)}<div class="qmain">
    <div class="row"><strong>${esc(issuesNow(x))}</strong>${timerHtml(x, 'plain')}</div>
    <div class="small muted">${esc(itemNow(x))}</div>
    <div class="pills">${roomBadge(x)}${attemptPill(x)}${carryover(x) ? '<span class="pill accent">💡 Fit carryover</span>' : ''}${target ? rackPill(target.rack) : ''}${tierPill(x, me())}${escPill(x)}${statusPill(x)}</div></div></div>`;
}

// ---------- floor task ----------
const CANCEL_REASON = {
  handed_over: 'The runner already handed the items to the customer.',
  customer_declined: 'The customer declined these items.',
};
const taskTitle = (x) => (x.taskType === 'restock' ? RESTOCK_KINDS[x.restockKind] || 'Restock' : 'Floor stock pull');
const RESTOCK_HELP = {
  recount: 'Count what is on the rack. If the stock record is wrong, correct it. The manager flagged it because customers found it missing.',
  replenish: 'Top up the rack closest to the fitting rooms with this item from stock. It has been brought to the fitting rooms several times.',
};
const RESTOCK_DONE = { recount: 'Recounted — record corrected', replenish: 'Restocked' };

function restockDetail(t) {
  return `
    <div class="head">${ringHtml(t, 56)}<div><h1>${esc(taskTitle(t))}</h1>${timerHtml(t, 'plain')}</div></div>
    <div class="card stack">
      <div class="optrow"><div class="optmain"><div class="bring-line"><strong>${esc(itemName(t.skuId))}</strong>${rackPill(t.rack)}</div></div></div>
      <div>${esc(RESTOCK_HELP[t.restockKind] || '')}</div>
      <div class="small muted">Sent from the Manager dashboard. No quantity is given: use your judgement on the floor.</div>
      ${statusPill(t)}
      ${t.status === 'requested' ? `<button class="btn primary block" data-action="a-task-accept" data-v="${esc(t.id)}">Accept</button>` : ''}
      ${t.status === 'accepted' ? `<button class="btn primary block" data-action="a-task-done" data-v="${esc(t.id)}">${esc(RESTOCK_DONE[t.restockKind] || 'Done')}</button>` : ''}
    </div>`;
}

function taskDetail(t) {
  if (t.taskType === 'restock') return restockDetail(t);
  return `
    <div class="head">${ringHtml(t, 56)}<div><h1>Floor stock pull</h1>${timerHtml(t, 'plain')}</div></div>
    <div class="card stack">
      ${(t.items || []).map((i) => `<div class="optrow"><div class="optmain"><div class="bring-line"><strong>${esc(itemName(i.itemId))}</strong>${rackPill(i.rack)}</div></div></div>`).join('')}
      <div>Bring ${(t.items || []).length > 1 ? 'all' : 'it'} to Room ${esc(t.room)}</div>
      <div class="small muted">Linked to request ${esc(t.parentId)}</div>
      ${t.escalated ? `<span class="esc-tag">ESCALATED</span> <span class="small muted">${esc(stageText(t))}</span>` : ''}${statusPill(t)}
      ${t.status === 'cancelled' ? `<div class="banner info">${esc(CANCEL_REASON[t.cancelReason] || 'This pull was cancelled.')} Nothing more to do.</div>` : ''}
      ${t.status === 'requested' ? `<button class="btn primary block" data-action="a-task-accept" data-v="${esc(t.id)}">Accept</button>` : ''}
      ${t.status === 'accepted' ? `<button class="btn primary block" data-action="a-task-done" data-v="${esc(t.id)}">Pulled &amp; handed to customer</button>` : ''}
    </div>`;
}

// ---------- request detail ----------
function requestDetail(r, role) {
  return isOpen(r) && r.escalated ? urgentDetail(r, role) : normalDetail(r, role, true);
}

/**
 * Escalated and open: answer one question, "what do I do right now?". A pulsing ring, one line, and the single
 * action for the current step. Everything else is one tap away under "Full details".
 */
function urgentDetail(r, role) {
  const ids = suggestionItemIds(r.suggestion);
  const opts = ids.map((id) => getSku(id)).filter(Boolean);
  const sku = curSku(r);
  const pre = r.status === 'requested';
  const onWay = r.status === 'on_the_way';
  const open = r.status === 'accepted' || onWay;
  const stage3 = open && (onWay || !opts.length || r.suggestionState === 'rejected');
  const trip = onWay ? (r.onTheWay?.items || []).map((i) => getSku(i.itemId)).filter(Boolean) : [];
  let action = '';
  if (pre) {
    action = `<button class="btn primary block xl" data-action="a-accept" data-v="${esc(r.id)}" data-role="${esc(r.assistedBy === role ? role : r.route.role)}">Accept request</button>`;
  } else if (r.itemDeclined) {
    action = `<button class="btn primary block xl" data-action="a-next-best" data-v="${esc(r.id)}" data-cause="customer_declined">Customer declined — show next best</button>`;
  } else if (r.suggestionState === 'shown' && opts.length) {
    action = `<div class="trip-head">Bring${opts.length > 1 ? ` these ${opts.length}` : ''}</div>
      ${opts.map((o) => `<div class="bring-line"><span><strong>${esc(optionName(baseFor(r, o), o))}</strong></span>${rackPill(o.rack)}</div>`).join('')}
      <button class="btn primary block xl" style="margin-top:12px" data-action="a-confirm" data-v="${esc(r.id)}">Confirm &amp; bring${opts.length > 1 ? ` all ${opts.length}` : ''}</button>`;
  } else if (stage3) {
    action = `${trip.length ? `<div class="trip-head">${r.deliveredTs != null ? 'Handed over' : 'On the way'}: ${esc(trip.map((o) => optionName(baseFor(r, o), o)).join(' · '))}</div>` : ''}${onWay ? tripEnd(r) : closeBlock(r)}`;
  }
  return `
    <div class="head">${ringHtml(r, 64)}<div><h1>Room ${esc(r.room)}</h1>${timerHtml(r, 'plain')} <span class="esc-tag">ESCALATED</span></div></div>
    <div class="subhead"><span>${esc(itemNow(r))} · <strong>${esc(issuesNow(r))}</strong></span></div>
    <div class="small muted">${esc(stageText(r))}${r.assistedNow ? ` · ${esc(roleLabel(r.assistedBy))} is assisting` : ''}</div>
    ${collectBadge(r)}
    <div class="urgent-action">${action}</div>
    <details class="sec" data-sec="full:${esc(r.id)}" ${openAttr(`full:${r.id}`, false)}><summary>Full details</summary>${normalDetail(r, role, false)}</details>`;
}

function normalDetail(r, role, withHead) {
  const sku = curSku(r);
  const info = mergeIssue({ sku, issue: r.cur.issue, issues: r.cur.issues, chips: r.cur.chips, styleAxes: r.cur.styleAxes, parsed: r.cur.parsed, parseMethod: r.cur.method });
  const open = r.status === 'accepted' || r.status === 'on_the_way';
  const pre = r.status === 'requested';
  // The card follows the physical step. Step 1 (accepted): locate / confirm the item. Step 2 (on the way): one
  // summary line. Step 3: outcome and reason, once the item is on its way. Outcomes are also open when there is
  // nothing to bring (hemming / no alternative) or the suggestion was rejected, and "customer left early" is
  // always one small tap away.
  const hasItem = !!(r.suggestion && (r.suggestion.itemId || r.suggestion.kind === 'stock_check'));
  const onWay = r.status === 'on_the_way';
  const stage3 = open && (onWay || !hasItem || r.suggestionState === 'rejected');
  // Why it did not convert is only asked once the request has closed without a sale (not for sales or cancellations).
  const showReason = r.status === 'closed' && !SAVE_OUTCOMES.includes(r.outcome);
  return `
    ${withHead ? `<div class="head">${ringHtml(r, 56)}<div><h1>Room ${esc(r.room)}</h1>${timerHtml(r, 'plain')}</div></div>
    <div class="subhead"><span>${esc(itemNow(r))}</span>${attemptPill(r)}${statusPill(r)}</div>` : ''}
    ${withHead ? escBanner(r) : ''}
    ${r.round > 1 && withHead ? `<div class="banner info"><strong>Attempt ${r.round}.</strong> The customer tried what was brought and said ${esc(itemNow(r))} ${r.cur.skuIds.length > 1 ? 'are' : 'is'} still not right (${esc(issuesNow(r))}).${r.cur.reportedBy !== 'customer' ? ` Reported at the door by the ${esc(roleLabel(r.cur.reportedBy).toLowerCase())}.` : ''} Everything already brought, in any colour, is left out of the suggestion.</div>` : ''}
    ${withHead ? collectBadge(r) : ''}
    ${(() => { const c = carryover(r); return c ? `<div class="banner info">💡 <strong>Fit carryover.</strong> ${esc(c.text)} <span class="small muted">A hint from this room visit, not a profile.</span></div>` : ''; })()}
    ${r.itemDeclined ? `<div class="banner alert"><strong>Customer says: not this one.</strong> Don't bring ${esc(itemName(r.itemDeclined.itemId))}. Show the next best below.</div>` : ''}
    ${r.status === 'cancelled' ? `<div class="banner alert"><strong>Cancelled by the customer</strong> ${esc(STAGE_TEXT[r.cancelStage] || '')}. No further action is needed.</div>` : ''}
    ${pre ? `${issueSection(r, info, true)}
      <button class="btn primary block" style="margin-top:12px" data-action="a-accept" data-v="${esc(r.id)}" data-role="${esc(r.assistedBy === role ? role : r.route.role)}">Accept request</button>` : ''}
    ${r.suggestion ? suggestionBlock(r, sku, role, onWay && !r.itemDeclined) : ''}
    ${open ? (stage3 ? (onWay ? tripEnd(r) : closeBlock(r)) : `<div style="text-align:right"><button class="back" data-action="a-left-early" data-v="${esc(r.id)}">Customer left early</button></div>`) : ''}
    ${r.status === 'closed' ? `<div class="banner good">Closed: <strong>${esc(outcomeLabel(r.outcome))}</strong> · ${esc(fmtDur(r.closedTs - r.createdTs))} from request</div>` : ''}
    ${!pre ? (showReason ? reasonBlock(r) : '') + issueSection(r, info, false) : ''}`;
}

/** Structured issue, collapsible. Open while the request waits to be accepted, collapsed afterwards. */
function issueSection(r, info, pre) {
  const key = `issue:${r.id}:${pre ? 'pre' : 'post'}`;
  return `<details class="sec" data-sec="${esc(key)}" ${openAttr(key, pre)}>
    <summary>Structured issue</summary>${issuePanel(r, info)}</details>`;
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

const fmtDelta = (d) => (d == null ? '–' : d > 0 ? `+${d}` : d < 0 ? `−${Math.abs(d)}` : '0');

function rowsFor(sku, alt, s) {
  if (s.diffs?.length) return s.diffs;
  return Object.keys(sku.m).filter((k) => k in alt.m).map((k) => ({
    measure: k, original: sku.m[k], alt: alt.m[k], delta: Math.round((alt.m[k] - sku.m[k]) * 10) / 10, role: 'other',
  }));
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
    const unchanged = (STYLE_AXES[styleKind(sku.category)] || []).filter((a) => !(c.axes || []).includes(a)).map((a) => STYLE_AXIS_LABELS[a].toLowerCase());
    const asked = (c.requested || []).map((a) => STYLE_AXIS_LABELS[a].toLowerCase());
    return `<div class="banner info"><strong>Different style</strong>${asked.length ? ` (customer asked for: ${esc(asked.join(', '))})` : ''}: ${changed || `${esc(c.from)} → ${esc(c.to)}`}.
      ${unchanged.length ? `${esc(cap1(unchanged.join(' and ')))} unchanged.` : ''}
      ${(c.unmet || []).length ? `<br><strong>Could not change ${esc(c.unmet.map((a) => STYLE_AXIS_LABELS[a].toLowerCase()).join(' and '))}</strong> in size ${esc(sku.size)}.` : ''}
      ${c.alsoCut ? `<br>${esc(alt.cut)} cut (no matching design in ${esc(sku.cut)}), so the fit changes.` : `<br>Same size and cut (${esc(sku.size)} ${esc(sku.cut)}), so the fit should stay close.`} Measurements below are for reference.</div>`;
  }
  if (s.kind === 'alternative_style' && s.change?.type === 'cut') {
    return `<div class="banner info"><strong>Same design, other cut.</strong> No other style is in stock in size ${esc(sku.size)}. The ${esc(alt.cut)} cut is the same design and changes how roomy it fits (see the table).</div>`;
  }
  if (s.kind === 'alternative_size') {
    return `<div class="banner info"><strong>Different size:</strong> ${esc(sku.size)} → ${esc(alt.size)}, same style and cut.</div>`;
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
  return `<table class="cmp"><thead><tr><th>cm</th><th>Now</th>${opts.map((o) => `<th>${esc(`${o.size} ${o.cut}`)}${o.colour !== sku.colour ? `<br><span class="muted" style="font-weight:400">${esc(o.colour)}</span>` : ''}</th>`).join('')}</tr></thead><tbody>
    ${keys.map((k) => `<tr class="${roles[k] === 'primary' || roles[k] === 'secondary' ? 'hl' : ''}"><td>${esc(MEASURE_LABELS[k] || k)}${roles[k] === 'primary' ? '<span class="tag">MAIN</span>' : roles[k] === 'secondary' ? '<span class="tag">ALSO</span>' : ''}</td>
      <td>${sku.m[k]}</td>${opts.map((o) => `<td>${o.m[k] ?? '–'}</td>`).join('')}</tr>`).join('')}
  </tbody></table>
  <div class="small muted" style="margin-top:4px">Every measurement is shown. Highlighted rows are what the fix targets, and the others change too.</div>`;
}

function suggestionBlock(r, sku, role, compact = false) {
  const s = r.suggestion;
  const ids = suggestionItemIds(s);
  const opts = ids.map((id) => getSku(id)).filter(Boolean);
  const hasItem = opts.length > 0;
  const isOpenReq = r.status === 'accepted' || r.status === 'on_the_way';
  const canAct = r.suggestionState === 'shown' && hasItem && !r.itemDeclined;
  const sel = hasItem ? selection(r) : new Set();
  let body = '';

  if (hasItem) {
    if (opts.length === 1) body += changeBanner(s, baseFor(r, opts[0], s) || sku, opts[0]);
    for (const n of (s.perBaseline || []).filter((x) => (s.baselines || []).length > 1 && !['alternative', 'alternative_size', 'alternative_style', 'stock_check'].includes(x.kind))) {
      body += `<div class="banner info"><strong>${esc(itemName(n.forId))}:</strong> ${esc(n.reason)}</div>`; // a picked item with nothing in stock
    }
    body += `<div class="trip-head">${opts.length > 1 ? `Bring these ${opts.length} in one trip` : 'Bring'}</div>`;
    body += opts.map((o) => {
      const why = choiceSummary(optionFor(s, o.id));
      return `<div class="optrow ${canAct && !sel.has(o.id) ? 'off' : ''}">
        ${canAct ? `<input type="checkbox" class="optbox" aria-label="Bring ${esc(optionName(baseFor(r, o, s) || sku, o))}" data-action="a-toggle" data-id="${esc(r.id)}" data-v="${esc(o.id)}" ${sel.has(o.id) ? 'checked' : ''}>` : ''}
        <div class="optmain"><div class="bring-line"><span><strong>${esc(optionName(baseFor(r, o, s) || sku, o))}</strong></span>${rackPill(o.rack, `${stockNow(o.id)} left`)}</div>
          <div class="small muted">${esc(skuLabel(o))}${reported(o.id) ? ` · ${onRecord(o.id)} on record, ${reported(o.id)} reported missing` : ''}</div>
          ${why && opts.length > 1 ? `<div class="small">${esc(cap1(why))}</div>` : ''}</div>
        ${isOpenReq && !r.itemDeclined && ['shown', 'confirmed'].includes(r.suggestionState) ? `<button class="btn small-btn" data-action="a-next-best" data-v="${esc(r.id)}" data-cause="not_on_rack" data-item="${esc(o.id)}">Not on rack</button>` : ''}
      </div>`;
    }).join('');
    if (opts.length > 1 && s.kind === 'alternative_style') {
      body += '<div class="small muted">Each is a different design in your size. See the notes above for what differs.</div>';
    }
    body += comparisons(r, s, opts, sku);
    if (s.reason && opts.length === 1) body += `<p>${esc(s.reason)}</p>`;
  } else {
    body += `<div class="banner ${s.kind === 'alteration_or_crossstore' ? 'info' : 'alert'}"><strong>${esc(s.reason)}</strong></div>`;
    if (s.drivers?.length) {
      body += `<div class="small muted">Checked: ${s.drivers.map((d) => `${esc(MEASURE_LABELS[d.measure] || d.measure)} ${d.original} cm`).join(', ')} — no in-stock item improves it.</div>`;
    }
  }

  // Items already ruled out for this request, struck through, so a rushed associate sees what changed.
  const struck = [
    ...r.discrepancies.map((d) => `<span class="chip struck">❌ <s>${esc(itemName(d.skuId))}</s> <span>(Rack ${esc(d.rack)} — marked empty)</span></span>`),
    ...r.declinedIds.map((id) => `<span class="chip struck">❌ <s>${esc(itemName(id))}</s> <span>(declined by the customer)</span></span>`),
  ];
  // "Fallback #n": how many items were reported missing on the rack or declined before this suggestion (not what was merely tried).
  const fallbackN = new Set([...r.discrepancies.map((d) => d.skuId), ...r.declinedIds]).size + 1;
  const isFallback = fallbackN > 1;
  const fallbackHead = isFallback
    ? `<div class="fallback-head">Fallback #${fallbackN}: ${hasItem ? `<strong>${esc(opts.map((o) => optionName(baseFor(r, o, s) || sku, o)).join(' · '))}</strong> ${rackPill(opts[0].rack, `${stockNow(opts[0].id)} left`)}` : 'no in-stock alternative'}</div>` : '';
  const struckHtml = struck.length ? `<div class="chips-struck">${struck.join('')}</div>` : '';

  const tripItems = r.onTheWay?.items?.map((i) => i.itemId) || [];
  const pulls = r.floorTaskIds.map((id) => S.derived.byId[id]).filter(Boolean);
  // Offered once the items are confirmed (before that, "Confirm & ask floor to pull" does both in one tap), and
  // only while no pull is live or done; cancelling a pull offers it again.
  const showPull = role === 'runner' && isOpenReq && tripItems.length && r.deliveredTs == null && !pulls.some((t) => ['requested', 'accepted', 'done'].includes(t.status));
  const pullBtn = showPull ? `<button class="btn block" style="margin-top:10px" data-action="a-pull" data-v="${esc(r.id)}">Request floor stock pull${tripItems.length > 1 ? ` for all ${tripItems.length}` : ''}</button>` : '';
  const tasks = pulls
    .map((t) => `<div class="row small" style="margin-top:8px"><span>Floor pull: ${(t.items || []).map((i) => rackPill(i.rack)).join(' ')}</span><span>${statusPill(t)}${['requested', 'accepted'].includes(t.status) && role === 'runner' ? ` <button class="link-btn" data-action="a-pull-cancel" data-v="${esc(t.id)}">Cancel pull</button>` : ''}</span></div>`).join('');

  // Step 2: the trip is on its way. One summary; the table stays one tap away.
  if (compact) {
    const trip = (r.onTheWay?.items || []).map((i) => getSku(i.itemId)).filter(Boolean);
    const key = `sugg:${r.id}`;
    return `<h2>On the way</h2><div class="card ${isFallback ? 'fallback-card' : ''}">
      ${fallbackHead}
      <div class="trip-head">Bringing ${trip.length > 1 ? `${trip.length} items` : 'this item'} to Room ${esc(r.room)}</div>
      ${trip.map((o) => `<div class="optrow"><div class="optmain"><div class="bring-line"><span><strong>${esc(optionName(baseFor(r, o, s) || sku, o))}</strong></span>${rackPill(o.rack)}</div>
        <div class="small muted">${esc(skuLabel(o))}</div></div>
        <button class="btn small-btn" data-action="a-next-best" data-v="${esc(r.id)}" data-cause="not_on_rack" data-item="${esc(o.id)}">Not on rack</button></div>`).join('')}
      ${struckHtml}
      <details class="sec" data-sec="${esc(key)}" ${openAttr(key, false)}><summary>All measurements</summary>${trip.length ? comparisons(r, s, trip, sku) : ''}</details>
      ${pullBtn}${tasks}
    </div>`;
  }

  // Step 1 (and the cases where nothing can be brought): the suggestion with its actions.
  let actions = '';
  if (r.itemDeclined) {
    actions = `<button class="btn primary block" style="margin-top:12px" data-action="a-next-best" data-v="${esc(r.id)}" data-cause="customer_declined">Customer declined — show next best</button>`;
  } else if (canAct) {
    actions = `<div class="stack" style="margin-top:12px">
      <button class="btn primary block" data-action="a-confirm" data-v="${esc(r.id)}" ${sel.size ? '' : 'disabled'}>Confirm &amp; bring ${sel.size === opts.length && opts.length > 1 ? 'all ' : ''}${sel.size}</button>
      ${role === 'runner' ? `<button class="btn block" data-action="a-confirm" data-pull="1" data-v="${esc(r.id)}" ${sel.size ? '' : 'disabled'}>Confirm &amp; ask floor to pull</button>` : ''}
      <button class="btn danger block" data-action="a-reject" data-v="${esc(r.id)}">Reject</button></div>`;
  } else if (r.suggestionState === 'rejected') {
    actions = '<div class="banner alert" style="margin-top:10px">Suggestion rejected (recorded)</div>';
  }
  return `<h2>Suggestion</h2><div class="card ${isFallback ? 'fallback-card' : ''}">
      <p class="label-note"><strong>Suggestion — associate confirms fit with customer</strong></p>
      ${fallbackHead}${struckHtml}${body}${actions}
      ${pullBtn}${tasks}
    </div>`;
}

/**
 * Once the items are confirmed: hand them over (that stops the delivery timer and starts the customer's try-on), and
 * only then the outcome. The customer's own word on the fit is shown, but the staff still close the request.
 */
function tripEnd(r) {
  if (r.deliveredTs == null) {
    const livePull = r.floorTaskIds.map((id) => S.derived.byId[id]).some((t) => t && ['requested', 'accepted'].includes(t.status));
    return `<button class="btn primary block xl" style="margin-top:12px" data-action="a-deliver" data-v="${esc(r.id)}">Handed to customer</button>
      <div class="small muted" style="margin-top:6px">Stops the delivery timer. The customer tries it on and tells us how it fits.${livePull ? ' A floor pull is in progress: whoever hands the items over first completes it for both of you.' : ''}</div>
      <div style="text-align:right"><button class="back" data-action="a-left-early" data-v="${esc(r.id)}">Customer left early</button></div>`;
  }
  const by = r.deliveredBy ? `<div class="small muted" style="margin-top:8px">Handed to the customer by the ${esc(roleLabel(r.deliveredBy).toLowerCase())}.</div>` : '';
  const say = !r.tryOn ? `${by}<div class="small muted">Customer is trying it on…</div>`
    : r.tryOn.result === 'no_more' ? `${by}<div class="banner info"><strong>Customer says they are all set 👋</strong> No more sizes needed. Close it with the outcome.</div>`
    : r.tryOn.result === 'fits' ? `${by}<div class="banner good"><strong>Customer says it fits 👍</strong> Close it when they decide.</div>`
      : `${by}<div class="banner info"><strong>Customer says it is still not right 🔄</strong> A follow-up request will come from the room.</div>`;
  return `${say}${doorBlock(r)}${closeBlock(r)}`;
}

/** "Customer asked for another size": which item came closest and what was off, entered by the runner at the door. */
function doorBlock(r) {
  const d = doorOf(r.id);
  const items = (r.onTheWay?.items || []).map((i) => i.itemId).filter((id) => getSku(id));
  if (!items.length) return '';
  if (!d.open) return `<button class="btn block" style="margin-top:10px" data-action="a-door-open" data-v="${esc(r.id)}">🔄 Customer asked for another size</button>`;
  const name = (id) => { const b = getSku(r.baseOf?.[id]) || getSku(r.skuId); return b ? tripItemName(b, getSku(id)) : itemName(id); };
  const kind = styleKind(getSku(d.item || items[0]).category);
  const optBtn = (action, v, label, on) => `<button type="button" class="opt ${on ? 'on' : ''}" data-action="${action}" data-id="${esc(r.id)}" data-v="${esc(v)}" aria-pressed="${on}">${esc(label)}</button>`;
  const chips = FIT_ISSUES.some((k) => d.issues.includes(k)) ? `<div class="small muted" style="margin-top:8px">Where? (optional)</div><div class="opts">${CHIPS_BY_KIND[kind === 'trousers' ? 'trousers' : 'top'].map((c) => optBtn('a-door-chip', c, c.charAt(0).toUpperCase() + c.slice(1), d.chips.has(c))).join('')}</div>` : '';
  return `<div class="card stack" style="margin-top:10px">
    <strong>Which item came closest?</strong>
    <div class="opts">${items.map((id) => optBtn('a-door-item', id, name(id), d.item === id)).join('')}</div>
    ${d.item ? `<strong>What was still off?</strong><div class="opts">${Object.entries(ISSUES).map(([k, v]) => optBtn('a-door-issue', k, v, d.issues.includes(k))).join('')}</div>${chips}` : ''}
    <button class="btn primary block" data-action="a-door-send" data-v="${esc(r.id)}" ${d.item && d.issues.length ? '' : 'disabled'}>Open the next attempt</button>
    <button class="link-btn" data-action="a-door-open" data-v="${esc(r.id)}">Cancel</button>
  </div>`;
}

function closeBlock(r) {
  // When more than one item could be the one kept (everything brought and not reported, from any attempt), "bought alternative"
  // names it: one tap each. That is also what lets the next request from the same room use what this customer's fit turned out to be.
  const kept = r.keepable.filter((id) => getSku(id));
  const label = (id) => { const b = getSku(r.baseOf?.[id]) || getSku(r.skuId); return b ? tripItemName(b, getSku(id)) : itemName(id); };
  const buttons = Object.entries(OUTCOMES).flatMap(([k, v]) => (k === 'bought_alternative' && kept.length > 1
    ? kept.map((id) => `<button class="btn" data-action="a-close" data-v="${esc(r.id)}" data-outcome="${k}" data-item="${esc(id)}">Bought ${esc(label(id))}</button>`)
    : [`<button class="btn" data-action="a-close" data-v="${esc(r.id)}" data-outcome="${k}">${esc(v)}</button>`]));
  return `<h2>Outcome</h2><div class="btn-grid">${buttons.join('')}</div>`;
}

/** What an earlier purchase in the same room visit suggests for this request (a hint, never a decision). */
const carryover = (r) => (r.kind === 'request' && r.round === 1 && ['requested', 'accepted'].includes(r.status)
  ? carryoverFor(r, S.derived, effectiveCatalogue(CATALOGUE, S.derived.discrepancies), S.config || {}) : null);

function reasonBlock(r) {
  const d = drafts[r.id];
  const last = r.reasons[r.reasons.length - 1];
  const aiMode = S.parser?.mode === 'ai';
  const rkey = `reason:${r.id}`;
  return `<details class="sec" data-sec="${esc(rkey)}" ${openAttr(rkey, true)}><summary>Why didn't it convert? (optional)</summary><div class="card stack">
    ${(!last && r.status === 'closed' && ['left', 'saved_for_later'].includes(r.outcome) && r.discrepancies.length) ? `<div class="banner info">
      An item was reported missing on the rack for this request.
      <button class="btn block" style="margin-top:8px" data-action="a-reason-system" data-v="${esc(r.id)}">Record reason: stock record wrong (system-observed)</button></div>` : ''}
    ${last ? `<div class="banner good">Recorded: <strong>${esc(reasonLabel(last.reason_tag))}</strong> · ${esc(last.evidence_type)}<br>
      <span class="small">“${esc(last.summary_en)}” · ${esc(methodLabel(last.method))}${last.edited ? ' · edited by associate' : ''}</span></div>` : ''}
    <div class="small muted">One tap</div>
    <div class="opts">${QUICK_REASONS.map((q) => `<button class="opt ${last?.method === 'quick_pick' && last.reason_tag === q.tag ? 'on' : ''}" data-action="a-quick-reason" data-v="${esc(r.id)}" data-key="${q.key}">${esc(q.label)}</button>`).join('')}</div>
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
