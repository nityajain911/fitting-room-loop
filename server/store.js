// Append-only event log. In memory, mirrored to a JSONL file (first line is a meta header with the epoch).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function createStore({ file = null, now = Date.now } = {}) {
  let events = [];
  let epoch = randomUUID().slice(0, 8);

  const writeHeader = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ _meta: { epoch } }) + '\n');
  };

  if (file && fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    if (text && !text.endsWith('\n')) fs.appendFileSync(file, '\n'); // a torn last line must not swallow the next event
    const lines = text.split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const o = JSON.parse(line);
        if (o._meta) epoch = o._meta.epoch;
        else events.push(o);
      } catch {
        /* skip a torn last line */
      }
    }
  } else {
    writeHeader();
  }

  return {
    get epoch() { return epoch; },
    get lastSeq() { return events.length ? events[events.length - 1].seq : 0; },
    all: () => events,
    since: (seq) => events.filter((e) => e.seq > seq),
    append({ requestId, type, actor = 'system', payload = {} }) {
      const seq = (events.length ? events[events.length - 1].seq : 0) + 1;
      const e = { seq, id: `e${seq}`, ts: now(), requestId, type, actor, payload };
      events.push(e);
      if (file) fs.appendFileSync(file, JSON.stringify(e) + '\n');
      return e;
    },
    reset() {
      events = [];
      epoch = randomUUID().slice(0, 8);
      writeHeader();
    },
  };
}
