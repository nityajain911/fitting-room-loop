// Rule-based routing and queue ordering. Priority is request type, then waiting time.
// Expected spend is never an input.
import { isOpen, ownerRole } from './derive.js';

const RULES = {
  too_tight: { role: 'runner', rank: 1 },
  too_loose: { role: 'runner', rank: 1 },
  too_long: { role: 'runner', rank: 1 },
  too_short: { role: 'runner', rank: 1 },
  another_size: { role: 'runner', rank: 2 },
  another_style: { role: 'runner', rank: 3 },
  check_stock: { role: 'floor', rank: 2 },
};
const rule = (issue) =>
  issue === 'check_stock' ? 'stock check -> floor associate' : `${issue.startsWith('too_') ? 'fit issue' : issue} -> fitting-room runner`;

export function routeFor(issue) {
  const r = RULES[issue];
  if (!r) throw new Error(`Unknown issue: ${issue}`);
  return { ...r, rule: rule(issue) };
}

export const TASK_ROUTE = { role: 'floor', rank: 1, rule: 'floor pull -> floor associate' };

// Customer work first; a restock task the manager dispatched waits behind it.
const rankOf = (x) => (x.taskType === 'restock' ? 4 : x.kind === 'task' ? TASK_ROUTE.rank : RULES[x.issue]?.rank ?? 9);

/** Open requests/tasks for a role, ordered by type rank, then longest waiting first. */
export function buildQueue(role, derived, now) {
  const items = [...derived.requests, ...derived.tasks].filter((x) => x.route?.role === role && isOpen(x));
  return items.sort((a, b) => rankOf(a) - rankOf(b) || a.createdTs - b.createdTs || (a.id < b.id ? -1 : 1));
}

/** Most recently finished (closed or cancelled) customer requests for a role, newest first. */
export function recentlyClosed(role, derived, limit = 5) {
  const end = (r) => r.closedTs ?? r.cancelledTs;
  return derived.requests
    .filter((r) => r.route?.role === role && (r.status === 'closed' || r.status === 'cancelled'))
    .sort((a, b) => end(b) - end(a))
    .slice(0, limit);
}

/**
 * Escalated items are mirrored to the other role so someone can step in.
 * offer: escalated right now, not yet picked up, held by the other team. assisting: picked up by this role.
 */
export function buildAssistQueue(role, derived) {
  const all = [...derived.requests, ...derived.tasks].filter(isOpen);
  const offer = all
    .filter((x) => x.escalated && ownerRole(x) !== role && !x.assistedNow)
    .sort((a, b) => a.escalatedTs - b.escalatedTs || (a.id < b.id ? -1 : 1));
  const assisting = all
    .filter((x) => x.assistedBy === role)
    .sort((a, b) => a.assistedTs - b.assistedTs || (a.id < b.id ? -1 : 1));
  return { offer, assisting };
}
