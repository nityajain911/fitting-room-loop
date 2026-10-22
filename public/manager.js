// Screen 3 — manager dashboard ("store command center"). Only what a store manager acts on, drawn rather than listed.
// Every number comes from computeMetrics(events). Definitions sit behind a small (i) toggle instead of captions.
// Settings, demo controls, parser stats, per-SKU detail, the raw event log and "clear data" live on the Admin page.
import { S, hooks, handlers, api, act, toast, esc, fmtDur, fmtClock, pct, outcomeLabel, reasonLabel, issuesText, itemName, timerHtml, roleLabel } from './core.js';
import { computeMetrics } from '/shared/metrics.js';
import { EVIDENCE_TYPES } from '/shared/events.js';
import { bulletScale, outcomeFunnel } from '/shared/visuals.js';
import { stageLimits, STAGE_LABEL } from '/shared/derive.js';
import { DEFAULTS } from '/shared/config.js';

const info = {}; // which (i) definitions are open
handlers['m-info'] = (el) => { info[el.dataset.k] = !info[el.dataset.k]; hooks.render(); };

const EV_LABEL = {
  'customer-stated': 'Customer said', 'associate-observed': 'Associate saw',
  'system-observed': 'System showed', unknown: 'Unknown',
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const cap = (a) => (a ? a[0].toUpperCase() + a.slice(1) : '');
const AREA_SHORT = { waist: 'Waist', chest: 'Chest', shoulders: 'Shldr', sleeves: 'Sleeve', length: 'Length', hips: 'Hips', general: 'No area' };

const infoBtn = (k) => `<button class="info-btn" data-action="m-info" data-k="${k}" aria-label="What is this?" aria-expanded="${!!info[k]}">ⓘ</button>`;

/** A card title with a small (i) that reveals the definition. */
const title = (k, text, definition) => `<div class="kpi-title"><strong>${text}</strong>${infoBtn(k)}</div>
  ${info[k] ? `<div class="info-text">${definition}</div>` : ''}`;

export function render() {
  const m = computeMetrics(S.events, undefined, S.config || undefined);
  const cfg = S.config || DEFAULTS;
  const accept = stageLimits(cfg, 'accept');
  const deliver = stageLimits(cfg, 'deliver');
  return `
    <div class="banner demo">Demo data — prototype only, not store results</div>
    <h1>Manager dashboard</h1>

    ${attention(m)}

    <div class="north">
      <div class="tile">${title('save', 'Issue save rate', 'Fitting-room proxy, not store conversion: (bought original + bought alternative + cross-store order) ÷ closed requests. Saved for later and cancelled requests are not counted as saves.')}
        <div class="num">${pct(m.saveRate)}</div>
        <div class="cap">${m.saves} of ${m.closed} closed</div></div>
      <div class="tile">${title('sla', 'SLA health', `Median time to accept a request, and median time from accept to the item being on its way, each against its own warning and escalation marks (accept: ${accept.warnSeconds}s / ${accept.escalateSeconds}s, deliver: ${deliver.warnSeconds}s / ${deliver.escalateSeconds}s). The escalation times are prototype settings, set on the Admin page.`)}
        ${bullet('Accept', m.medianAcceptMs, accept, 'Pending first accept')}${bullet('Deliver', m.medianDeliverMs, deliver, 'Pending first delivery')}</div>
      <div class="tile">${title('rack', 'Not on rack', 'Times an associate found a suggested item missing from its rack, meaning the stock record was wrong.')}
        <div class="num">${m.inventoryDiscrepancies.total}</div>
        <div class="cap">${plural(m.inventoryDiscrepancies.bySku.length, 'SKU')} affected</div></div>
    </div>
    <div class="statusline">${m.total} requests · ${m.open} waiting · ${m.accepted} in progress · ${m.closed} closed${m.cancelled ? ` · ${m.cancelled} cancelled` : ''} · ${plural(m.escalations, 'escalation')}${m.assists ? ` (${m.assists} picked up)` : ''}${m.routing.recorded ? ` · ${Math.round(m.routing.primaryShare * 100)}% taken by their primary person` : ''}</div>

    <h2>Where requests ended ${infoBtn('funnel')}</h2>
    ${info.funnel ? '<div class="info-text">Every closed request, by outcome. The three green and blue segments (bought alternative, bought original, cross-store order) add up to the issue save rate. "Saved for later" is shown apart because it is not counted as a save. Cancelled requests are not closed, so they sit outside the bar.</div>' : ''}
    ${funnel(m)}

    <h2>Fit issues by garment and body area ${infoBtn('heat')}</h2>
    ${info.heat ? '<div class="info-text">Each cell counts fit reports for one garment and cut and body area; "No area" is where the customer named the issue but no body area. A request with two issues counts once under each. Coral: they needed more room or length (too tight, too short). Teal: they needed less (too loose, too long). Darker means more requests.</div>' : ''}
    ${heatmap(m, cfg)}

    ${m.signals.length ? `<h2>What to act on</h2>${signals(m)}` : ''}

    ${reasons(m)}`;
}

/** One median against the warning and escalation marks. */
function bullet(label, ms, cfg, waiting = 'no data yet') {
  const b = bulletScale(ms, cfg);
  if (!b) return `<div class="bullet"><span class="bl-label">${label}</span><span class="pill">${esc(waiting)}</span></div>`;
  const zones = `linear-gradient(to right, var(--ok-soft) 0 ${b.warnPct}%, var(--warn-soft) ${b.warnPct}% ${b.escPct}%, var(--danger-soft) ${b.escPct}% 100%)`;
  return `<div class="bullet"><span class="bl-label">${label}</span>
    <div class="bl-track" style="background:${zones}" role="img" aria-label="${label} median ${esc(fmtDur(ms))}">
      <i class="bl-val ${b.tone}" style="width:${b.valuePct}%"></i>
      <span class="mark" style="left:${b.warnPct}%"></span><span class="mark" style="left:${b.escPct}%"></span></div>
    <span class="bl-num">${esc(fmtDur(ms))}</span></div>`;
}

/** Open escalations only. Nothing is shown when there are none. */
function attention(m) {
  const items = m.openEscalations.map((id) => S.derived.byId[id]).filter(Boolean);
  if (!items.length) return '';
  return `<h2 style="color:var(--danger)">Needs attention — ${plural(items.length, 'escalation')} open</h2>
    ${items.map((x) => `<div class="card attn">
      <div class="row"><strong>${x.kind === 'task' ? `Floor pull → Room ${esc(x.room)}` : `Room ${esc(x.room)} · ${esc(issuesText(x.cur ?? x))}${x.round > 1 ? ` · attempt ${x.round}` : ''}`}</strong>${timerHtml(x)}</div>
      <div class="small">${x.kind === 'task' ? `${esc(itemName(x.itemId))} · rack ${esc(x.rack)}` : esc(itemName(x.skuId))}</div>
      <div class="small muted">${esc(STAGE_LABEL[x.escalatedStage] || 'Escalated')} · ${x.assistedNow ? `${esc(roleLabel(x.assistedBy))} stepped in at ${esc(fmtClock(x.assistedTs))}` : 'nobody has stepped in yet'}</div>
    </div>`).join('')}`;
}

const FUNNEL_COLOURS = { bought_alternative: 'var(--ok)', bought_original: '#7bcf9b', cross_store_order: 'var(--accent)', saved_for_later: '#a78bfa', left: 'var(--danger)' };

/** 100% stacked bar of closed outcomes. */
function funnel(m) {
  const f = outcomeFunnel(m);
  if (!f.total) return `<div class="card muted">No closed requests yet.${f.cancelled ? ` ${f.cancelled} cancelled.` : ''}</div>`;
  return `<div class="card">
    <div class="funnel" role="img" aria-label="Outcomes of ${f.total} closed requests">${f.segments.map((s) => `<i style="width:${s.pct}%;background:${FUNNEL_COLOURS[s.key]}" title="${esc(outcomeLabel(s.key))}: ${s.count}"></i>`).join('')}</div>
    <div class="flegend">${f.segments.map((s) => `<span><i style="background:${FUNNEL_COLOURS[s.key]}"></i>${esc(outcomeLabel(s.key))} <strong>${s.count}</strong> (${Math.round(s.pct)}%)</span>`).join('')}</div>
    ${f.cancelled ? `<div class="small muted" style="margin-top:6px">+ ${f.cancelled} cancelled by the customer (not part of the bar)</div>` : ''}
  </div>`;
}

/** Garment+cut rows by body-area columns, shaded by how many fit issues were reported. */
function heatmap(m, cfg) {
  const h = m.heatmap;
  const cols = h.areas.filter((a) => h.rows.some((r) => r.cells[a].more + r.cells[a].less > 0));
  if (!h.rows.length) {
    return '<div class="card muted">No fit issues yet.</div>';
  }
  const alpha = (n) => (0.18 + 0.82 * (n / h.max)).toFixed(2);
  const CORAL = '224, 90, 67';
  const TEAL = '20, 150, 150';
  const cell = (c) => {
    const n = c.more + c.less;
    if (!n) return '<div class="hcell empty"></div>';
    const bg = c.more && c.less
      ? `linear-gradient(to bottom, rgba(${CORAL}, ${alpha(c.more)}) 50%, rgba(${TEAL}, ${alpha(c.less)}) 50%)`
      : `rgba(${c.more ? CORAL : TEAL}, ${alpha(n)})`;
    return `<div class="hcell" style="background:${bg}" title="Needed more: ${c.more} · needed less: ${c.less}">${n}</div>`;
  };
  const minN = cfg.smallSampleN ?? 5;
  return `<div class="card"><div class="heat" style="grid-template-columns: minmax(104px, 1fr) repeat(${cols.length}, minmax(38px, 54px))">
      <div></div>${cols.map((a) => `<div class="hhead" title="${a === 'general' ? 'The customer named the issue but no body area' : esc(cap(a))}">${esc(AREA_SHORT[a] || cap(a))}</div>`).join('')}
      ${h.rows.map((r) => `<div class="hrow">${esc(r.label)}<div class="muted small" style="font-weight:400">${r.total} report${r.total === 1 ? '' : 's'}${r.total < minN ? ' · small sample' : ''}</div></div>${cols.map((a) => cell(r.cells[a])).join('')}`).join('')}
    </div>
    <div class="hlegend"><span><i style="background:rgb(${CORAL})"></i>needed more room or length</span><span><i style="background:rgb(${TEAL})"></i>needed less</span></div>
  </div>`;
}

const KIND = { inventory: 'Stock record', fit: 'Fit / sizing', stock_gap: 'Stock depth', high_demand: 'High demand' };
const SEVERITY = { high: 'danger', medium: 'warn', low: 'accent' };
handlers['m-dispatch'] = async (el) => {
  const out = await act(() => api('POST', '/api/restock', { skuId: el.dataset.sku, kind: el.dataset.kind }));
  if (out) toast('Sent to the floor team');
};

/** The one-tap "do something about it": only signals the floor can act on (a recount, or restocking near the rooms). */
function dispatchControl(s) {
  if (!s.dispatch) return '';
  if (s.dispatched) return `<span class="pill ok">Sent to the floor · ${s.dispatched.status === 'accepted' ? 'in progress' : 'waiting'}</span>`;
  const label = s.dispatch.kind === 'recount' ? 'Send recount to the floor' : 'Send restock to the floor';
  return `<button class="btn small-btn" data-action="m-dispatch" data-sku="${esc(s.dispatch.skuId)}" data-kind="${esc(s.dispatch.kind)}">${label}</button>`;
}

function signals(m) {
  return m.signals.map((s) => `<div class="card signal ${esc(s.kind)}">
      <div class="small muted">${esc(KIND[s.kind])}</div><div>${esc(s.text)}</div>
      ${s.action ? `<div style="margin-top:6px"><span class="pill ${SEVERITY[s.action.severity] || ''}">Action: ${esc(s.action.label)}</span> ${dispatchControl(s)}</div>` : ''}</div>`).join('')
    + '<p class="label-note">Suggested actions come from simple rules on the counts above. Shares are of requests, not defect rates: only customers who asked for help are counted.</p>';
}

function reasons(m) {
  const groups = EVIDENCE_TYPES.filter((ev) => m.reasons.byEvidence[ev].length);
  if (!groups.length) return '';
  return `<h2>Why requests didn't convert</h2><div class="card">${groups.map((ev) => `
    <div style="margin:6px 0"><div class="small muted">${EV_LABEL[ev]}</div>
      ${m.reasons.byEvidence[ev].map((x) => `<div class="row small"><span>${esc(reasonLabel(x.tag))}</span><strong>${x.count}</strong></div>`).join('')}</div>`).join('')}</div>`;
}
