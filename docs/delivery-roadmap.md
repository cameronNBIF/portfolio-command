# Portfolio Command — Delivery Roadmap

**Version:** 2.2, 19 August 2026 — supersedes v2.1
**What changed in 2.2:** a fourth track. **Track F — Finance model hardening** carries the work that came out of the finance requirements meeting and can be built with the context currently in hand. It is sequenced **before A13** and gates it, because sixteen of the thirty-six requirements need a schema change and every one of them is cheap against 284 synthetic transactions and expensive against fifteen years of real history. Everything that depends on an unanswered question from Pat or Funke is deliberately excluded and listed, so the boundary is visible rather than implied.
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

## Four tracks

**Track A — Platform build.** Sequential, yours, now fully unblocked.
**Track B — Data readiness.** Finance-driven, asynchronous, gates cutover only.
**Track C — Process and access.** Hours of effort, long lead times, start this week.
**Track F — Finance model hardening.** Added 19 August 2026. Platform build, but it originates from Track B's stakeholder and **it gates A13**, which is what earns it a track of its own rather than a place in Track A's sequence. Runs before A13 and may interleave with A10 to A12 or displace them.

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

**Track F runs alongside this stage and finishes before Stage 4.** A10, A11 and A12 below can move around it; A13 cannot. Every Track F item changes the schema, and the schema is only cheap to change while the financial spine is 284 synthetic rows regenerable from a seed.

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

**Track F must be complete before this stage starts.** Not a preference: every schema change Track F makes is materially cheaper before A13 loads fifteen years of history than after, and F0's frozen Affinity snapshot is a prerequisite for the outbound write A13 performs (ADR-039).

#### A13 · Financial history port — the one-time load from Finance
**The phase where the platform stops being a demo.** Everything Affinity and Visible do not supply arrives here, in one designed operation rather than a trickle, and it is the riskiest phase in the programme — which is why it gets its own budget rather than being treated as a switch.

- Company crosswalk resolved (B1): every name in Finance's records mapped to an Affinity organisation and an internal `company_id`
- Staging load pipeline (B3): templates load, resolve names to keys, validate, emit exceptions. **`batch_id` rollback proven before the first real batch, not after a bad one**
- Transactions and rounds (B4), valuation marks (B5), LP positions, cashflows and NAV (B6), ownership backfill (B7) — batch by batch, each reconciled to Finance's control totals before the next one starts
- **Verified removal of every synthetic row** — `v_synthetic_data_status` must read zero, and the banner disappears only when it does
- **The A6 generator is retired in the same operation.** `npm run db:generate` has no business existing in an environment holding real money; the command, its data files and `is_synthetic` handling are removed or hard-disabled here
- **Each batch reconciles to `affinity_control_snapshot`, not to the live column.** The agreed control totals — $47,216,678 invested, $42,030,272 FMV — were agreed at an instant, and `company.affinity_total_investment` is synced nightly and VC-team maintained. Frozen at F0 (ADR-039 clause A) so that a reconciliation failure here can be told apart from Affinity having moved underneath it

**Not in A13, and moved out of it deliberately on 20 August 2026:** the outbound write of total invested back to Affinity (FR-02, Q-17, ADR-039 clause B). Q-17's *"push at A13"* was read as naming the phase; it is not. The push needs total invested extracted from **live history Finance has verified**, which is an *output* of this phase rather than a step within it — and putting the platform's first irreversible write to a system it does not own inside the riskiest phase in the programme, on figures whose verification is that same phase's exit criterion, is a sequencing error. It happens when the platform's own figures are trustworthy, on its own decision. Until then ADR-009's one-way rule holds in full.

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

## Track F — Finance model hardening

**Added 19 August 2026**, from the finance requirements meeting with Pat McMullon (Director of Finance) and Funke Yusuf (Controller). The source documents are `docs/finance-requirements-register.md` (the FR numbers), `docs/finance-design-notes.md` (the D numbers and the open-question list) and `docs/finance-current-state.md` (the S numbers — the as-built baseline). **Cite the S-number in a commit message:** a fix that names the seam it closes is a fix someone can trace.

### Why a new track, and why it goes before A13

Tracks A, B and C above are platform build, data readiness and process. This work sits awkwardly in all three: it is platform build, but it originates from Track B's stakeholder, and — this is the part that matters — **it gates A13 in a way A10 to A12 do not.**

Sixteen of the thirty-six requirements need a schema change. Every one of them is cheap now, against 284 synthetic transactions that can be regenerated from a seed, and expensive after A13 loads fifteen years of real financial history. **Track F is the work that has to happen while changing the schema is still free.** A10 (memos), A11 (reports) and A12 (modelling) do not have that property and can move around it.

Track F is therefore sequenced **before A13**, and may interleave with A10 to A12 or displace them. If scope has to give, it gives on A10 and A12, exactly as *Minimum launchable product* already contemplates.

**On the numbering:** `F` rather than `D` because the design notes already use `D-1`, `D-2` and so on for design decisions, and two identifier schemes one letter apart is how a reader ends up in the wrong document. `FR-` remains the requirements register.

### The test applied to every item

An item is in Track F only if **all four** hold:

1. **The requirement is settled** — either from the meeting, from Cameron's review, or from a decision the architecture already made.
2. **No plausible answer to an outstanding question changes the shape** of what gets built. Where an answer could change *which rows get written* but not *what a row looks like*, the storage is in and the automation is out. This is the rule that lets F2 exist.
3. **It does not move a published board figure** — or, where it does, that is called out and gated on sign-off rather than discovered afterwards.
4. **It is reversible or additive.** Nothing here drops a column that A13 might need.

Items failing any test are in the deferred list at the end, with the question that blocks them named.

### Sequence

```
F0  Groundwork ─────────┬─────────────────────────────────────────► (must be first)
                        │
F1  Round ↔ transaction ├──► F2  Valuation ledger
                        │
F3  Ownership & policy ─┤
                        │
F4  Exits & Exited view ┤
                        │
F5  LP three-stage ─────┘
                        │
                        └──► F6  Reconciliation surface  (must be last)
```

**F0 first** because it commits the context the rest is built against and takes one snapshot that becomes impossible to take later. **F6 last** because it reports on the states F1 to F5 create; building it earlier gives a screen with nothing to say. **F1 before F2** because the FMV review surface wants the round and transaction context F1 makes coherent. **F3, F4 and F5 are mutually independent** and can be reordered freely — put whichever is most useful to demonstrate to Finance first.

#### F0 · Groundwork

*Documentation, decisions, and two safeguards that get harder to take later.*

**Closes:** repository context for everything below · the FR-02 / Q-17 snapshot obligation · transaction-level instrument classification (part of S-5).

**Why it is safe.** Nothing here changes a calculation. The snapshot is pure insurance and the instrument column is nullable and unread until something reads it.

- Commit the finance documents to `docs/` and cross-reference them from the ADRs and from this roadmap
- Raise seven ADRs as **Proposed** — ADR-033 to ADR-039 — and move each to Accepted as its phase lands. An ADR written after the code is a summary; one written before it is a decision. Amend ADR-007, ADR-009, ADR-012 and ADR-031 in place, so a reader who finds the old one first does not come away with a rule that is no longer whole
- **Freeze Affinity's pre-cutover control totals** in `affinity_control_snapshot`. `company.affinity_total_investment` and `company.affinity_fmv` are simultaneously the A6 reconciliation anchor, the agreed A13 control totals, and — per Q-17 — the fields the platform will overwrite with its own figure at cutover. **After the first outbound write, reconciling against them proves nothing**: the platform would be checking its arithmetic against its own output
- **Add instrument classification to the transaction**, backfilled from the linked round only where a link exists, never inferred from `company.instrument_id`, and settable on the transaction form beside the vehicle picker

**Deliberately not in scope:** the equity-versus-loan categorisation (FR-25), which needs Q-20 — SAFEs are genuinely ambiguous. Capture the instrument now; classify it into balance-sheet buckets when Pat has answered.

**Exit:** docs committed and cross-referenced · seven ADRs raised as Proposed · `affinity_control_snapshot` populated and reconciling to the two known totals to the cent · `instrument_id` present, backfilled only where defensible, and settable on the form. **Size: S**

**Done, 19 August 2026** — see the F0 entry in `BUILD-LOG.md`. The snapshot reconciles to $47,216,678 invested and $42,030,272 FMV across 82 companies, to the cent, and the script refuses to write a second baseline under the same label. 180 of 284 transactions carry an instrument backfilled from their round; the other 104 stay NULL and are honest about it. ~~One gap is recorded rather than papered over: `finance-current-state.md` was not supplied with the other two documents.~~ **Closed 20 August 2026** — the baseline is committed and every S-number cited in this track now resolves.

#### F1 · The round–transaction link, and explicit participation

*Closes the largest as-built hole in the finance model.*

**Closes:** S-1 (no interface links a cheque to its round) · S-2 (four states collapsed into one) · FR-04 · FR-05 · most of FR-06 · design notes D-1 and D-2. **Lands ADR-033.**

**Why it is safe.** The cardinality was settled in the meeting, and D-2 resolves the contradiction in the minutes without needing Finance to arbitrate: a round is an event in the company's life, so a round with no cheque is legitimate when we did not participate and an error when we did. No outstanding question bears on this.

- `investment_round.nbif_participated`, three-state — `yes` / `no` / `unknown` — defaulting to unknown, because a backfilled 2011 round genuinely may not know and unknown is not a synonym for no. Backfilled to `yes` from evidence only: a live linked transaction
- `transaction.standalone_confirmed_at` / `_by`, the other half of the same idea — a null round link somebody has actually looked at, versus one nobody has touched. Without it the F6 unlinked-cheque check can never reach zero
- A new, deliberately narrow `link-transactions` mutation that sets or clears `transaction.investment_round_id` **and touches no other column on that table**. That narrowness is what resolves the permission question: a deal lead attaching a cheque to a round is doing reconciliation, not restating Finance's figures, so `CAN_CAPTURE_ROUND` is the right gate for an operation that can move a foreign key and nothing else. Amount, date, type and currency stay behind `CAN_WRITE_FINANCIAL`
- A *cheques in this round* section on the Deal Close form, and an **enabled** round picker on the transaction form with an explicit *No round — standalone* option

Two properties come for free and should be asserted rather than assumed: the ADR-031 trigger captures the link change, because it fires on any `UPDATE` to `transaction`; and restatement detection works, because `checkRestatement` keys on `txn_date`.

**The metric change to read before merging.** `v_round_leverage` must **exclude rounds where `nbif_participated = 'no'`**. Leverage measures capital attracted alongside our own money; a round we sat out contributes round total with no matching cost and would inflate the ratio. **No number moves today**, because every generated round carries a cheque and backfills to `yes`. The exclusion is a guard installed before the data that would trip it exists, which is the cheapest moment to install it — and it is asserted in a test rather than trusted, because the first non-participating round will arrive months from now with nobody watching.

**Exit:** a cheque can be attached to a round from either surface, by the role that would naturally do it, and the change is auditable. A round can state that we did not participate, and the leverage figure believes it. No board number has moved. **Size: M**

**Done, 20 August 2026** — see the F1 entry in `BUILD-LOG.md`. Migration 0008 backfilled 176 of 180 rounds to `yes` from evidence and left 4 as `unknown`, which are the genuine S-2 states rather than a gap. 252 golden-master tests, 39 db tests and 63 functions tests pass unchanged; the API suite goes from 95 to 111.

**One thing in this spec did not survive contact with the code, and it is the metric change above.** `v_round_leverage` is marked CONVENIENCE ONLY (ADR-021) and **no API path reads it** — the published leverage KPI is `fundMetrics` over the ADR-001 export, whose predicate lets a round we sat out through with `invested` of 0 and adds its whole total to capital attracted. The guard as specified would have gone into the one place it could never trip. It is installed in **both** the view and `read/export.ts`, which is not a change to the frozen contract: the contract's own `Round` type is documented as *"one financing round we participated in"*. ADR-033 clause 3 carries the full reasoning and the cost. **The F1 suite asserts the view and the export together, and demonstrates the ratio moving**, because a change to one without the other is silent.

#### F2 · The valuation ledger

*The FMV storage model and the manual review path. Not the automation.*

**Closes:** S-3 (the same-day mark index) · the FR-16 storage half · FR-18 in full · the FR-19 read half · design note D-3. **Lands ADR-034, amends ADR-007.**

**Why it is safe — and this is the phase where that argument matters most.** Q-2, Q-3 and Q-4 are unanswered, and they are all about **which rows get written and by what process**. None of them is about **what a row looks like**:

| If Pat says… | Row shape |
|---|---|
| "Repricing, not at cost" | Unchanged — a different number lands in `fmv` |
| "No automatic adjustments at all" | Unchanged — two type values go unused |
| "Automatic and final, no confirmation" | Unchanged — `status` is set to `final` instead of `draft` |
| "Unpriced rounds raise a flag" | Unchanged — a flag is a read, not a column here |

The storage model is robust to every answer available, and the manual review path is fully specified by Cameron's FR-18 clarification. So the ledger and the review entry go in now, and the two automatic types are declared in the vocabulary and written by nothing until Block 1 is answered.

- `valuation_mark` gains `adjustment_type`, `basis_mark_id`, `basis_fmv`, `retention_factor` and `adjustment_amount`. **A factor, not a percentage** — 0.7500 means the position is carried at 75% of its previous FMV, has one arithmetic meaning, and cannot be read backwards six months from now. The UI shows the sentence; the column holds the number the arithmetic uses. **`basis_fmv` is stored rather than looked up** so that a later correction to an earlier mark becomes a *detectable* inconsistency rather than silently invalidating everything downstream — F6 reports the mismatch
- `ref_fmv_retention_option`, a table rather than a CHECK constraint, so Finance can add or retire an option through the Policies surface without a migration. The meeting's intent was a constrained list, not free entry; what changes is who can change the list
- **Relax the same-date unique index** to one *review* mark per company per date. Two cheques on one day are two facts, not a conflict. **Then fix the tiebreak in `company_fmv_asof`**, which orders by `effective_date desc, booked_at desc` and can tie on two marks written inside one database transaction. Adding `valuation_mark_id desc` is one line and it is load-bearing the moment same-day marks are legal
- A review path on `writeValuationMark` where the server resolves the prior mark, stores the basis, and computes `fmv = round(basis_fmv × retention_factor, 2)`. **`fmv` is never accepted from the client on this path** — a computed figure the client can also supply is one that will eventually disagree with itself. The retention factor is validated against the active reference rows, server-side, not by the shape of a drop-down
- **The FMV review workspace**, a surface rather than a form: current FMV with its full provenance, the complete mark history with rationale and author, transactions since the last mark with the round each is attached to, rounds since the last mark, and the retention control showing the resulting dollar figure before saving

**Deliberately not in scope:** the `transaction` and `round_reprice` types are declared and written by nothing. The workspace shows *context*, not *proposals* — the proposal panel is Block 1's payoff.

**Exit:** Finance can run a review from a screen that shows them everything they would otherwise look up. Every stored FMV is still an absolute, every existing metric reads it unchanged, and no board number has moved. **Size: L** — the largest phase in Track F, and the one with the most direct daily value to Finance.

**Done, 20 August 2026** — see the F2 entry in `BUILD-LOG.md`. Migration 0009 labelled all 1,016 existing marks `legacy` and moved not one figure; portfolio FMV still reconciles to the frozen Affinity control total of **$42,030,272.00 to the cent**. 252 golden masters, 39 db tests and 63 functions tests pass unchanged; the API suite goes from 111 to 128.

**Two things the spec did not settle, both decided and recorded.** A review may be applied to **cost** — ADR-007 holds an unmarked company there, so it is the carrying value, and refusing would send Finance to compute cost × 0.75 by hand and enter it as an absolute, which is the re-entry FR-19 exists to remove. And the same-date index gained `deleted_at is null` while it was being rewritten: the 0001 version did not exclude soft-deleted rows while the application check did, so deleting a mark and entering another at the same date passed validation and then failed on a constraint the operator could not see.

**Q-1 stops being a reading and becomes a test.** Successive 50% / 50% impairment landing at 25% of the original is now asserted rather than described as "almost certainly what is intended".

#### F3 · Ownership maintenance, the Policies surface, and significant influence

**Closes:** FR-36 (new, from Q-15) · FR-21 · Cameron's Policies-tab design. **Lands ADR-035.**

**Why it is safe.** Q-15 settles the ownership workflow completely: Finance enters adjustments ad hoc, no cadence. The significant-influence threshold and derived flag are unambiguous — Pat named 10% as the standard rule. Only the override for board-seat grey areas needs Q-7, and an override is additive to a flag that already works.

- `company_ownership` gains `change_reason` and an optional `investment_round_id`. A cap-table position with no explanation feeds MOIC, the waterfall and — once the threshold lands — the accounting treatment of the company
- `fund_accounting_policy`, effective-dated on the `fund_alert_policy` pattern and for the same reason: this drives financial-statement treatment, and a prior period's classification has to stay reproducible. **Insert no policy row in the migration** — the behaviour change lands when someone sets the threshold on the Policies screen, deliberately, exactly as migration 0005 did for the alert policy
- `significant_influence_asof()`, returning **NULL, never false, when ownership is unrecorded**. "We hold no ownership figure" and "this company is below the threshold" are different statements, and reporting the second when the first is true is how a company quietly drops off a schedule an auditor expects to find it on. D-5's rule where the stakes are highest
- Standalone ownership entry gated to `CAN_CAPTURE_ROUND`, and accounting-policy entry gated to `finance` and `admin`, following `fund_alert_policy`'s write pattern exactly: **supersede, never update**
- **A Policies tab** with two role-gated sections: *Portfolio Alert Policies*, moved out of the Alerts tab, and *Finance Policies*. Moving the alert policy card is a clean move rather than a copy, and it improves the tab it leaves — Alerts was deliberately built as the *working* view, and configuration sitting inside it was always slightly the wrong shape
- The significant-influence report, with an as-of date selector, and companies with no ownership figure in a separate group headed *ownership not recorded* — visible, not silently absent, and directly actionable from the same screen

**Deliberately not in scope:** the manual override for board-seat cases (Q-7). Until it exists the report carries a `ConventionNote` saying the flag is derived from ownership alone and that grey areas are known to exist.

**Size: M**

#### F4 · Exits and the Exited view

*The one phase that starts with a question rather than a migration.*

**Closes:** S-4 (`company_exit` has no write path) · FR-28 · FR-29 as corrected · FR-30 · design note D-7 · a live defect in the A6 generator. **Lands ADR-036, amends ADR-009.**

**Why it is safe — with one condition.** Cameron's FR-29 correction settles the model completely: membership follows Affinity's roster status; the exit event is a separate financial fact owned by Finance. What is *not* known is what Affinity actually contains, and that is knowable today without asking anyone.

**F4 does not begin with a migration. It begins with a read-only probe.** The Affinity list carries a Status field; the export profiled it as 80/80 rows with one distinct value, always `Portfolio`, and mapped it as unused on that basis. Before anything is written: pull the Status field's dropdown options via the metadata route (ADR-009's rule — seed from field configuration, not observed values), count list entries by Status, and report how many companies carry `Exited`, whether any are already on the 82-company roster, and what their invested and FMV figures are.

**Gate:** if the Exited companies bring new organisations onto the roster, the invested and FMV control totals move — the same totals A6 reconciles to and A13 is meant to tie to. **Stop and decide with the numbers on the table.** The F0 snapshot is what makes that decision recoverable.

Then: `company_state.roster_status`, on the dated state table rather than on `company`, because "when did this company leave the portfolio" is a question the board asks. Widen the sync to accept `Exited` as a valid membership status, keeping every other rule intact — one-way inbound, upsert never truncate, never delete — and verify the convergence property still holds: a second run must create zero new rows. Derive `exited` as `roster_status = 'Exited'` **or** (`roster_status is null` and a `company_exit` row exists), which preserves the fixture path and every golden master untouched while making Affinity authoritative wherever it actually speaks. Add an Exited tab, and an exit-event entry for Finance that records the economic event and **does not move the company between views** — the whole point of D-7, and it should be said on the screen so nobody expects otherwise.

**Correct the generator.** `packages/db/src/generate/plan.ts` writes a `company_exit` row wherever the lifecycle status reads `Winding Down`. Under the corrected model those companies are still portfolio companies, which means **the 7 exited companies on today's dashboard are a generator artefact.** Drive exits from `roster_status = 'Exited'` instead. **This moves a visible number on the dashboard** — a correction rather than a regression, but it should be merged deliberately with the before and after recorded in `BUILD-LOG.md`, not discovered by someone in a meeting.

**Size: L** — mostly because of the discovery step and the blast radius, not the code.

#### F5 · The LP three-stage model

**Closes:** S-7 (commitment is a scalar) · FR-32 · FR-33 · FR-34 · an outstanding ADR-002 debt. **Lands ADR-037.**

**Why it is safe.** Q-16 confirmed the model and disposed of the figures that muddied it. The word that settles the design is **adjustable**: a commitment is not fixed at subscription, so it cannot be a column.

- `fund_commitment`, dated, holding the commitment **as at** a date rather than a delta — same reasoning as the valuation ledger, and an increase is a new dated row rather than an arithmetic puzzle. Plus `fund_committed_asof()`
- **Then retire the column.** Backfill one row per position at inception, assert the total reconciles to the workbook's **$8,725,000**, run for one cycle with both in place and compared, then drop `fund_investment.committed`. This pays down a debt ADR-002 has carried since A1
- **The contract does not change.** `FundInvestment.committed` stays a `$M` scalar; the API derives it instead of reading a column. `packages/metrics/lp.ts` is untouched, and TVPI, DPI, RVPI and IRR do not move
- **The terminology rename**, of the stored value and not just the label: the `txn_lp_types` CHECK constraint, `TXN_TYPES`, `TXN_TYPE_LABELS`, the export adapter's cashflow-sign mapping, the fixture importer, the A6 LP generator, and every test naming the string. Doing it now costs an afternoon; doing it after A13 costs a data migration over fifteen years of history
- A drawdown exceeding the commitment in force is **accepted and flagged, never refused** — the same principle as a round total below our cheque. It is a real state of real data, and the platform's job is to surface it rather than make it un-recordable

**One dependency outside the code:** the exact terminology (Q-23). That is an email to Funke, not a meeting item, and it should be sent **before this phase starts**. Do not guess; the whole value of renaming now is that it happens once.

**Size: M**

#### F6 · The reconciliation surface

*Last, because it reports on everything above.*

**Closes:** S-10 · FR-08 · FR-09 · FR-14. **Lands ADR-038, amends ADR-031.**

**Why it is safe.** FR-14's mechanism — distinguishing a correction from information arriving late — is unambiguous and independent of every open question. FR-08's duplicate rule needs Q-9, but **built as a warning with a mandatory acknowledgement it cannot be got wrong in a damaging way**: too loose and it under-fires, too tight and it is clicked through. Pat's answer tightens it later without a rebuild.

- `financial_row_version.change_kind` — `correction` / `new-information` / `initial-load`, nullable, and NULL means unclassified because every row written before the migration genuinely is, and backfilling a guess would be worse than the gap. A grant that arrives six months after the round is not a correction of a wrong figure; the row's history was right and the *label* was wrong
- Soft duplicate detection on `investment_round`, with the acknowledgement and its reason stored on the row, and a normalised-label index behind it. **Never a hard block** — the codebase's own precedent is that a round total below our cheque is accepted and flagged, because pushing someone into fudging a figure to get past a form is worse than the figure being wrong and visible
- **One view, one screen, seven checks:** unlinked transaction · round marked participated with no cheque · round captured but not Finance-confirmed · co-investor sum ≠ `nb_other` · round total below our cheque · mark basis drift · exit-status mismatch. Each row names what, which company, the two figures that disagree, and links straight to the screen that fixes it. **A reconciliation list that cannot be acted on from itself becomes wallpaper** — the same argument A9 made for time-boxed acknowledgements, and it applies identically here

**Size: M**

### Deliberately held back

Not oversights. Each names the question that blocks it.

| Work | Blocked by | Why it cannot be guessed |
|---|---|---|
| **Automatic FMV adjustment** (FR-17, the proposal half of FR-19) | Q-2, Q-3, Q-4 | At cost or repriced is a different NAV. The storage is built in F2; only the rules wait. |
| **Net book value** (FR-20, FR-31) | Q-5, Q-6 | The largest item in the register. Whether gross and provision are separately reportable decides whether wind-up is an event or a status — a schema question, not a display one. |
| **Debt instruments and conversion** (FR-22 to FR-26) | Q-11, Q-20, Q-21 | Day count and compounding are columns. Guessing them means storing numbers that are wrong in a way nobody can see. |
| **Non-investment leverage** (FR-13, FR-15) | Q-8, and the pedal report file | Changing a published board figure without sign-off is not a thing to do quietly. And the fields follow the report format, which has not been seen. |
| **Significant-influence override** (part of FR-21) | Q-7 | Additive to a flag F3 builds. No rework. |
| **Affinity write-back** (FR-02) | A13 | Confirmed by Q-17, sequenced at cutover. F0 takes the snapshot that makes it safe. |
| **Hard completeness gate** (FR-10) | Q-10 | Refusing to record an incomplete transaction risks real cheques going unrecorded. Needs the intent confirmed. |
| **Round-level region and sector** (FR-12) | Clarification | Company-level values already exist; surfacing them may be the whole requirement. |

### The ADRs Track F raises

Raised as **Proposed** at F0; each moves to **Accepted** as its phase lands.

| ADR | Thesis | Lands with |
|---|---|---|
| **ADR-033** ✅ | A round is an event in the company's life; participation is explicit, and the cheque-to-round link is writable from both surfaces through a narrow mutation. **Accepted 20 Aug 2026.** Clause 3 was amended on landing: the leverage guard had to go in the export as well as the view | F1 |
| **ADR-034** ✅ | A valuation mark records the adjustment that produced it and stores the resulting absolute; the retention factor is the input and the absolute is the fact. **Accepted 20 Aug 2026.** Clause 3 gained the rule for a review applied to cost | F2 |
| **ADR-035** | Ownership is maintained between rounds by Finance, ad hoc; significant influence is a dated policy with a derived flag | F3 |
| **ADR-036** | Portfolio membership follows Affinity's roster status; the exit event is a separate financial fact that does not move a company between views | F4 |
| **ADR-037** | LP commitments are dated events and `committed` becomes derived | F5 |
| **ADR-038** | The version store distinguishes a correction from information arriving late | F6 |
| **ADR-039** | Total invested is pushed to Affinity at cutover and becomes read-only there; the pre-cutover figures are frozen before the first write | F0 / A13 |

Amendments land **in** the existing ADRs rather than only in the new ones, because a reader who finds ADR-009 first must not come away with a rule that is no longer whole: **ADR-007** (the same-date index and the retention entry path), **ADR-009** (roster status becomes a synced field, and the one-way rule gains its first stated exception), **ADR-012** (the transaction link is a reconciliation rather than a capture, and why `CAN_CAPTURE_ROUND` is the right gate for it) and **ADR-031** (change kind).

### Before the second Finance meeting

Take `docs/finance-design-notes.md`, the *Open questions* section. It is grouped into five blocks, each stating what it blocks, so if the meeting runs short the cost of stopping is visible. **Block 2 — net book value — is the one worth protecting:** it is the largest item in the register and the one that takes an Excel file off Pat's desk.

**One email, ahead of it and independent of it:** Q-23 to Funke, confirming the exact LP wording. F5 is gated on the answer and nothing else in Track F is.

---

## Minimum launchable product

If the full sequence runs too long, this is the smaller thing worth launching.

**In:** A0–A9, A11, F0–F6, A13, A14 — Pipeline, Portfolio, Funds, Dashboard, Reports, Finance entry, alerts. Neither cutover phase is optional: A13 is what makes the numbers real and A14 is what makes them supportable.
**Deferred past launch:** A10 Memo builder and A12 Modeling. Daniel keeps using the prototype for both; neither has an upstream data dependency, so nothing decays while they wait.
**Track F is in, and that is a change from v2.1's list.** Not because it is more valuable than A10 or A12 — it is not, to anyone using the platform — but because it is the only work here whose cost rises sharply if it is deferred past A13. A memo builder built next year costs the same as one built this year. A schema change made after fifteen years of history has loaded does not. If Track F itself has to be cut, the order to cut in is F6, then F3, then F4; **F0, F1, F2 and F5 are the ones that touch the schema in ways A13 would make expensive.**

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
