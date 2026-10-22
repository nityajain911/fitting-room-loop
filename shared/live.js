// The floor right now: how many are waiting and for how long, who holds what, and what each fitting room is doing.
// Read from the same derived events as everything else; nothing here is stored.
import { isOpen, stageStart } from './derive.js';
import { loadOf } from './staffing.js';

/** What a room is doing, from its open requests: the furthest-along one decides, but anything waiting shows first. */
const ORDER = ['waiting', 'accepted', 'on_the_way', 'trying'];
const stateOf = (r) => (r.status === 'requested' ? 'waiting' : r.status === 'accepted' ? 'accepted' : r.deliveredTs != null ? 'trying' : 'on_the_way');

export function liveFloor(derived, now, { rooms, roster = [] }) {
  const open = derived.requests.filter(isOpen);
  const waiting = open.filter((r) => r.status === 'requested');
  const longest = waiting.length ? Math.max(...waiting.map((r) => now - stageStart(r, 'accept'))) : null;
  const escalatedItems = [...open, ...derived.tasks.filter(isOpen)].filter((x) => x.escalated);
  const roomState = (n) => {
    const here = open.filter((r) => r.room === n);
    if (!here.length) return { n, state: 'free', esc: false };
    const states = here.map(stateOf);
    return { n, state: ORDER.find((s) => states.includes(s)), esc: here.some((r) => r.escalated) };
  };
  return {
    waiting: waiting.length,
    longestWaitMs: longest,
    oldestWaiting: waiting.length ? waiting.reduce((a, b) => (stageStart(a, 'accept') <= stageStart(b, 'accept') ? a : b)) : null, // for a ticking timer
    inProgress: open.filter((r) => r.status === 'accepted' || (r.status === 'on_the_way' && r.deliveredTs == null)).length,
    tryingOn: open.filter((r) => r.status === 'on_the_way' && r.deliveredTs != null).length,
    escalated: escalatedItems.length,
    tasks: derived.tasks.filter((t) => isOpen(t) && t.taskType !== 'restock').length,
    rooms: rooms.map(roomState),
    team: roster.map((p) => ({ id: p.id, label: p.label, type: p.type, load: loadOf(derived, p.id), here: !!(p.onShift && p.active) })),
  };
}
