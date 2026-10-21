# Fitting-Room Request Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline). Steps use checkbox syntax. Test-first for every `shared/` module.

**Goal:** Working multi-phone prototype of the closed fitting-room loop, driven by one server-side event log.

**Architecture:** Express server holding an append-only JSONL event log; vanilla-JS SPA polling `/api/events`; all derivation (status, timers, metrics, fit matching) in pure `shared/` ES modules used by server, browser and tests.

**Tech Stack:** Node 20+ (installed: 24), Express, `node:test`, vanilla ES modules, Cerebras OpenAI-compatible API.

**Spec:** `docs/superpowers/specs/2026-10-20-fitting-room-loop-design.md`

## Global Constraints

- No names, phone numbers or customer IDs anywhere; raw free text never stored or logged.
- Catalogue screens labelled "Illustrative sample data — not Tommy Hilfiger specifications".
- Manager banner "Demo data — prototype only, not store results"; save-rate label "Fitting-room proxy, not store conversion".
- Thresholds/settings live only in `shared/config.js`, shown as "prototype settings".
- Every metric computed from events; none hardcoded. Routing/priority never uses expected spend.
- AI never picks the garment, changes an outcome, or marks a sale recovered. Fallback labelled "Rule-based fallback — not AI".
- Shared state server-side only.

## Module interfaces (fixed names used by all tasks)

- `shared/config.js`: `makeConfig(env = {}) → {warnSeconds, escalateSeconds, alterationOffered, minImprovementCm}`
- `shared/events.js`: enums `ISSUES, AREAS, CHIPS, ISSUE_WORDS, OUTCOMES, ROLES, REASON_TAGS, EVIDENCE_TYPES, SAVE_OUTCOMES`
- `shared/catalogue.js`: `CATALOGUE, CATALOGUE_LABEL, getSku(id), garments()`
- `shared/parser.js`: `validateCustomer(raw), validateReason(raw), ruleBasedCustomer(text), ruleBasedReason(text), parseCustomerText(text, llm), parseReasonText(text, llm)` where `llm(kind, text) → Promise<string|null>`; parse fns return `{fields, method}`
- `shared/fitMatch.js`: `mergeIssue({issue, chips, parsed, sku}) → issueInfo`, `fitMatch({sku, issueInfo, catalogue, config}) → result`
- `shared/routing.js`: `routeFor(issue) → {role, rank, rule}`, `TASK_ROUTE`, `buildQueue(role, derived, now)`
- `shared/derive.js`: `deriveAll(events) → {requests, tasks, byId}`, `timerState(elapsedMs, config)`, `customerSteps(req)`
- `shared/metrics.js`: `computeMetrics(events) → metrics`
- `server/store.js`: `createStore({file}) → {append, since, all, reset, epoch}`
- `server/llm.js`: `makeLlm(env, fetchImpl) → llm | null`
- `server/index.js`: `createApp({store, llm, config, now}) → express app`; `npm start` runs it

## Tasks

### Task 1: Scaffold, config, enums, catalogue
**Files:** `package.json`, `.gitignore`, `.env.example`, `shared/config.js`, `shared/events.js`, `shared/catalogue.js`
- [ ] `npm init`, install `express`; scripts `start`, `test` (`node --test test/`).
- [ ] Implement the three shared files exactly per spec §5, §7.
- [ ] Sanity test: catalogue has 8 SKUs, one has stock 0, `makeConfig` honours env overrides.

### Task 2: Parser (TDD) — `test/parser.test.js`
- [ ] Tests: valid JSON; fenced JSON; off-list → `other/unknown`; garbage throws; confidence clamp; phone/email scrub; Hinglish demo phrase via rules → waist/tight primary, sleeves/long secondary; reason fallback → `time_constraint`/`customer-stated`; `parseCustomerText` falls back on null llm and on llm throwing/invalid, with `method` set to `rule_fallback`, and to `ai:<model>`-style tag passed by llm wrapper on success.
- [ ] Implement `shared/parser.js`.

### Task 3: Fit matching (TDD) — `test/fitMatch.test.js`
- [ ] Tests: Oxford L Slim + waist tight + sleeve long → OX-M-REG with drivers; secondary-fix beats XL; chinos too long → `alteration_or_crossstore` (and hemming-off variant); shirt tight with impossible target → `no_alternative`; out-of-stock never chosen; chip wins over conflicting AI with conflict note; inapplicable chip ignored; another_size/another_style/check_stock kinds.
- [ ] Implement `shared/fitMatch.js`.

### Task 4: Derive, routing, metrics (TDD) — `test/derive.test.js`, `test/metrics.test.js`
- [ ] Tests: status progression; timer states; queue ordering by rank then wait; floor task excluded from metrics; save rate 100% then 50%; zero closed → null; medians; acceptance rate; reasons by evidence type.
- [ ] Implement `shared/derive.js`, `shared/routing.js`, `shared/metrics.js`.

### Task 5: Store, LLM adapter, server, e2e — `test/e2e.test.js`
- [ ] Implement `server/store.js`, `server/llm.js`, `server/index.js` (endpoints per spec §9, escalation sweep, rate limit, 409 guards).
- [ ] e2e test plays the spec §15 demo script over HTTP with no API key; asserts statuses, floor-queue entry, 100% → 50%, reason evidence type, timeline.
- [ ] Unit-test `llm.js` with mocked fetch (success, HTTP error, timeout).

### Task 6: Frontend — `public/*`
- [ ] `index.html`, `style.css` (mobile-first, light/dark), `app.js` (poll loop, hash routing, clock offset, API helper), `customer.js`, `associate.js`, `manager.js`.
- [ ] Verify in the built-in browser at phone width: run the demo script through the UI across multiple tabs.

### Task 7: Docs and deploy
- [ ] `README.md` (run, API key, phones, public deploy, demo script, prototype settings), `render.yaml`.
- [ ] Run `npm test`; final full UI walkthrough; report results truthfully.
