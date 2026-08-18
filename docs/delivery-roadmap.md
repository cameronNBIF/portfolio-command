# Portfolio Command — Delivery Roadmap

**Version:** 2.1, 14 August 2026 — supersedes v2.0
**What changed in 2.1:** the 5–10 company real sample (B2) is **withdrawn**. The schema-fit question is answered at cutover on the whole dataset instead, and A6's synthetic spine — which reconciles to Affinity's own per-company invested and FMV figures — is what makes that acceptable. Cutover splits into **A13 · Financial history port** and **A14 · Go-live**, because loading fifteen years of financial history and proving the platform is operationally ready fail in different ways and neither should be able to hide the other.
**What changed in 2.0:** development is decoupled from Finance's data timeline. The platform is built end to end against synthetic financial data attached to real companies from Affinity, and real history is loaded once at cutover (ADR-020).
**Constraint that shapes everything below:** one developer, who is also the organisation's internal IT, with no external deadline.

---

## Why v2 differs from v1

v1.0 treated the historical backfill as the critical path and sequenced the build behind data availability. That was the wrong shape for this team: development capacity currently exceeds Finance's extraction capacity, and waiting would idle the only developer available.

v2.0 inverts it. Affinity and Visible are live today, so company identity, pipeline and quarterly KPIs are real from early on. The financial spine — transactions, marks, rounds, ownership, LP cashflows — is generated, deliberately messy, and swapped for real data at cutover.

**The dependency has not disappeared, it has moved.** Finance no longer gates *development*; it still gates *launch*. A finished application that cannot go live is still a stalled programme, so Track B has to keep moving even though nothing is waiting on it day to day.

---

## How to read this

No dates, because dates from a solo part-time build are fiction. There is **exit criteria** which is what actually tells you a phase is finished.

The lever remains scope, not speed — see *Minimum launchable product*.

---

## Three tracks

**Track A — Platform build.** Sequential, yours, now fully unblocked.
**Track B — Data readiness.** Finance-driven, asynchronous, gates cutover only.
**Track C — Process and access.** Hours of effort, long lead times, start this week.

---

## Track C — Start this week

| Action | Why it can't wait |
|---|---|
| Add women in C-suite and C-suite size to the Visible quarterly request | The series starts only from the quarter the request changes. Every quarter of delay is a permanent hole. |
| Confirm Affinity API v2 access on your plan tier, pull one test record | A4 assumes it. A plan change or support ticket is cheap to discover now and expensive in month four. |
| Confirm Visible.vc API access and what it exposes | Same. Also confirms revenue granularity and whether the new diversity fields will come through the API. |
| Start capturing round totals and NB co-investors on paper | Deals will close during the build. A shared sheet from today means no gap when the form arrives. |

---

## Track B — Data readiness (asynchronous)

Runs on Finance's clock. Nothing in Track A waits on it except A13, where all of it lands at once.

| Step | Exit criteria |
|---|---|
| B1 · Company crosswalk | Every company in Finance's records mapped to an Affinity organisation and an internal id. Renames, duplicates and restructures documented. |
| B2 · ~~Real sample, 5–10 companies~~ | **Withdrawn, 14 August 2026.** The sample existed to answer the schema-fit question early, on a handful of companies. A6 answered enough of it another way: the synthetic spine is attached to the real roster and reconciles to Affinity's own invested and FMV figures per company, which makes the platform demonstrable to the VC team lead now — the thing the sample was really buying. The remainder of the question moves to B4–B7 and is answered on everything at once. Numbering is left with a gap rather than renumbered, because the steps are referenced elsewhere. |
| B3 · Staging load pipeline | Templates load, resolve names to keys, validate, emit exceptions. Rollback by `batch_id` proven. |
| B4 · Rounds and transactions | All batches tie to Finance's control totals. |
| B5 · Valuation marks | Loaded with effective dates. Coverage boundary documented — the date before which only fund-level NAV exists, if any. |
| B6 · LP positions, cashflows, NAV | Reconciled per position against GP statements. |
| B7 · Ownership backfill | Loaded from SharePoint cap tables with source document links. Gaps listed, never estimated. |

---

## Track A — Platform build

### Stage 1 — Shell and presentation

#### A0 · Foundations
Repository, Azure resources, authentication, deployment. No features.

- Monorepo: `apps/web`, `packages/metrics`, `packages/db`, `functions/`
- Azure: Postgres Flexible Server (Canada Central), App Service, Blob Storage, Key Vault
- Entra ID app registration, MSAL sign-in, the four roles from ADR-005
- Migrations as plain SQL with `schema.sql` as the starting point; types generated from the live database rather than hand-maintained
- GitHub Actions: lint, test, build, deploy

**Exit:** empty authenticated shell deployed to Azure, schema applied, CI green.

#### A1 · Metrics package and golden-master tests
**Still first, still non-negotiable.** It protects every board number in the rebuild, and it is far harder to retrofit than to front-load.

- Port `moic`, `fundMetrics`, `xirr`, `fiMetrics`, `healthAlerts`, `suggestedReserve`, `runScenario`, plus leverage, FMV growth and same-store revenue into `packages/metrics` as pure functions
- Golden-master harness: run the prototype under Node with `document`, `Chart` and `localStorage` stubbed, capture every metric on the demo dataset, freeze as fixtures
- Assert the TypeScript package reproduces all of them, in CI
- Build the ADR-001 export-contract snapshot test alongside it

**Exit:** the metrics package reproduces every prototype number exactly, and drift fails the build.

#### A2 · Frontend port against seed fixture
The big presentation-layer port. **No backend required.**

This works because ADR-001 makes the export contract and the API response the same shape — so Daniel's exported `demo.json` served as a static fixture *is* the contract the API will later satisfy. Nothing built here gets reworked when the API arrives.

- All eight tabs ported to React components: layout, terminology, colour conventions, drawer interaction, tab structure
- Chart.js → Recharts with visual parity
- Fiscal and calendar quarter labelling per D‑6, stated on every quarterly view
- Revenue relabelled as quarterly revenue per D‑2; diversity tile showing coverage per D‑5

**Exit:** every tab renders correctly from the fixture and is indistinguishable from the prototype, side by side.

### Stage 2 — Real backend and real external data

#### A3 · API and persistence
- Contract endpoints serving the ADR-001 shape from Postgres, replacing the fixture
- Derived views wired in — nothing computed in a component
- Role-based authorisation enforced server-side
- Audit log on every write

**Exit:** the frontend runs unchanged against the API instead of the fixture, and the contract snapshot test still passes.

#### A4 · Affinity integration
- Affinity API v2 client, nightly sync Function
- `affinity_status_map` seeded and editable
- Pipeline tab on real data; company identity, sector, sourcing channel, CEO and HQ real

**Exit:** real pipeline visible and refreshing nightly. Company roster is real.

#### A5 · Visible.vc integration
- Quarterly KPI sync into `company_kpi` with calendar quarter labels
- `request_version` stamping
- Revenue, burn, cash, FTE, NB FTE real; diversity fields nullable until the request lands

**Exit:** real quarterly KPI history flowing, with per-field coverage visible.

**Met, 13 August 2026.** 999 rows across 81 of 82 companies, 2021 Q2 to 2026 Q2, converging on re-run. Two findings changed the design and are recorded in ADR-029: the burn question was renamed mid-series and needed splicing under `request_version`, and `fte` became `numeric` because a full-time equivalent is fractional. `net_revenue_retention` and `gross_margins` were added as columns. Diversity remains NULL — nothing to sync until action A-1 lands, and `v_kpi_coverage` now reports that as a running cost.

#### A6 · Synthetic financial dataset
Generated transactions, rounds, marks, ownership and LP activity, attached to the **real** company ids from A4.

- Deterministic, seeded, regenerable — the prototype's `mulberry32` generator is the precedent
- Realistic volume and distribution: fifteen-plus year histories, most companies one to three rounds, a few with six or more, some write-offs, some exits
- **Deliberately dirty**, per ADR-020: orphan transactions, unresolvable names, missing round totals at the rate expected for old vintages, a renamed company, a duplicate, a mark predating first investment, a non-CAD transaction, a company with no KPIs
- Every row flagged `is_synthetic`; `v_synthetic_data_status` drives a persistent banner on every screen and every PDF

**Exit:** a full, messy, realistic dataset attached to the real roster and reconciling to the control totals the VC team already knows; the banner works; the platform is demonstrable end to end on it. Schema gaps the synthetic data exposes are fixed here, while that is still cheap.

*Restated 14 August 2026.* The criterion previously ended "…and the real sample loads without schema changes". B2 is withdrawn, so the clause is gone rather than merely unmet — see Track B.

**Met, 14 August 2026.** 177 rounds, 282 transactions, 1,015 marks, 16 LP positions and 69 quarterly NAV snapshots against the real 82-company roster, **reconciling to Affinity's own control totals exactly: $47,216,678 invested and $42,030,272 FMV, to the cent, asserted per company before the generator will commit.** LP commitments and capital called reconcile to the workbook the same way. The schema did change, and cheaply, which is the criterion working as intended: `ref_investment_vehicle` and vehicle attribution on the transaction (ADR-030), and `amount_cad` on `v_transaction_live` after the first genuinely non-CAD row proved four aggregates had been ignoring `fx_rate_to_cad` since A1.

### Stage 3 — Production workflows, all testable on synthetic data

#### A7 · Finance entry interfaces
**Walk the workflow through with the Director of Finance before building it** (ADR-020, condition 4).

- Transaction entry, table view with filters, **Edit, Delete and Restore over a versioned store** (ADR-031, superseding ADR-018's Reverse and Correct)
- Valuation mark entry, Finance role only, entry as sign-off (ADR-007)
- LP cashflow and NAV entry; running totals net of deletions and reversals

**Done, 17 August 2026**, with ADR-018 reversed on the way in — see the ADR-031 entry in `BUILD-LOG.md`. The exit condition the phase actually has to meet moved with it: it is no longer "Finance cannot change a row" but "a figure the board has already seen can still be reproduced after Finance changes a row", which `packages/api/test/financial-versioning.test.ts` asserts directly.

#### A8 · Deal-close capture and mandate completeness
- Capture form: round total, co-investors with NB flag and amount, ownership, pro-rata, post-money
- `v_mandate_completeness` surfaced on the dashboard

**Done, 17 August 2026** — see the A8 entry in `BUILD-LOG.md` and the amendments to ADR-012 and ADR-031. The schema for all five fields had existed since A1, so the phase's real content was making three tables writable safely: `round_coinvestor` joined the ADR-031 versioned set in the same migration that gave it an edit button, and five reads that had gained a `deleted_at` column at A7 without any reader — including the ADR-001 export adapter's round query — were taught to honour it. The capture is **one mutation over three tables in one transaction**, because a round total that saves without its co-investors moves one mandate KPI and leaves the other behind silently. Coverage reads 84.7% on the real portfolio, with the ADR-015 taper visible by year rather than blended away. A7's outstanding investment-vehicle picker is closed with it.

#### A9 · Alerts, health and watchlist
- Alert feed from runway thresholds, risk flags, covenant status, government funding conditions
- ~~Health rating workflow with audit~~ — **amended 18 August 2026, see ADR-032.** There is no
  workflow for this platform to own: Affinity is the system of record for the Risk Assessment that
  drives health (ADR-009), the sync is one-way, and the VC team maintains the rating there. An edit
  box here would create a rating that disagrees with itself across two systems and the next nightly
  sync would silently win. **Replaced by health provenance** — the grade, who set it, when — shown on
  the company drawer, read-only, with the reason stated on screen.
- Deliberately exercised against the synthetic edge cases from A6

**Done, 18 August 2026** — see the A9 entry in `BUILD-LOG.md` and ADR-032. The phase turned out to be
three surfaces rather than one: a **fund-level alert policy** that per-company thresholds inherit from
(there was previously nowhere to say "our runway threshold is 12 months", and a company nobody had
configured was silently unwatched); a **controlled vocabulary for risk flags**, which replaces
de-duplicating them by regex on their display text; and **time-boxed acknowledgements**, because an
alert feed that cannot be answered becomes wallpaper. Four metrics joined runway. The contract went to
`schemaVersion` 3 and the golden master moved by exactly four alerts, enumerated in the test rather
than absorbed into the fixture.

#### A10 · Memo builder
- Auto-prefill from company or deal data, versioning, structured decision field, Markdown and PDF export

#### A11 · Reports and board PDF
- Reports tab on real infrastructure: fund summary, highlights, watchlist, top and bottom positions, NAV bridge
- Fiscal labels throughout per D‑6
- Playwright PDF replacing the print stylesheet; NAV snapshot freezing on issue
- **Sole board-facing artefact under ADR-005, so it has to be genuinely good**

#### A12 · Modeling
- Reserves tool on dry-powder basis, editable allocations, suggested-reserve policy
- Exit waterfall with ADR-016 simplifications and their on-screen caveats

### Stage 4 — Cutover

#### A13 · Financial history port — the one-time load from Finance
**The phase where the platform stops being a demo.** Everything Affinity and Visible do not supply arrives here, in one designed operation rather than a trickle, and it is the riskiest phase in the programme — which is why it gets its own budget rather than being treated as a switch.

- Company crosswalk resolved (B1): every name in Finance's records mapped to an Affinity organisation and an internal `company_id`
- Staging load pipeline (B3): templates load, resolve names to keys, validate, emit exceptions. **`batch_id` rollback proven before the first real batch, not after a bad one**
- Transactions and rounds (B4), valuation marks (B5), LP positions, cashflows and NAV (B6), ownership backfill (B7) — batch by batch, each reconciled to Finance's control totals before the next one starts
- **Verified removal of every synthetic row** — `v_synthetic_data_status` must read zero, and the banner disappears only when it does
- **The A6 generator is retired in the same operation.** `npm run db:generate` has no business existing in an environment holding real money; the command, its data files and `is_synthetic` handling are removed or hard-disabled here

**After this phase the platform is the system of record for financial data, and there is no second import.** Affinity stays authoritative for company identity and pipeline (ADR-009) and Visible for company-reported KPIs (ADR-010), both syncing nightly. Everything financial — every new transaction, mark, round, LP cashflow and ownership change — is entered and maintained through the A7 and A8 interfaces from this point on. That is the whole reason those interfaces are built before the port rather than after it.

**Exit:** every figure on every screen traces to Finance's records, Affinity or Visible. Control totals tie batch by batch. `v_synthetic_data_status` reads zero and the banner is gone.

#### A14 · Go-live
Operational readiness, separated from the data work above because the two fail in different ways and neither should be able to mask the other. A perfect load into a system nobody can restart at 9pm is not a launch.

- Parallel run: platform and prototype side by side for one full reporting cycle, numbers compared line by line
- Backup and restore rehearsed, not assumed
- MSP runbook: how to restart, where the logs are, what to check
- Accounts issued and roles assigned per ADR-005; board members receive PDFs, not accounts

**Exit:** a board report produced from the platform matches one produced from the prototype, and any differences that remain are explained and intended.

---

## Minimum launchable product

If the full sequence runs too long, this is the smaller thing worth launching.

**In:** A0–A9, A11, A13, A14 — Pipeline, Portfolio, Funds, Dashboard, Reports, Finance entry, alerts. Neither cutover phase is optional: A13 is what makes the numbers real and A14 is what makes them supportable.
**Deferred past launch:** A10 Memo builder and A12 Modeling. Daniel keeps using the prototype for both; neither has an upstream data dependency, so nothing decays while they wait.

---

## What this sequencing buys, and what it costs

**Buys:** development never waits on another department. Something real is in front of Daniel by the end of A2, months earlier than v1.0 would have managed. Synthetic data can be made *harder* than real data, so edge-case handling gets tested more thoroughly than a partial real load would allow.

**Costs:** cutover becomes a genuine phase with genuine risk rather than a configuration change — which is why it is now two of them, A13 and A14. And the schema-fit question — does Finance actually hold transactions the way we assumed — is answered at A13 on everything at once, rather than early on a sample. **That is a deliberate trade, taken 14 August 2026 when B2 was withdrawn**, and what pays for it is that A6 stopped being a guess: the synthetic spine hangs off the real roster, reconciles to Affinity's own per-company invested and FMV figures, and is deliberately dirtier than the real extract is expected to be. The exception paths the port will need are therefore built and exercised before the port begins, which is the substance of what the sample was going to buy. What is genuinely given up is the early warning — a granularity or aggregation mismatch now surfaces during A13 rather than months ahead of it, and A13's budget has to carry that.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Schema does not match how Finance holds data.** Granularity, aggregation, missing early years, fund-level-only marks. | High | **Accepted into A13 rather than mitigated early (B2 withdrawn, 14 August 2026).** Reduced by three things: the load path is built and exercised against deliberately dirty synthetic data (ADR-020 condition 1); `batch_id` rollback is proven before the first real batch; and each batch reconciles to Finance's control totals before the next starts, so a mismatch surfaces on batch one rather than after the lot is in. A6's per-company reconciliation to Affinity's figures also means the target numbers are already known and agreed. |
| **Synthetic data flatters the build.** Clean generated data validates only the happy path. | High | Deliberate dirt per ADR-020 condition 1. Exception handling built against mess, not ideal input. |
| **Synthetic numbers escape into a real conversation.** | Medium | `is_synthetic` flags, `v_synthetic_data_status`, persistent banner on screen and in every PDF. Removed only when the count reads zero. |
| **Bus factor of one.** Developer, DBA and internal IT are the same person. | High | Single-language stack (ADR-003). Runbook written as you go, targeted at what the MSP can realistically do. |
| **Finance stalls because nothing is visibly waiting on them.** | Medium | Track B has its own exit criteria and control totals. Review Track B progress at the end of every Track A stage, not at cutover. |
| **API access assumptions.** Affinity v2 and Visible availability may be plan-dependent. | Medium | Verify both this week. |
| **Scope creep.** Eight tabs of visible surface invites requests. | Medium | ADR-014 makes "looks identical" a testable criterion. Change requests go to a phase-2 list. |

---

## The initial development steps

1. Confirm Affinity v2 and Visible API access on your current plan tiers.
2. Add the two diversity fields to the Visible quarterly request.
3. Send `finance-data-templates.xlsx` for the full extract and agree control totals for the first batch.
4. Stand up the repository and Azure resources (A0).

Items 1 to 3 are hours of your time with long lead times. Item 4 is where the real days go. Doing them in that order means Finance, Affinity and Visible are all moving while you build foundations.

*Item 3 carries more weight since B2 was withdrawn: the full extract is now the only real financial data the programme will see before A13, so the templates and the agreed control totals are the whole of Track B's early surface.*
