// Shared client state, API helper, formatting and render helpers.
import { deriveAll, timerFor } from '/shared/derive.js';
import { DEFAULTS } from '/shared/config.js';
import { ISSUES, OUTCOMES, ROLES, REASON_LABELS, issuesLabel } from '/shared/events.js';
import { getSku, skuLabel } from '/shared/catalogue.js';
import { slaRing, rackZone } from '/shared/visuals.js';

export const S = {
  events: [], lastSeq: 0, epoch: null, offset: 0,
  config: null, roster: [], parser: null, demo: { enabled: false, forceFallback: false, fastTimers: false }, settingsJson: '', catalogueLabel: '',
  derived: deriveAll([]), online: true, loaded: false,
};
export const handlers = {};
// Open/closed state of <details> sections, kept across re-renders (key -> boolean).
export const sections = {};
export const openAttr = (key, dflt) => ((sections[key] ?? dflt) ? 'open' : '');
export const hooks = { pollNow: async () => {}, render: () => {} };

export const now = () => Date.now() + S.offset;

// Which team member this phone is. Set once with a join code from the manager; the associate cannot change what
// the person covers (the admin does that). Tab-level first, so two tabs on one computer can be two people.
const STAFF_KEY = 'frl.staff';
export const pairedId = () => {
  try { return sessionStorage.getItem(STAFF_KEY) || localStorage.getItem(STAFF_KEY) || null; } catch { return null; }
};
export const setPaired = (id) => {
  try {
    for (const store of [sessionStorage, localStorage]) { if (id) store.setItem(STAFF_KEY, id); else store.removeItem(STAFF_KEY); }
  } catch { /* private mode: the join lasts until reload */ }
};
export const rosterOn = () => S.roster.length > 0;
export const me = () => S.roster.find((x) => x.id === pairedId()) || null;
export const staffLabel = (id) => S.roster.find((x) => x.id === id)?.label || 'a removed team member';

export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** Run an action, show errors as a toast, then pull fresh events straight away. */
export async function act(fn) {
  try {
    const out = await fn();
    await hooks.pollNow();
    return out;
  } catch (e) {
    toast(e.message || 'Something went wrong');
    await hooks.pollNow();
    return null;
  }
}

let toastTimer;
export function toast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

/** innerHTML swap that keeps typed text and focus in [data-keep] fields. */
export function renderInto(root, html) {
  const saved = {};
  root.querySelectorAll('[data-keep]').forEach((el) => {
    saved[el.dataset.keep] = {
      value: el.value, focus: document.activeElement === el, s: el.selectionStart, e: el.selectionEnd,
    };
  });
  root.innerHTML = html;
  root.querySelectorAll('[data-keep]').forEach((el) => {
    const v = saved[el.dataset.keep];
    if (!v) return;
    el.value = v.value;
    if (v.focus) {
      el.focus();
      try { el.setSelectionRange(v.s, v.e); } catch { /* not a text input */ }
    }
  });
}

// ---------- formatting ----------
export function fmtDur(ms) {
  if (ms == null) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
export const fmtTimer = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
export const fmtClock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);

/** Timer attributes for the current stage: its start, its warn and escalate marks, and when it froze (if it did). */
function timerAttrs(x) {
  const t = timerFor(x, now(), S.config || DEFAULTS);
  return `data-start="${t.startTs}" data-end="${x.status === 'on_the_way' || t.stage == null ? t.endTs ?? '' : ''}" data-warn="${t.warnSeconds}" data-limit="${t.escalateSeconds}" data-esc="${x.escalated ? 1 : 0}"`;
}

export function timerHtml(x, extra = '') {
  return `<span class="timer ${extra}" data-timer ${timerAttrs(x)}>0:00</span>`;
}

const RING_C = 113.1; // circumference of the ring (r = 18)

/** Room badge wrapped in a ring that fills towards the escalation threshold (green, amber, pulsing red). */
export function ringHtml(x, size = 46) {
  return `<span class="ring ok" data-ring ${timerAttrs(x)} style="width:${size}px;height:${size}px">
    <svg viewBox="0 0 44 44" aria-hidden="true"><circle class="rt" cx="22" cy="22" r="18"/><circle class="rp" cx="22" cy="22" r="18" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}"/></svg>
    <b>${esc(x.room ?? '·')}</b></span>`;
}

/** Rack code as a pill coloured by its aisle, so a runner can see at a glance which aisle to walk to. */
export function rackPill(rack, note = '') {
  const z = rackZone(rack);
  return `<span class="rack zone-${esc(z.aisle)}" title="Aisle ${esc(z.aisle)}"><b>${esc(z.aisle)}</b>Rack ${esc(rack)}${note ? ` · ${esc(note)}` : ''}</span>`;
}

export function tickTimers() {
  const marks = (el) => ({ warnSeconds: Number(el.dataset.warn), escalateSeconds: Number(el.dataset.limit) });
  document.querySelectorAll('[data-ring]').forEach((el) => {
    const start = Number(el.dataset.start);
    const end = el.dataset.end ? Number(el.dataset.end) : null;
    const ms = Math.max(0, (end ?? now()) - start);
    let { fraction, tone } = slaRing(ms, marks(el), end != null);
    if (end == null && el.dataset.esc === '1') { fraction = 1; tone = 'esc'; }
    el.className = `ring ${tone}`;
    el.querySelector('.rp')?.setAttribute('stroke-dashoffset', String(RING_C * (1 - fraction)));
  });
  document.querySelectorAll('[data-timer]').forEach((el) => {
    const start = Number(el.dataset.start);
    const end = el.dataset.end ? Number(el.dataset.end) : null;
    const ms = Math.max(0, (end ?? now()) - start);
    const m = marks(el);
    el.textContent = fmtTimer(ms);
    el.classList.remove('warn', 'esc', 'done');
    if (end != null) el.classList.add('done');
    else if (el.dataset.esc === '1' || ms >= m.escalateSeconds * 1000) el.classList.add('esc');
    else if (ms >= m.warnSeconds * 1000) el.classList.add('warn');
  });
}

export const issueLabel = (issue) => ISSUES[issue] || issue;
/** All the issues a customer named for one article, e.g. "Too tight + Too short". Works on a request or an event payload. */
export const issuesText = (x) => issuesLabel(x.issues?.length ? x.issues : [x.issue]);
export const outcomeLabel = (o) => OUTCOMES[o] || o;
export const roleLabel = (r) => ROLES[r] || r;
export const reasonLabel = (t) => REASON_LABELS[t] || t;
export const itemName = (id) => {
  const s = getSku(id);
  return s ? skuLabel(s) : '–';
};

export const methodLabel = (method) =>
  method === 'rule_fallback' ? 'Rule-based fallback — not AI'
    : method === 'system_rule' ? 'Recorded from a stock-discrepancy report (rule, not AI)'
    : method === 'quick_pick' ? 'Chosen by the associate (one tap, no AI)'
    : method?.startsWith('ai:') ? `Parsed by AI (${method.slice(3)})`
      : 'No free text';

export function sourceLabel(src, method) {
  switch (src) {
    case 'customer_tapped': return 'customer tapped';
    case 'ai_parsed': return method?.startsWith('ai:') ? 'parsed by AI from customer text' : 'parsed by AI from customer text';
    case 'rule_fallback': return 'Rule-based fallback — not AI';
    case 'default': return 'assumed default';
    default: return src;
  }
}

export const STAGE_TEXT = { requested: 'before anyone accepted', accepted: 'after it was accepted', on_the_way: 'while the item was on the way' };

const KIND_TEXT = {
  alteration_or_crossstore: 'No in-stock alternative — hemming or cross-store order shown',
  no_alternative: 'No in-stock alternative — cross-store order suggested',
  stock_check: 'Stock check: in-stock options listed',
};

export function describeEvent(e) {
  const p = e.payload || {};
  switch (e.type) {
    case 'created': return `Room ${p.room} · ${itemName(p.skuId)} · ${issuesText(p)}${p.styleAxes?.length ? ` (${p.styleAxes.join(', ')})` : ''} · ${methodLabel(p.method)}`;
    case 'routed': return `Routed to ${roleLabel(p.role)}`;
    case 'accepted': return `Accepted by ${p.staffId ? staffLabel(p.staffId) : roleLabel(p.role)}${p.tier && p.tier !== 'primary' ? ` (${p.tier === 'secondary' ? 'as backup' : 'after it opened to everyone'})` : ''}`;
    case 'assigned': return p.tier === 'open' ? 'Opened to everyone' : p.staffId ? `Given to ${staffLabel(p.staffId)} (${p.tier === 'secondary' ? 'backup' : 'primary'})` : `Nobody available as ${p.tier === 'secondary' ? 'backup' : 'primary'}`;
    case 'suggestion_shown': return p.itemId ? `Suggested ${itemName(p.itemId)}` : (KIND_TEXT[p.kind] || 'No suggestion');
    case 'suggestion_confirmed': return `Confirmed ${itemName(p.itemId)}`;
    case 'suggestion_rejected': return 'Suggestion rejected';
    case 'on_the_way': return `On the way to Room ${p.room}`;
    case 'floor_pull_requested': return `Floor pull: ${itemName(p.itemId)} (rack ${p.rack})`;
    case 'floor_pull_done': return 'Floor pull done';
    case 'floor_pull_cancelled': return p.reason === 'customer_declined' ? 'Floor pull cancelled: the customer declined the items' : `Floor pull cancelled by ${roleLabel(p.byRole)}`;
    case 'escalated': return `Escalated: ${p.stage === 'deliver' ? 'not delivered' : 'not accepted'} within ${p.thresholdSec}s`;
    case 'closed': return `Closed: ${outcomeLabel(p.outcome)}`;
    case 'inventory_discrepancy': return `Not on rack: ${itemName(p.skuId)} (rack ${p.rack}) — stock record wrong`;
    case 'item_declined': return `Customer declined ${itemName(p.itemId)} ("not this one")`;
    case 'assisted': return `${roleLabel(p.byRole)} stepped in to assist`;
    case 'cancelled': return `Cancelled by customer (${STAGE_TEXT[p.stage] || 'while open'})`;
    case 'reason_added': return `Reason: ${reasonLabel(p.reason_tag)} · ${p.evidence_type} · ${methodLabel(p.method)}${p.edited ? ' · edited' : ''}`;
    default: return e.type;
  }
}
