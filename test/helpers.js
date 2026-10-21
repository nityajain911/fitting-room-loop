// Tiny event builder for tests: { seq, id, ts, requestId, type, actor, payload }.
export function makeLog() {
  let seq = 0;
  const events = [];
  const add = (ts, requestId, type, payload = {}, actor = 'system') => {
    events.push({ seq: ++seq, id: `e${seq}`, ts, requestId, type, actor, payload });
    return events;
  };
  return { events, add };
}

/** r1: saved (bought_alternative) with a floor pull; r2: lost (left) with a reason. */
export function demoLog() {
  const { events, add } = makeLog();
  add(0, 'r1', 'created', { room: 2, skuId: 'OX-L-SLIM', issue: 'too_tight', chips: [], parsed: null, method: 'rule_fallback' }, 'customer');
  add(0, 'r1', 'routed', { role: 'runner', rule: 'fit issue -> runner' });
  add(10000, 'r1', 'accepted', { role: 'runner' }, 'runner');
  add(10000, 'r1', 'suggestion_shown', { kind: 'alternative', itemId: 'OX-M-REG' });
  add(20000, 'r1', 'suggestion_confirmed', { itemId: 'OX-M-REG' }, 'runner');
  add(20000, 'r1', 'on_the_way', { room: 2, itemId: 'OX-M-REG', itemLabel: 'Oxford Shirt · White · M Regular' }, 'runner');
  add(25000, 'r1', 'floor_pull_requested', { taskId: 'f1', itemId: 'OX-M-REG', rack: 'A4' }, 'runner');
  add(30000, 'f1', 'accepted', { role: 'floor' }, 'floor');
  add(40000, 'f1', 'floor_pull_done', {}, 'floor');
  add(70000, 'r1', 'closed', { outcome: 'bought_alternative' }, 'runner');
  add(100000, 'r2', 'created', { room: 4, skuId: 'CH-32-SLIM', issue: 'too_long', chips: [], parsed: null, method: 'none' }, 'customer');
  add(100000, 'r2', 'routed', { role: 'runner', rule: 'fit issue -> runner' });
  add(120000, 'r2', 'accepted', { role: 'runner' }, 'runner');
  add(120000, 'r2', 'suggestion_shown', { kind: 'alteration_or_crossstore', itemId: null });
  add(150000, 'r2', 'suggestion_rejected', { itemId: null }, 'runner');
  add(150000, 'r2', 'closed', { outcome: 'left' }, 'runner');
  add(160000, 'r2', 'reason_added', { reason_tag: 'time_constraint', summary_en: 'Travelling tonight', evidence_type: 'customer-stated', confidence: 0.5, method: 'rule_fallback', edited: false }, 'runner');
  return events;
}
