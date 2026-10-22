// What needs a person's attention, and what changed since they last looked, so a phone can buzz or beep only for
// something new. `attention` maps an item id to whether it is urgent (escalated, or someone asking for help).

/** Compare the last and the current attention maps: newly arrived items, and items that just became urgent. */
export function newAttention(prev, cur) {
  const added = [];
  const urgent = [];
  for (const [id, isUrgent] of cur) {
    if (!prev.has(id)) (isUrgent ? urgent : added).push(id);
    else if (isUrgent && !prev.get(id)) urgent.push(id);
  }
  return { added, urgent, count: cur.size };
}
