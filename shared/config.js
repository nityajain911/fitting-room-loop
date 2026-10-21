// Prototype settings. Shown in the UI as "prototype settings"; override via env vars on the server.
export const DEFAULTS = {
  // Escalation is per stage. Stage 1: from the customer's request until someone accepts it.
  // Stage 2: from accept until the item is on its way to the customer (floor pulls: until handed over).
  acceptEscalateSeconds: 120,
  deliverEscalateSeconds: 120,
  warnShare: 0.5, // a card turns amber at this share of its stage time
  alterationOffered: true,
  minImprovementCm: 1.0,
  smallSampleN: 5, // per-SKU breakdowns with fewer requests are flagged as a small sample
  signalMinN: 3, // a store signal needs at least this many requests (or suggestions) for the SKU...
  signalMinShare: 0.6, // ...and at least this share of them to point the same way
  signalMinMisses: 1, // a rack is flagged for a recount after this many "not on rack" reports
  signalMinPulls: 2, // a replacement brought to the fitting rooms this many times is flagged as high demand
  bringCount: 3, // how many best options a runner brings in one trip (1 to 5)
  primaryWaitSeconds: 20, // a request is with its primary person this long, then a secondary person is added
  secondaryWaitSeconds: 20, // ...and with the secondary this long, then it opens to everyone
  staffActiveSeconds: 60, // a team member's phone counts as on for this long after it last polled
};

const num = (v, d) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n > 0 ? n : d;
};

export function makeConfig(env = {}) {
  const legacy = num(env.ESCALATE_SECONDS, undefined); // one shared time, as before stages existed
  return {
    acceptEscalateSeconds: num(env.ACCEPT_ESCALATE_SECONDS, legacy ?? DEFAULTS.acceptEscalateSeconds),
    deliverEscalateSeconds: num(env.DELIVER_ESCALATE_SECONDS, legacy ?? DEFAULTS.deliverEscalateSeconds),
    warnShare: DEFAULTS.warnShare,
    alterationOffered:
      env.ALTERATION_OFFERED === undefined || env.ALTERATION_OFFERED === ''
        ? DEFAULTS.alterationOffered
        : !['false', '0', 'no'].includes(String(env.ALTERATION_OFFERED).toLowerCase()),
    minImprovementCm: num(env.MIN_IMPROVEMENT_CM, DEFAULTS.minImprovementCm),
    smallSampleN: num(env.SMALL_SAMPLE_N, DEFAULTS.smallSampleN),
    signalMinN: num(env.SIGNAL_MIN_N, DEFAULTS.signalMinN),
    signalMinShare: num(env.SIGNAL_MIN_SHARE, DEFAULTS.signalMinShare) <= 1 ? num(env.SIGNAL_MIN_SHARE, DEFAULTS.signalMinShare) : DEFAULTS.signalMinShare,
    signalMinMisses: num(env.SIGNAL_MIN_MISSES, DEFAULTS.signalMinMisses),
    signalMinPulls: num(env.SIGNAL_MIN_PULLS, DEFAULTS.signalMinPulls),
    bringCount: Math.min(5, Math.max(1, Math.floor(num(env.BRING_COUNT, DEFAULTS.bringCount)))),
    primaryWaitSeconds: num(env.PRIMARY_WAIT_SECONDS, DEFAULTS.primaryWaitSeconds),
    secondaryWaitSeconds: num(env.SECONDARY_WAIT_SECONDS, DEFAULTS.secondaryWaitSeconds),
    staffActiveSeconds: num(env.STAFF_ACTIVE_SECONDS, DEFAULTS.staffActiveSeconds),
  };
}
