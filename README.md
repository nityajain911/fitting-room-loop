# Fitting-Room Request Loop (v1 prototype)

A working prototype of one recommendation from the "low in-store conversion at Tommy Hilfiger India" case: a **closed-loop store-execution system**.

> customer request → routed to the right associate → action recommended from verified data → outcome recorded → results shown to the manager

One web app, three mobile-first screens (Customer · Associate · Manager), all reading and writing **one shared event log on the server**. Open it on 2–3 phones and changes appear on the others within ~1.5 seconds.

AI is used only where interpretation is needed: turning free text (English / Hindi / Hinglish) into structured fields. Routing, fit matching and every metric are deterministic rules over the event log.

**Everything in the sample catalogue is illustrative. This is demo data, not Tommy Hilfiger specifications or store results.**

**Sample catalogue:** 272 SKUs across five garments, built from 12 **style variants** (product lines): Oxford shirts (button-down solid, spread solid, button-down stripe), Poplin shirts (spread solid, button-down solid, spread check), Polos (classic solid, classic stripe, mock neck), Chinos (flat, pleated) and Jeans. Each variant comes in 2–3 colours, Slim and Regular, and a full size grid (S–XXL for tops, waist 28–38 for trousers), with stock that includes realistic gaps. It is generated from size grids so measurements stay consistent (bigger sizes are bigger, Slim is trimmer than Regular, colour variants share measurements, and a style variant's attributes are shared by all its sizes, cuts and colours). It is built to keep the two demo cases honest: Oxford L Slim → Regular M, and Chinos 32 Slim has no shorter inseam in stock (a shorter-leg 30 Slim exists but is out of stock). Colour is only ever a tie-break in matching: measurements decide first, and the reason says when another colour is suggested.

## Run it

Requires Node 20 or newer.

```bash
npm install
npm start
```

The console prints `http://localhost:3000` and your Wi-Fi address. Without an API key the app still works end to end, using a clearly labelled rule-based fallback instead of the AI.

```bash
npm test      # unit tests + an end-to-end run of the demo script
```

## Set the AI key (Cerebras)

The AI parser calls Cerebras's OpenAI-compatible chat API.

```bash
cp .env.example .env     # then edit .env
```

| Variable | Meaning |
|---|---|
| `CEREBRAS_API_KEY` | Your key. Leave empty to use the rule-based fallback. |
| `CEREBRAS_MODEL` | Model id, default `gpt-oss-120b`. Cerebras rotates its lineup, so check their model list if you get fallbacks. |
| `CEREBRAS_BASE_URL` | Default `https://api.cerebras.ai/v1` (any OpenAI-compatible endpoint works). |

Or inline: `CEREBRAS_API_KEY=... npm start`.

**How to tell it worked:** the Admin page's "prototype settings" section (`/#admin`) says `parser: AI (<model>)`, and the Associate screen labels fields "parsed by AI from customer text". If the key is missing, the model id is wrong, the call times out (6 s) or the output fails validation, that one record falls back to rules and is labelled **"Rule-based fallback — not AI"**. Every record stores which method produced it.

The AI can only fill the structured fields (area, issue, summary, evidence type, confidence, or a reason tag from a fixed list). Anything outside the fixed lists becomes `other/unknown`. It never picks a garment, changes an outcome or marks a sale recovered.

## Open it on phones

**Same Wi-Fi:** run `npm start` on your laptop and open the `on your Wi-Fi: http://192.168.x.x:3000` address on each phone. Tabs on the bottom switch screens; direct links:

- Customer: `/#customer` (or `/#customer?room=3` to pre-set the room, as a per-door QR code would)
- Runner: `/#associate/runner`
- Floor associate: `/#associate/floor`
- Manager: `/#manager`

If the phones can't reach the laptop, the Wi-Fi probably isolates devices (common on guest and office networks). Turn on your phone's hotspot and connect the laptop and the other phones to it, or use the public deploy below.

**Public deploy (recommended as the backup plan):** the repo includes a `render.yaml` for Render's free tier.

1. Push this folder to a GitHub repo.
2. Render dashboard → New → Blueprint → select the repo.
3. Enter `CEREBRAS_API_KEY` when prompted.
4. Open the `onrender.com` URL on every phone.

Free instances sleep when idle and take ~30 s to wake, so **open the URL a few minutes before the demo**. A restart empties the event log (it lives in a file on the instance's disk), which is fine for a demo; use "Clear demo data" (on the Admin page) to reset between runs. Anyone with the URL can use the app, so treat the key's spend accordingly (AI calls are limited to 20 per minute per IP; beyond that, the fallback is used).

## The 3-minute demo script

Use three phones: **Customer**, **Runner**, and **Manager** (plus the Floor view on a fourth tab or the runner's phone). Start with "Clear demo data" on the Admin page (the small **Admin** link in the header).

1. **Customer:** Room 2 → Oxford Shirt → L → Slim → "Too tight" → type `kamar pe tight hai, sleeves thodi lambi` → Send. The parser reads waist/tight (main) and sleeves/long (also).
2. **Runner:** the request appears with a live timer → open it → **Accept**. The customer screen changes to "Accepted (checking stock…)".
3. **Suggestion:** Regular M appears next to Slim L, waist and sleeve highlighted, with sample stock and rack → **Confirm & bring** (customer: "On the way to Room 2") → **Request floor stock pull** (switch to *Floor associate*: the pull is in the queue; Accept → Mark pulled) → on the Runner, close **Bought alternative**. Manager shows **100%**.
4. **Second request:** Room 4 → Chinos → 32 → Slim → "Too long" → the runner accepts and sees "No shorter inseam in stock — eligible for in-store hemming … or cross-store order" → close **Left** → in the reason box type `Customer travelling tonight, cannot wait for alteration` and tap **Left** (or tap *Structure* first) → the note is structured automatically: tag **Time constraint**, evidence **customer-stated** → **Looks right**. (Or skip typing: tap the one-tap **Short on time** chip.)
5. **Manager:** save rate **50%**, the SLA bars, the outcome bar, the fit heatmap and the reasons behind lost sales. The full event log is on the Admin page.

To show colour changes on the timers on purpose, wait: cards go amber at half of their stage time and red (with an `escalated` event) at the full stage time: 120 s to accept, then 120 s from accept to on-its-way, unless you change them on the Admin page.

## How it works

- **Event log is the single source of truth.** Events: `created, routed, accepted, suggestion_shown, suggestion_confirmed, suggestion_rejected, on_the_way, floor_pull_requested, floor_pull_done, escalated, assisted, closed, cancelled, reason_added, inventory_discrepancy, item_declined`. Request status, timers, queues and every dashboard number are derived from the events in the browser by `shared/derive.js` and `shared/metrics.js`; nothing is stored separately and nothing is hardcoded. Timestamps come from the server clock.
- **"Another size" and "Another style" mean different things.** *Another size* keeps the design and cut and moves to the nearest in-stock size. *Another style* means a different **design**, never a size change. The customer can say what they want different (**Collar, Pattern, Fabric** for shirts; **Neckline, Pattern** for polos; **Front, Fabric** for trousers; "fabric" crosses Oxford ↔ Poplin and chinos ↔ jeans). The rule: same size and kind of garment, a different design, **differing on every detail asked for and changing as little else as possible** (ask for a collar and the pattern stays the same); same cut first, then the original colour, then the closest fit. With nothing chosen, the smallest style change wins. Fallbacks are labelled: the other cut with a matching design, a partial match that says what could not be changed, and finally the other cut of the same design ("same design, other cut"). Fit and size suggestions stay inside the customer's own design, so a roomier waist never swaps the collar. The associate card names exactly what changes ("collar: Spread → Button-down. Pattern and fabric unchanged.") and the customer is told the same.
- **Floor pulls.** A floor pull asks a floor associate to fetch the confirmed items from the sales-floor racks and bring them to the room. The runner has two confirm buttons: **Confirm & bring all 3** (he fetches them himself) and **Confirm & ask floor to pull** (one tap: confirms and requests a pull for every confirmed item). After confirming, "Request floor stock pull" is also offered, once, while no pull is live or done. A pull that is not finished (waiting, or accepted) can be withdrawn with **Cancel pull**; it also cancels itself if the customer declines the items or cancels the request, and a cancelled pull can be requested again. Cancelled pulls are counted apart on Admin. A pull lists its items as they were when it was requested, so after a "not on rack" report cancel and request it again.
- **Handing over, and the customer's try-on.** After "Confirm & bring", the runner's next action is **Handed to customer** (event `delivered`). That is the end of the delivery stage (accept to handed over, with the same escalation rule), and the request stays open while the customer tries the item on, so the runner does not hover at the door. The customer's tracker then says **Delivered** and asks "How does the new one fit?" with two buttons. **Fits great** is recorded as the customer's own statement (`tryon_feedback`), shown to the runner, and is **not** an outcome: the staff still close the request with the real result, so the save rate is never inflated. **Still not right** opens "Which ones aren't right?": the customer taps **one or several** of the delivered items (the ones left out are left as they are), says what is wrong (one or two compatible fit issues, body areas, a note), and the **same request starts attempt 2**. Nothing new is created to track: one request, one tracker, one timeline, one outcome. It goes back to waiting (to the **same runner first**, widening after the primary wait as usual), its accept and delivery clocks and escalation start again for the attempt, and it gets a suggestion **for each reported item** (the best option for each first, then the next best of each, up to the trip size; anything already brought, missing or declined is never offered again). The customer's card says "Attempt 2: L Slim + M Regular" with a short history line; staff see an "Attempt 2" tag and a banner. Items not reported can still be reported in a later attempt, once each, with a different issue. The closing buttons name the item kept from **any** attempt. The headline response times and save rate come from the first attempt; Admin shows how many requests needed another attempt and how many of those were saved. Admin shows the median times to hand over, to set off and for the try-on, and how often customers say "still not right". **There is one hand-over, whoever does it:** if the floor associate finishes a floor pull ("Pulled & handed to customer") the request is delivered too and the runner's own button disappears (he sees "Handed to the customer by the floor associate"); if the runner hands over first, a floor pull still in progress is withdrawn, and the floor associate sees "The runner already handed the items to the customer" with nothing left to tap. Admin shows how many hand-overs each did.
- **Restock tasks from the Manager's signals.** A signal the floor can act on (a rack reported missing, or an item brought to the fitting rooms several times) has a **Send to the floor** button. It creates a task (`restock_task_created`, a recount or a restock near the fitting rooms) in the floor queue behind customer pulls, shown as "From the manager". It carries no quantity, because the app does not know backroom stock, and it never escalates. The server only creates one while the signal exists and none is already open. When the floor finishes a recount, the earlier "not on rack" reports for that item are cleared (the signal goes away and the stock count returns); finishing a restock resets the "brought to the fitting room" count. Admin counts restock tasks apart from customer floor pulls.
- **Room visits and fit carryover.** A fitting room's visit ends when the customer taps **I'm done with this room** (anything still open from the room is cancelled, so nobody carries items to an empty room), or after the room has had nothing open and no activity for `ROOM_SESSION_MINUTES` (default 30, editable on Admin). When a customer in a room buys an alternative (the runner taps the kept item when several were brought), and a second request comes from the same visit for a similar garment (same department, measured the same way), the associate sees a **Fit carryover** hint, for example "went from Poplin Shirt M Slim to L Slim (+5 cm chest, +4 cm waist). Consider bringing L Slim Oxford Shirt alongside." It is computed from the catalogue measurements, only offers in-stock items from the garment's own line, is only a hint, and uses nothing but the log of the current visit: no profile is kept, and a new visit starts clean.
- **Several best items per trip.** The associate no longer carries one guess at a time: the fit engine returns up to `BRING_COUNT` (default 3, range 1–5) **different** options, ranked best first (for sizes: the nearest sizes; for styles: distinct designs; colour only as a tie-break), each with its rack and stock. All are pre-selected; the associate unticks any they don't want and taps **Confirm & bring all 3**. The customer sees every item on the trip and may say "None of these". "Not on rack" is per item: the rest of the trip stays, and only the missing one is replaced by the next best. The engine, not the AI, picks every garment.
- **Escalated = focus mode.** An escalated request is pulled to a "Needs you now" group at the top of the queue, shown as only a ring, a timer and a one-line summary. Opening it shows the room, the issue, what to bring and **one** primary action; everything else (measurements, reasons, outcomes history) is collapsed under "Full details". Escalated items are open to every associate regardless of skills.
- **Team, sections and who gets a request.** On the Admin page the manager builds a team of runners and floor associates (a label each, no real names needed) and gives each person **primary** and **backup** sections (Men's / Women's × shirts / polos / trousers), and an on/off-shift switch. Each person gets a 4-character **join code**; a phone joins once and then shows the person's role and sections read-only, so an associate cannot change what they cover. A phone that has not joined sees only the join screen (with no team set up, everyone sees everything, as before). A new request goes to the **least busy** on-shift person whose phone is on and who has its section as **primary** (busy = requests given to them and waiting, plus what they accepted and have not finished; ties go to whoever was given a request least recently). If nobody has accepted after the **primary wait** (default 20 s), the least busy **backup** is added too: **the first person keeps it**. After the **backup wait** (20 s) it opens to everyone. **Whoever accepts first serves it**; the server enforces who may accept (409 if it is not yet theirs, 403 if the phone has not joined). A step with nobody to give it to is skipped without waiting, and an escalated request is open to everyone. Floor pulls follow the same rules through their request's section. Each accept records who took it and in which capacity (primary / backup / opened to all); Admin shows the split and the Manager status line shows the share taken by their primary person. A phone counts as "on" while it keeps polling; sample team: Admin > "Add a sample team".
- **Women's range.** The sample catalogue now has Women's shirts, polos and trousers (jeans and chinos), with tops in XS–XL and trousers in waist 26–34, beside the men's; the customer picks Men's or Women's first. Same sample-data label, same rules.
- **Routing (rules, no AI):** fit issues (tight / loose / long / short) → runner; another size → runner; another style → runner; stock checks and floor pulls → floor associate. Queues order by request type then waiting time, never by expected spend.
- **Fit matching (deterministic, `shared/fitMatch.js`):** the structured issue (tapped button + chips + parsed fields) maps to target measurements. It searches in-stock items of the same category and fabric family that improve the main problem, prefers one that also fixes the secondary problem, then the closest match on everything else, and always shows which measurements drove the choice. If a trouser length issue has no shorter inseam in stock, it shows the hemming / cross-store message; if nothing improves, it says so. If tapped chips and the AI disagree, a conflict note is shown and the tapped chip wins.
- **Cancellation:** a customer can cancel an open request from the tracker (a `cancelled` event, recording the stage it was cancelled at). Cancelled requests are counted separately and are **never** part of the save-rate denominator, because a customer who cancels before anyone arrives is not a lost sale. A cancelled request also withdraws its unfinished floor pulls.
- **Escalation has two stages, each with its own time (set on the Admin page).** Stage 1 runs from the customer's request until someone accepts it; stage 2 runs from accept until the item is on its way to the customer (for a floor pull: until it is handed over). A request or floor pull that stays in a stage past that stage's time gets one `escalated` event for the stage (`stage: accept` or `deliver`), at most once per stage. **Accepting it clears the escalation**: it stops showing as escalated and its timer restarts for the delivery stage, which escalates again only if the delivery time is passed. The history is kept in the log and counted per stage. "Delivered" means the on-its-way step: the app has no later "arrived" event, so that is the last point it can know. An escalation sits in its own queue under "Needs you now", is **mirrored into the other team's queue** under "Escalated — can you assist?" with a pulsing **Assist** button, and is listed on the Manager dashboard under "Needs attention" with the stage that was missed. Tapping Assist appends an `assisted` event (once per escalation, only from the team that is not holding the item); the assisting team can then accept and work it, and the manager sees the time to assist. There are no logins, so ownership is per team, not per person.
- **"Not on rack — show next best":** if the associate finds the suggested item missing, one tap appends an `inventory_discrepancy`, withdraws that item (the customer's tracker steps back to "Accepted (checking stock…)") and re-runs the same deterministic fit engine **excluding** it, giving the #2 alternative or the hemming / cross-store message. The report also lowers that SKU's stock for later requests (effective stock = sample stock minus reports, derived from the log). It is not a "rejection" of the fit logic and does not enter suggestion acceptance. If the request then ends unsaved (left / saved for later), a one-tap "stock record wrong" reason (system-observed) is offered; reasons are never auto-logged.
- **The customer screen is two exclusive states.** The *form* (garment, style, colour, size, cut, issue, optional details and note) shows only when there is something to ask; the room is locked into a "📍 Room 2 · Change" pill once chosen, the Send button says what is still missing ("Select issue to continue") and then names the order ("Send request: White Poplin Shirt XL Slim"). After sending, the form is **not rendered at all**: an *order card* shows a horizontal Requested → Accepted → On the way → Resolved stepper, the item and issue, and a live box ("Waiting…", "Checking stock…", then "Bringing to Room 2" listing every item on the trip by its full name, with a one-line reason). "+ Request another item" opens a **clean** form (room kept, nothing else pre-selected) with a link back; other open requests in the room appear as compact "Request 1 of 2" cards. The "Illustrative sample data" label now sits in a quiet footer instead of the middle of the form.
- **Several issues for one article.** For a fit problem the customer can tap two issues that do not contradict (for example **too tight** and **too short**; "too tight" with "too loose", or "too long" with "too short", swap instead). Size, style and stock checks stay single choices. The request keeps the list (`issues`; the first is the main one for routing and labels). Each issue gets its own body area: the tapped chip of its kind (girth areas for tight/loose, length areas for long/short), else the area the AI read, else the garment's default. The matcher looks for items that fix **both**: if any in-stock item does, only those are offered; if none can (for example "too tight" and "too long" where chest and length grow together), the best items for the first issue are shown and the reason names the one left unfixed ("does not fix body length"), with a hemming hint for trouser length when the store offers alteration. The Manager heatmap and per-garment counts count a two-issue request under both of its areas. The associate's "used for matching" panel lists both.
- **Customer form:** garment → style variant (when the garment has more than one) → colour → size → cut; the six fit/style issues sit in a 2-column grid with the stock check below; the "Where?" body-area chips appear only for fit issues (too tight / loose / long / short) and depend on the garment (tops: Waist, Chest, Shoulders, Sleeves, Length; trousers: Waist, Hips, Length). The Send button carries the summary ("Room 3 · White Oxford Shirt · L Slim"). Once an item is on its way, the tracker shows a **"What we're bringing"** card: every item on the trip, a plain-language reason and a "None of these" button. No cm deltas are shown to the customer: one changed number never tells the whole story (a bigger waist can come with a longer rise or a different cut), so the full measurement table lives on the associate card only.
- **Associate cards are quick to scan.** The room number sits inside a ring that fills towards the escalation threshold (green, amber, pulsing red); racks are coloured pills by aisle; the garment is named once and the suggestion lists up to three items with their racks (the full measurement table, every measurement side by side, is one tap away); provenance is compact (👤 tapped, ✨ AI, ⚙ rule-based fallback, with a legend, and "Rule-based fallback — not AI" stated once when it applies).
- **The associate card follows the physical step.** After Accept it shows only the suggestion and its actions (Confirm & bring with the rack, Reject, Not on rack, floor pull). Once the item is on its way it collapses to one summary line (fit details one tap away) and the five outcome buttons plus the reason box appear. Outcomes are also open when there is nothing to bring (hemming / no alternative) or after a reject, and a small "Customer left early" link is always available.
- **Not-on-rack feedback:** the missing item is shown struck through with its rack ("Rack A5 — marked empty"), the next best appears under an amber "Fallback #2" header with its new rack and stock, and a toast says where to walk.
- **Reasons are only for requests that did not convert.** After a request closes as "Left" or "Saved for later", the card asks "Why didn't it convert?" with six one-tap chips (method `quick_pick`, no AI call) or a typed note, which is structured and shown for a one-tap "Looks right" (or an edit), never saved unreviewed. Sales (bought original or alternative, cross-store order) and customer cancellations are not asked; the server refuses a reason for them (409), and the Manager's "Why requests didn't convert" ignores any on a sale.
- **"Not this one":** once an item is on its way, the customer can tap this (an `item_declined` event). The runner's card is flagged ("Customer says: not this one — don't bring it") and offers "show next best", which never re-offers the declined item.
- **One QR code per fitting room:** open `/#customer?room=3` and the room is pre-set (with a "Change" link). Print one QR code per door in a real deployment; the room picker remains the fallback.
- **Several garments in one room:** the customer screen lists the other open requests from the same room, read from the shared log (a room number is not personal data), so nothing is stored in the browser.
- **Privacy:** no names, phone numbers or customer IDs are collected. Free text is parsed on the server and discarded; only the structured result and a short English summary (scrubbed of phone numbers and emails) are stored.

### Dashboard definitions

- **Issue save rate** = (bought original + bought alternative + cross-store order) ÷ closed requests. Labelled "Fitting-room proxy, not store conversion".
- **Deferred** = saved for later ÷ closed requests, shown separately and not counted as saved.
- Open / accepted / closed counts, median time-to-accept and time-to-close, escalations, outcome mix, suggestion acceptance = confirmed ÷ (confirmed + rejected).
- Reasons are split by evidence type: customer-stated, associate-observed, system-observed, unknown. Floor-pull tasks are excluded from request counts.
- Cancelled requests are shown separately ("before anyone accepted / after accept / item on the way") and counted in the total, but excluded from the closed and save-rate figures.
- **Merchandising & fit signals** (above the per-SKU breakdown): deterministic observations with their evidence, e.g. *"Oxford Shirt · White · L Slim: 3 of 3 requests were 'Too tight · Waist' — worth reviewing size grading / fit with the buying team"*, *"…no in-stock alternative in 3 of 4 suggestions — review stock depth"*, and *"…reported missing on the rack 1 time — recount the rack"*. Each signal carries a recommended action badge ("Audit rack A5", "Flag fit to the buying team", "Review stock depth", "Keep a buffer near the fitting rooms" for a replacement brought to the fitting room at least twice). Actions are rule-based and never include invented quantities. A signal appears only when its threshold is met (prototype settings below). They are **shares of requests, not defect rates**: only customers who asked for help are counted. No unit counts or restock quantities are invented.
- **By garment, size & cut:** per SKU: request count (n), top issue and area, save rate, cancellations, and a stock-gap signal (suggestions where no in-stock alternative existed). Areas are reported only where the customer tapped or typed one, never from a default assumption. Groups with fewer than `SMALL_SAMPLE_N` requests are flagged "small sample".
- **The Manager screen is a short "command center", drawn rather than listed.** Three headline cards (issue save rate; **SLA health** as bullet bars of the median time to accept and the median time from accept to on-its-way, each against its own stage's marks; **not on rack**), a **100% stacked outcome bar** over closed requests (its bought-alternative, bought-original and cross-store segments add up to the save rate; "saved for later" is its own segment because it is not counted as a save; cancellations sit outside the bar), a **garment × body-area fit heatmap** (coral = needed more room or length, teal = needed less; darker = more requests; requests where the customer named no body area are plotted in a "No area" column, so every fit request is in the matrix), the "what to act on" signals, escalations needing attention, and why requests didn't convert. Definitions are behind a small ⓘ instead of captions. Everything else lives on the **Admin page** (`/#admin`, linked in the header): prototype settings, demo controls, "Clear demo data", detailed metrics, **per-garment breakdown**, parser statistics, and the colour-coded event log with filters.
- With no closed requests, rates show "–" instead of 0%.

### Prototype settings

All in `shared/config.js`, overridable by env vars, and displayed on the Admin page. The two escalation times and the two waits can also be **edited on the Admin page** (whole seconds; escalation 10 to 3600, waits 5 to 3600); they apply to every phone at once and are saved next to the log in `data/settings.json` together with the team, so they survive a restart and "Clear demo data" leaves them alone. The Admin page has no login in this prototype, so anyone who can open it can change them:

| Setting | Env var | Default |
|---|---|---|
| Escalate if not accepted within (stage 1) | `ACCEPT_ESCALATE_SECONDS` | 120 |
| Escalate if not on its way within, counted from accept (stage 2) | `DELIVER_ESCALATE_SECONDS` | 120 |
| (`ESCALATE_SECONDS` still works as one shared default for both) | | |
| A card turns amber at this share of its stage time | fixed | 0.5 |
| Store offers alteration (hemming) | `ALTERATION_OFFERED` | true |
| Minimum improvement counted as "better" | `MIN_IMPROVEMENT_CM` | 1.0 |
| Per-SKU groups below this many requests are flagged "small sample" | `SMALL_SAMPLE_N` | 5 |
| A fit / stock-depth signal needs at least this many requests (or suggestions) | `SIGNAL_MIN_N` | 3 |
| ...and at least this share of them pointing the same way | `SIGNAL_MIN_SHARE` | 0.6 |
| A rack is flagged for a recount after this many "not on rack" reports | `SIGNAL_MIN_MISSES` | 1 |
| A replacement brought to the fitting rooms this many times is flagged as high demand | `SIGNAL_MIN_PULLS` | 2 |
| Items brought per trip (1–5) | `BRING_COUNT` | 3 |
| Seconds the primary person has a request before a backup is added too (also editable on Admin) | `PRIMARY_WAIT_SECONDS` | 20 |
| Seconds the backup has it before it opens to everyone (also editable on Admin) | `SECONDARY_WAIT_SECONDS` | 20 |
| Seconds a phone counts as on after it last polled | `STAFF_ACTIVE_SECONDS` | 60 |

## Demo controls (optional)

Set `DEMO_CONTROLS=true` (for example in `.env`) and the Admin page shows two switches. They change **settings only; the event log is never edited**, and they affect everyone using the app, so leave them off on a public deploy (the Render blueprint sets `DEMO_CONTROLS=false`).

- **Force rule-based fallback** simulates an AI outage or rate limit: new requests are parsed by rules and labelled "Rule-based fallback — not AI". It also keeps you under the Cerebras per-minute limit while rehearsing.
- **Fast timers** sets both stages to warn at 10 s and escalate at 20 s, so amber, red and the Assist flow appear on demand. It **switches itself off after 5 minutes** (back to the configured times), so it cannot be left on by mistake; the Admin page shows when. Escalations that fired stay in the log.

## Project layout

```
shared/   pure ES modules used by server, browser and tests
          config · events (vocabularies) · catalogue (generated size grids, men's and women's) · skills · derive · routing · fitMatch · visuals · metrics · parser
server/   index.js (Express API + sweep) · store.js (JSONL log) · llm.js (Cerebras adapter)
public/   index.html · style.css · app.js (router/poll) · core.js · customer.js · associate.js · manager.js · admin.js
test/     unit tests + end-to-end demo-script test
```

## Limitations (v1)

- Sample catalogue only: no real stock or POS integration.
- No login, roles or multi-store views. Role is just a tab.
- The log is a single file on one server instance, which is fine for a demo, not for production.
- Roadmap, deliberately not built: voice input (v2, would feed the same parser; needs HTTPS and has a privacy cost), a zero-PII Claim Pass for saved-for-later / cross-store outcomes, real staff logins (a person is a label with a join code today), and batch pulls for nearby racks. No WhatsApp.
