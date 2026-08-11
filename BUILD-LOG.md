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