// The admin's timing settings, in plain words.

/** 20 -> "20 seconds", 120 -> "2 minutes", 150 -> "2 min 30 s". */
export function plainDuration(seconds) {
  const s = Math.round(seconds);
  if (s < 60) return `${s} ${s === 1 ? 'second' : 'seconds'}`;
  if (s % 3600 === 0) { const h = s / 3600; return `${h} ${h === 1 ? 'hour' : 'hours'}`; }
  if (s % 60 === 0) { const m = s / 60; return `${m} ${m === 1 ? 'minute' : 'minutes'}`; }
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** What happens to a request nobody accepts, and when, in order. */
export function timingTimeline(cfg) {
  return [
    { at: 0, what: 'Main person is asked' },
    { at: cfg.primaryWaitSeconds, what: 'Backup is asked too' },
    { at: cfg.primaryWaitSeconds + cfg.secondaryWaitSeconds, what: 'Everyone is asked' },
    { at: cfg.acceptEscalateSeconds, what: 'Manager is alerted' },
  ].sort((a, b) => a.at - b.at);
}
