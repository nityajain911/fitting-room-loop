import test from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig } from '../shared/config.js';

test('smallSampleN is a prototype setting with an env override', () => {
  assert.equal(makeConfig().smallSampleN, 5);
  assert.equal(makeConfig({ SMALL_SAMPLE_N: '10' }).smallSampleN, 10);
  assert.equal(makeConfig({ SMALL_SAMPLE_N: 'x' }).smallSampleN, 5);
});

test('signal thresholds are prototype settings with env overrides', () => {
  const c = makeConfig();
  assert.deepEqual([c.signalMinN, c.signalMinShare, c.signalMinMisses], [3, 0.6, 1]);
  const o = makeConfig({ SIGNAL_MIN_N: '4', SIGNAL_MIN_SHARE: '0.75', SIGNAL_MIN_MISSES: '2' });
  assert.deepEqual([o.signalMinN, o.signalMinShare, o.signalMinMisses], [4, 0.75, 2]);
  assert.equal(makeConfig({ SIGNAL_MIN_SHARE: '7' }).signalMinShare, 0.6); // a share above 100% is rejected
});

test('signalMinPulls is a prototype setting with an env override', () => {
  assert.equal(makeConfig().signalMinPulls, 2);
  assert.equal(makeConfig({ SIGNAL_MIN_PULLS: '4' }).signalMinPulls, 4);
});

test('escalation has one time per stage, with the old ESCALATE_SECONDS as the shared default', () => {
  const c = makeConfig();
  assert.deepEqual([c.acceptEscalateSeconds, c.deliverEscalateSeconds, c.warnShare], [120, 120, 0.5]);
  const o = makeConfig({ ACCEPT_ESCALATE_SECONDS: '90', DELIVER_ESCALATE_SECONDS: '240' });
  assert.deepEqual([o.acceptEscalateSeconds, o.deliverEscalateSeconds], [90, 240]);
  const legacy = makeConfig({ ESCALATE_SECONDS: '150' });
  assert.deepEqual([legacy.acceptEscalateSeconds, legacy.deliverEscalateSeconds], [150, 150]);
});

test('primary and secondary waits are prototype settings with env overrides', () => {
  const c = makeConfig();
  assert.deepEqual([c.primaryWaitSeconds, c.secondaryWaitSeconds, c.staffActiveSeconds], [20, 20, 60]);
  const o = makeConfig({ PRIMARY_WAIT_SECONDS: '30', SECONDARY_WAIT_SECONDS: '45', STAFF_ACTIVE_SECONDS: '90' });
  assert.deepEqual([o.primaryWaitSeconds, o.secondaryWaitSeconds, o.staffActiveSeconds], [30, 45, 90]);
  assert.equal(makeConfig({ PRIMARY_WAIT_SECONDS: 'x' }).primaryWaitSeconds, 20);
  assert.equal(makeConfig().specialistOverflowSeconds, undefined); // replaced by the two waits
});
