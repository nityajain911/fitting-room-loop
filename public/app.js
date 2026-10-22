// Router, polling loop and event delegation. All shared state lives on the server.
import { deriveAll } from '/shared/derive.js';
import { S, hooks, handlers, sections, now, tickTimers, renderInto, fmtClock, pairedId } from './core.js';
import * as customer from './customer.js';
import * as associate from './associate.js';
import * as manager from './manager.js';
import * as admin from './admin.js';
import * as alerts from './alerts.js';
import { MODE_PARAM, isMode, allowedView, homeOf, showAdminLink } from '/shared/modes.js';

const views = { customer, associate, manager, admin };
const root = document.getElementById('view');
const conn = document.getElementById('conn');
const bell = document.getElementById('bell');

// What this device is for: set once by a link (`&mode=customer`), remembered, and "demo" (no lock) by default.
const MODE_KEY = 'frl.mode';
const currentMode = () => { try { const m = localStorage.getItem(MODE_KEY); return isMode(m) ? m : 'demo'; } catch { return 'demo'; } };
function applyModeParam(query) {
  const m = query.get(MODE_PARAM);
  if (!isMode(m)) return;
  try { if (m === 'demo') localStorage.removeItem(MODE_KEY); else localStorage.setItem(MODE_KEY, m); } catch { /* private mode */ }
}

function parseRoute() {
  // e.g. "#customer?room=3&mode=customer" (one link per fitting-room tablet) or "#associate/runner/r_abc123"
  const [path, q = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  const query = new URLSearchParams(q || location.search.slice(1));
  applyModeParam(query);
  const view = parts[0] in views ? parts[0] : 'customer';
  if (!allowedView(currentMode(), view)) return { view: homeOf(currentMode()), args: [], query: new URLSearchParams(), moved: true };
  return { view, args: parts.slice(1), query };
}

/** A pill on every tab whenever a presenter switch is on, so nobody is surprised by short timers or a forced fallback. */
function updateDemoPill() {
  const pill = document.getElementById('demo-pill');
  const parts = [];
  if (S.demo.fastTimers) parts.push(`⚡ Fast timers ON${S.demo.fastTimersUntil ? ` until ${fmtClock(S.demo.fastTimersUntil)}` : ''}`);
  if (S.demo.forceFallback) parts.push('AI fallback: FORCED');
  pill.hidden = parts.length === 0;
  pill.textContent = parts.join(' · ');
}

/** Staff and the manager get an alert bell; what needs their attention is asked of their screen. */
function attention(view) {
  if (view === 'associate') return associate.attention();
  if (view === 'manager') return manager.attention();
  return null;
}
const syncBell = (view) => {
  bell.hidden = !['associate', 'manager'].includes(view);
  bell.textContent = alerts.soundOn() ? '🔔' : '🔕';
};
bell.addEventListener('click', () => { alerts.toggleSound(); syncBell(parseRoute().view); });

function render() {
  const { view, args, query, moved } = parseRoute();
  if (moved) history.replaceState(null, '', `#${view}`);
  document.body.dataset.mode = currentMode();
  document.body.dataset.view = view;
  document.querySelector('.admin-link').hidden = !showAdminLink(currentMode());
  syncBell(view);
  document.querySelectorAll('[data-tab]').forEach((a) => a.classList.toggle('on', a.dataset.tab === view));
  renderInto(root, views[view].render({ args, query }));
  tickTimers();
  updateDemoPill();
  alerts.update(attention(view));
}
hooks.render = render;

async function fetchEvents(since) {
  // The phone's team member (a heartbeat so it counts as on), and the Admin page also receives the join codes.
  const staff = pairedId() ? `&staff=${encodeURIComponent(pairedId())}` : '';
  const admin = parseRoute().view === 'admin' ? '&admin=1' : '';
  const res = await fetch(`/api/events?since=${since}${staff}${admin}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let inflight = null;
async function poll() {
  if (inflight) return inflight;
  inflight = (async () => {
    let changed = false;
    try {
      const t0 = Date.now();
      let data = await fetchEvents(S.lastSeq);
      const t1 = Date.now();
      if (S.epoch !== null && data.epoch !== S.epoch) {
        S.events = []; S.lastSeq = 0; // log was cleared: start over
        data = await fetchEvents(0);
        changed = true;
      }
      S.epoch = data.epoch;
      if (data.settings) {
        const j = JSON.stringify(data.settings);
        if (j !== S.settingsJson) { // thresholds, parser mode and demo toggles can change at any time
          S.settingsJson = j;
          S.config = data.settings.config;
          S.saved = data.settings.saved;
          S.roster = data.settings.staff || [];
          S.parser = data.settings.parser;
          S.demo = { enabled: !!data.settings.demoControls, ...data.settings.demo };
          changed = true;
        }
      }
      S.offset = data.serverNow - (t0 + t1) / 2;
      if (data.events.length) {
        S.events.push(...data.events);
        S.lastSeq = data.events[data.events.length - 1].seq;
        changed = true;
      }
      if (!S.loaded) { S.loaded = true; changed = true; }
      if (!S.online) { S.online = true; changed = true; }
      if (changed) S.derived = deriveAll(S.events);
    } catch {
      if (S.online) { S.online = false; changed = true; }
    }
    conn.hidden = S.online;
    document.body.classList.toggle('offline', !S.online);
    if (changed) render();
  })().finally(() => { inflight = null; });
  return inflight;
}
hooks.pollNow = poll;

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (el && handlers[el.dataset.action]) handlers[el.dataset.action](el, e);
});
window.addEventListener('hashchange', () => { render(); poll(); });
// <details> does not bubble 'toggle', so listen in the capture phase and remember what the user opened or closed.
document.addEventListener('toggle', (e) => {
  const key = e.target?.dataset?.sec;
  if (key) sections[key] = e.target.open;
}, true);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); keepAwake(); } });

// A tablet in a fitting room, and a runner's phone, should not go to sleep in the middle of a shift.
let wake = null;
async function keepAwake() {
  if (!('wakeLock' in navigator) || !['customer', 'staff'].includes(currentMode()) || wake) return;
  try {
    wake = await navigator.wakeLock.request('screen');
    wake.addEventListener('release', () => { wake = null; });
  } catch { /* not allowed right now: it is tried again when the page is shown */ }
}

(async function start() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    S.config = cfg.config;
    S.saved = cfg.saved;
    S.roster = cfg.staff || [];
    S.parser = cfg.parser;
    S.catalogueLabel = cfg.catalogueLabel;
  } catch { /* retried implicitly: config is needed only for timers */ }
  render();
  keepAwake();
  await poll();
  setInterval(poll, 1500);
  setInterval(tickTimers, 1000);
})();

export { now };
