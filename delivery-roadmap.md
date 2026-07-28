# Portfolio Command — Delivery Roadmap

**Version:** 1.0, 28 July 2026
**Status:** all architecture and data decisions signed off (ADR-001 to ADR-019, decisions D‑1 to D‑6)
**Constraint that shapes everything below:** one developer, who is also the organisation's internal IT, with no external deadline.

---

## How to read this

There are no dates in this roadmap, because dates from a solo part-time build are fiction. There is **effort**, expressed in weeks of focused work, and there are **entry and exit criteria**, which are what actually tell you whether a phase is finished.

Total build effort is roughly **30 to 40 focused weeks**. What that means in elapsed time depends entirely on what fraction of your week this gets:

| Time on this | Elapsed to full launch |
|---|---|
| Full time | 8–10 months |
| Half time | 15–18 months |
| A day a week | 3 years — not a viable plan |

If that number is uncomfortable, the lever is scope, not speed. See *Minimum launchable product* below, which gets to real value in roughly half the effort.

---

## Three tracks, running in parallel

**Track A — Platform build.** Sequential, yours.
**Track B — Data migration.** Finance-driven, already started, runs underneath everything.
**Track C — Process changes.** Small effort, long lead time, needs starting now.

Track B is the critical path to *launch*, not to *building*. You can build the entire application against Daniel's demo dataset. You cannot go live without history. Starting Track B late is the single most likely cause of the whole programme slipping.

---

## Track C — Process changes (start immediately, tiny effort)

These take an hour each and then need weeks or months of calendar time to bear fruit. Do them first.

| Action | Why it can't wait |
|---|---|
| Add women in C-suite and C-suite size to the Visible quarterly request | The diversity series starts only from the quarter the request changes. Every quarter you delay is a permanent hole. |
| Confirm Affinity API v2 access on your plan tier, and pull one test record | Phase A2 assumes it. If API access needs a plan change or a support ticket, find out now, not in three months. |
| Confirm Visible.vc API access and what it exposes | Same. Also confirms whether revenue is exposed as you expect and whether the new diversity fields will come through the API. |
| Start the deal-close capture habit on paper | Deals will close during the build. Capturing round total and NB co-investors in a shared sheet from today means no gap when the form arrives. |

---

## Track B — Data migration (Finance-driven, already underway)

| Step | Effort (yours) | Exit criteria |
|---|---|---|
| B1 · Company crosswalk | 1–2 wks | Every company in Finance's records mapped to an Affinity organisation and an internal id. Duplicates, renames and restructures resolved and documented. **Nothing else in Track B starts until this is done.** |
| B2 · Staging schema and load pipeline | 2 wks | Templates load into staging, resolve names to keys, validate against production constraints, and emit an exceptions report. Rollback by `batch_id` works. |
| B3 · Rounds and transactions load | 1–2 wks | All batches tie to Finance's control totals. Differences investigated, not absorbed. |
| B4 · Valuation marks load | 1 wk | Marks loaded with effective dates. **Coverage boundary documented** — the date before which only fund-level NAV exists, if any. |
| B5 · LP positions, cashflows and NAV | 1 wk | Committed, called and distributions reconcile per position against GP statements. |
| B6 · Ownership backfill | 1–2 wks | Ownership loaded from SharePoint cap tables, with source document links. Known gaps listed rather than estimated. |

Elapsed time here is governed by Finance, not by you. Their effort is likely larger than yours.

---

## Track A — Platform build

### A0 · Foundations · 2–3 weeks

Repository, Azure resources, authentication, deployment. No features.

- Monorepo: `apps/web`, `packages/metrics`, `packages/db`, `functions/`
- Azure: Postgres Flexible Server (Canada Central), App Service, Blob Storage, Key Vault
- Entra ID app registration, MSAL sign-in, the four roles from ADR-005
- **Migrations as plain SQL, with `schema.sql` as the starting point.** Types generated from the live database rather than hand-maintained — the schema has views and functions that ORM-first tooling will fight you on.
- GitHub Actions: lint, test, build, deploy
- Daniel's demo JSON loaded as a seed, so there is data to build against from day one

**Exit:** an empty authenticated app shell deployed to Azure, schema applied, seeded, CI green.

### A1 · Metrics package and golden-master tests · 2–3 weeks

**Do this before any UI.** It is the thing that protects every board number in the rebuild, and it is much harder to retrofit than to front-load.

- Port `moic`, `fundMetrics`, `xirr`, `fiMetrics`, `healthAlerts`, `suggestedReserve`, `runScenario`, plus leverage, FMV growth and same-store revenue into `packages/metrics` as pure functions
- Build the golden-master harness: run the prototype under Node with `document`, `Chart` and `localStorage` stubbed, capture every metric on the demo dataset, freeze as fixtures
- Assert the TypeScript package reproduces all of them, in CI
- Build the export-contract snapshot test from ADR-001 at the same time

**Exit:** the metrics package reproduces every prototype number exactly, and any drift fails the build.

### A2 · Pipeline vertical slice · 3–4 weeks

The thin end-to-end slice. Affinity is live and disciplined, so this proves the whole stack on data where being wrong costs nothing.

- Affinity API v2 client, nightly sync Function
- `affinity_status_map` seeded and editable
- Pipeline tab ported: kanban, deal drawer, gate dropdowns with audit, term sheet summary, platform target tracker

**Exit:** real pipeline visible in the platform, refreshing nightly, gates editable, changes audited. Auth → sync → database → API → ported UI all proven.

### A3 · Portfolio · 4–6 weeks

The largest single tab, and the one that carries the most value.

- Roster with filters and sorting
- Company drawer: rounds and cap-table position, KPIs against thresholds, reserves, board seat, milestones, covenants, government funding, mark history, tasks
- Visible.vc KPI sync, with calendar quarter labels per D‑6
- **Deal-close capture form** — pull this forward rather than leaving it to A6, because deals will be closing while you build

**Depends on:** B1–B3 for real data, though it can be built against the seed.

### A4 · Funds · 2 weeks

Small dataset, mostly manual entry.

- LP positions, dated NAV from GP statements, cashflows
- Funds tab ported: KPI row, commitment pacing, NAV by strategy, position drawer, strategic scorecard

### A5 · Dashboard · 3–4 weeks

Needs A1, A3 and A4 complete, because it aggregates all of them.

- Fund KPI tiles, Mandate & Impact tile row
- Charts ported from Chart.js to Recharts with visual parity
- Alert feed from runway thresholds, risk flags, covenants and government funding conditions
- Mandate completeness indicator (ADR-012)

### A6 · Finance entry interfaces · 3–4 weeks

Replaces the bulk-upload path from ADR-011 phase 1.

- Transaction entry form, table view with filters, **Reverse and Correct actions rather than Edit** (ADR-018)
- Valuation mark entry, Finance role only, entry as sign-off (ADR-007)
- LP cashflow and NAV entry
- Running totals net of reversals

### A7 · Reports and board PDF · 2–3 weeks

- Reports tab ported: fund summary, highlights, watchlist, top and bottom positions, NAV bridge
- Fiscal quarter labels throughout, per D‑6
- Playwright PDF generation, replacing the print stylesheet
- NAV snapshot freezing on report issue (ADR-007)

**This is the sole board-facing artefact under ADR-005, so it has to be genuinely good.**

### A8 · Modeling and Memo Builder · 3–4 weeks

Lowest priority, largely self-contained, safe to defer past launch.

- Reserves tool with dry-powder basis, editable allocations, suggested-reserve policy
- Exit waterfall with the ADR-016 simplifications and their on-screen caveats
- Memo builder with auto-prefill, versioning, structured decision field, Markdown and PDF export

### A9 · Hardening and cutover · 2–3 weeks

- Export contract endpoint verified byte-compatible against Daniel's workflow
- Backup and restore rehearsed, not assumed
- Runbook for the MSP: how to restart, where the logs are, what to check
- Parallel run: platform and prototype side by side for one reporting cycle, numbers compared

---

## Minimum launchable product

If the full sequence is too long to sustain, this is the smaller thing worth launching. It matches the priorities you named at the outset.

**In:** A0, A1, A2, A3, A4, A5, A7, A9 — Pipeline, Portfolio, Funds, Dashboard, Reports.
**Out until after launch:** A6 Finance entry interfaces (keep the Excel bulk upload from ADR-011 phase 1) and A8 Modeling and Memo Builder (Daniel keeps using the prototype for those).

**Effort:** roughly 22–28 focused weeks rather than 30–40.

This works because the bulk-upload path was designed to be non-throwaway, and because Modeling and Memo Builder are the two tabs with no upstream data dependency — the prototype remains perfectly usable for them in the meantime.

---

## Sequencing rationale

Two choices in here are worth stating plainly, because they run against the obvious ordering.

**Metrics before UI.** The instinct is to build a screen first because it feels like progress. But the metrics package is what makes the rebuild *verifiable* — without golden-master fixtures, you find out you changed a board number when someone at the board table notices. Two weeks up front buys certainty across the entire build.

**Pipeline before Portfolio,** despite Portfolio being the higher-value tab. Portfolio depends on the transaction registry, valuation marks and structured ownership — none of which exist yet. Pipeline depends on Affinity, which is live and disciplined today. Building Pipeline first proves authentication, sync, database, API and the ported UI on data where a mistake costs nothing, and it does so while Finance is still assembling the history that Portfolio needs.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **Bus factor of one.** You are the developer, the DBA and internal IT. | High | The single-language stack (ADR-003) is the main mitigation. Beyond that: commit runbook documentation as you go rather than at the end, and keep the MSP's realistic capability — restart, read logs, check connectivity — as the target for operational docs. |
| **Backfill quality.** Fifteen-plus years of history from spreadsheets and closing documents. | High | Control totals per batch, reversible by `batch_id`, exceptions never force-loaded (ADR-019). Accept partial mandate coverage on old vintages and report it honestly rather than imputing. |
| **API access assumptions.** Affinity v2 and Visible API availability may be plan-dependent. | Medium | Verify both this week (Track C). Cheap now, expensive in Phase A2. |
| **Scope creep from "while you're in there."** Eight tabs of visible surface invites requests. | Medium | ADR-014 makes "looks identical" a testable acceptance criterion for phase 1. Every change request goes to a phase-2 list, not into the current phase. |
| **Elapsed time erodes momentum.** A build measured in quarters loses its sponsor's attention. | Medium | The vertical slice at A2 puts something real in front of Daniel early. Aim to demo at the end of A2, A3 and A4 rather than at the end. |
| **Visible diversity fields arrive late.** | Low | Schema already nullable; tile shows coverage (D‑5). No rework, only a shorter series. |

---

## The first two weeks

1. Send `finance-data-templates.xlsx` to Finance and agree the control totals for the first batch.
2. Add the two diversity fields to the Visible quarterly request.
3. Confirm Affinity v2 and Visible API access on your current plans.
4. Start the company crosswalk (B1). It gates all of Track B and it is the step most likely to surface surprises.
5. Stand up the repository and Azure resources (A0).

Items 1 to 4 are hours of work with long lead times. Item 5 is the one that takes real days. Doing them in that order means Finance and Visible are already moving while you build foundations.
