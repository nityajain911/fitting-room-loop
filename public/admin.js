// Admin — the material that is not for the store manager: prototype settings, demo controls, detailed
// metrics, parser statistics, the raw event log, and clearing demo data. Reached from the header link (#admin).
import { S, hooks, handlers, api, act, toast, esc, fmtDur, fmtClock, pct, describeEvent, issueLabel, itemName } from './core.js';
import { computeMetrics } from '/shared/metrics.js';
import { SKILLS } from '/shared/skills.js';
import { FITTING_ROOMS } from '/shared/events.js';
import { loadOf } from '/shared/staffing.js';
import { DEFAULTS } from '/shared/config.js';
import { plainDuration, timingTimeline } from '/shared/timing.js';

const view = { filter: 'all', room: null }; // timeline filter: all | escalated | room

handlers['m-clear'] = async () => {
  if (!confirm('Clear all demo data? This removes every event for everyone.')) return;
  view.filter = 'all'; view.room = null;
  await act(() => api('POST', '/api/reset'));
};
handlers['m-save-esc'] = async () => {
  const num = (id) => Number(document.getElementById(id).value);
  const out = await act(() => api('POST', '/api/settings', {
    acceptEscalateSeconds: num('esc-accept'), deliverEscalateSeconds: num('esc-deliver'),
    primaryWaitSeconds: num('wait-primary'), secondaryWaitSeconds: num('wait-secondary'), roomSessionMinutes: num('room-session'),
  }));
  if (out) toast('Times saved');
};
handlers['m-staff-add'] = async () => {
  const label = document.getElementById('staff-label').value.trim();
  const type = document.getElementById('staff-type').value;
  if (!label) return toast('Give the person a label, for example "Runner 1"');
  const out = await act(() => api('POST', '/api/staff', { label, type }));
  if (out) document.getElementById('staff-label').value = '';
  return out;
};
handlers['m-staff-seed'] = () => act(() => api('POST', '/api/staff/seed'));
handlers['m-staff-sec'] = (el) => {
  // none -> primary -> backup (secondary) -> none
  const person = S.roster.find((x) => x.id === el.dataset.id);
  if (!person) return null;
  const k = el.dataset.k;
  const primary = person.primary.filter((x) => x !== k);
  const secondary = person.secondary.filter((x) => x !== k);
  if (!person.primary.includes(k) && !person.secondary.includes(k)) primary.push(k);
  else if (person.primary.includes(k)) secondary.push(k);
  return act(() => api('POST', `/api/staff/${person.id}`, { primary, secondary }));
};
handlers['m-staff-shift'] = (el) => {
  const person = S.roster.find((x) => x.id === el.dataset.id);
  return person ? act(() => api('POST', `/api/staff/${person.id}`, { onShift: !person.onShift })) : null;
};
handlers['m-staff-del'] = (el) => {
  const person = S.roster.find((x) => x.id === el.dataset.id);
  if (!person || !confirm(`Remove ${person.label}?`)) return null;
  return act(() => api('DELETE', `/api/staff/${person.id}`));
};
handlers['m-demo'] = (el) => act(() => api('POST', '/api/demo', { [el.dataset.k]: !S.demo[el.dataset.k] }));
handlers['m-filter'] = (el) => {
  view.filter = el.dataset.v;
  view.room = el.dataset.room ? Number(el.dataset.room) : null;
  hooks.render();
};

const TABS = [['team', 'Team'], ['timing', 'Timing'], ['devices', 'Devices'], ['data', 'Data'], ['demo', 'Demo']];
const TAB_KEY = 'frl.admintab';
let tab = (() => { try { return localStorage.getItem(TAB_KEY) || 'team'; } catch { return 'team'; } })();
handlers['m-tab'] = (el) => {
  tab = el.dataset.v;
  try { localStorage.setItem(TAB_KEY, tab); } catch { /* private mode */ }
  hooks.render();
};

/** One section at a time. The rest of the admin's work is a tap away, not a scroll away. */
export function render() {
  const tabs = TABS.filter(([k]) => k !== 'demo' || S.demo.enabled);
  if (!tabs.some(([k]) => k === tab)) tab = 'team';
  const body = { team: teamSection, timing: timingTab, devices: tabletLinks, data: dataTab, demo: demoControls }[tab];
  return `
    <a class="link" href="#manager">‹ Manager dashboard</a>
    <h1>Admin</h1>
    <div class="seg" role="tablist">${tabs.map(([k, l]) => `<button type="button" role="tab" class="${tab === k ? 'on' : ''}" aria-selected="${tab === k}" data-action="m-tab" data-v="${k}">${l}</button>`).join('')}</div>
    ${body()}`;
}

/** Prototype settings the admin cannot change here, read-only. */
function settingsNote(c) {
  return `<h2>Matching rules</h2>
    <div class="settings">
      price band ±${c?.maxPriceDelta != null ? `₹${c.maxPriceDelta.toLocaleString('en-IN')}` : '–'} (a design further away in price is offered only when nothing nearer is in stock) · closeness limits (a bigger change is not offered): tops chest ${c?.fitLimits?.top.chest ?? '–'} · waist ${c?.fitLimits?.top.waist ?? '–'} · length ${c?.fitLimits?.top.length ?? '–'} cm, trousers waist ${c?.fitLimits?.trousers.waist ?? '–'} · inseam ${c?.fitLimits?.trousers.inseam ?? '–'} cm, at most ${c?.maxSizeSteps ?? '–'} sizes away ·
      alteration offered: ${c ? (c.alterationOffered ? 'yes' : 'no') : '–'} · min improvement ${c?.minImprovementCm ?? '–'} cm ·
      small sample below n=${c?.smallSampleN ?? '–'} ·
      signals need ≥${c?.signalMinN ?? '–'} requests and ≥${c ? Math.round(c.signalMinShare * 100) : '–'}% share, rack recount after ${c?.signalMinMisses ?? '–'}+ report, high demand at ${c?.signalMinPulls ?? '–'}+ replacements · bring up to ${c?.bringCount ?? '–'} items per trip ·
      parser: ${parserText()}${S.demo.fastTimers ? ' · <strong>⚡ fast timers ON</strong>' : ''}
    </div>`;
}

function timingTab() {
  return `${escalationTimes(S.saved ? { ...S.config, ...S.saved } : S.config)}${settingsNote(S.config)}`; // the form shows what is saved, not fast-timer values
}

/** Numbers behind the dashboard, the raw event log, and clearing the demo data. */
function dataTab() {
  const m = computeMetrics(S.events, undefined, S.config || undefined);
  const c = S.config;
  const decided = m.confirmed + m.rejected;
  return `
    <div class="row"><h2>Detailed metrics</h2><button class="btn danger" data-action="m-clear">Clear demo data</button></div>
    <div class="card stack small">
      <div class="row"><span>Suggestion acceptance</span><strong>${pct(m.suggestionAcceptance)} (${m.confirmed} of ${decided} decided)</strong></div>
      <div class="row"><span>Reported not on rack</span><strong>${m.inventoryDiscrepancies.total} (${m.inventoryDiscrepancies.bySku.length} SKUs)</strong></div>
      <div class="row"><span>Items declined at the door</span><strong>${m.itemsDeclined}</strong></div>
      <div class="row"><span>Escalations / assisted / median time to assist</span><strong>${m.escalations + m.floorTaskEscalations} / ${m.assists} / ${fmtDur(m.medianAssistMs)}</strong></div>
      <div class="row"><span>Cancelled (before accept / after accept / on the way)</span><strong>${m.cancelled} (${m.cancelledByStage.requested} / ${m.cancelledByStage.accepted} / ${m.cancelledByStage.on_the_way})</strong></div>
      <div class="row"><span>Median to hand over (accept → handed to customer)</span><strong>${fmtDur(m.medianDeliverMs)}</strong></div>
      <div class="row"><span>Handed to the customer by the runner / the floor associate</span><strong>${m.deliveredBy.runner} / ${m.deliveredBy.floor}</strong></div>
      <div class="row"><span>Median to set off (accept → on the way)</span><strong>${fmtDur(m.medianDispatchMs)}</strong></div>
      <div class="row"><span>Median try-on (handed over → closed)</span><strong>${fmtDur(m.medianTryOnMs)}</strong></div>
      <div class="row"><span>Customers said: fits / still not right / all set / none close</span><strong>${m.tryOn.fits} / ${m.tryOn.notRight} / ${m.tryOn.done} / ${m.tryOn.noneClose}</strong></div>
      <div class="row"><span>Closed as a purchase after a try-on (recorded by staff)</span><strong>${m.boughtAfterTryOn}</strong></div>
      <div class="row"><span>Second attempts and later: median to accept / to hand over (n)</span><strong>${fmtDur(m.laterAttempts.medianAcceptMs)} / ${fmtDur(m.laterAttempts.medianDeliverMs)} (${m.laterAttempts.n})</strong></div>
      <div class="row"><span>Requests that needed another attempt / of those, saved</span><strong>${m.retried} / ${m.savedAfterRetry}</strong></div>
      <div class="row"><span>Requests where nothing in stock fitted (the engine said no, or the associate did)</span><strong>${m.noMatchRequests}</strong></div>
      <div class="row"><span>Attempts in total</span><strong>${m.rounds}</strong></div>
      <div class="row"><span>Restock tasks from the Manager: done / sent</span><strong>${m.restock.done} / ${m.restock.requested}</strong></div>
      <div class="row"><span>Floor pulls done / requested</span><strong>${m.floorPullsDone} / ${m.floorPullsRequested}</strong></div>
      <div class="row"><span>Deferred (saved for later)</span><strong>${pct(m.deferredRate)} (${m.deferred} of ${m.closed} closed)</strong></div>
      <div class="row"><span>Parsing so far</span><strong>${m.parseMethods.ai} AI · ${m.parseMethods.fallback} rule-based · ${m.parseMethods.none} no free text</strong></div>
    </div>

    <h2>Who took requests</h2>
    ${routingTable(m)}

    <h2>By garment, size &amp; cut</h2>
    ${skuBreakdown(m, c)}

    ${timeline()}`;
}

const parserText = () => {
  const mode = S.parser?.mode;
  if (mode === 'ai') return `AI (${esc(S.parser.model)})`;
  if (mode === 'forced_fallback') return '<strong>rule-based fallback — FORCED OFF (demo control)</strong>';
  return 'rule-based fallback (no API key)';
};

/**
 * The times that move a request along, in plain words: when the backup is asked, when everyone is, and when the manager
 * is told. Each number shows what it comes to ("= 2 minutes"), and the strip above them shows the whole sequence.
 */
const timelineHtml = (cfg) => `<ol class="tl-strip" id="tl-strip">${timingTimeline(cfg).map((st) => `<li><b>${st.at === 0 ? 'At once' : esc(plainDuration(st.at))}</b><span>${esc(st.what)}</span></li>`).join('')}</ol>`;
const readValues = () => {
  const num = (id) => Number(document.getElementById(id)?.value);
  return { primaryWaitSeconds: num('wait-primary'), secondaryWaitSeconds: num('wait-secondary'), acceptEscalateSeconds: num('esc-accept'), deliverEscalateSeconds: num('esc-deliver') };
};
// Typing in a time updates its plain-words readout and the strip straight away.
document.addEventListener('input', (e) => {
  if (!e.target.matches?.('.esc-input input[data-unit]')) return;
  const v = Number(e.target.value);
  const out = e.target.closest('.esc-row')?.querySelector('.plain');
  if (out) out.textContent = Number.isFinite(v) && v > 0 ? `= ${e.target.dataset.unit === 'min' ? plainDuration(v * 60) : plainDuration(v)}` : '';
  const vals = readValues();
  const strip = document.getElementById('tl-strip');
  if (strip && Object.values(vals).every((n) => n > 0)) strip.outerHTML = timelineHtml(vals);
});

function escalationTimes(c) {
  const cfg = c || DEFAULTS;
  const row = (id, label, value, unit = 's', min = 5, max = 3600) => `<label class="esc-row"><span><strong>${label}</strong></span>
      <span class="esc-input"><input type="number" id="${id}" data-keep="${id}" data-unit="${unit === 's' ? 's' : 'min'}" min="${min}" max="${max}" step="1" inputmode="numeric" value="${value}"> ${unit}
      <span class="plain muted small">= ${esc(unit === 'min' ? plainDuration(value * 60) : plainDuration(value))}</span></span></label>`;
  return `<h2>When nobody picks up a request</h2>
    <div class="card stack">
      ${timelineHtml(cfg)}
      ${row('wait-primary', 'Ask the backup person after', cfg.primaryWaitSeconds)}
      ${row('wait-secondary', 'Ask everyone after another', cfg.secondaryWaitSeconds)}
      ${row('esc-accept', 'Alert the manager if not accepted within', cfg.acceptEscalateSeconds, 's', 10)}
      ${row('esc-deliver', 'Alert the manager if not on its way within', cfg.deliverEscalateSeconds, 's', 10)}
      ${row('room-session', 'Free an empty room after', cfg.roomSessionMinutes ?? 30, 'min', 1, 240)}
      ${S.demo.fastTimers ? '<div class="small"><strong>Fast timers are on and override these for now.</strong></div>' : ''}
      <button class="btn primary" data-action="m-save-esc">Save</button>
    </div>`;
}

const STATE_OF = (p, k) => (p.primary.includes(k) ? 'primary' : p.secondary.includes(k) ? 'secondary' : 'none');

/** One link per device. Opened once, a device stays locked to its role (and, for a tablet, its room). */
function tabletLinks() {
  const link = (label, hash) => `<div class="row small"><span>${label}</span><a class="link" href="${hash}" style="user-select:all">${esc(`${location.origin}/${hash}`)}</a></div>`;
  return `<h2>Devices</h2><div class="card stack">
    <div class="small muted">Open once on each device. It stays locked.</div>
    ${FITTING_ROOMS.map((n) => link(`Room ${n} tablet`, `#customer?room=${n}&mode=customer`)).join('')}
    ${link('Runner / floor phone', '#associate?mode=staff')}
    ${link('Manager', '#manager?mode=manager')}
    ${link('Unlock a device', '#customer?mode=demo')}
  </div>`;
}

/** The roster. The admin gives each person a role and primary / backup sections; phones join with the code. */
function teamSection() {
  const staff = S.roster;
  const card = (p) => `<div class="card stack staff">
      <div class="row"><strong>${esc(p.label)}</strong>
        <span><span class="pill">${esc(p.type === 'runner' ? 'Runner' : 'Floor')}</span> <span class="pill ${p.active ? 'ok' : ''}">${p.active ? 'phone on' : 'phone off'}</span></span></div>
      <div class="small muted">${p.code ? `Join code <strong class="code">${esc(p.code)}</strong> · ` : ''}${loadOf(S.derived, p.id)} open now</div>
      <div class="opts">${SKILLS.map((k) => { const st = STATE_OF(p, k.key); return `<button type="button" class="opt ${st === 'primary' ? 'on' : st === 'secondary' ? 'sec' : ''}" data-action="m-staff-sec" data-id="${esc(p.id)}" data-k="${k.key}" aria-label="${esc(k.label)}: ${st}">${esc(k.label)}${st === 'primary' ? ' · primary' : st === 'secondary' ? ' · backup' : ''}</button>`; }).join('')}</div>
      <div class="row"><button class="opt ${p.onShift ? 'on' : ''}" data-action="m-staff-shift" data-id="${esc(p.id)}" aria-pressed="${p.onShift}">${p.onShift ? 'On shift' : 'Off shift'}</button>
        <button class="link-btn danger" data-action="m-staff-del" data-id="${esc(p.id)}">Remove</button></div>
    </div>`;
  return `<h2>Team and sections</h2>
    <p class="muted small">Primary gets a request first; backup is added after the wait. Whoever accepts first serves it. With no team, everyone sees everything.</p>
    ${staff.length ? staff.map(card).join('') : '<div class="card muted">No team yet. Add people below, or start from a sample team.</div>'}
    <div class="card stack">
      <div class="small muted">Tap a section: primary, backup, none.</div>
      <input type="text" id="staff-label" data-keep="staff-label" maxlength="30" placeholder="Label, e.g. Runner 1" aria-label="Label">
      <select id="staff-type" data-keep="staff-type" aria-label="Type"><option value="runner">Fitting-room runner</option><option value="floor">Floor associate</option></select>
      <div class="row"><button class="btn primary" data-action="m-staff-add">Add person</button>
        ${staff.length ? '' : '<button class="btn" data-action="m-staff-seed">Add a sample team</button>'}</div>
    </div>`;
}

/** Presenter switches. Settings only, never the event log; they affect every phone. */
function demoControls() {
  if (!S.demo.enabled) return '';
  const row = (k, title, detail) => `<div class="switch-row">
      <div><strong>${title}</strong><div class="small muted">${detail}</div></div>
      <button class="opt ${S.demo[k] ? 'on' : ''}" data-action="m-demo" data-k="${k}" aria-pressed="${S.demo[k]}">${S.demo[k] ? 'ON' : 'OFF'}</button></div>`;
  const until = S.demo.fastTimersUntil ? ` Switches off automatically at ${esc(fmtClock(S.demo.fastTimersUntil))}.` : '';
  return `<h2>Demo controls</h2><div class="card"><span class="small muted">Affect every phone. Settings only: the event log is never edited.</span>
    ${row('forceFallback', 'Force rule-based fallback', 'Simulates an AI outage or rate limit: new requests are parsed by rules and labelled "Rule-based fallback — not AI".')}
    ${row('fastTimers', 'Fast timers (5 min)', `Warn at 10 s, escalate at 20 s in both stages so amber, red and the assist flow show on demand. Normal values return by themselves.${until}`)}
  </div>`;
}

// Left-border colour by who acted: customer blue, associates green, system amber, escalations red.
const tone = (e) => (e.type === 'escalated' ? 'red' : e.type === 'inventory_discrepancy' ? 'amber'
  : e.actor === 'customer' ? 'blue' : e.actor === 'system' ? 'amber' : 'green');

function timeline() {
  const d = S.derived;
  const rooms = [...new Set(d.requests.map((r) => r.room))].sort((a, b) => a - b);
  const escIds = new Set([...d.requests, ...d.tasks].filter((x) => x.escalations.length).map((x) => x.id));
  const keep = (e) => (view.filter === 'escalated' ? escIds.has(e.requestId)
    : view.filter === 'room' ? d.byId[e.requestId]?.room === view.room : true);
  const filtered = S.events.filter(keep);
  const latest = [...filtered].reverse().slice(0, 40);
  const chip = (label, on, v, room = '') =>
    `<button class="opt ${on ? 'on' : ''}" data-action="m-filter" data-v="${v}" data-room="${room}" aria-pressed="${on}">${esc(label)}</button>`;
  return `<h2>Event log (showing ${latest.length} of ${filtered.length}${filtered.length !== S.events.length ? `, ${S.events.length} total` : ''})</h2>
    <div class="filters">
      ${chip('All', view.filter === 'all', 'all')}
      ${chip(`Escalated only (${escIds.size})`, view.filter === 'escalated', 'escalated')}
      ${rooms.map((r) => chip(`Room ${r}`, view.filter === 'room' && view.room === r, 'room', r)).join('')}
    </div>
    <div class="legend"><span class="dot-k blue"></span>Customer <span class="dot-k green"></span>Associate <span class="dot-k amber"></span>System / stock <span class="dot-k red"></span>Escalation</div>
    <div class="card"><ul class="timeline">${latest.length ? latest.map((e) => `
      <li class="tone-${tone(e)}"><span class="t">${esc(fmtClock(e.ts))}</span><span>${esc(describeEvent(e))}<br><span class="rid">${esc(e.type)} · ${esc(e.requestId)} · ${esc(e.actor)}</span></span></li>`).join('') : '<li class="muted">No matching events.</li>'}</ul></div>`;
}

const capw = (a) => (a ? a[0].toUpperCase() + a.slice(1) : '');

/** Per SKU: requests, top issue and area, save rate and stock flags. (Moved here from the Manager screen.) */
function skuBreakdown(m, c) {
  if (!m.bySku.length) return '<div class="card muted">No requests yet.</div>';
  const minN = c?.smallSampleN ?? 5;
  return m.bySku.slice(0, 12).map((g) => {
    const t = g.topIssue;
    const small = g.n < minN;
    return `<div class="card">
      <div class="row"><strong>${esc(itemName(g.skuId))}</strong>
        <span class="pill ${small ? 'warn' : 'accent'}">${small ? `small sample · ${g.n}` : `${g.n} requests`}</span></div>
      <div class="sku-line">${t ? `<strong>${esc(issueLabel(t.issue))}${t.area ? ` · ${esc(capw(t.area))}` : ''}</strong> (${t.count} of ${g.n})` : '–'}
        ${g.closed ? ` · ${g.saves} of ${g.closed} saved` : ''}</div>
      ${g.noAlternative || g.missing || g.declined ? `<div class="sku-line">
        ${g.noAlternative ? `<span class="pill warn">no alternative in stock ×${g.noAlternative}</span> ` : ''}
        ${g.missing ? `<span class="pill warn">missing on rack ×${g.missing}</span> ` : ''}
        ${g.declined ? `<span class="pill">declined at door ×${g.declined}</span>` : ''}</div>` : ''}
    </div>`;
  }).join('') + (m.bySku.length > 12 ? `<p class="label-note">Showing the 12 most-requested of ${m.bySku.length}.</p>` : '');
}

/** How requests were taken: by their primary person, a backup, or after it opened to everyone. */
function routingTable(m) {
  const r = m.routing;
  if (!r.recorded && !r.unassigned.n) return '<div class="card muted">No accepts recorded yet.</div>';
  const row = (label, g) => `<tr><td>${label}</td><td>${g.n}</td><td>${g.n ? esc(fmtDur(g.medianAcceptMs)) : '–'}</td><td>${g.closed ? `${pct(g.saveRate)} (${g.saves}/${g.closed})` : '–'}</td></tr>`;
  return `<div class="card"><table class="cmp"><thead><tr><th>Taken by</th><th>n</th><th>Median accept</th><th>Save rate</th></tr></thead><tbody>
      ${row('Primary person', r.primary)}${row('Backup', r.secondary)}${row('Anyone (opened to all)', r.open)}${r.unassigned.n ? row('Shared queue (before a team existed)', r.unassigned) : ''}</tbody></table>
    <div class="small muted" style="margin-top:6px">Later tiers include the wait before they were added. With few requests, read these as indicative.</div></div>`;
}
