// Who gets a request. The admin keeps a roster of team members (a label, runner or floor associate, primary and
// secondary sections, on/off shift). A new request goes to the least busy person who has its section as primary.
// If nobody has accepted after the primary wait, the least busy person with it as secondary is added: the first
// person keeps it too. After the secondary wait it opens to everyone. Whoever accepts first serves it.
// Pure functions over the roster and the derived events; the server appends the `assigned` events.
import { ALL_SKILLS } from './skills.js';
import { ROLES } from './events.js';
import { isOpen } from './derive.js';

export const MAX_STAFF = 30;
export const TIERS = ['primary', 'secondary', 'open'];

const uniqueSections = (list, what) => {
  if (!Array.isArray(list)) throw new Error(`${what} sections must be a list`);
  if (list.some((k) => !ALL_SKILLS.includes(k))) throw new Error(`Unknown section in ${what}`);
  return [...new Set(list)];
};

/**
 * Validate a team member's fields. Whole record by default; `partial` accepts any subset (an update).
 * A section may be primary or secondary for one person, not both.
 */
export function normaliseStaff(input = {}, { partial = false } = {}) {
  const out = {};
  if (!partial || 'label' in input) {
    const label = typeof input.label === 'string' ? input.label.trim() : '';
    if (!label || label.length > 30) throw new Error('A label of 1 to 30 characters is required');
    out.label = label;
  }
  if (!partial || 'type' in input) {
    if (!(input.type in ROLES)) throw new Error('Type must be runner or floor');
    out.type = input.type;
  }
  if (!partial || 'primary' in input) out.primary = uniqueSections(input.primary ?? [], 'primary');
  if (!partial || 'secondary' in input) out.secondary = uniqueSections(input.secondary ?? [], 'secondary');
  if ('onShift' in input) {
    if (typeof input.onShift !== 'boolean') throw new Error('onShift must be true or false');
    out.onShift = input.onShift;
  }
  if (out.primary && out.secondary && out.primary.some((k) => out.secondary.includes(k))) throw new Error('A section cannot be both primary and secondary');
  return out;
}

/** Open work held by a person: requests waiting that were given to them, plus what they accepted and not yet finished. */
export function loadOf(derived, staffId) {
  let n = 0;
  for (const x of [...derived.requests, ...derived.tasks]) {
    if (!isOpen(x)) continue;
    if (x.status === 'requested' ? x.assignments.some((a) => a.staffId === staffId) : x.acceptedStaffId === staffId) n += 1;
  }
  return n;
}

/** When this person was last given a request (for fair tie-breaks); -1 if never. */
function lastAssignedTs(derived, staffId) {
  let last = -1;
  for (const x of [...derived.requests, ...derived.tasks]) for (const a of x.assignments) if (a.staffId === staffId) last = Math.max(last, a.ts);
  return last;
}

/**
 * The person a tier should go to, or null. ctx: { roster, derived, isActive(id), ... }.
 * Candidates are on shift, phone on, the right type for the item, and not already holding it.
 * primary: has the section as primary. secondary: has it as secondary (other primaries only as a fallback).
 * Least busy wins; ties go to a secondary-listed person, then to whoever was given a request least recently.
 */
export function pickAssignee(item, tier, ctx) {
  const role = item.route?.role;
  const holding = new Set(item.assignments.map((a) => a.staffId).filter(Boolean));
  const ranked = ctx.roster
    .filter((s) => s.onShift && s.type === role && ctx.isActive(s.id) && !holding.has(s.id))
    .map((s) => ({ s, listed: s.primary.includes(item.skill) ? 'primary' : s.secondary.includes(item.skill) ? 'secondary' : null }))
    .filter(({ listed }) => (tier === 'primary' ? listed === 'primary' : listed != null))
    .map(({ s, listed }) => ({ s, key: [loadOf(ctx.derived, s.id), listed === 'secondary' ? 0 : 1, lastAssignedTs(ctx.derived, s.id), s.id] }))
    .sort((a, b) => {
      for (let i = 0; i < a.key.length; i += 1) if (a.key[i] !== b.key[i]) return a.key[i] < b.key[i] ? -1 : 1;
      return 0;
    });
  return ranked.length ? ranked[0].s : null;
}

/**
 * The next `assigned` event a waiting request is due, or null. A tier with nobody to give it to is recorded with a
 * null person and does not wait, so a request never sits waiting for a person who does not exist.
 */
export function nextAssignment(item, ctx) {
  if (!isOpen(item) || item.status !== 'requested' || !item.route) return null;
  const find = (tier) => item.assignments.find((a) => a.tier === tier);
  if (find('open')) return null;
  const primary = find('primary');
  if (!primary) return { tier: 'primary', staffId: pickAssignee(item, 'primary', ctx)?.id ?? null };
  const secondary = find('secondary');
  if (!secondary) {
    if (primary.staffId && ctx.now - primary.ts < ctx.primaryWaitMs) return null;
    return { tier: 'secondary', staffId: pickAssignee(item, 'secondary', ctx)?.id ?? null };
  }
  if (secondary.staffId && ctx.now - secondary.ts < ctx.secondaryWaitMs) return null;
  return { tier: 'open', staffId: null };
}

/**
 * Whether a team member can see (and so accept) an item now, and in which capacity.
 * With no roster there is no restriction. Escalated items are open to everyone.
 */
export function accessFor(item, staff, roster) {
  if (!roster.length) return { visible: true, tier: 'open' };
  const mine = item.assignments.find((a) => a.staffId === staff.id);
  if (mine) return { visible: true, tier: mine.tier };
  if (item.escalated || item.openToAll) return { visible: true, tier: 'open' };
  return { visible: false, tier: null };
}
