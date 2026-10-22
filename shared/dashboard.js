// What the Manager dashboard shows over time. Pure helpers for the screen: which requests a time range covers, and how
// the store's signals are grouped so seven similar ones read as one.

export const RANGES = [
  { key: 'hour', label: 'Last hour' },
  { key: 'today', label: 'Today' },
  { key: 'week', label: '7 days' },
  { key: 'all', label: 'All' },
];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The earliest time a range covers, or null for "all". "Today" is since local midnight. */
export function rangeStart(key, now) {
  if (key === 'hour') return now - HOUR;
  if (key === 'today') { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (key === 'week') return now - 7 * DAY;
  return null;
}

/**
 * The events of every request (and restock task) created at or after `since`, whole: a request that started inside the
 * range is counted with everything that happened to it, a request from before it is not counted at all. So a figure
 * never mixes half a request. A floor pull belongs with the request it was asked for.
 */
export function eventsSince(events, since) {
  if (since == null) return events;
  const keep = new Set();
  for (const e of events) if ((e.type === 'created' || e.type === 'restock_task_created') && e.ts >= since) keep.add(e.requestId);
  for (const e of events) if (e.type === 'floor_pull_requested' && keep.has(e.requestId) && e.payload?.taskId) keep.add(e.payload.taskId);
  return events.filter((e) => keep.has(e.requestId));
}

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };
const rank = (s) => SEVERITY_RANK[s] ?? 0;

/** Signals grouped by kind. The group with the most serious signal comes first (then the bigger one); within a group, the most serious first. */
export function groupSignals(signals) {
  const by = new Map();
  for (const s of signals) {
    if (!by.has(s.kind)) by.set(s.kind, []);
    by.get(s.kind).push(s);
  }
  return [...by.entries()]
    .map(([kind, list]) => {
      const items = [...list].sort((a, b) => rank(b.action?.severity) - rank(a.action?.severity));
      return { kind, items, severity: items[0].action?.severity ?? null };
    })
    .sort((a, b) => rank(b.severity) - rank(a.severity) || b.items.length - a.items.length); // a tie goes to the bigger group
}
