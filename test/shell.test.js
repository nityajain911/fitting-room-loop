import test from 'node:test';
import assert from 'node:assert/strict';
import { VIEWS_BY_MODE, isMode, allowedView, homeOf, showNav, showAdminLink, MODE_PARAM } from '../shared/modes.js';
import { newAttention } from '../shared/alerts.js';
import { typicalAcceptMs, computeMetrics } from '../shared/metrics.js';
import { deriveAll } from '../shared/derive.js';
import { waitPhrase } from '../shared/visuals.js';
import { makeLog } from './helpers.js';

test('a device is locked to one role: the customer tablet sees only the customer screen, staff phones only the associate screen', () => {
  assert.deepEqual(VIEWS_BY_MODE.customer, ['customer']);
  assert.deepEqual(VIEWS_BY_MODE.staff, ['associate']);
  assert.deepEqual(VIEWS_BY_MODE.manager, ['manager', 'admin']);
  assert.deepEqual(VIEWS_BY_MODE.demo, ['customer', 'associate', 'manager', 'admin']); // an unlocked browser still sees everything
  assert.equal(allowedView('customer', 'manager'), false);
  assert.equal(allowedView('staff', 'associate'), true);
  assert.equal(allowedView('demo', 'admin'), true);
  assert.equal(homeOf('customer'), 'customer');
  assert.equal(homeOf('manager'), 'manager');
  assert.ok(isMode('staff') && !isMode('boss') && !isMode(undefined));
  assert.equal(MODE_PARAM, 'mode');
});

test('navigation and the Admin link are only for an unlocked browser and the manager', () => {
  assert.deepEqual(['demo', 'customer', 'staff', 'manager'].map(showNav), [true, false, false, false]);
  assert.deepEqual(['demo', 'customer', 'staff', 'manager'].map(showAdminLink), [true, false, false, true]);
});

test('newAttention reports what is new since last time, and what just became urgent', () => {
  const prev = new Map([['a', false], ['b', false]]);
  const cur = new Map([['a', false], ['b', true], ['c', false], ['d', true]]);
  assert.deepEqual(newAttention(prev, cur), { added: ['c'], urgent: ['b', 'd'], count: 4 });
  assert.deepEqual(newAttention(cur, cur), { added: [], urgent: [], count: 4 });                   // nothing changed: silence
  assert.deepEqual(newAttention(cur, new Map()), { added: [], urgent: [], count: 0 });             // things got done
  assert.deepEqual(newAttention(new Map(), new Map([['x', false]])), { added: ['x'], urgent: [], count: 1 });
});

const acceptedAfter = (add, id, ms) => {
  add(0, id, 'created', { room: 1, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [], parsed: null, method: 'none' }, 'customer');
  add(0, id, 'routed', { role: 'runner', rule: 'x' });
  add(ms, id, 'accepted', { role: 'runner' }, 'runner');
};

test('the typical wait is the median time to accept, and only once there are enough requests to say so', () => {
  const { events, add } = makeLog();
  acceptedAfter(add, 'a', 30_000); acceptedAfter(add, 'b', 90_000);
  assert.equal(typicalAcceptMs(deriveAll(events).requests), null);                                  // two is too few to promise anything
  acceptedAfter(add, 'c', 60_000);
  assert.equal(typicalAcceptMs(deriveAll(events).requests), 60_000);
  assert.equal(computeMetrics(events).medianAcceptMs, 60_000);                                      // same number the Manager sees
  add(0, 'd', 'created', { room: 1, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [], parsed: null, method: 'none' }, 'customer');
  assert.equal(typicalAcceptMs(deriveAll(events).requests), 60_000);                                // a request still waiting does not count
});

test('waitPhrase says it in a few words', () => {
  assert.equal(waitPhrase(20_000), 'under a minute');
  assert.equal(waitPhrase(44_999), 'under a minute');
  assert.equal(waitPhrase(60_000), 'about 1 min');
  assert.equal(waitPhrase(110_000), 'about 2 min');
  assert.equal(waitPhrase(null), null);
});
