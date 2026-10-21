import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveAll } from '../shared/derive.js';
import {
  normaliseStaff, loadOf, pickAssignee, nextAssignment, accessFor, MAX_STAFF,
} from '../shared/staffing.js';
import { makeLog } from './helpers.js';

const person = (id, type, primary = [], secondary = [], over = {}) => ({ id, label: id, type, primary, secondary, onShift: true, ...over });
const SHIRT = 'Men|shirt';
const POLO = 'Men|polo';

// A men's-shirt fit request (skill Men|shirt) routed to runners.
const mkReq = (add, id, ts = 0) => {
  add(ts, id, 'created', { room: 1, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [], parsed: null, method: 'none' });
  add(ts, id, 'routed', { role: 'runner', rule: 'x' });
};
const ctx = (roster, derived, now, over = {}) => ({
  roster, derived, now, isActive: () => true, primaryWaitMs: 20_000, secondaryWaitMs: 20_000, ...over,
});

test('normaliseStaff: label, type and sections are validated; a section is primary or secondary, not both', () => {
  assert.deepEqual(normaliseStaff({ label: '  Asha ', type: 'runner', primary: [SHIRT], secondary: [POLO] }),
    { label: 'Asha', type: 'runner', primary: [SHIRT], secondary: [POLO] });
  assert.deepEqual(normaliseStaff({ label: 'Floor 1', type: 'floor' }), { label: 'Floor 1', type: 'floor', primary: [], secondary: [] });
  assert.throws(() => normaliseStaff({ label: '', type: 'runner' }), /label/i);
  assert.throws(() => normaliseStaff({ label: 'x'.repeat(31), type: 'runner' }), /label/i);
  assert.throws(() => normaliseStaff({ label: 'A', type: 'manager' }), /type/i);
  assert.throws(() => normaliseStaff({ label: 'A', type: 'runner', primary: ['Kids|shirt'] }), /section/i);
  assert.throws(() => normaliseStaff({ label: 'A', type: 'runner', primary: [SHIRT], secondary: [SHIRT] }), /both/i);
  assert.deepEqual(normaliseStaff({ primary: [SHIRT, SHIRT] }, { partial: true }), { primary: [SHIRT] }); // partial update, de-duplicated
  assert.deepEqual(normaliseStaff({ onShift: false }, { partial: true }), { onShift: false });
  assert.throws(() => normaliseStaff({ onShift: 'no' }, { partial: true }), /shift/i);
  assert.equal(MAX_STAFF, 30);
});

test('load is open items assigned to someone (still waiting) plus items they accepted and have not finished', () => {
  const { events, add } = makeLog();
  mkReq(add, 'a'); add(1, 'a', 'assigned', { tier: 'primary', staffId: 'p1' });
  mkReq(add, 'b'); add(1, 'b', 'assigned', { tier: 'primary', staffId: 'p1' }); add(5, 'b', 'accepted', { role: 'runner', staffId: 'p1', tier: 'primary' });
  mkReq(add, 'c'); add(1, 'c', 'assigned', { tier: 'primary', staffId: 'p1' }); add(5, 'c', 'accepted', { role: 'runner', staffId: 'p2', tier: 'open' }); // someone else took it
  mkReq(add, 'd'); add(1, 'd', 'assigned', { tier: 'primary', staffId: 'p1' }); add(5, 'd', 'accepted', { role: 'runner', staffId: 'p1', tier: 'primary' }); add(9, 'd', 'closed', { outcome: 'left' });
  const d = deriveAll(events);
  assert.equal(loadOf(d, 'p1'), 2); // a (waiting) and b (accepted); c went to p2, d is closed
  assert.equal(loadOf(d, 'p2'), 1); // c
  assert.equal(loadOf(d, 'nobody'), 0);
});

test('primary goes to the least busy on-shift, active person of the right type who has the section as primary', () => {
  const { events, add } = makeLog();
  mkReq(add, 'old'); add(1, 'old', 'assigned', { tier: 'primary', staffId: 'r1' }); add(2, 'old', 'accepted', { role: 'runner', staffId: 'r1', tier: 'primary' });
  mkReq(add, 'new', 10);
  const d = deriveAll(events);
  const item = d.byId.new;
  const roster = [
    person('r1', 'runner', [SHIRT]),                          // busy: 1 open
    person('r2', 'runner', [SHIRT]),                          // free
    person('r3', 'runner', [POLO]),                           // wrong section
    person('f1', 'floor', [SHIRT]),                           // wrong type
    person('r4', 'runner', [SHIRT], [], { onShift: false }),  // off shift
  ];
  assert.equal(pickAssignee(item, 'primary', ctx(roster, d, 10)).id, 'r2');
  // inactive phones are skipped
  assert.equal(pickAssignee(item, 'primary', ctx(roster, d, 10, { isActive: (id) => id !== 'r2' })).id, 'r1');
  // nobody qualifies -> null
  assert.equal(pickAssignee(item, 'primary', ctx([person('r3', 'runner', [POLO])], d, 10)), null);
});

test('ties on load go to whoever was given a request least recently (round robin)', () => {
  const { events, add } = makeLog();
  mkReq(add, 'x'); add(1, 'x', 'assigned', { tier: 'primary', staffId: 'r1' }); add(2, 'x', 'accepted', { role: 'runner', staffId: 'r1', tier: 'primary' }); add(3, 'x', 'closed', { outcome: 'left' });
  mkReq(add, 'n', 10);
  const d = deriveAll(events);
  const roster = [person('r1', 'runner', [SHIRT]), person('r2', 'runner', [SHIRT])];
  assert.equal(pickAssignee(d.byId.n, 'primary', ctx(roster, d, 10)).id, 'r2'); // r1 had the last one
});

test('secondary: least busy person with the section as secondary, not already holding the request; other primaries are fallback candidates', () => {
  const { events, add } = makeLog();
  mkReq(add, 'n'); add(1, 'n', 'assigned', { tier: 'primary', staffId: 'p1' });
  const d = deriveAll(events);
  const roster = [person('p1', 'runner', [SHIRT]), person('p2', 'runner', [SHIRT]), person('s1', 'runner', [], [SHIRT]), person('s2', 'runner', [], [SHIRT])];
  const pick = pickAssignee(d.byId.n, 'secondary', ctx(roster, d, 30));
  assert.ok(['s1', 's2'].includes(pick.id)); // a secondary-listed person is preferred on equal load, and p1 is excluded
  assert.notEqual(pick.id, 'p1');
  assert.equal(pickAssignee(d.byId.n, 'secondary', ctx([person('p1', 'runner', [SHIRT])], d, 30)), null); // nobody else exists
  assert.equal(pickAssignee(d.byId.n, 'secondary', ctx([person('p1', 'runner', [SHIRT]), person('p2', 'runner', [SHIRT])], d, 30)).id, 'p2');
});

test('the timeline: primary now, secondary after the primary wait, everyone after the secondary wait', () => {
  const { events, add } = makeLog();
  mkReq(add, 'n', 0);
  const roster = [person('p1', 'runner', [SHIRT]), person('s1', 'runner', [], [SHIRT])];
  const step = (now) => {
    const d = deriveAll(events);
    return nextAssignment(d.byId.n, ctx(roster, d, now));
  };
  let n = step(0);
  assert.deepEqual(n, { tier: 'primary', staffId: 'p1' });
  add(0, 'n', 'assigned', n);
  assert.equal(step(19_999), null);                                 // still the primary's call
  n = step(20_000);
  assert.deepEqual(n, { tier: 'secondary', staffId: 's1' });        // the primary does NOT lose it; the secondary is added
  add(20_000, 'n', 'assigned', n);
  assert.equal(step(39_999), null);
  n = step(40_000);
  assert.deepEqual(n, { tier: 'open', staffId: null });
  add(40_000, 'n', 'assigned', n);
  assert.equal(step(99_000), null);                                 // nothing further to do
});

test('skipped tiers do not wait: no primary at all goes straight to secondary; no secondary either opens at once', () => {
  const { events, add } = makeLog();
  mkReq(add, 'n', 0);
  let d = deriveAll(events);
  let n = nextAssignment(d.byId.n, ctx([person('s1', 'runner', [], [SHIRT])], d, 0));
  assert.deepEqual(n, { tier: 'primary', staffId: null });          // recorded as "nobody", so no wait
  add(0, 'n', 'assigned', n);
  d = deriveAll(events);
  n = nextAssignment(d.byId.n, ctx([person('s1', 'runner', [], [SHIRT])], d, 0));
  assert.deepEqual(n, { tier: 'secondary', staffId: 's1' });
  add(0, 'n', 'assigned', n);

  const e2 = makeLog();
  mkReq(e2.add, 'm', 0);
  let d2 = deriveAll(e2.events);
  const empty = [person('f1', 'floor', [SHIRT])];                   // exists, but cannot take a runner request
  e2.add(0, 'm', 'assigned', nextAssignment(d2.byId.m, ctx(empty, d2, 0)));
  d2 = deriveAll(e2.events);
  e2.add(0, 'm', 'assigned', nextAssignment(d2.byId.m, ctx(empty, d2, 0)));
  d2 = deriveAll(e2.events);
  assert.deepEqual(nextAssignment(d2.byId.m, ctx(empty, d2, 0)), { tier: 'open', staffId: null });
});

test('nothing is assigned once a request is accepted, closed or cancelled', () => {
  const { events, add } = makeLog();
  mkReq(add, 'n', 0); add(1, 'n', 'accepted', { role: 'runner', staffId: 'p1', tier: 'open' });
  const d = deriveAll(events);
  assert.equal(nextAssignment(d.byId.n, ctx([person('p1', 'runner', [SHIRT])], d, 0)), null);
});

test('accessFor: who can see (and so accept) a request right now', () => {
  const { events, add } = makeLog();
  mkReq(add, 'n', 0);
  add(0, 'n', 'assigned', { tier: 'primary', staffId: 'p1' });
  const roster = [person('p1', 'runner', [SHIRT]), person('s1', 'runner', [], [SHIRT]), person('o', 'runner')];
  let d = deriveAll(events);
  assert.deepEqual(accessFor(d.byId.n, roster[0], roster), { visible: true, tier: 'primary' });
  assert.deepEqual(accessFor(d.byId.n, roster[1], roster), { visible: false, tier: null });
  add(20_000, 'n', 'assigned', { tier: 'secondary', staffId: 's1' });
  d = deriveAll(events);
  assert.deepEqual(accessFor(d.byId.n, roster[1], roster), { visible: true, tier: 'secondary' });
  assert.deepEqual(accessFor(d.byId.n, roster[0], roster), { visible: true, tier: 'primary' }); // the first person keeps it
  assert.equal(accessFor(d.byId.n, roster[2], roster).visible, false);
  add(40_000, 'n', 'assigned', { tier: 'open', staffId: null });
  d = deriveAll(events);
  assert.deepEqual(accessFor(d.byId.n, roster[2], roster), { visible: true, tier: 'open' });
});

test('accessFor: an escalated request is open to everyone; with no roster there is no restriction', () => {
  const { events, add } = makeLog();
  mkReq(add, 'n', 0);
  add(0, 'n', 'assigned', { tier: 'primary', staffId: 'p1' });
  const roster = [person('p1', 'runner', [SHIRT]), person('o', 'runner')];
  add(125_000, 'n', 'escalated', { level: 1, stage: 'accept' });
  const d = deriveAll(events);
  assert.deepEqual(accessFor(d.byId.n, roster[1], roster), { visible: true, tier: 'open' });
  assert.deepEqual(accessFor(d.byId.n, roster[0], []), { visible: true, tier: 'open' });
});
