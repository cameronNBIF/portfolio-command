# Build Log — Portfolio Command

A running record of what was built, in what order, and what changed. Complements `docs/architecture-decisions.md`: **ADRs capture decisions with lasting consequence; this file captures what actually happened.**

Newest entries at the top. Update at the end of every working session — an entry with nothing under "Changed" or "Outstanding" is still worth writing, because the gaps are what future-you needs.

---

## Entry format

```
## YYYY-MM-DD · Phase ref · Short title

**Built**
- What now exists that did not before.

**Changed**
- Anything altered from the plan, the schema, or an earlier build. Say why.

**Decided**
- Judgement calls made in passing. If it has lasting consequence, also raise an ADR.

**Outstanding**
- What is blocked, deferred, or needs someone else.
```

Phase refs come from `docs/delivery-roadmap.md` — A0, A1, A2 and so on, suffixed for sub-tasks (A0.1, A0.2). Track B and C items use B and C refs.

---

## 2026-08-11 · A3 · API and persistence — the frontend now runs on Postgres

**Built**
- **`packages/api`** — a fifth workspace package holding the read path, the write path, authorisation and the unit boundary. It knows nothing about HTTP, so the logic worth testing is testable without a server; the Next route handlers are thin wrappers.
- **`src/units.ts`** — the ADR-001 `$M`/dollars conversion, in both directions, in **one** place. The literal `1e6` appears nowhere else in the repository.
- **The ADR-001 document importer** (`src/import/`) — the real D-1 import path, not a dev seed. Derived fields advisory, reconciliation warnings named, every row `is_synthetic` and `batch_id`-tagged so a load reverses wholesale. `npm run import:fixture`.
- **The adapter** (`src/read/export.ts`) — database rows to the frozen contract. Rounds delivered unfiltered so the leverage predicate stays in `packages/metrics` (ADR-021, ADR-023).
- **Authorisation** — the four ADR-005 roles, an Entra seam with a working dev provider, and full JWKS bearer validation for when the registration is configured.
- **`audit_log` on every write**, capturing before and after against a real `app_user`.
- **`GET /api/v1/export`** and **`POST /api/v1/judgement`**.
- **The ADR-020 synthetic-data banner**, which did not exist. A2 had a fixture so the flag was never real; it now reads from `v_synthetic_data_status` through `meta.demo`, appears above the header on every screen, has no dismiss control, and carries into the print stylesheet.

**Verified** — the round trip is **exact**. `demo.json` → Postgres → contract reproduces the document field for field, all 70 companies, 11 deals, 6 LP positions and the fund. Every A1 golden-master metric reproduces over the **database-built** document, which is what closes the residual risk ADR-021 names. 267 tests pass (17 new). In the browser: the dashboard renders from Postgres at $300.8M invested, $577.8M FMV, TVPI 2.08x, DPI 0.16x, gross IRR 19.0%, leverage 2.6:1, 39 alerts of which 13 critical, 64 active / 6 exited — every figure identical to A2. Role enforcement exercised live: `leadership` reads the export at 200 and is refused a gate edit at 403. A financial-table edit through the judgement endpoint is rejected by construction.

**Decided**
- **ADR-025 · `fund.distributions[]` stays a stored series and the ADR-002 correction is deferred.** The fixture's fund-level distributions ($47.5M) and per-company realizations ($53.0M) disagree by exactly $5.5M, and the decomposition is now known: three exits itemised per company against two "Generated exits" aggregate rows covering the same events. Deriving one from the other moves **five board numbers visibly** — TVPI 2.08x→2.10x, DPI 0.16x→0.18x, gross IRR 19.0%→19.1%, net IRR 16.7%→16.8%, dry powder $146.7M→$152.2M. Keeping them frozen is what makes A3's round trip a real test: any number that moved during the storage swap is an adapter bug, not an intended change. Approved this session.
- **ADR-026 · The importer preserves contract strings verbatim and resolves reference keys on exact match only.** Six vocabulary collisions surfaced at once — the fixture's sectors are generic-VC (`AI / ML Infra`, `Enterprise SaaS`) against Affinity's real provincial taxonomy (`ICT`, `Agritech`, `Oceans`), overlapping on `Cybersecurity` alone. Coercing to a nearest neighbour would break the round trip; inserting fixture values into `ref_sector` would pollute the taxonomy ADR-009 makes Affinity the system of record for. Both stored instead, and 61 of 70 companies correctly carry a null `sector_id`. **Directly informed by the steer this session that A4/A5 should bring as much real data as possible** — it makes A4 a clean overwrite rather than a cleanup job.
- **ADR-027 · Four fields in ADR-002's derived inventory are independent facts and are stored.** Established by measurement, not inspection: `reservesDeployed` disagrees with any round sum on 4 of 70 companies; `runwayMo` equals `cash/burn` on **10 of 71** KPI rows; `fteAtEntry` predates the KPI series by up to a decade; `company.instrument` is neither the first nor the last round's on C009. Each also has a reason to stay independent once real data arrives — runway is company-reported through Visible and the platform is not the system of submission (ADR-017). Three LP fields (`coInvestsDone`, `referrals`, `capitalToDirect`) are **carried rather than reclassified**: they have a working derivation from `round_coinvestor`, waiting on the A8 capture form.
- **The as-of parameter reaches exactly one column.** `v_company_current`'s `current_date` TODO is resolved as `company_current_asof(p_as_of date)`. Only `fmv` takes the date. `invested`, `realized` and `exited` deliberately do not: two exits in the fixture are dated **after** the pinned as-of (Nimbus Grid 2029, Quorum 2027), so filtering realizations by date would erase $13.4M and move company MOIC.
- **`ownership_after_pct` widened to `numeric(19,16)`.** The contract carries a computed float (`10.521185332909226`) and `numeric(7,4)` truncated it on four rows. Scale is contract fidelity, not a claim about cap-table accuracy.
- **Roles come from `app_user.role`, never from an Entra app-role claim.** Entra proves identity; the platform decides permission. The app registration needs only sign-in configured, changing someone's role is a database update rather than a tenant change, and the row that granted the permission is the row `audit_log` attributes the write to.
- **`0001_init.sql` amended in place again**, per the A1 precedent and its stated expiry: nothing is deployed, the runner aborts loudly on a checksum mismatch, and the `schema.sql ≡ 0001` invariant is worth more than an empty forward migration. **This stops being available the moment anything reaches Azure.**
- **`page.tsx` calls the API layer directly rather than fetching its own endpoint.** Both paths run the same authorisation and the same adapter; a server component fetching its own origin adds a hop and a token it already has the identity for. `GET /api/v1/export` exists for the export contract and external consumers.
- **`PipelineDeal.valuation` corrected to `number | null`** in the contract types. Two deals in the fixture are genuinely unpriced; the type said `number` and was already inaccurate. The JSON shape is unchanged, so this is not a contract change.

**Outstanding**
- **The Entra app registration is created but otherwise unconfigured.** `AUTH_MODE=entra` is implemented and validates properly, but nothing can obtain a token until the registration has a redirect URI, an exposed API scope and the frontend MSAL flow. Running on `AUTH_MODE=dev` locally. **No MSAL sign-in UI exists yet** — that is the honest gap in A3's auth exit criterion; the authorisation half is complete and enforced.
- **Memos are untested against real content.** `demo.json` carries an empty `memos` object, so the memo import and export paths round-trip nothing. The write path was exercised directly.
- **`v_lp_position_current.tvpi`/`.dpi` and `v_round_leverage` are still present and still convenience-only** (ADR-023). Now that the API exists, removing them is finally cheap.
- **`fund.currency` is `USD` in the fixture while transactions store CAD**, because the contract carries no per-transaction currency. Flagged as an import warning rather than resolved silently; harmless on demo data, needs a real answer before any non-CAD position exists.
- **`pipeline_deal.funnel_stage_id` is nullable at A3 only.** Restore `NOT NULL` at A4 when every stage resolves against Affinity's real vocabulary.
- **`docs/reference/demo.json` remains the only dataset.** A6's generator and the real Affinity roster replace it; the importer is written to take either.
- Carried: `eslint-config-next` not wired into the flat config; `npm audit` transitive dev-tooling findings; `ref_funnel_stage` seeding from Affinity metadata; branch protection not configured; deploy not wired.

---

## 2026-08-11 · A2 · Frontend ported against the seed fixture — all eight tabs

**Built**
- `apps/web/app/globals.css` — the prototype's `<style>` block **verbatim**. That stylesheet is what delivers "looks identical to the prototype", so it is extracted rather than rewritten. Two marked additions at the end, both structural: Chart.js drew tooltips on canvas where Recharts renders DOM, and a body scroll-lock class behind the open drawer.
- **Shell** (`components/AppShell.tsx`) — header, eight-tab nav, scrolling main, drawer, overlay, toast, plus Escape-to-close and overlay-click-to-close.
- **Eight tabs**: Dashboard, Portfolio, Funds, Pipeline, Modeling (two sub-tools), Memo Builder, Reports, Data.
- **Three drawers**: company, LP position, pipeline deal.
- **Twelve charts** ported from Chart.js to Recharts at visual parity.
- `packages/contract` consumed end to end — every component reads the ADR-001 shape and nothing else.
- Root `npm run dev`.

**Verified** — in a browser, tab by tab, against the golden-master fixture. Dashboard invested $300.8M / TVPI 2.08x / gross IRR 19.0% / leverage 2.6:1 / 39 alerts of which 13 critical; Portfolio 64 active with Cobalt Harbor top at 5.24x and G/L +50.9, sort flips on a second click, exited filter shows six with ownership "-"; all six LP positions match their frozen TVPI, DPI and IRR; Pipeline 2/5 closed and $15.8M probability-weighted; Reserves policy-suggested $128.9M matching the frozen rounded-sum total; the waterfall pays pari passu below the pref stack and the greater of pref or as-converted above it; memo prefill for Vantara shows 2.91x; Reports reads FY2025-26 Q4. Gate and reserve edits write through and survive a drawer close and reopen.

**Decided**
- **`asOf` is derived from the latest valuation mark, not the clock.** This is the one place A2 looks different in a side-by-side: gross IRR reads 19.0% against whatever the prototype renders today, which drifts about a point per quarter. Same definition, stated date — and it makes the IRR consistent with the marks it is built on, which ADR-007 wants stamped on board-facing views anyway.
- **The J-curve stayed out of `packages/metrics`.** It is a modelled interpolation, not a metric, so it ports with the chart code. It now takes `asOf` rather than reading the clock, and reads inception from `fund.vintage` rather than a hardcoded 2019 — which *is* 2019 here, so nothing moves.
- **The hardcoded `"2026"` in the pipeline closed-YTD filter now reads the year from `asOf`.** Identical output on this data; it simply stops being wrong on 1 January.
- **`lib/editable.tsx` draws the ADR-018 line explicitly.** Gates, reserves and memos are judgement records and are freely editable; nothing in that provider can reach a transaction, a mark or an LP cashflow. State is lifted above both tab and drawer so an edit made in the drawer survives closing it. A3 replaces it with API writes into `audit_log` and the shape above does not change.
- **The Data tab's schema block and CSV specs are extracted from the prototype at build time**, not transcribed, so 55 lines of contract documentation cannot drift by typo.
- **Import is shown as unavailable rather than faked.** There is nothing to import into a read-only fixture. The D-1 advisory-fields rule is stated on screen for when it arrives at A3.
- **`next.config.ts` gains an `extensionAlias`** so webpack resolves the metrics package's NodeNext `.js` specifiers. The bundler bends rather than the library, which would otherwise fail its own typecheck and vitest run.

**Both sanctioned content exceptions are live and marked in place.** D-2: revenue is labelled quarterly-as-reported on the dashboard tile, the Portfolio column note, the memo prefill and the Reports highlight; the arithmetic is untouched. D-5: the diversity tile excludes non-reporters from the denominator and states coverage, the drawer shows "Not reported" rather than "0 of 0", and the Reports impact line names the reporting count. Every quarterly view states its convention per D-6 — calendar on the Portfolio KPI history, fiscal on Reports.

**Outstanding**
- **Side-by-side sign-off against the prototype is the exit criterion and has not formally happened.** The Dashboard was reviewed and accepted; the other seven tabs have been verified against the fixture by value, not by eye against the prototype.
- **One inherited disagreement is now visible on screen**: the NB Co-Investment tile and the Capital Attracted chart do not quite reconcile, because the tile neither caps nor excludes and the chart does both (`INHERITED-COERCIONS.md §2`). Present in the prototype too, reproduced deliberately.
- The Reports print path is the browser's. A11 replaces it with Playwright, which is when it becomes the board-facing artefact ADR-005 requires.
- `eslint-config-next` is installed but not wired into the flat config; Next warns on each build. Harmless, worth doing when A2's review settles.
- Carried: `v_company_current.fmv` still reads `current_date`; `npm audit` transitive dev-tooling findings; `ref_funnel_stage` seeding from Affinity metadata.

---

## 2026-08-11 · A0 (deferred item) · CI on GitHub Actions; capture made platform-independent

**Built**
- `.github/workflows/ci.yml`. Two jobs, split by whether they need a database. Closes the last open A0 exit criterion except deploy, which waits for the Azure resources — a deploy step wired to nothing is worse than none.
- **`verify`** (no services): `npm ci`, lint, typecheck, test, **golden-master reproducibility**, then the web build.
- **`database`** (postgres:17 service): migrations apply to an empty database; migrate and seed are then re-run to **assert idempotency** rather than assume it; `db:types` is regenerated and diffed to prove the committed generated types still match the schema.

**Changed**
- **The capture harness is now platform-independent.** Adding a Linux runner surfaced two ways the capture was silently bound to the machine that ran it, neither of which could show up while development was Windows-only:
  1. **Digests were computed over raw bytes.** The working copy is CRLF here and LF on a runner, so the same committed file hashed two different ways. Digests are now taken over line-ending-normalised content — the same normalisation `migration-parity.test.ts` already does. Metric values were never affected: `demo.json` parses identically either way.
  2. **The fixture recorded the runtime locale.** `resolvedLocale` came from `Intl.NumberFormat().resolvedOptions()`, which is `en-CA` here and whatever the runner defaults to there. The harness now pins `DISPLAY_LOCALE` itself and records the pin, and the capture formats job counts through it.
- Fixture recaptured. **Only three provenance fields moved** — the two digests, the script byte count, and the locale field's name and note. Every metric value is untouched and all 249 tests passed before and after.

**Decided**
- **The harness defines its own `DISPLAY_LOCALE` rather than importing the one in `src/format.ts`.** The harness must not depend on the implementation it exists to check (ADR-022), so the constant is deliberately duplicated — and `golden-master.test.ts` asserts the two agree, which is what stops the duplication rotting.
- **CI re-captures and verifies the fixture with `--check`, not with `git diff`.** The check catches three distinct things a passing test suite would not: an edit to `vc-toolkit.html` (a reference document that should not be edited at all), a re-export of `demo.json` (which invalidates every fixture at once), and a hand-edited fixture made to silence a failing test — the one thing ADR-013 exists to prevent. All three verified by tampering deliberately: a 0.3% value edit is caught, and so is a display-string-only edit that a float comparison alone would miss.
- **`git diff --exit-code` was the wrong check and the first CI run proved it.** It asserts bit-identical floats across operating systems, which JavaScript does not offer. **`Math.pow` is implementation-approximated in ECMAScript** — not required to be correctly rounded — so `runScenario`'s `Math.pow(mo, 1/yrs)` returns `49.30267835392137` on Windows and `49.30267835392135` on the Linux runner. A relative difference of 4e-16, with an identical display string. `xirr` is unaffected: 120 bisection halvings of a fixed bracket converge to a stable point either way. `--check` compares structure and strings exactly and floats within `FLOAT_TOLERANCE`, keeping every drift property without failing on the last bit.
- **`FLOAT_TOLERANCE` lives in the harness and the golden-master test imports it**, so the tolerance is one number rather than two that can drift apart.
- **The database job asserts idempotency explicitly.** Forward-only migrations mean a re-run must be a no-op and the seed is written to be re-runnable. A migration that is not safe to re-run is otherwise discovered at the worst possible moment.
- Node pinned to major 22 via a workflow-level env var rather than tracking `latest`, so a Node release cannot turn into a mystery failure.
- The `database` job's Postgres password is a literal in the workflow. It is an ephemeral throwaway inside the runner with nothing real reachable from it, so it is not a secret — but it is worth stating rather than leaving a reader to wonder.

**Outstanding**
- **Deploy is not wired.** Arrives with the Azure resources at A0.
- Branch protection is not configured; CI reports status but nothing yet requires it to pass before merge. Worth turning on now that there is something worth blocking on.
- Carried: `v_company_current.fmv` still reads `current_date`; `npm audit` transitive dev-tooling findings; `ref_funnel_stage` seeding from Affinity metadata.

---

## 2026-08-11 · A1 (stage 3) · Metrics package ported, golden master green, contract snapshot

**Built**
- **`packages/contract`** — the ADR-001 export contract as TypeScript types and nothing else. No runtime code, no I/O, no dependencies. Imported by `packages/metrics` now and by `apps/web` and the API at A2/A3.
- **`packages/metrics/src`** — the port, as pure functions over the contract shape. `format.ts` (the `fmt` object plus the three call-site formatters the prototype inlines), `xirr.ts`, `company.ts` (`moic`, `suggestedReserve`, the two gain/loss definitions), `fund.ts` (the 31-field `fundMetrics` bag), `lp.ts`, `alerts.ts`, `scenario.ts`, `selectors.ts`.
- **`test/golden-master.test.ts`** — 202 assertions against the committed fixtures. Display strings exact, floats to 1e-12 relative.
- **`test/coverage-gaps.test.ts`** — 46 constructed tests for the paths `demo.json` cannot reach.
- **`test/contract-snapshot.test.ts`** — the ADR-001 guard.

**Verified**
- **249 metrics tests pass; the port reproduces every prototype number on the first run.** No fixture was touched at any point.
- **The suite was mutation-tested rather than trusted.** Applying the per-round cap to `nbCapital` — the exact "fix" the rejected ADR-024 would have made — failed two assertions and reported the delta as `166.19999999999996 vs frozen 166.69999999999996`. The suite catches a 0.3% change to a board number and names the field.
- Re-running the capture harness after the port reproduces the committed fixture byte for byte, so the harness and the port agree independently.
- `typecheck`, `lint` and the migration parity test all pass.

**Decided**
- **`fundMetrics` keeps `cs` (all companies) and `actC` (active only) exactly as the prototype mixes them**, with the map in `INHERITED-COERCIONS.md §1`. Reproduced, not tidied.
- **The contract snapshot fingerprints structure, not values.** It walks the document and emits `path: type` for every field, unioning types across array elements and collapsing arrays to `[]`, so adding a company cannot change it but adding a field to a company must. Alongside it sit explicit unit assertions — money is `$M` not dollars, percentages are plain numbers not fractions, dates are `YYYY-MM-DD`. Those matter because a dropped `$M` conversion would multiply every figure by ~1e6 while leaving every field name identical, and a name-and-type snapshot alone would not notice.
- **`DISPLAY_LOCALE` pinned to `en-CA`.** The prototype calls `toLocaleString()` with no locale, so job counts rendered differently per environment. The port pins it, and a test asserts the fixture was captured under the same locale — otherwise a CI failure would report a metric change when the truth is a locale difference.
- **`diversityWithCoverage` implements D-5 as a separate function** rather than changing `fundMetrics`. The frozen bag keeps the `|| 0` coercion; the D-5 selector excludes non-reporters from the denominator and returns coverage alongside. Both are tested. This is the only sanctioned departure and it lives beside the frozen definition rather than replacing it.
- **`lpMetrics` is the port's name for `fiMetrics`**, with `fiMetrics` kept as an alias so the prototype's name stays greppable.
- **Two of my own test expectations were wrong and were corrected, not the code.** A one-year doubling solves to 99.716%, not 99.8% — 2024 is a leap year, so the span is 366 days against an ACT/365.25 year. And a loss worse than −95%/yr returns `null` rather than clamping to the bracket floor, because the NPV stays negative at both ends and the sign-change test bails. Both are now asserted as the frozen behaviour.

**Outstanding**
- **`packages/metrics/src` is the definition layer only.** Nothing consumes it yet — A2 wires it into the frontend.
- The J-curve `navApprox` (`vc-toolkit.html :784–791`) was **not** ported. It is a modelled chart interpolation with a hardcoded 2019 start and a six-year ramp, not a metric; it belongs with the chart code at A2. Recorded in `INHERITED-COERCIONS.md §12`.
- The pipeline probability weights (`:1071`) and the `"2026"` year literals (`:1069`, `:1217`, `:1218`) are **not** ported either — they live in view functions and move at A2, when there is a view to move them into.
- **Still no CI.** `npm test` now runs 250 assertions that would catch a changed board number, and nothing runs them automatically. This is the point at which a GitHub Actions workflow starts earning its keep (A0 exit criterion, still open).
- Carried: `v_company_current.fmv` still reads `current_date`; `npm audit` transitive dev-tooling findings; `ref_funnel_stage` seeding from Affinity metadata.

---

## 2026-08-11 · A1 (stages 1–2) · Metrics reconnaissance, ADR-021/022, golden-master harness

**Built**
- `packages/metrics/test/harness/prototype.ts` — loads the prototype under Node. Extracts the single inline `<script>` from `docs/reference/vc-toolkit.html` at run time and evaluates it in a `node:vm` context with `document`, `Chart`, `localStorage`, `requestAnimationFrame` and `getComputedStyle` stubbed. **Nothing is vendored** — mirrors `migration-parity.test.ts`, which reads `docs/schema.sql` directly for the same reason.
- `packages/metrics/test/harness/capture.ts` — the capture entry point (`npm run capture:fixtures -w @portfolio-command/metrics`). Refuses to write anything if the prototype throws, if `demo.json` no longer matches the prototype's boot state, or if a captured value comes back `undefined`.
- `packages/metrics/test/fixtures/golden-master.json` — 7,034 lines. Every metric frozen twice: full-precision value **and** the display string the board reads. Covers the 31-field `fundMetrics` bag, `fiMetrics`, per-position `fiTvpi`/`fiDpi`/`fiIrr`, `xirr` over the fund cashflow series independently of `fundMetrics`, per-company `moic` and `suggestedReserve`, all 39 `healthAlerts` in order, and `runScenario` over `scenarioDefaults` for all 70 companies.
- `packages/metrics/INHERITED-COERCIONS.md` — twelve categories of prototype behaviour that look accidental, ported verbatim under ADR-013, with measured impact where it is non-zero. Plus three items examined and found sound, recorded so they are not re-litigated.
- **ADR-021** (metrics input contract and unit boundary) and **ADR-022** (golden-master methodology), written into `docs/architecture-decisions.md`.

**Verified**
- `demo.json` is **byte-identical to the prototype's boot state** — it is `freshDB()` serialised, not an arbitrary sample. The harness asserts this before capturing; perturbing `demo.json` was tested and correctly aborts with exit 1 and an untouched fixture.
- Capture is **byte-reproducible across runs**. Confirmed by `cmp` on repeated runs.
- Clean database cycle re-run after the schema change: `docker compose down -v` → `db:up` → `db:migrate` → `db:seed` → `db:types`. 47 relations, `moic` gone from the generated types. `typecheck`, `lint` and the migration parity test all pass.

**Changed**
- **`v_company_current.moic` removed** (`docs/schema.sql`, `0001_init.sql`). It divided one aggregate by another, which ADR-023 defines as a metric, and MOIC is named in its prohibition list. Removed now rather than at A3 because the view has no dependents yet and `create or replace view` cannot drop a column — the required `drop view … cascade` gets more expensive with every view A3 stacks on top.
- **Amended `0001_init.sql` in place rather than adding `0002`**, and rebuilt the local database. A0.1 established forward-only migrations; that protects deployed state, and nothing is deployed yet. What it buys is the `schema.sql ≡ 0001` invariant the parity test exists to guard — a `0002` would have kept that test green while making `docs/schema.sql` describe a schema that no longer exists. **Forward-only becomes binding the moment anything reaches Azure.**
- `v_lp_position_current.tvpi/.dpi` and `v_round_leverage` carry the convenience-only SQL comments ADR-023 requires, including the note that `v_round_leverage`'s `least()` cap matches the prototype's dashboard chart but **not** its `fundMetrics`.
- `tsx` added to `packages/metrics` devDependencies for the capture script.

**Decided**
- **`asOf` is a required argument on every metric function that dates a cashflow.** `fundMetrics`, `fiMetrics` and `fiIrr` call `new Date()` for their terminal NAV — an undeclared input. Two consecutive calls on identical data return different numbers, and the figure drifts roughly a point per quarter with no data change. This is the **sole** departure from a literally verbatim port: a change of signature, not of definition. No default, because a default would silently reintroduce "today". (ADR-021.)
- **Fixtures pin `asOf = 2026-03-31`** — the effective date of every valuation mark in `demo.json` and the end of its last `navHistory` quarter. Gross IRR reads 18.98% rather than the 17.55% a run on 11 August produces; the latter was never reproducible the following day.
- **`fundMetrics` ports as one function returning the same field bag**, with named selectors layered on top rather than the internals split. Its outputs share intermediates; splitting them would recompute those intermediates into a different implementation. (ADR-022.)
- **`includeAccelerator: true` is the only golden-mastered path.** The prototype has no ACC concept, so the exclusion path gets conventional constructed tests instead.
- **ADR-024 was proposed and rejected.** It would have reframed the golden master as a change ledger, permitting accepted divergences where the prototype's behaviour is an implementation accident rather than a validated definition. Ten candidate repairs were measured against `demo.json`: eight were provably zero-impact, two moved numbers by 0.30% and 0.15%. **Decision: continue the verbatim port.** The prototype is the artefact handed over by the VC team lead, and A4/A5/A6 — real Affinity data, real Visible KPIs, the synthetic financial dataset — is when it becomes possible to tell which coercions actually matter rather than guessing. Corrections belong to that phase. The measurements are preserved in `INHERITED-COERCIONS.md` so the work is not repeated.

**Outstanding**
- **Stage 3 not started.** The TypeScript port into `packages/metrics/src`, the vitest assertions against the fixtures, and the ADR-001 export-contract snapshot test.
- **`packages/contract` not yet created** (ADR-021). Needed before the port, since the metric signatures depend on it.
- **`v_company_current.fmv` still calls `company_fmv_asof(…, current_date)`**, making the view non-deterministic and pinning "now" to the database clock. Flagged with a TODO in `schema.sql`; becomes an as-of parameter when A3 designs the read path. Deliberately not guessed at ahead of A3.
- **Four coverage gaps recorded in the fixture header**, each needing constructed unit tests because `demo.json` cannot reach them: no round fails the leverage exclusion (all 78 are valid); no diversity field is null, so the D-5 departure is unobservable; same-store revenue growth runs over 7 companies of 64; the `outsideCapital` clamp never binds at aggregate level.
- **`fte` display strings are locale-sensitive** — `toLocaleString()` with no locale. The fixture records `en-CA`; a CI run under a different locale will fail on a locale difference, not a metric change. The port must pin one.
- Carried from A0.1: `npm audit` transitive dev-tooling findings; `ref_funnel_stage` to be seeded from Affinity field metadata.

---

## 2026-07-29 · A0.1 · Repository scaffold, local database, migrations, reference seed

**Built**
- npm workspaces monorepo (Node 22): `apps/web` (minimal Next.js 15 App Router scaffold, no UI — A2 ports the prototype), `packages/metrics` (empty, vitest wired — A1 fills it), `packages/db`, `functions/` (placeholder — Azure Functions runtime scaffold arrives at A4).
- `docker-compose.yml` at root: `postgres:17`, credentials from the gitignored `.env`; `.env.example` committed with placeholders only.
- Custom plain-SQL migration runner (`packages/db/src/migrate.ts`): sorted `NNNN_name.sql` files, one transaction each, sha-256 checksums in `public.schema_migrations`, advisory-locked, forward-only. Migration `0001_init.sql` is a **verbatim copy** of `docs/schema.sql`; `packages/db/test/migration-parity.test.ts` fails the build if they ever diverge. `docs/schema.sql` was not modified.
- Reference seed (`packages/db/src/seed.ts`), idempotent: ref_sector (9), ref_funnel_stage (8, Closed/Passed terminal), ref_source_channel (14, incl. the Propel/Apex/AVF/ONB/AllNB split) from `docs/affinity-vocabularies.csv`; ref_stage (6) and ref_instrument (5) from the prototype constants; ref_valuation_method (6). The CSV's health and nb_region sections are CHECK constraints, not tables, and are not seeded.
- Type generation from the live database: `db:types` runs kysely-codegen into `packages/db/src/generated/db.ts` (47 tables and views, committed so typecheck never needs a running database).
- Root scripts: `db:up`, `db:down`, `db:migrate`, `db:seed`, `db:types`, `lint`, `typecheck`, `test`.

**Verified** — full clean cycle (`docker compose down -v` → `db:up` → `db:migrate` → `db:seed`) run end to end:
- `docs/schema.sql` applies cleanly to a fresh database with **no changes required**. Nothing in it was wrong.
- `db:migrate` re-run is a no-op ("up to date"); `db:seed` re-run yields identical counts.
- Reference tables: sector 9, funnel stage 8 (Closed/Passed terminal), source channel 14, stage 6, instrument 5, valuation method 6. Casing normalised (Breakthru, Investor Connection); the Propel/Apex/AVF/ONB/AllNB row split into five channels as intended.
- `db:types` generates all 47 relations including every derived view (`v_synthetic_data_status`, `v_mandate_completeness`, `v_round_leverage`, `v_company_current`, …). `typecheck`, `lint` and the parity test all pass against it.

**Decided**
- Custom ~110-line migration runner over node-pg-migrate/dbmate — zero extra dependencies, wholly readable, nothing fighting hand-written SQL. Forward-only; a bad migration is corrected by the next one. (Approved this session.)
- ref_valuation_method seeded with the six methods the prototype produces: Last round, Revenue multiple, Calibrated last round, Scenario-weighted, Write-off, Realized. Free-text variants in the demo marks ("Revenue multiple, discounted") belong in the mark's rationale. (Approved this session.)
- Kysely + kysely-codegen as the typed query builder and type source — types come from introspecting the live DB, never hand-maintained; Kysely is the query builder A3 will use anyway. Not an ORM. Two properties worth keeping: `numeric` generates as **string**, not `number`, so money cannot silently become a float (ADR-008); and the schema's SQL `comment on` text carries through as JSDoc, putting the ADR rationale in the types themselves.
- `postgres:17` locally to match what a new Azure Flexible Server provisions; pin the exact minor at the A0 Azure step.
- eslint-config-next deferred to A2 (no React code yet); root typescript-eslint flat config covers everything for now.

**Outstanding**
- `npm audit` reports transitive high-severity findings, all in dev tooling (an old minimatch chain under eslint and kysely-codegen; postcss/sharp pinned by next). Nothing reachable in this scaffold; revisit when next/eslint publish patched pins.
- TODO carried in `seed.ts`: ref_funnel_stage must eventually be seeded from Affinity's Status dropdown-option metadata, not the CSV — ranks 2, 8, 9 and 11 exist unobserved (ADR-009).

---

## 2026-07-29 · Pre-development · Architecture and data design complete

**Built**
- Nothing in code yet. This entry records the design phase so the log starts from a known state.

**Decided** — the full set is in `docs/architecture-decisions.md`; the ones that shape day-to-day work:
- ADR-001 · The prototype's JSON schema is the frozen API and export contract; the storage model underneath is normalised.
- ADR-002 · Transactions are the only stored financial facts. Eighteen prototype fields are derived and must not be stored.
- ADR-003 · TypeScript end to end, reversing an earlier recommendation of a Python metrics service. Rationale: solo maintainer, non-development MSP for coverage.
- ADR-006 · Reporting periods stored as dates; fiscal and calendar quarter labels both derived. Fiscal year starts 1 April; Visible reports on calendar quarters.
- ADR-007 · Valuation marks effective 31 January and 31 July, carried forward between cycles. Two of four quarters show no revaluation, labelled on screen.
- ADR-011 · The platform is the transaction registry. Excel bulk upload first, in-app Finance forms second, same table.
- ADR-013 · Metric definitions frozen at the prototype's implementations, guarded by golden-master tests.
- ADR-014 · Frontend ports one-to-one. Two sanctioned content exceptions.
- ADR-018 · Financial rows append-only; corrections are reversals or supersessions.
- ADR-019 · Finance data lands in staging templates in their own terms, not production schema.
- ADR-020 · Development runs on synthetic financial data calibrated to Affinity's real figures. Real history is a cutover event.

**Outstanding**
- **A-8 · Request a 5–10 company real sample from Finance.** Highest-leverage open item. Validates that the schema fits how Finance actually holds data, before everything is built on the assumption.
- **A-7 · Confirm Affinity v2 and Visible.vc API access on current plan tiers.**
- **A-1 · Add women in C-suite and C-suite size to the Visible quarterly request.** The series begins only from the quarter the request changes.
- **Verify the identifier namespace.** The CSV export's `Organization Id` (224–313 million) and the v2 API's `entity.id` (1,783,269) were observed in different ranges. Confirm before using either as a crosswalk key; `website` is the intended join.
- Start capturing round totals and NB co-investors on paper for deals closing before the capture form exists.

---

## 2026-07-29 · Data source confirmation · Affinity live data profiled

**Built**
- `docs/affinity-field-mapping.csv` — field-by-field mapping for both list views, with fill rates, transforms and controlled vocabularies ready to seed the reference tables.

**Changed**
- **Corrected an error.** An earlier reading treated Affinity's Pipeline and Portfolio as two separate lists that lose history at the boundary, and proposed a `pipeline_stage_history` table to reconstruct it by nightly snapshotting. They are two saved *views* of one list (`listId 328745`) filtered by Status. The table was removed.
- Replaced it with `affinity_field_change`, a local mirror of Affinity's own change log. Affinity remains system of record; the mirror exists because the endpoint is per-list-entry and a funnel chart would otherwise fan out to one API call per deal.
- Added `company.nb_region` (NW/NE/SW/SE) — a mandate reporting dimension the prototype lacked.
- Replaced `company_state.affinity_risk_grade` with `risk_grade` constrained to A/B/C/ACC, and extended `health` with `acc`.
- Added `company.affinity_fmv` and `company.affinity_total_investment` as reference-only columns.
- Added `pipeline_deal_owner` — Affinity's Owners field is person-multi and accumulates; the platform mirrors the full list rather than picking one.

**Decided**
- Sector taxonomy is Affinity's eight provincial priority sectors plus Other, unchanged. No invented sectors to absorb the Other population.
- Risk Assessment drives health. A/B/C map to green/yellow/red; ACC carries no risk colour.
- Accelerator investments are **included** in fund-wide MOIC, leverage and FMV growth, with a dashboard toggle keyed on the ACC tag. Metric functions take an `includeAccelerator` option so the toggle changes an argument rather than forking the definition.
- Owners governs pipeline stages, VC Lead governs portfolio stages. Ownership commonly changes hands at diligence.
- Source of Deal carries through verbatim; case-folding applied for chart grouping only.
- Affinity's FMV and Total Investment Amount are reference-only and never enter a calculation. The synthetic generator is calibrated to them so company-level figures land in a plausible range.

**Outstanding**
- Seed `ref_funnel_stage` from the Status field's dropdown-option metadata, not from observed values — ranks 2, 8, 9 and 11 exist unobserved.
- Handle `referenceType: deleted-entity` in the sync: store `displayValue`, tolerate the absent `dropdownOptionId`.
- Affinity date-only fields arrive at US Pacific midnight in UTC. Pin the timezone on extraction.
- Two VC Lead records in the export carry non-`nbif.ca` addresses and will not resolve against Entra. Fix in Affinity.