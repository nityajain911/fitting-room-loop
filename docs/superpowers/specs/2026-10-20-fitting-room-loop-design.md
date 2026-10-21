# Fitting-Room Request Loop (v1) — Design Spec

Date: 2026-10-20 · Status: approved in brainstorming, pending user review of this file

Prototype for an Outcome Manager case ("low in-store conversion at Tommy Hilfiger India"). It demonstrates a closed loop:
capture a customer request → route to the right associate → recommend an action from verified data → record the outcome → use results to improve store decisions. AI is used only where interpretation is needed (free-text parsing).

Demo: ~3 minutes on 2–3 phones, all reading and writing ONE shared server-side event log.

## 1. Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Stack | Node (v20+) + Express, vanilla-JS ES-module SPA, no build step, `node:test` for tests |
| Shared state | Append-only event log on the server (memory + `data/events.jsonl`). No browser-storage state |
| Sync | Clients poll `GET /api/events?since=<seq>` every ~1.5 s |
| LLM | Cerebras via OpenAI-compatible `/chat/completions`; key and model from env vars |
| Hosting | Free public deploy (Render) AND local `npm start` fallback |
| Auth | None (out of scope). Light per-IP rate limit on parse endpoints to protect the API key |
| Floor-pull tasks | Child tasks linked to the parent request; shown in the Floor queue; excluded from customer-request metrics |
| Escalation | Server sweep (every 2 s) appends one `escalated` event per request/task past the threshold |

## 2. Repository layout

```
package.json  README.md  render.yaml  .env.example
shared/   config.js catalogue.js events.js derive.js routing.js fitMatch.js metrics.js parser.js
server/   index.js store.js llm.js
public/   index.html style.css app.js customer.js associate.js manager.js
test/     fitMatch.test.js metrics.test.js parser.test.js derive.test.js e2e.test.js
data/     events.jsonl (gitignored, created at runtime)
docs/superpowers/specs/  (this file)
```

`shared/` is pure ES modules with no Node-only imports; it is served to the browser at `/shared/*` and imported by the server and tests, so every screen and the server derive from identical code.

## 3. Event log

Every event: `{ seq, id, ts, requestId, type, actor, payload }`. `seq`, `id`, `ts` are assigned by the server (server clock only; phone clocks are never used). Clients compute a clock offset from `serverNow` in each poll response to drive live timers.

`actor` ∈ `customer | runner | floor | system`.

| type | requestId | payload |
|---|---|---|
| `created` | request | `room, skuId, issue, chips[], parsed (7 AI fields or null), method` |
| `routed` | request | `role (runner\|floor), rule (string naming the rule)` |
| `accepted` | request or task | `role` |
| `suggestion_shown` | request | the fitMatch result (`kind, itemId, drivers[], reason, assumptions[]`) |
| `suggestion_confirmed` | request | `itemId` |
| `suggestion_rejected` | request | `itemId` |
| `on_the_way` | request | `room, itemId, itemLabel` |
| `floor_pull_requested` | parent request | `taskId, itemId, rack` |
| `floor_pull_done` | task | `—` |
| `escalated` | request or task | `level, thresholdSec` |
| `closed` | request | `outcome` |
| `reason_added` | request | `reason_tag, summary_en, evidence_type, confidence, method, edited` |

Notes:
- A floor task's own id is `taskId`; `accepted`, `escalated`, `floor_pull_done` for the task use `requestId = taskId`. `floor_pull_requested` uses the parent's id.
- `created.issue` ∈ `too_tight, too_loose, too_long, too_short, another_size, another_style, check_stock`.
- `closed.outcome` ∈ `bought_original, bought_alternative, cross_store_order, saved_for_later, left`.
- `method` ∈ `ai:<model>`, `rule_fallback`, `none` (no free text).
- Free text is never stored. Only structured fields and `summary_en` are.
- Status, timers, queues and metrics are derived from events and never stored.
- Reset (`POST /api/reset`) truncates the file and issues a new `epoch` (persisted as a header line); clients whose epoch differs restart from `since=0`.

## 4. Derived state (`derive.js`)

`deriveRequests(events)` → map of requests and tasks:
- `status`: `requested` → `accepted` → `on_the_way` → `closed`, from the latest milestone event.
- `createdTs`, `acceptedTs`, `closedTs`, `escalated` (bool), `outcome`, `suggestion` (latest shown), `suggestionState` (shown/confirmed/rejected), `reasons[]`, `floorTasks[]`.
- `elapsed(now)`; `timerState(now, config)` → `normal | warn | escalated`.
- Customer tracker steps: Requested → Accepted ("checking stock…") → On the way to Room N (bringing `<item>`) → Resolved.

## 5. Routing and thresholds (`routing.js`, `config.js`)

Rules only, no AI. Priority = request type, then longest wait. Expected spend is never an input.

| Request | Role | Rank |
|---|---|---|
| too_tight / too_loose / too_long / too_short | runner | 1 |
| another_size | runner | 2 |
| another_style | runner | 3 |
| floor pull (task) | floor | 1 |
| check_stock | floor | 2 |

Config (`config.js`, env-overridable, displayed in a "prototype settings" strip):
`WARN_SECONDS=60`, `ESCALATE_SECONDS=120`, `ALTERATION_OFFERED=true`, `MIN_IMPROVEMENT_CM=1.0`.
One timer per open card/task from creation until close; amber at warn, red once escalated.

## 6. Fit matching (`fitMatch.js`, deterministic)

Input: original SKU, merged structured issue, catalogue. Output: `{ kind, item, drivers[], diffs[], reason, assumptions[], conflicts[] }`.

**Structured issue merge** (`mergeIssue`):
- Primary issue = tapped button (for the four fit issues).
- Primary area = first tapped chip → else AI `primary_area` → else garment default (shirt/polo: tight/loose → chest, long/short → length; chinos: tight/loose → waist, long/short → inseam). Defaulted areas are labelled "assumed".
- Secondary = AI secondary fields, or extra tapped chips with the same direction.
- Every field carries a `source`: `customer_tapped | ai_parsed | rule_fallback | default`.
- If tapped chips and AI disagree on area or issue, a conflict note is added and the tapped value wins.
- Areas that don't apply to the garment (e.g. sleeves on chinos) are ignored with a note.

**Target mapping:** tight → measure up; loose → down; long → down; short → up. Areas map to measurements: waist→waist, chest→chest, shoulders→shoulder, sleeves→sleeve, length→length (shirt/polo) or inseam (chinos).

**Search** (fit issues): in-stock SKUs, same category and fabric family, not the original, whose primary measure moves the right way by ≥ `MIN_IMPROVEMENT_CM`.
**Rank:** (1) also improves the secondary measure; (2) smallest total |Δ| over all other measurements; (3) smallest primary jump; (4) SKU id (determinism).
**Fallback outputs:**
- Chinos/trouser length too long, no shorter inseam in stock → `kind: alteration_or_crossstore`: "No shorter inseam in stock — eligible for in-store hemming (if the store offers alteration — prototype setting) or cross-store order". With `ALTERATION_OFFERED=false` the hemming clause is dropped.
- Otherwise nothing improves → `kind: no_alternative`: "No in-stock alternative improves this — consider cross-store order".
- `another_size`: same category, fabric family and cut, different size, in stock, nearest size order; labelled "no measurement driver — customer asked for a different size".
- `another_style`: same category, fabric family and size, other cut, in stock; labelled similarly.
- `check_stock` (floor): up to 4 in-stock SKUs in the same category and fabric family with colour, size, rack; the associate picks one.
- Drivers (measurement, original, alternative, delta, role primary/secondary) are always returned and displayed.
- The AI never selects an item; only `fitMatch` does.

## 7. Sample catalogue (`catalogue.js`)

Label on every catalogue-bearing screen: **"Illustrative sample data — not Tommy Hilfiger specifications"**. Values in cm.

| id | Item | Cat. / fabric | Size / cut | Colour | Chest | Waist | Shoulder | Sleeve | Length | Inseam | Stock | Rack |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| OX-L-SLIM | Oxford Shirt | shirt / oxford | L Slim | White | 112 | 98 | 47 | 66 | 77 | – | 2 | A3 |
| OX-M-REG | Oxford Shirt | shirt / oxford | M Regular | White | 110 | 104 | 46 | 64 | 75 | – | 3 | A4 |
| OX-XL-REG | Oxford Shirt | shirt / oxford | XL Regular | White | 120 | 112 | 49 | 68 | 79 | – | 1 | A5 |
| PO-L-SLIM | Polo | polo / pique | L Slim | Navy | 110 | 96 | 46 | 24 | 72 | – | 4 | B1 |
| PO-M-REG | Polo | polo / pique | M Regular | White | 108 | 102 | 45 | 23 | 70 | – | 2 | B2 |
| CH-32-SLIM | Chinos | chinos / twill | 32 Slim | Khaki | – | 82 | – | – | – | 79 | 2 | C2 |
| CH-32-REG | Chinos | chinos / twill | 32 Regular | Khaki | – | 82 | – | – | – | 80 | 3 | C3 |
| CH-30-SLIM | Chinos | chinos / twill | 30 Slim | Khaki | – | 77 | – | – | – | 77 | **0** | C1 |

Intended demo outcomes: Oxford L Slim + waist too tight (+ sleeve too long) → OX-M-REG (waist +6, sleeve −2; XL Regular improves waist but lengthens the sleeve, so ranks lower). Chinos 32 Slim + too long → no in-stock SKU has a shorter inseam (CH-30-SLIM is out of stock; CH-32-REG is longer) → hemming/cross-store message.

## 8. AI parser (`llm.js`, `parser.js`)

- `llm.js`: POST `${CEREBRAS_BASE_URL}/chat/completions` (default `https://api.cerebras.ai/v1`), `Authorization: Bearer ${CEREBRAS_API_KEY}`, `model: ${CEREBRAS_MODEL}`, temperature 0, 4 s timeout. System prompt lists the fixed enums and demands JSON only. Model name has no hard-coded default beyond a documented example in `.env.example`.
- **Customer text** → `{primary_area, primary_issue, secondary_area, secondary_issue, summary_en, evidence_type, confidence}`.
  - areas: `waist, chest, shoulders, sleeves, length, other/unknown`; issues: `tight, loose, long, short, other/unknown`.
- **Associate reason text** → `{reason_tag, summary_en, evidence_type, confidence}`.
  - tags: `time_constraint, price, style_not_liked, size_unavailable, colour_unavailable, alteration_not_wanted, just_browsing, will_return, stock_unavailable, other_unknown`.
  - evidence types: `customer-stated, associate-observed, system-observed, unknown`.
- `validate(raw, kind)`: strips code fences, `JSON.parse`, checks each field against its list (off-list → `other/unknown`; evidence off-list → `unknown`), clamps confidence to [0,1], trims `summary_en` to 200 chars, and scrubs phone-like digit runs and emails. Unparseable → throws, triggering fallback. Output has no garment or outcome field.
- **Fallback** (`ruleBasedCustomer`, `ruleBasedReason`): used when no key, timeout, HTTP error or invalid output. Bilingual keyword dictionaries (e.g. kamar/waist, seena/chest, kandha/shoulder, sleeve/aastin/baju, lamba/lambi/long, kasa/tight, dhila/loose, chhota/short); order of mention → primary/secondary; reason fallback keywords map to tags and evidence types. UI label: **"Rule-based fallback — not AI"**. Fallback customer-text evidence type is `customer-stated`.
- Stored `method` on every record: `ai:<model>`, `rule_fallback` or `none`.
- Associate reason flow: type → server returns the proposed structure (text discarded, nothing logged) → associate may edit tag/summary → confirm → `reason_added` (`edited` records whether changed). Allowed before or after close.

## 9. Server API (`server/index.js`)

| Endpoint | Effect |
|---|---|
| `GET /api/events?since=N` | `{ events, lastSeq, serverNow, epoch }` |
| `POST /api/requests` `{room, skuId, issue, chips[], text?}` | parse text (AI → fallback) → append `created`, `routed` |
| `POST /api/requests/:id/accept` `{role}` | append `accepted`; for runner/floor requests also run `fitMatch` and append `suggestion_shown` |
| `POST /api/requests/:id/confirm` `{itemId}` | append `suggestion_confirmed`, `on_the_way` |
| `POST /api/requests/:id/reject` | append `suggestion_rejected` |
| `POST /api/requests/:id/floor-pull` | append `floor_pull_requested` (child task) |
| `POST /api/tasks/:taskId/accept` · `/done` | append `accepted` / `floor_pull_done` for the task |
| `POST /api/requests/:id/close` `{outcome}` | append `closed` |
| `POST /api/parse/reason` `{text}` | returns proposed structure; appends nothing |
| `POST /api/requests/:id/reason` `{tag, summary_en, evidence_type, confidence, method, edited}` | validate again, append `reason_added` |
| `POST /api/reset` | clear log, new epoch |
| `GET /health` | `ok` |

Commands validate against derived state (e.g. cannot accept twice, confirm before accept, or close twice) and respond 409 on violation. A server interval (2 s) appends `escalated` events. Rate limit: 20 requests/min/IP on the two parse paths.

## 10. UI

One page, bottom tab bar (Customer / Associate / Manager), mobile-first, light and dark via `prefers-color-scheme`. Hash routing (`#customer/<requestId>`, `#associate/runner`, `#associate/floor`, `#manager`) so each phone can open a direct link. The hash holds only which view/request, not application state.

- **Customer:** room; garment → size → cut (only existing combinations); 7 issue buttons; optional chips (Waist, Chest, Shoulders, Sleeves, Length); optional free text (English/Hindi/Hinglish); catalogue label; no name/phone/ID fields. After submit, the 4-step tracker.
- **Associate:** role switch; queue for the role, ordered by rank then waiting time; live timers (amber/red); Accept. Detail view: structured-issue panel with per-field source labels and conflict note; suggestion card with original vs alternative measurements side by side (differing rows highlighted), stock and rack, one-line reason, label "Suggestion — associate confirms fit with customer", and "Rule-based fallback — not AI" where applicable; actions Confirm & bring, Reject, Request floor stock pull (runner only); outcome close buttons; reason box with AI structure + edit + confirm.
- **Manager:** banner "Demo data — prototype only, not store results"; "Clear demo data"; tiles for issue save rate (labelled "Fitting-room proxy, not store conversion"), deferred %, open/accepted/closed, median time-to-accept and time-to-close, escalations, suggestion acceptance, outcome mix, top reasons split by evidence type, latest-events timeline; prototype-settings strip.

## 11. Metrics (`metrics.js`, input = event array)

- closed = requests with a `closed` event (customer requests only; floor tasks excluded).
- Issue save rate = (bought_original + bought_alternative + cross_store_order) ÷ closed. Deferred = saved_for_later ÷ closed. Both display "–" when closed = 0.
- Open/accepted/closed counts; medians of (accepted.ts − created.ts) and (closed.ts − created.ts); escalation count; outcome mix; suggestion acceptance = confirmed ÷ (confirmed + rejected); reasons grouped by tag and evidence type from `reason_added`.
- Nothing is hard-coded. Every number traces to events.

## 12. Privacy

No names, phone numbers or customer IDs are collected or stored. Free text is parsed server-side and discarded; only structured fields and a scrubbed English summary persist. Server logs do not include free text.

## 13. Testing

`node --test`:
- `fitMatch`: Oxford L Slim → OX-M-REG with drivers; secondary-fix preference over XL; chinos hemming branch; `ALTERATION_OFFERED=false` variant; no-alternative branch; out-of-stock exclusion; chip-wins conflict; ignored inapplicable chips; determinism.
- `metrics`: event lists for 100% then 50%; zero closed; medians; acceptance rate; deferred separate; reasons by evidence type; floor tasks excluded.
- `parser`: valid JSON, fenced JSON, off-list → `other/unknown`, garbage → fallback, confidence clamp, scrubbing, fallback on missing key and on mocked HTTP failure, Hinglish demo phrase via rules.
- `derive`: status progression and timer states.
- `e2e`: boot server on a random port with a temp data file and no API key; play the 5-step demo script over HTTP; assert statuses, floor-queue entry, 100% then 50%, reason evidence type, and event timeline contents.
- Manual: click through the UI on phone-width viewports before declaring done.

## 14. Deployment and README

- `npm install && npm start` (binds `0.0.0.0`, prints LAN URLs; `PORT` env respected).
- `.env.example`: `CEREBRAS_API_KEY`, `CEREBRAS_MODEL`, `CEREBRAS_BASE_URL`, `WARN_SECONDS`, `ESCALATE_SECONDS`, `ALTERATION_OFFERED`, `DATA_FILE`.
- `render.yaml` for a free Render web service; README notes cold starts (pre-warm), that a restart empties the log (use Clear demo data), and the hotspot tip if venue Wi-Fi isolates clients.
- README sections: how to run, API key, phones, public deploy, demo script, prototype settings, limitations.

## 15. Demo script (acceptance test)

1. Customer: Room 2 → Oxford shirt, L, Slim → "too tight" → types "kamar pe tight hai, sleeves thodi lambi" → submit. Parser yields waist/tight (primary), sleeves/long (secondary).
2. Runner phone: request appears with a timer → Accept. Customer screen shows "Accepted".
3. Suggestion: Regular Fit M with side-by-side measurements → Confirm & bring (customer: "On the way to Room 2") → Request floor stock pull (floor queue lights up) → close "bought alternative". Dashboard save rate 100%.
4. Second request: chinos 32, too long → runner sees the hemming/cross-store message → close "left" → associate types "Customer travelling tonight, cannot wait for alteration" → tag with evidence type customer-stated → associate confirms.
5. Dashboard: save rate 50%, outcome mix, response times, reasons by evidence type, full event timeline.

## 16. Out of scope (v1)

Voice input (v2, would feed the same parser), real stock/POS integration, WhatsApp, login/roles, multi-store views.

## 17. Addendum (2026-10-21): changes after UX review

Approved additions; everything else above is unchanged.

- **New event `cancelled`** (`requestId` = request, `actor` = customer, payload `{ stage: requested | accepted | on_the_way }`). Derived status `cancelled`; not open; unfinished floor pulls become `cancelled` with it. Cancelled requests count in `total` and in `cancelled` / `cancelledByStage`, and are excluded from `closed`, save rate, deferred rate and outcome mix. Endpoint: `POST /api/requests/:id/cancel` (409 if already closed or cancelled). The escalation sweep skips cancelled requests.
- **Escalation** stays a flag, now surfaced: associate cards say "Escalated — flagged to manager"; the manager dashboard lists open escalations (`openEscalations` in metrics). No auto-assignment.
- **Per-SKU breakdown** (`bySku` in metrics): n, cancelled, closed, saves, save rate, top issue + area (only when stated, never defaulted), suggestions shown, suggestions with no in-stock alternative. New prototype setting `smallSampleN` (default 5, env `SMALL_SAMPLE_N`).
- **Timeline filters** (All / Escalated only / room) on the manager screen.
- **Room from URL** (`#customer?room=N`), **open requests for the room** on the customer screen, and a **"Chosen for …"** line on the tracker built from the stored fit drivers (`describeChange` / `choiceSummary`).
- **Associate declutter:** the issue panel is open only before Accept; the reason box stays collapsed until the request is finished or there is something to show. Open/closed state persists across live re-renders.
- Deliberately not done: auto-running the AI on blur (provider rate limits; associate confirms by design) and hiding close buttons until "on the way" (would block closing "left" straight from the hemming message).

## 18. Addendum (2026-10-21): friction handling, assist and signals

Approved additions after the second review. This **reverses the section 17 escalation decision**: escalation now reassigns, it is no longer a flag only.

- **New events:** `inventory_discrepancy` (request, `{skuId, rack}`), `item_declined` (customer, `{itemId}`), `assisted` (request or task, `{byRole}`).
- **Not on rack:** `POST /api/requests/:id/next-best {cause: "not_on_rack"}` appends `inventory_discrepancy`, then a new `suggestion_shown` computed with `excludeIds` (reported-missing and declined SKUs) over an *effective catalogue* (sample stock minus reports per SKU, never below 0). The withdrawn item clears `onTheWay`; status returns to `accepted`. Not counted as a rejection. Reasons are never auto-logged; a one-tap `system_rule` reason (`stock_unavailable`, system-observed) is offered when the request closes left / saved for later.
- **Not this one:** `POST /api/requests/:id/decline-item` (only while `on_the_way`, once). `POST .../next-best {cause: "customer_declined"}` re-suggests excluding it.
- **Assist:** `POST /api/items/:id/assist {role}` for an escalated, open, not-yet-assisted request or floor task, from the *other* team only. The assisting team may then accept it (`accept` and the task endpoints accept the assisting role). Actions record the acting team (`role` in the body) as `actor`. Queues: `buildAssistQueue(role)` returns `offer` (escalated items routed to the other team) and `assisting`. Metrics: `assists`, `medianAssistMs` (assisted minus escalated). The manager "Needs attention" list shows who stepped in.
- **Signals** (`buildSignals`, in `computeMetrics`): `fit` (top issue share of a SKU's requests), `stock_gap` (no-alternative share of its suggestions), `inventory` (reports per SKU). New settings `signalMinN` 3, `signalMinShare` 0.6, `signalMinMisses` 1. Observations with counts only; no invented quantities; "share of requests, not a defect rate".
- **Demo controls** (`DEMO_CONTROLS=true`): `POST /api/demo {forceFallback?, fastTimers?}` (403 otherwise); settings (config, parser mode incl. `forced_fallback`, demo flags) travel with every `/api/events` poll so all phones stay in sync. Fast timers = warn 10 s / escalate 20 s. Settings only, never log edits.
- **Not built:** timestamp fast-forward (would falsify the log), "Looks good" acknowledgement, batch-pull grouping, claim pass, voice input, seeded data.

## 19. Addendum (2026-10-21): richer sample data, a shorter Manager screen, timers

- **Catalogue (supersedes the table in section 7):** 128 SKUs generated from size grids (`shared/catalogue.js`): Oxford Shirt (3 colours), Poplin Shirt (2), Polo (3), Chinos (2), Jeans (2); Slim and Regular; tops S–XXL, trousers waist 28–38; explicit stock tables with gaps. Kept stable: the ids, measurements and stock of the original demo SKUs (OX-L-SLIM, OX-M-REG, OX-XL-REG, PO-L-SLIM, CH-32-SLIM, CH-30-SLIM out of stock), except Regular chinos inseam 80 → 82 so that Slim vs Regular is a meaningful length difference, and PO-M-REG is now Navy (the polo primary colour). Ids: `<family>-<size>-<SLIM|REG>`, with a colour suffix for non-primary colours. New category `jeans` (trousers: same area mapping and the hemming / cross-store branch as chinos).
- **Fit rules:** unchanged order (primary improvement, secondary fix, closest on everything else) with **colour as the final tie-break** before the id, and a "in <colour>" note in the reason when another colour is suggested. `another_size` / `another_style` prefer the original colour. `check_stock` lists same size and cut in other colours first, then same size, then same cut.
- **Customer picker:** Garment → Colour (primary pre-selected) → Size → Cut.
- **Tests:** rule tests use a frozen 8-SKU fixture (`test/fixtures.js`) so they do not depend on data volume; `test/catalogue.test.js` checks the real catalogue (consistency, full grids, the two demo guarantees, and that dead ends only occur at the extremes of the size range).
- **Manager screen (supersedes the Screen 3 list in section 10):** banner, save rate (with deferred noted), requests, escalations (open ones listed under "Needs attention"), median time to accept and close, "what to act on" signals, top 8 garments, outcomes, reasons. **New Admin screen (`#admin`, header link):** prototype settings, demo controls, Clear demo data, detailed metrics, parser statistics and the filterable event log. Nothing was removed from the product; it moved.
- **Timers:** defaults remain `WARN_SECONDS=60`, `ESCALATE_SECONDS=120`. The Fast timers demo control now expires after 5 minutes (`fastTimersUntil` in the settings).

## 20. Addendum (2026-10-21): UX pass

- **Customer form:** "Where?" chips render only for fit issues and by garment kind (`CHIPS_BY_KIND`: tops waist/chest/shoulders/sleeves/length; trousers waist/hips/length). New area **`hips`** (maps to the `hip` measurement for chinos/jeans; ignored with a note on tops); added to `CHIPS`/`AREAS`, the parser dictionaries (hip/hips/kulha/kulhe) and so to the AI prompt. 2-column issue grid; the Send button carries the room and garment summary.
- **Customer tracker:** "What we're bringing" card (item, `choiceSummary`, and `driverDeltas`: signed cm per measurement driver, only for `kind: alternative`; labelled illustrative) with the "Not this one" button.
- **Associate card is stage-gated** (`requestDetail`): step 1 (accepted) shows the suggestion and its actions; step 2 (on the way) a one-line summary with fit details collapsed; step 3 shows outcomes + reason once the item is on its way, or when nothing can be brought (no item suggested), the suggestion was rejected, or the customer declined. `Customer left early` closes as `left` at any time (with a confirm).
- **Not on rack:** struck-through chips for excluded items, an amber "Fallback #N" header (`N = excluded.length + 1`) with rack and stock, a toast naming the new rack, and a one-shot flash.
- **One-tap reasons:** `QUICK_REASONS` (six, mapped to fixed tags and evidence types); recorded with method `quick_pick`. Typing a note and tapping an outcome closes first, then calls `/api/parse/reason` and shows the draft for "Looks right"; nothing is saved unreviewed.
- **Signals carry actions** (`action: {label, severity}`) and a fourth kind **`high_demand`** (an item brought to the fitting room at least `signalMinPulls` = 2 times; withdrawn items and cancelled requests are not counted). No quantities are invented.
- **Chrome:** a pill on every screen while Fast timers or Force fallback is on; the Admin event log is colour-coded by actor/type.
- **Not built (roadmap):** voice input, Claim Pass, specialist routing, collapsible threads in the event log.

## 21. Addendum (2026-10-21): "Another style" redefined (defect fix)

- **Defect:** `another_style` only swapped the *cut* (Slim <-> Regular) of the same garment at the same size, so the associate was shown, for example, Poplin M Regular for a Poplin M Slim customer: the same shirt with a roomier fit (waist +9 cm), which reads as a larger size and is not a different style.
- **New rule (supersedes the `another_style` bullet in section 6):** style means design. Candidates are in-stock SKUs of the customer's own size. Tier 1: a different product of the same kind (`STYLE_KINDS`: shirt <-> shirt, i.e. Oxford <-> Poplin; chinos <-> jeans; polo has none) in the same cut. Tier 2: a different product in the other cut (flagged `alsoCut`). Tier 3: the other cut of the same product, labelled as the same design with a changed fit. Within a tier: original colour first, then the smallest total measurement gap (`fitGap`), then id. Never a different size. `excluded` SKUs (not on rack, declined) are honoured.
- **Result shape:** `change: {type: "design", from, to, alsoCut}` or `{type: "cut", from, to}`. `choiceSummary` gives the customer "a different style: Poplin Shirt" or "the Regular cut of the same design". The associate card shows a banner naming the change (also for `alternative_size`: "Different size: M -> L, same style and cut").
- **Tests:** tiers, trousers, colour preference, exclusions and size-never-changes on synthetic catalogues; on the real catalogue, shirts get a genuinely different design at least 80% of the time and polos get the labelled cut change.

## 22. Addendum (2026-10-21): style attributes and "Another style" by detail (supersedes section 21's rule)

- **Data model:** a SKU belongs to a **line** (one design) and carries `line`, `styleName` and `attrs`: shirts `{collar, pattern, fabric}`, polos `{neckline, pattern}`, trousers `{front, fabric}` (`STYLE_AXES`, `styleKind`). All sizes, cuts and colours of a line share them. 12 lines, 272 SKUs (`shared/catalogue.js`); ids of the original demo lines are unchanged. `skuLabel` includes the style variant, e.g. `Oxford Shirt (Button-down · Solid) · White · L Slim`.
- **Scope of fit rules:** fit issues, `another_size` and `check_stock` stay inside the customer's own line (`lineOf`), so a roomier waist never swaps the collar. Rows without `line` fall back to category + fabric.
- **Customer input (decision B):** chips only. After "Another style" an optional "What would you like different?" row (`styleAxes` on `created`, validated against `ALL_STYLE_AXES`, dropped for other issues). Free text for style is not parsed (a follow-up would extend the AI contract).
- **Rule:** pool = in-stock, same size, same garment kind, different line, not excluded. A candidate's `diff` = axes where its attributes differ. Tier 1: same cut and `diff` contains every asked axis; tier 2: the same in the other cut (`alsoCut`); tier 3: same cut, partial (`unmet` lists what could not change); tier 4: the other cut of the same line (`change.type: "cut"`). Within a tier: fewest unrequested changes (with nothing asked: fewest axes), original colour, smallest `fitGap`, id.
- **Result:** `change: {type: "design", from, to, alsoCut, axes, changed: [{axis, label, from, to}], requested, unmet}`. `choiceSummary` gives the customer "a different collar (Spread)" / "... and pattern (Stripe)".
- **Tests:** axis rules on synthetic catalogues; on the real catalogue every single-axis request is honoured (586 of 586 in-stock SKU x axis), designs and sizes are coherent, every axis has a pair of lines differing only in it, and dead ends occur only at the extremes of the size range.

## 23. Addendum (2026-10-21): visual and copy pass

- **Customer screen = two exclusive states** (`form` / `tracker`). Form: room locked into a pill after the first choice (`Change` reopens the picker), no explanatory paragraph (an "Anonymous" badge instead), note header "Add a note (optional)", the Send button states the next missing step and then names the order. Starting a new request (`+ Request another item`, or after a send) resets everything except the room. Tracker: horizontal stepper (Requested, Accepted, On the way, Resolved), item pill, live "incoming" box (waiting / checking stock / bringing with fit-delta bars), secondary actions (request another item; a muted cancel), other open requests as compact "Request i of n" cards. The sample-data disclaimer moved from the middle of the form to a global footer, so every catalogue screen is still labelled.
- **Shared visual helpers** (`shared/visuals.js`, tested): `deltaBar` / `deltaLabel` ("+6 cm looser (108 cm)"), `slaRing`, `bulletScale`, `outcomeFunnel`, `rackZone`, `bringParts` (what differs from the garment worn). Metrics gain `heatmap` (garment+cut rows by body area; "needed more" = too tight / too short, "needed less" = too loose / too long; only stated areas, others counted in `skipped`).
- **Associate:** SLA ring around the room badge, rack pills coloured by aisle, "Bring: <what differs>" with delta bars and the table behind "All measurements", compact provenance badges with a legend.
- **Manager:** three headline cards, a stacked outcome bar over closed requests, the heatmap, signals, reasons; definitions behind an ⓘ. Per-garment cards moved to Admin.
- **Deliberate differences from the review:** the funnel keeps "saved for later" apart from cross-store (it is not a save) and is over closed requests so it reconciles to the save rate; no invented "Backroom" or "Thighs" (racks are coloured by aisle; the trouser column is Hips, matching the data); no quantities in actions; the stepper ends in "Resolved" (there is no "Here" event); no voice button or batch-pull banner (roadmap); "Another style" stays in the issue grid; no unmeasured "Takes 10s" claim; suggestion-acceptance stays on Admin.

## 24. Addendum (2026-10-21): specialist routing, multi-item trips, escalation focus, delta bars reversed

- **Delta bars reversed.** The "+3 cm chest" bars and per-measurement deltas are removed from the customer, associate and `shared/visuals.js` (`deltaBar`, `deltaLabel`, `bringParts`, `driverDeltas`). A single changed measurement is not the whole change: a larger size moves several measurements at once. The customer sees item names (`tripItemName`) and a one-line reason; the associate gets a comparison table of **all** measurements, original beside suggestion, with no summary arrow.
- **Multi-item trips.** `fitMatch` returns `options[]` (best first, distinct by size or design, at most `bringCount`, default 3). The associate confirms a subset (`suggestion_confirmed.itemIds`; `itemId` stays the best for older readers); `on_the_way.items[]`, `floor_pull_requested.items[]` and `item_declined.itemIds` carry the trip. "Not on rack" removes one item (`excludeIds`), the rest stay. Older single-item events still derive. Metrics count deliveries per trip item.
- **Escalation focus mode.** Open escalated requests are grouped as "Needs you now": ring, timer, one-line summary. The detail view shows the bring list and a single primary action; all else is under "Full details". Escalated requests are open to all associates.
- **Specialist routing.** `shared/skills.js`: skill = `department|garment kind` (six skills). Coverage of an accept is `generalist` (device declares none or all), `specialist` or `overflow`. A request outside the device's skills is reserved until `specialistOverflowSeconds` (20 s) after creation unless escalated; the server rejects an earlier accept with 409. `accepted` payload gains `{skills, coverage}`; metrics gain `routing` (counts per coverage, `specialistShare`), shown on Admin and in the Manager status line. Skills live in `localStorage` (`frl.skills`), not in the log, so there are no identities. Default = all sections, so a fresh demo behaves as before.
- **Women's range and department.** SKUs gain `department` (Men / Women); the customer chooses a section first; labels read "Women's ...". "Another style" and fit suggestions never cross departments.
- **Settings added (prototype):** `BRING_COUNT` (3, clamp 1–5), `SPECIALIST_OVERFLOW_SECONDS` (20).
- **Deliberate limits:** no per-person skills or presence (a phone is a "specialist" only by its setting); the overflow wait is not shortened when the specialist is known to be busy, because the prototype cannot know; no invented utilisation metrics.

## 25. Addendum (2026-10-21): escalation per stage, set by the admin

- **Two stages, two times.** Stage 1 `accept`: request created to accepted. Stage 2 `deliver`: accepted to on-its-way (floor pulls: accepted to handed over). Settings `acceptEscalateSeconds` and `deliverEscalateSeconds` (default 120 each; `ESCALATE_SECONDS` still sets both). Amber is `warnShare` (0.5) of a stage's time. The single `warnSeconds` / `escalateSeconds` pair is gone.
- **Edited on the Admin page.** `POST /api/settings` accepts only those two keys, whole seconds 10 to 3600, rejects anything else with 400. Values are held by the server, saved to `data/settings.json` next to the log and loaded at start; "Clear demo data" does not touch them. The prototype has no login, so the Admin page is open to anyone who can reach it. Fast timers still override both stages (20 s) for five minutes.
- **Escalation follows the stage.** The sweep appends `escalated {stage, thresholdSec}` once per stage per item. Derived state: `escalated` is true only while the current escalation is open; an `accepted` event (and `on_the_way`, `floor_pull_done`) clears it, so an accepted item is no longer shown as escalated and is only escalated again if the delivery time is breached on its own clock (measured from accept). The history is `escalations[{stage, ts}]`; metrics count requests that ever escalated, plus `escalationsByStage`, and `openEscalations` means escalated right now. Events written before stages existed take the stage from the item's status at that time.
- **Timers and rings** show the current stage: time since creation while waiting, time since accept after that, frozen at the delivery time once the item is on its way.
- **Assist is per escalation.** One assist per escalation, from the team that does not hold the item (the holder is whoever accepted it, else the routed team). A second escalation can be assisted again. Metrics keep every assist and its time to assist.
- **Manager:** SLA health shows median time to accept and median accept to on-its-way (`medianDeliverMs`), each against its own marks; "Needs attention" names the stage missed.
- **Deliberate limits:** "delivered" is the on-its-way step because the app records nothing later; the two times are global, not per section or per team; no notification beyond the queues and the Manager screen.

## 26. Addendum (2026-10-21): admin-allocated sections, primary / backup routing (replaces section 24's per-phone skills)

- **Roster, set by the admin.** Team members `{id, label, type: runner|floor, primary[], secondary[], onShift, code}` are kept by the server beside the log (`data/settings.json`), not in it. Sections are the six `department|kind` keys; one section is primary or backup for a person, not both. Max 30 people. `POST /api/staff` (add), `POST /api/staff/:id` (update), `DELETE /api/staff/:id`, `POST /api/staff/seed` (sample team, only when empty), `POST /api/staff/join {code}`. Join codes are sent only to the Admin page (`?admin=1`). The per-phone "I cover" panel and `frl.skills` are removed.
- **Phones.** A phone joins once with a code and stores the person's id (tab-level first, so two tabs can be two people). It then shows the role and sections read-only, with no role tabs and no way to change coverage. Polling carries the id as a heartbeat; a phone is "on" for `staffActiveSeconds` (60) after its last poll (in memory, never logged). With no roster there is no restriction and no join step.
- **Allocation (`shared/staffing.js`, pure).** On creation (and on every sweep) a waiting request or floor pull gets `assigned {tier, staffId}` events: `primary` to the least busy on-shift, phone-on person of the right type with the section as primary; after `primaryWaitSeconds` (20) `secondary` to the least busy person with it as backup (other primaries only as a fallback), who is added without the first person losing it; after `secondaryWaitSeconds` (20) `open` (visible to everyone). A tier with nobody is recorded with a null person and does not wait. Busy = waiting items assigned to the person plus items they accepted and have not finished; ties go to a backup-listed person, then to the person given a request least recently. Escalated requests are open to everyone. Settings `primaryWaitSeconds`, `secondaryWaitSeconds` (5 to 3600) are edited on Admin; fast timers set both to 5 s.
- **Accepting.** The server requires a joined person of the right type who can see the item now (403 not joined, 400 wrong type, 409 not theirs yet); the first accept wins (409 after). `accepted` carries `{staffId, tier}`; metrics `routing` groups accepts by tier (`primary`, `secondary`, `open`, with `primaryShare`).
- **Deliberate limits:** no authentication (the Admin page and codes are open to anyone who can reach the server, by design for a prototype); presence is only "phone polling"; no manual reassignment; a person removed from the roster simply stops matching.

## 27. Addendum (2026-10-21): several issues for one article

- **Input.** `POST /api/requests` takes `issues` (a list) or the older single `issue`. `normaliseIssues` (shared): one issue of any kind, or up to two **fit** issues that are not opposites (tight/loose, long/short); anything else is 400. `created` carries `issues` and `issue` (= the first, used for routing, queue order and labels). Derived requests always have `issues` (older events: `[issue]`).
- **Matching.** `mergeIssue` builds a target per issue: the tapped chip of its kind (girth: chest, waist, shoulders, hips; length: sleeves, length), else the AI's area for that word, else the garment default; an extra chip of the same kind is noted, not silently dropped. The first target is `primary`, the second `secondary`. `fitMatch` offers only items that fix both when any exist; otherwise it offers the best partial fits, each reason naming the issue left unfixed, with a hemming hint for trouser inseam when alteration is offered. A single issue behaves as before.
- **Metrics.** The heatmap and per-garment issue counts count a two-issue request under both areas (a "named" request counts once per issue). Signals still use the per-issue counts.
- **UI.** Customer: fit issues toggle (max two, opposite swaps, non-fit choices stand alone); the tracker and the associate screens show "Too tight + Too short". Deliberate limit: opposite issues (for example tight chest and loose length) are not combinable in this version, and one area per issue is used.
- **QA pass (2026-10-21).** "Where?" appears only once a garment is chosen; with two issues it splits into one list per issue ("Where is it too tight?" with the girth areas, "Where is it too long?" with sleeves and length); chips that do not apply are dropped when the garment changes. The form opened from "+ Request another item" has a clear "✕ Cancel — back to your request" link. The multiline note box no longer resizes and the page keeps 96 px clear of the bottom bar. Manager SLA bars say "Pending first accept" / "Pending first delivery" until there is data.

## 28. Addendum (2026-10-21): second QA pass
- **Heatmap:** a fit request with no named body area is plotted in a "No area" column (`general`) instead of being left out, so the matrix accounts for every fit report (a two-issue request counts once under each issue). The "not plotted" footnote and `skipped` are gone.
- **Who took requests:** accepts made before any team existed (no tier) appear as "Shared queue (before a team existed)" (`routing.unassigned`).
- **Customer:** switching Men's / Women's keeps the chosen issues, body areas and style details (only the garment choice starts over; the note was already kept).
- **Associate:** a request whose room has two or more open items carries a "Room N: n open items — take together" badge. With demo controls on, the join screen offers one-tap "Quick join" buttons (join codes then reach every phone; with demo controls off they stay Admin-only).
- **Not changed, deliberately:** the cancelled-request banner (shown only on that request's own page, and not in any switcher), per-item status (the other-open-items cards already show Waiting / Accepted / On the way), forcing a system-observed reason (the associate can always add a one-tap or typed reason), and SLA bar scaling (the bars already rescale past the limit and turn red).

## 29. Addendum (2026-10-21): reasons only for non-conversions
- The reason block appears only once a request has closed as `left` or `saved_for_later`; it is not shown before closing, after a sale (`SAVE_OUTCOMES`) or after a cancellation, and the "type a reason, then tap an outcome" shortcut is removed. `POST /api/requests/:id/reason` returns 409 for any other state. Metrics "why requests didn't convert" ignores reasons on converted requests (older logs). The runner's "Recently finished" list says "Sale saved" for sales and "Tap to add why it did not convert" otherwise.

## 30. Addendum (2026-10-21): floor pulls, one tap and cancellable
- `POST /api/requests/:id/confirm` accepts `pull: true`: it appends `suggestion_confirmed`, `on_the_way` and a `floor_pull_requested` for every confirmed item, and returns `taskId`. The standalone "Request floor stock pull" is offered only after the items are confirmed (it used to appear before, covering only the top suggestion) and only while no pull is `requested`, `accepted` or `done` (409 otherwise).
- New event `floor_pull_cancelled` (`requestId` = the task, payload `{byRole, reason?}`), via `POST /api/tasks/:id/cancel` (409 if done or cancelled). The task becomes `cancelled` (not open, leaves the floor queue); a later `floor_pull_done` or `accepted` cannot revive it. The server appends it for every live pull when the customer declines the items (`reason: customer_declined`); a cancelled request already withdraws its pulls. Metrics: `floorPullsRequested` excludes cancelled pulls; `floorPullsCancelled` counts them.
- Deliberate limit: a pull is not edited when one item is later reported not on rack; the runner cancels it and requests again.
