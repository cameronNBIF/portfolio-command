# Portfolio Command — Delivery Roadmap

**Version:** 2.0, 28 July 2026 — supersedes v1.0
**What changed:** development is decoupled from Finance's data timeline. The platform is built end to end against synthetic financial data attached to real companies from Affinity, and real history is loaded once at cutover (ADR-020).
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
| **Request a 5–10 company real sample from Finance** | See A6. The one Track B item that is genuinely urgent, and a day of their time rather than months. |

---

## Track B — Data readiness (asynchronous)

Runs on Finance's clock. Nothing in Track A waits on it except A13.

| Step | Exit criteria |
|---|---|
| B1 · Company crosswalk | Every company in Finance's records mapped to an Affinity organisation and an internal id. Renames, duplicates and restructures documented. |
| B2 · **Real sample, 5–10 companies** | Complete real history for a representative handful. **Delivered during A6, not at the end.** Validates that the schema fits how Finance actually holds data. |
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

**Runs alongside B2.** The real sample arrives here and loads next to the synthetic data to check the schema actually fits.

**Exit:** a full, messy, realistic dataset; the banner works; the real sample loads without schema changes — or the schema changes now, cheaply.

### Stage 3 — Production workflows, all testable on synthetic data

#### A7 · Finance entry interfaces
**Walk the workflow through with the Director of Finance before building it** (ADR-020, condition 4).

- Transaction entry, table view with filters, **Reverse and Correct rather than Edit** (ADR-018)
- Valuation mark entry, Finance role only, entry as sign-off (ADR-007)
- LP cashflow and NAV entry; running totals net of reversals

#### A8 · Deal-close capture and mandate completeness
- Capture form: round total, co-investors with NB flag and amount, ownership, pro-rata, post-money
- `v_mandate_completeness` surfaced on the dashboard

#### A9 · Alerts, health and watchlist
- Alert feed from runway thresholds, risk flags, covenant status, government funding conditions
- Health rating workflow with audit
- Deliberately exercised against the synthetic edge cases from A6

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

#### A13 · Real data migration and go-live
The riskiest phase, and the reason it gets its own budget rather than being treated as a switch.

- Load real history through the B3 pipeline, batch by batch, reconciled to control totals
- **Verified removal of every synthetic row** — `v_synthetic_data_status` must read zero
- Banner disappears only when that is true
- Parallel run: platform and prototype side by side for one full reporting cycle, numbers compared line by line
- Backup and restore rehearsed, not assumed
- MSP runbook: how to restart, where the logs are, what to check

**Exit:** a board report produced from the platform matches one produced from the prototype, and any differences that remain are explained and intended.

---

## Minimum launchable product

If the full sequence runs too long, this is the smaller thing worth launching.

**In:** A0–A9, A11, A13 — Pipeline, Portfolio, Funds, Dashboard, Reports, Finance entry, alerts.
**Deferred past launch:** A10 Memo builder and A12 Modeling. Daniel keeps using the prototype for both; neither has an upstream data dependency, so nothing decays while they wait.

---

## What this sequencing buys, and what it costs

**Buys:** development never waits on another department. Something real is in front of Daniel by the end of A2, months earlier than v1.0 would have managed. Synthetic data can be made *harder* than real data, so edge-case handling gets tested more thoroughly than a partial real load would allow.

**Costs:** cutover becomes a genuine phase with genuine risk rather than a configuration change. And the schema-fit question — does Finance actually hold transactions the way we assumed — moves from "discovered early on real data" to "discovered at A6 on a small sample, or at A13 on everything." Which of those two it turns out to be depends entirely on whether the real sample gets requested. That is the single highest-leverage item in this document.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Schema does not match how Finance holds data.** Granularity, aggregation, missing early years, fund-level-only marks. | High | The 5–10 company real sample at A6/B2. Without it this surfaces at A13, after everything is built on the assumption. |
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
3. **Ask Finance for the 5–10 company real sample**, and be explicit that it is a small early ask, separate from and ahead of the full backfill.
4. Send `finance-data-templates.xlsx` for the full extract and agree control totals for the first batch.
5. Stand up the repository and Azure resources (A0).

Items 1 to 4 are hours of your time with long lead times. Item 5 is where the real days go. Doing them in that order means Finance, Affinity and Visible are all moving while you build foundations.
