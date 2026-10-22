import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveAll } from '../shared/derive.js';
import { RANGES, rangeStart, eventsSince, groupSignals } from '../shared/dashboard.js';
import { liveFloor } from '../shared/live.js';
import { plainDuration, timingTimeline } from '../shared/timing.js';
import { computeMetrics } from '../shared/metrics.js';
import { makeLog } from './helpers.js';

const open = (add, id, ts, room = 1) => {
  add(ts, id, 'created', { room, skuId: 'OX-M-SLIM', issue: 'too_tight', issues: ['too_tight'], chips: [], parsed: null, method: 'none' }, 'customer');
  add(ts, id, 'routed', { role: 'runner', rule: 'fit issue -> runner' });
};

// ---------- time ranges ----------
test('ranges: the start of each, and "all" has none', () => {
  const now = new Date(2026, 9, 22, 15, 30).getTime();
  assert.deepEqual(RANGES.map((r) => r.key), ['hour', 'today', 'week', 'all']);
  assert.equal(rangeStart('hour', now), now - 3_600_000);
  assert.equal(rangeStart('today', now), new Date(2026, 9, 22, 0, 0).getTime());
  assert.equal(rangeStart('week', now), now - 7 * 86_400_000);
  assert.equal(rangeStart('all', now), null);
  assert.equal(rangeStart('nonsense', now), null);
});

test('a range keeps every request created inside it with all its events, and its floor pulls; nothing else', () => {
  const { events, add } = makeLog();
  open(add, 'old', 1000);
  add(1500, 'old', 'accepted', { role: 'runner' }, 'runner');
  add(9000, 'old', 'closed', { outcome: 'left' }, 'runner');   // closed inside the window, but created before it
  open(add, 'new', 5000);
  add(5100, 'new', 'accepted', { role: 'runner' }, 'runner');
  add(5200, 'new', 'floor_pull_requested', { taskId: 't1', itemId: 'OX-M-REG', rack: 'A4' }, 'runner');
  add(5300, 't1', 'accepted', { role: 'floor' }, 'floor');
  const kept = eventsSince(events, 4000);
  assert.deepEqual([...new Set(kept.map((e) => e.requestId))].sort(), ['new', 't1']);
  assert.equal(kept.length, 5);
  assert.equal(eventsSince(events, null), events);
  assert.equal(computeMetrics(eventsSince(events, 4000)).total, 1);
  assert.equal(computeMetrics(eventsSince(events, 0)).total, 2);
});

// ---------- grouped signals ----------
test('signals are grouped by kind, the most serious group first, with the worst severity named', () => {
  const sig = (kind, severity, text) => ({ kind, text, action: { label: 'x', severity } });
  const g = groupSignals([sig('high_demand', 'low', 'a'), sig('high_demand', 'low', 'b'), sig('inventory', 'high', 'c'), sig('fit', 'medium', 'd'), sig('high_demand', 'medium', 'e')]);
  assert.deepEqual(g.map((x) => [x.kind, x.items.length, x.severity]), [['inventory', 1, 'high'], ['high_demand', 3, 'medium'], ['fit', 1, 'medium']]);
  assert.deepEqual(groupSignals([]), []);
});

// ---------- the live floor ----------
test('the live floor: queue depth, longest wait, who is where, room by room', () => {
  const { events, add } = makeLog();
  open(add, 'a', 1_000, 1);                                                           // waiting 29 s
  open(add, 'b', 10_000, 2);                                                          // waiting 20 s
  open(add, 'c', 0, 3); add(5_000, 'c', 'accepted', { role: 'runner' }, 'runner');    // being prepared
  open(add, 'd', 0, 4); add(1_000, 'd', 'accepted', { role: 'runner' }, 'runner');
  add(2_000, 'd', 'suggestion_shown', { kind: 'alternative', itemId: 'OX-M-REG', itemIds: ['OX-M-REG'], options: [{ itemId: 'OX-M-REG', forId: 'OX-M-SLIM' }] });
  add(3_000, 'd', 'suggestion_confirmed', { itemId: 'OX-M-REG', itemIds: ['OX-M-REG'] }, 'runner');
  add(3_000, 'd', 'on_the_way', { room: 4, itemId: 'OX-M-REG', itemLabel: 'x', items: [{ itemId: 'OX-M-REG', itemLabel: 'x', forId: 'OX-M-SLIM' }] }, 'runner');
  open(add, 'e', 0, 5); add(1_000, 'e', 'accepted', { role: 'runner' }, 'runner');
  add(2_000, 'e', 'suggestion_shown', { kind: 'alternative', itemId: 'OX-M-REG', itemIds: ['OX-M-REG'], options: [{ itemId: 'OX-M-REG', forId: 'OX-M-SLIM' }] });
  add(3_000, 'e', 'suggestion_confirmed', { itemId: 'OX-M-REG', itemIds: ['OX-M-REG'] }, 'runner');
  add(3_000, 'e', 'on_the_way', { room: 5, itemId: 'OX-M-REG', itemLabel: 'x', items: [{ itemId: 'OX-M-REG', itemLabel: 'x', forId: 'OX-M-SLIM' }] }, 'runner');
  add(4_000, 'e', 'delivered', {}, 'runner');                                         // trying on
  open(add, 'f', 0, 6); add(1_000, 'f', 'accepted', { role: 'runner' }, 'runner'); add(2_000, 'f', 'closed', { outcome: 'left' }, 'runner'); // finished: not on the floor
  const d = deriveAll(events);
  const roster = [{ id: 's1', label: 'Runner 1', type: 'runner', onShift: true, active: true }, { id: 's2', label: 'Runner 2', type: 'runner', onShift: false, active: false }];
  const f = liveFloor(d, 30_000, { rooms: [1, 2, 3, 4, 5, 6], roster });
  assert.deepEqual([f.waiting, f.longestWaitMs, f.inProgress, f.tryingOn, f.escalated], [2, 29_000, 2, 1, 0]);
  assert.deepEqual(f.rooms.map((r) => [r.n, r.state]), [[1, 'waiting'], [2, 'waiting'], [3, 'accepted'], [4, 'on_the_way'], [5, 'trying'], [6, 'free']]);
  assert.deepEqual(f.team.map((p) => [p.label, p.load, p.here]), [['Runner 1', 0, true], ['Runner 2', 0, false]]);
});

test('the live floor with nothing open has no longest wait, and an escalation flags its room', () => {
  const empty = liveFloor(deriveAll([]), 0, { rooms: [1, 2], roster: [] });
  assert.deepEqual([empty.waiting, empty.longestWaitMs, empty.inProgress, empty.rooms.every((r) => r.state === 'free')], [0, null, 0, true]);
  const { events, add } = makeLog();
  open(add, 'a', 0, 2);
  add(130_000, 'a', 'escalated', { stage: 'accept' });
  const f = liveFloor(deriveAll(events), 131_000, { rooms: [1, 2], roster: [] });
  assert.equal(f.escalated, 1);
  assert.deepEqual(f.rooms.map((r) => [r.n, r.state, r.esc]), [[1, 'free', false], [2, 'waiting', true]]);
});

// ---------- plain-language timing ----------
test('durations in plain words', () => {
  assert.equal(plainDuration(20), '20 seconds');
  assert.equal(plainDuration(1), '1 second');
  assert.equal(plainDuration(60), '1 minute');
  assert.equal(plainDuration(120), '2 minutes');
  assert.equal(plainDuration(150), '2 min 30 s');
  assert.equal(plainDuration(3600), '1 hour');
});

test('the timing timeline lists what happens and when, in order', () => {
  const cfg = { primaryWaitSeconds: 20, secondaryWaitSeconds: 20, acceptEscalateSeconds: 120, deliverEscalateSeconds: 90 };
  assert.deepEqual(timingTimeline(cfg), [
    { at: 0, what: 'Main person is asked' },
    { at: 20, what: 'Backup is asked too' },
    { at: 40, what: 'Everyone is asked' },
    { at: 120, what: 'Manager is alerted' },
  ]);
  assert.deepEqual(timingTimeline({ ...cfg, acceptEscalateSeconds: 30 }).map((s) => s.what), ['Main person is asked', 'Backup is asked too', 'Manager is alerted', 'Everyone is asked']);
});
