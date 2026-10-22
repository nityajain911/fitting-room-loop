// Admin — the material that is not for the store manager: prototype settings, demo controls, detailed
// metrics, parser statistics, the raw event log, and clearing demo data. Reached from the header link (#admin).
import { S, hooks, handlers, api, act, toast, esc, fmtDur, fmtClock, pct, describeEvent, issueLabel, itemName } from './core.js';
import { computeMetrics } from '/shared/metrics.js';
import { stageLimits } from '/shared/derive.js';
import { SKILLS } from '/shared/skills.js';
import { loadOf } from '/shared/staffing.js';
import { DEFAULTS } from '/shared/config.js';

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

export function render() {
  const m = computeMetrics(S.events, undefined, S.config || undefined);
  const c = S.config;
  const decided = m.confirmed + m.rejected;
  return `
    <a class="link" href="#manager">‹ Manager dashboard</a>
    <div class="row"><h1>Admin</h1><button class="btn danger" data-action="m-clear">Clear demo data</button></div>
    <p class="muted small">Prototype internals. Not part of the store manager's view.</p>

    ${teamSection()}

    ${escalationTimes(c)}

    <h2>Prototype settings</h2>
    <div class="settings">
      alteration offered: ${c ? (c.alterationOffered ? 'yes' : 'no') : '–'} · min improvement ${c?.minImprovementCm ?? '–'} cm ·
      small sample below n=${c?.smallSampleN ?? '–'} ·
      signals need ≥${c?.signalMinN ?? '–'} requests and ≥${c ? Math.round(c.signalMinShare * 100) : '–'}% share, rack recount after ${c?.signalMinMisses ?? '–'}+ report, high demand at ${c?.signalMinPulls ?? '–'}+ replacements · bring up to ${c?.bringCount ?? '–'} items per trip ·
      parser: ${parserText()}${S.demo.fastTimers ? ' · <strong>⚡ fast timers ON</strong>' : ''}
    </div>

    ${demoControls()}

    <h2>Detailed metrics</h2>
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
      <div class="row"><span>Try-on: customer said fits / still not right</span><strong>${m.tryOn.fits} / ${m.tryOn.notRight}</strong></div>
      <div class="row"><span>Requests that needed another attempt / of those, saved</span><strong>${m.retried} / ${m.savedAfterRetry}</strong></div>
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

/** The times that move a request along: escalation per stage, and the waits before it widens to backups and to everyone. */
function escalationTimes(c) {
  const cfg = c || DEFAULTS;
  const row = (id, label, hint, value) => `<label class="esc-row"><span><strong>${label}</strong>
      <span class="small muted">${hint}</span></span>
      <span class="esc-input"><input type="number" id="${id}" data-keep="${id}" min="5" max="3600" step="1" inputmode="numeric" value="${value}"> s</span></label>`;
  return `<h2>Timing</h2><div class="card stack">
    ${row('wait-primary', 'Primary person has it for', 'Then the least busy backup is added too (the first keeps it).', cfg.primaryWaitSeconds)}
    ${row('wait-secondary', 'Backup has it for', 'Then it opens to everyone.', cfg.secondaryWaitSeconds)}
    ${row('esc-accept', 'Escalate if not accepted within', `Placed → accepted. Turns amber at ${stageLimits(cfg, 'accept').warnSeconds}s.`, cfg.acceptEscalateSeconds)}
    ${row('esc-deliver', 'Escalate if not on its way within', `Accepted → on its way. Turns amber at ${stageLimits(cfg, 'deliver').warnSeconds}s.`, cfg.deliverEscalateSeconds)}
    <label class="esc-row"><span><strong>A room with nothing open is empty again after</strong><span class="small muted">The customer can end the visit sooner with "I'm done with this room". Minutes, 1 to 240.</span></span>
      <span class="esc-input"><input type="number" id="room-session" data-keep="room-session" min="1" max="240" step="1" inputmode="numeric" value="${cfg.roomSessionMinutes ?? 30}"> min</span></label>
    <div class="small muted">Waits are 5 to 3600 s, escalation times 10 to 3600 s, whole seconds. Whoever accepts first serves the request. Once accepted, a request stops showing as escalated and only escalates again if the delivery time is passed.${S.demo.fastTimers ? ' <strong>Fast timers are on and override these for now.</strong>' : ''}</div>
    <button class="btn primary" data-action="m-save-esc">Save times</button>
  </div>`;
}

const STATE_OF = (p, k) => (p.primary.includes(k) ? 'primary' : p.secondary.includes(k) ? 'secondary' : 'none');

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
    <p class="muted small">Give each runner and floor associate their sections. A new request goes to the least busy person with it as <strong>primary</strong>; after the primary wait the least busy <strong>backup</strong> is added too. Whoever accepts first serves it. With no team here, everyone sees everything.</p>
    ${staff.length ? staff.map(card).join('') : '<div class="card muted">No team yet. Add people below, or start from a sample team.</div>'}
    <div class="card stack">
      <div class="small muted">Tap a section to cycle: primary, then backup, then none.</div>
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
