// Screen 1 — customer (fitting room). Collects no names, phone numbers or customer IDs.
//
// The screen is a strict two-state machine, never both at once:
//   form     (#customer)      — pick the garment and the problem. The room is locked into a header pill.
//   tracker  (#customer/<id>) — one active order card. The form is not rendered, so nothing can be edited by accident.
import { S, hooks, handlers, api, act, esc, toast, issuesText, itemName, STAGE_TEXT } from './core.js';
import { oppositeIssue } from '/shared/events.js';
import { CATALOGUE, garments, getSku, stylesFor } from '/shared/catalogue.js';
import { ISSUES, FIT_ISSUES, CHIPS_BY_KIND, STYLE_AXES, STYLE_AXIS_LABELS, styleKind } from '/shared/events.js';
import { customerSteps, isOpen } from '/shared/derive.js';
import { choiceSummary, optionFor, GIRTH_AREAS } from '/shared/fitMatch.js';
import { tripItemName } from '/shared/visuals.js';

const ROOMS = [1, 2, 3, 4, 5, 6, 7, 8];
let roomLocked = false;  // the room came from the URL (one QR code per fitting-room door)
let pickingRoom = false; // the customer tapped "Change"
const blank = () => ({ dept: 'Men', name: null, styleName: null, colour: null, size: null, cut: null, followsId: null, issues: [], chips: new Set(), styleAxes: new Set(), busy: false });
const form = { room: null, ...blank() };
/** Start a fresh request: everything is cleared except the room, which stays locked. */
const resetForm = () => Object.assign(form, blank());

const inDept = () => CATALOGUE.filter((s) => s.department === form.dept);
const coloursFor = (name, styleName) => [...new Set(inDept().filter((s) => s.name === name && (!styleName || s.styleName === styleName)).map((s) => s.colour))]; // primary colour first
const sizesFor = (name) => [...new Set(inDept().filter((s) => s.name === name).map((s) => s.size))];
const cutsFor = (name, size) => [...new Set(inDept().filter((s) => s.name === name && s.size === size).map((s) => s.cut))];
const resolveSku = () => inDept().find((s) => s.name === form.name && s.styleName === form.styleName && s.colour === form.colour && s.size === form.size && s.cut === form.cut) || null;
const DEPTS = [['Men', "Men's"], ['Women', "Women's"]];
const prefix = (sku) => (sku?.department === 'Women' ? "Women's " : '');
// Body-area chips depend on the garment: nobody is asked about sleeves on trousers.
const formKind = () => {
  const s = inDept().find((x) => x.name === form.name);
  return s ? styleKind(s.category) : 'shirt';
};
const chipsForForm = () => CHIPS_BY_KIND[formKind() === 'trousers' ? 'trousers' : 'top'];
const styleAxesForForm = () => STYLE_AXES[formKind()];
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const opt = (action, v, label, on, cls = '') =>
  `<button type="button" class="opt ${cls} ${on ? 'on' : ''}" data-action="${action}" data-v="${esc(v)}" aria-pressed="${on}">${esc(label)}</button>`;

handlers['c-room'] = (el) => { form.room = Number(el.dataset.v); pickingRoom = false; hooks.render(); };
handlers['c-room-change'] = () => {
  pickingRoom = true;
  if (roomLocked) location.hash = '#customer'; else hooks.render(); // drop the QR room from the URL so the picker can be used
};
handlers['c-dept'] = (el) => {
  if (form.dept === el.dataset.v) return;
  // sizes and designs differ by department, so the garment starts over; the issue and body areas are about the
  // customer's problem, not the department, so they stay (areas that do not fit the next garment are dropped when it is chosen)
  const { issues, chips, styleAxes } = form;
  Object.assign(form, { ...blank(), dept: el.dataset.v, issues, chips, styleAxes });
  hooks.render();
};
handlers['c-colour'] = (el) => { form.colour = el.dataset.v; hooks.render(); };
handlers['c-style'] = (el) => {
  form.styleName = el.dataset.v;
  if (!coloursFor(form.name, form.styleName).includes(form.colour)) form.colour = coloursFor(form.name, form.styleName)[0];
  hooks.render();
};
handlers['c-style-axis'] = (el) => {
  const a = el.dataset.v;
  if (form.styleAxes.has(a)) form.styleAxes.delete(a); else form.styleAxes.add(a);
  hooks.render();
};
handlers['c-garment'] = (el) => {
  form.name = el.dataset.v;
  form.styleName = stylesFor(form.name, CATALOGUE, form.dept)[0]; // the first style and its first colour are pre-selected; the customer can change them
  form.colour = coloursFor(form.name, form.styleName)[0];
  form.styleAxes = new Set([...form.styleAxes].filter((a) => styleAxesForForm().includes(a)));
  const sizes = sizesFor(form.name);
  form.size = sizes.length === 1 ? sizes[0] : null;
  form.cut = null;
  if (form.size) { const cuts = cutsFor(form.name, form.size); if (cuts.length === 1) form.cut = cuts[0]; }
  form.chips = new Set([...form.chips].filter((c) => chipsForForm().includes(c))); // drop chips that do not apply to this garment
  hooks.render();
};
handlers['c-size'] = (el) => {
  form.size = el.dataset.v;
  const cuts = cutsFor(form.name, form.size);
  form.cut = cuts.length === 1 ? cuts[0] : (cuts.includes(form.cut) ? form.cut : null);
  hooks.render();
};
handlers['c-cut'] = (el) => { form.cut = el.dataset.v; hooks.render(); };
handlers['c-issue'] = (el) => {
  const k = el.dataset.v;
  if (!FIT_ISSUES.includes(k)) form.issues = [k]; // size, style and stock checks stand alone
  else if (form.issues.includes(k)) form.issues = form.issues.filter((x) => x !== k);
  else {
    // a fit issue joins the other fit issues (at most two), replaces its opposite, and replaces any non-fit choice
    const keep = form.issues.filter((x) => FIT_ISSUES.includes(x) && x !== oppositeIssue(k));
    form.issues = [...keep, k].slice(-2);
  }
  if (!form.issues.some((x) => FIT_ISSUES.includes(x))) form.chips = new Set(); // body areas only apply to fit issues
  if (!form.issues.includes('another_style')) form.styleAxes = new Set(); // style details only apply to "Another style"
  hooks.render();
};
handlers['c-chip'] = (el) => {
  const c = el.dataset.v;
  if (form.chips.has(c)) form.chips.delete(c); else form.chips.add(c);
  hooks.render();
};
handlers['c-new'] = (el) => {
  resetForm(); // never carry the previous garment or issue into a new request
  const room = el.dataset.room || form.room;
  location.hash = room ? `#customer?room=${room}` : '#customer';
  hooks.render();
};
handlers['c-tryon'] = async (el) => {
  const out = await act(() => api('POST', `/api/requests/${el.dataset.v}/try-on`, { result: el.dataset.result }));
  if (out && el.dataset.result === 'not_right') location.hash = `#customer?room=${S.derived.byId[el.dataset.v]?.room}&from=${el.dataset.v}`;
};
handlers['c-another'] = (el) => { location.hash = `#customer?room=${S.derived.byId[el.dataset.v]?.room}&from=${el.dataset.v}`; };
handlers['c-decline'] = (el) => act(() => api('POST', `/api/requests/${el.dataset.v}/decline-item`));
handlers['c-cancel'] = async (el) => {
  if (!confirm('Cancel this request? The team will be told you no longer need help.')) return;
  await act(() => api('POST', `/api/requests/${el.dataset.v}/cancel`));
};
handlers['c-submit'] = async () => {
  const sku = resolveSku();
  if (form.busy || !form.room || !sku || !form.issues.length) return;
  const text = (document.getElementById('c-text')?.value || '').trim();
  form.busy = true;
  hooks.render();
  const out = await act(() => api('POST', '/api/requests', {
    room: form.room, skuId: sku.id, issues: [...form.issues], chips: [...form.chips], ...(form.followsId ? { followsId: form.followsId } : {}),
    styleAxes: form.issues.includes('another_style') ? [...form.styleAxes] : [], text,
  }));
  form.busy = false;
  if (out?.requestId) {
    resetForm(); // the room stays; the form is gone and cannot be mistaken for the live order
    const t = document.getElementById('c-text'); if (t) t.value = '';
    location.hash = `#customer/${out.requestId}`;
  } else {
    toast('Could not send the request — please try again');
    hooks.render();
  }
};

/** "Still not right, try another": the form starts from the item that was handed over (the first of the trip). */
function startFollowUp(id) {
  const r = S.derived.byId[id];
  const sku = r?.onTheWay?.items?.length ? getSku(r.onTheWay.items[0].itemId) : null;
  if (!sku || !isOpen(r)) return;
  Object.assign(form, { ...blank(), room: r.room, dept: sku.department ?? 'Men', name: sku.name, styleName: sku.styleName ?? null, colour: sku.colour, size: sku.size, cut: sku.cut, followsId: id });
}

export function render({ args, query }) {
  const n = Number(query?.get('room'));
  roomLocked = Number.isInteger(n) && n >= 1 && n <= 99;
  if (roomLocked) form.room = n;
  const from = query?.get('from');
  if (from && form.followsId !== from && !args[0]) startFollowUp(from);
  return args[0] ? tracker(args[0]) : formView();
}

const roomOpen = (room) => S.derived.requests.filter((r) => r.room === room && isOpen(r)).sort((a, b) => a.createdTs - b.createdTs);

/** The room, locked into the header once chosen. */
function roomBar() {
  return `<div class="roombar"><span>📍 <strong>Room ${esc(form.room)}</strong></span>
    <button class="link-btn" data-action="c-room-change">Change</button></div>`;
}

/**
 * Where on the garment. Only once a garment is chosen (the areas depend on it). With two issues, each gets its own
 * list, so it is clear which area belongs to which issue: how roomy it is (waist, chest...) or how long it is.
 */
function whereView() {
  const fit = form.issues.filter((k) => FIT_ISSUES.includes(k));
  if (!form.name || !fit.length) return '';
  const optional = '<span class="muted" style="text-transform:none;letter-spacing:0">(optional)</span>';
  const chips = chipsForForm();
  const group = (list) => `<div class="opts">${list.map((c) => opt('c-chip', c, cap(c), form.chips.has(c))).join('')}</div>`;
  if (fit.length < 2) return `<h2>Where? ${optional}</h2>${group(chips)}`;
  return fit.map((k) => {
    const lengthIssue = k === 'too_long' || k === 'too_short';
    return `<h2>Where is it ${esc(ISSUES[k].toLowerCase())}? ${optional}</h2>${group(chips.filter((c) => GIRTH_AREAS.includes(c) !== lengthIssue))}`;
  }).join('');
}

function formView() {
  const sku = resolveSku();
  const sizes = form.name ? sizesFor(form.name) : [];
  const cuts = form.name && form.size ? cutsFor(form.name, form.size) : [];
  const next = !form.room ? 'room' : !form.name ? 'garment' : !form.size ? 'size' : !form.cut ? 'cut' : !form.issues.length ? 'issue' : null;
  const ready = !next && !form.busy;
  const open = form.room ? roomOpen(form.room) : [];
  return `
    <div class="row"><h1>What's not working?</h1><span class="badge-anon">🔒 Anonymous</span></div>
    ${form.followsId && S.derived.byId[form.followsId] ? `<div class="banner info">Following up on the item we brought: <strong>${esc(itemName(S.derived.byId[form.followsId].onTheWay?.items?.[0]?.itemId))}</strong>. Change the size or cut if you tried another, then tell us what is still not right. <a href="#customer/${esc(form.followsId)}">Cancel</a></div>` : ''}
    ${open.length ? `<a class="back-link" href="#customer/${esc(open[open.length - 1].id)}">✕ Cancel — back to your request${open.length > 1 ? 's' : ''}</a>` : ''}

    ${form.room && !pickingRoom ? roomBar() : `<h2>Fitting room</h2><div class="opts">${ROOMS.map((r) => opt('c-room', r, `Room ${r}`, form.room === r)).join('')}</div>`}

    <div class="seg" role="tablist" aria-label="Section">${DEPTS.map(([k, l]) => `<button type="button" class="${form.dept === k ? 'on' : ''}" data-action="c-dept" data-v="${k}">${l}</button>`).join('')}</div>

    <h2>Garment</h2>
    <div class="opts">${garments(CATALOGUE, form.dept).map((g) => opt('c-garment', g, g, form.name === g)).join('')}</div>
    ${form.name && stylesFor(form.name, CATALOGUE, form.dept).length > 1 ? `<h2>Style</h2><div class="opts">${stylesFor(form.name, CATALOGUE, form.dept).map((st) => opt('c-style', st, st, form.styleName === st)).join('')}</div>` : ''}
    ${form.name ? `<h2>Colour</h2><div class="opts">${coloursFor(form.name, form.styleName).map((c) => opt('c-colour', c, c, form.colour === c)).join('')}</div>` : ''}
    ${form.name ? `<h2>Size</h2><div class="opts">${sizes.map((s) => opt('c-size', s, s, form.size === s)).join('')}</div>` : ''}
    ${form.size ? `<h2>Cut</h2><div class="opts">${cuts.map((c) => opt('c-cut', c, c, form.cut === c)).join('')}</div>` : ''}

    <h2>What's the issue? ${form.issues.some((k) => FIT_ISSUES.includes(k)) ? '<span class="muted" style="text-transform:none;letter-spacing:0">(pick more than one if both apply)</span>' : ''}</h2>
    <div class="issue-grid">${Object.entries(ISSUES).map(([k, v]) => opt('c-issue', k, v, form.issues.includes(k), k === 'check_stock' ? 'wide' : '')).join('')}</div>

    ${form.issues.includes('another_style') ? `<h2>What would you like different? <span class="muted" style="text-transform:none;letter-spacing:0">(optional)</span></h2>
    <div class="opts">${styleAxesForForm().map((a) => opt('c-style-axis', a, STYLE_AXIS_LABELS[a], form.styleAxes.has(a))).join('')}</div>` : ''}
    ${whereView()}

    <h2>Add a note <span class="muted" style="text-transform:none;letter-spacing:0">(optional)</span></h2>
    <textarea id="c-text" data-keep="c-text" maxlength="500" placeholder="English, हिन्दी or Hinglish — e.g. “kamar pe tight hai”"></textarea>

    <div class="cta-wrap">
      <button class="btn primary block" data-action="c-submit" ${ready ? '' : 'disabled'}>${form.busy ? 'Sending…'
        : ready ? `Send request: ${esc(prefix(sku))}${esc(sku.colour)} ${esc(sku.name)} ${esc(sku.size)} ${esc(sku.cut)}` : `Select ${next} to continue`}</button>
    </div>`;
}

const SHORT_STEPS = { requested: 'Requested', accepted: 'Accepted', on_the_way: 'On the way', resolved: 'Resolved' };

/** Horizontal four-step progress. */
function stepper(r, steps, cancelled) {
  let current = 0;
  steps.forEach((s, i) => { if (s.reached) current = i; });
  return `<ol class="hstep">${steps.map((s, i) => `<li class="${s.reached ? 'reached' : ''} ${i === current && !cancelled ? 'current' : ''}">
    <span class="dot">${s.reached ? '✓' : ''}</span><span class="lbl">${esc(s.key === 'on_the_way' && r.deliveredTs != null ? 'Delivered' : SHORT_STEPS[s.key])}</span></li>`).join('')}</ol>`;
}

/** The live "what is coming" box: waiting, checking stock, then every item on the trip. */
function incoming(r) {
  if (r.status === 'cancelled') return `<div class="banner alert">You cancelled this request ${esc(STAGE_TEXT[r.cancelStage] || '')}. Nothing more is needed.</div>`;
  if (r.status === 'closed' && r.outcome === 'continued') {
    const next = S.derived.requests.find((x) => x.followsId === r.id);
    return `<div class="incoming done">We're on it with your new request.${next ? ` <a href="#customer/${esc(next.id)}">See it</a>` : ''}</div>`;
  }
  if (r.status === 'closed') return '<div class="incoming done">All done. Thanks for letting us help.</div>';
  if (r.status === 'requested') return '<div class="incoming wait"><span class="spin"></span>Waiting for a team member…</div>';
  if (r.status === 'accepted' || !r.onTheWay) return '<div class="incoming wait"><span class="spin"></span>Checking stock…</div>';

  const orig = getSku(r.skuId);
  const trip = r.onTheWay.items.map((i) => ({ sku: getSku(i.itemId), id: i.itemId })).filter((x) => x.sku);
  const many = trip.length > 1;
  const item = ({ sku, id }) => {
    const why = r.suggestion ? choiceSummary(optionFor(r.suggestion, id)) : null;
    return `<div class="bitem"><strong>${esc(orig ? tripItemName(orig, sku) : itemName(id))}</strong>
      <div class="small muted">${esc(itemName(id))}</div>${why ? `<div class="small">Chosen for ${esc(why)}</div>` : ''}</div>`;
  };
  return `<div class="incoming bring">
    <div class="small muted" style="letter-spacing:.6px;font-weight:700">${r.deliveredTs != null ? (many ? `${trip.length} ITEMS DELIVERED` : 'DELIVERED') : (many ? `BRINGING ${trip.length} ITEMS` : 'BRINGING')} TO ROOM ${esc(r.room)}</div>
    ${many ? '<div class="small muted" style="margin:2px 0 6px">Try them all; keep the one that fits.</div>' : ''}
    ${trip.map(item).join('')}
    ${r.deliveredTs != null ? tryOnBlock(r, many)
      : r.itemDeclined
        ? '<div class="small" style="margin-top:8px;color:var(--warn)">Thanks — we told the team you don\'t want these. They\'ll bring something else.</div>'
        : `<button class="btn small-btn" data-action="c-decline" data-v="${esc(r.id)}">${many ? 'None of these' : 'Not this one'}</button>`}
  </div>`;
}

/** After the item has been handed over: how does it fit? A statement from the customer, never an outcome. */
function tryOnBlock(r, many) {
  if (r.tryOn?.result === 'fits') return '<div class="small" style="margin-top:10px">Glad it fits! The team will wrap up with you.</div>';
  if (r.tryOn?.result === 'not_right') {
    return `<div class="small" style="margin-top:10px">Thanks, let's find another.</div>
      <button class="btn primary block" style="margin-top:8px" data-action="c-another" data-v="${esc(r.id)}">Tell us what's still not right</button>`;
  }
  return `<div style="margin-top:10px"><strong>How does ${many ? 'the one you kept' : 'the new one'} fit?</strong></div>
    <div class="btn-grid" style="margin-top:8px">
      <button class="btn primary" data-action="c-tryon" data-result="fits" data-v="${esc(r.id)}">👍 Fits great</button>
      <button class="btn" data-action="c-tryon" data-result="not_right" data-v="${esc(r.id)}">🔄 Still not right</button>
    </div>`;
}

/** Other open requests from this room as compact cards, read from the shared log (a room number is not personal data). */
function others(r, list) {
  const rest = list.filter((x) => x.id !== r.id);
  if (!rest.length) return '';
  return `<h2>Also open in Room ${esc(r.room)}</h2>${rest.map((x) => `
    <a class="card tap compact" href="#customer/${esc(x.id)}">
      <div class="row"><strong>Request ${list.indexOf(x) + 1} of ${list.length}</strong><span class="pill ok">${esc(x.status === 'requested' ? 'Waiting' : x.status === 'accepted' ? 'Accepted' : 'On the way')}</span></div>
      <div class="small muted">${esc(itemName(x.skuId))} · ${esc(issuesText(x))}</div>
    </a>`).join('')}`;
}

function tracker(id) {
  const r = S.derived.byId[id];
  if (!r || r.kind !== 'request') {
    return S.loaded
      ? `<div class="card"><h3>We can't find that request</h3><p class="muted">It may have been cleared.</p><button class="btn primary" data-action="c-new">New request</button></div>`
      : '<p class="muted">Loading…</p>';
  }
  const sku = getSku(r.skuId);
  const cancelled = r.status === 'cancelled';
  const open = isOpen(r);
  const list = roomOpen(r.room);
  const idx = list.findIndex((x) => x.id === r.id);
  const area = r.chips.length ? r.chips.map(cap).join(', ')
    : (r.parsed && r.parsed.primary_area !== 'other/unknown' ? cap(r.parsed.primary_area) : '');
  const issueTxt = `${issuesText(r)}${area && r.issue !== 'check_stock' ? ` · ${area}` : ''}${r.styleAxes?.length ? ` · ${r.styleAxes.map(cap).join(', ')}` : ''}`;
  return `
    <div class="roombar"><span>📍 <strong>Room ${esc(r.room)}</strong></span>${open && list.length > 1 ? `<span class="muted small">Request ${idx + 1} of ${list.length}</span>` : ''}</div>
    <div class="card order">
      ${stepper(r, customerSteps(r), cancelled)}
      <div class="item-pill"><strong>${esc(sku ? `${prefix(sku)}${sku.colour} ${sku.name} · ${sku.size} ${sku.cut}` : '')}</strong>
        <span class="pill">${esc(issueTxt)}</span></div>
      ${incoming(r)}
    </div>
    <div class="secondary">
      <button class="btn block" data-action="c-new" data-room="${esc(r.room)}">${open ? '+ Request another item' : 'New request'}</button>
      ${open ? `<button class="link-btn muted-btn" data-action="c-cancel" data-v="${esc(r.id)}">Cancel request</button>` : ''}
    </div>
    ${others(r, list)}`;
}
