// Cerebras (OpenAI-compatible) adapter. Returns null when no API key is set.
// The raw model text is returned for shared/parser.js to validate; this file never trusts it.
import { AREAS, ISSUE_WORDS, REASON_TAGS, EVIDENCE_TYPES } from '../shared/events.js';

const CUSTOMER_PROMPT = `You extract structured fit feedback from a customer's message in a clothing-store fitting room.
The message may be English, Hindi (Devanagari or Roman script) or Hinglish.
Reply with ONLY a JSON object with exactly these keys:
primary_area, primary_issue, secondary_area, secondary_issue, summary_en, evidence_type, confidence.
Allowed values:
- primary_area / secondary_area: ${AREAS.join(' | ')}
- primary_issue / secondary_issue: ${ISSUE_WORDS.join(' | ')}
- evidence_type: ${EVIDENCE_TYPES.join(' | ')} (use "customer-stated" for what the customer said)
- summary_en: one short English sentence, no personal data
- confidence: number from 0 to 1
Rules: primary is the first-mentioned or most emphasised problem; secondary is a different second problem.
Use "other/unknown" for anything not mentioned. Never suggest products, sizes or outcomes.`;

const REASON_PROMPT = `You structure a store associate's note about why a customer's fitting-room request ended the way it did.
The note may be in any language. Reply with ONLY a JSON object with exactly these keys:
reason_tag, summary_en, evidence_type, confidence.
Allowed values:
- reason_tag: ${REASON_TAGS.join(' | ')}
- evidence_type: ${EVIDENCE_TYPES.join(' | ')}
  (customer-stated = the customer said it; associate-observed = the associate saw or judged it; system-observed = stock/system data showed it; unknown = unclear)
- summary_en: one short English sentence, no personal data
- confidence: number from 0 to 1
Tag meanings:
- time_constraint: the customer is short of time, in a hurry, travelling, or cannot wait (for an alteration, delivery, etc.). If lack of time is the reason, use this even when an alteration is involved.
- price: cost, discount or budget
- style_not_liked: the look or design is not liked
- size_unavailable: the size needed is not available
- colour_unavailable: the colour needed is not available
- alteration_not_wanted: the customer does not want or trust alterations, for reasons other than time
- just_browsing: no intent to buy right now
- will_return: the customer plans to come back later
- stock_unavailable: the item is out of stock in this store (general stock problem)
- other_unknown: none of the above
Use "other_unknown" / "unknown" when unsure. Never decide or change a sale outcome.`;

export function makeLlm(env = {}, fetchImpl = globalThis.fetch) {
  const key = env.CEREBRAS_API_KEY;
  if (!key) return null;
  const model = env.CEREBRAS_MODEL || 'gpt-oss-120b';
  const base = (env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1').replace(/\/$/, '');
  const timeoutMs = Number(env.LLM_TIMEOUT_MS) || 6000;
  let coolUntil = 0; // after a 429, skip the API until retry-after has passed

  const llm = async (kind, text) => {
    if (Date.now() < coolUntil) throw new Error('LLM rate-limited (cooling down)');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 800,
          messages: [
            { role: 'system', content: kind === 'reason' ? REASON_PROMPT : CUSTOMER_PROMPT },
            { role: 'user', content: text },
          ],
        }),
        signal: ctrl.signal,
      });
      if (res.status === 429) {
        const wait = Number(res.headers?.get?.('retry-after')) || 30;
        coolUntil = Date.now() + Math.min(wait, 120) * 1000;
      }
      if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('Empty LLM response');
      return { raw: content.replace(/<think>[\s\S]*?<\/think>/g, ''), method: `ai:${model}` };
    } finally {
      clearTimeout(timer);
    }
  };
  llm.model = model;
  return llm;
}
