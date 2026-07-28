# Portfolio Command — Architecture Decision Records

**Status of this document:** decisions agreed between the Systems & Data Analyst and Claude, 27 July 2026, based on Daniel Armali's v1 prototype (`vc-toolkit.html`) and the answers to the twelve open questions raised against the field inventory.

Each record follows Context → Decision → Consequences. Where a decision changes something in the prototype, the prototype's behaviour is stated so the change is deliberate and traceable rather than incidental.

---

## ADR-001 — The MVP JSON schema is the contract at the boundary, not the storage model

**Status:** Accepted

**Context.** Daniel's requirement: *"the JSON schema documented in the app's Data tab is the contract — keep that intact so my imports and workflow keep working while you rebuild whatever's underneath."* The prototype's schema is a denormalised document tree that stores derived values as facts. Adopting it as the storage model would carry its reconciliation problems into production; discarding it would break his workflow.

**Decision.** The JSON schema is preserved exactly as the **API and export contract**. `GET /api/v1/export` emits JSON matching the Data tab schema field for field, `meta.schemaVersion` remains `1`, and the four CSV importers keep their exact headers and column order. Underneath, storage is normalised (ADR-002).

On import, fields that the new model derives are treated as **advisory**. If an imported file asserts `invested: 8.5` and the transactions behind it sum to 8.3, the import succeeds, 8.3 is used, and the response carries a reconciliation warning naming the discrepancy.

**Consequences.**
- Daniel's export → edit → re-import loop is unchanged. No retraining, no migration on his side.
- The contract is versioned independently of the database. Schema changes underneath do not bump `schemaVersion`; only contract changes do.
- Contract stability must be enforced by test. A serialisation snapshot test runs against the demo dataset on every build; any drift in field names, nesting or units fails CI.
- Money remains `$M` in the contract while the database stores dollars. The API layer owns that conversion in exactly one place.

---

## ADR-002 — Transactions are the only stored financial facts; portfolio scalars are derived

**Status:** Accepted

**Context.** The prototype stores `company.invested` alongside `rounds[].invested`, and `company.fmv` alongside `marks[]`, with nothing enforcing agreement. More seriously, realizations are held twice: `fund.distributions[]` drives fund DPI while `company.realized` drives company MOIC. These are independent representations of the same events and will diverge.

**Decision.** One `transaction` table records every dollar movement — investments, follow-ons, realizations, write-offs, LP capital calls, LP distributions, fees. Every financial scalar is computed from it. Of the 148 fields in the inventory, 18 are marked Derived and must not be stored: `company.invested`, `company.fmv`, `company.realized`, `company.exited`, `company.vintage`, `company.instrument`, `reservesDeployed`, `runwayMo`, `fteAtEntry`, `fundInvestment.called`, `fundInvestment.distributions`, `coInvestsDone`, `referrals`, `capitalToDirect`, `ytdPlatformsClosed`, and the NAV history series.

**Consequences.**
- Fund DPI and company MOIC can no longer disagree; both read the same rows. This resolves Q4.
- Reads become joins rather than column lookups. At roughly 70 companies this is irrelevant; the views in `schema.sql` are the read path.
- Every derived value needs a definition owned by the metrics package, not by whichever view happens to compute it.
- The transaction registry becomes load-bearing. Its absence today is the single largest gap in the programme (ADR-011).

---

## ADR-003 — TypeScript end to end

**Status:** Accepted — supersedes an earlier recommendation of a Python metrics service

**Context.** Maintenance rests with one person, who is also the organisation's internal IT. Emergency coverage comes from an external MSP that manages the Microsoft tenant and is not a development shop. An earlier recommendation split the stack — TypeScript frontend, Python metrics service — on the grounds that XIRR and waterfall maths are more natural in Python.

**Decision.** One language across the stack. Next.js + TypeScript for the application and API, a `packages/metrics` TypeScript library for all metric definitions, Azure Functions in TypeScript for scheduled ingestion. One repository, one toolchain, one deployment pipeline.

**Consequences.**
- The MSP's realistic capability — restart an App Service, read a Function log, check a database connection — covers the whole system rather than part of it.
- The prototype's `xirr`, `runScenario`, `fundMetrics` and `fiMetrics` are already JavaScript. They port directly into the metrics package, which materially reduces the risk of changing a board number during the rebuild.
- Numerical work is slightly less ergonomic than in Python. Accepted: the maths here is bisection and arithmetic, not scientific computing.
- Metrics are never computed in a React component. The package is imported by the API and by batch jobs; the frontend renders values it is given.

---

## ADR-004 — Azure Database for PostgreSQL as system of record, hosted in Canada

**Status:** Accepted

**Context.** No formal data-residency requirement exists, but leadership prefers Canadian hosting. The organisation has an Azure tenant, an M365 tenant, and prior experience building and hosting full-stack applications in Azure.

**Decision.** Azure Database for PostgreSQL Flexible Server in Canada Central, with the application on Azure App Service and documents in Azure Blob Storage, all in the same region. Point-in-time restore enabled; geo-redundant backup to Canada East.

**Consequences.**
- Leadership's preference is satisfied without constraining the design.
- Affinity and Visible.vc remain US-hosted third parties. Data flows one way into Canadian storage; this should be stated plainly to leadership rather than implied.
- Postgres is a deliberate choice over SQL Server despite the Microsoft estate: the schema uses `jsonb` for audit payloads, generated columns, and lateral joins, and the hosting and tooling story on Azure is equivalent.

---

## ADR-005 — Entra ID authentication for staff; board consumption by PDF

**Status:** Accepted

**Context.** Expected user base is 10–20 across VC, Finance and Leadership. Board members were a possible fifth audience. Introducing external guest accounts brings row-level restrictions, guest lifecycle management and a materially larger security surface.

**Decision.** Authentication via Entra ID (MSAL), staff only. Four roles: `vc`, `finance`, `leadership`, `admin`. Board members receive generated PDF exports; no accounts are issued to them in phase 1.

**Consequences.**
- Authorisation reduces to role checks. No row-level security, no guest lifecycle, no external sharing policy needed now.
- The board PDF becomes a first-class output rather than a convenience, and must be good enough to be the sole board-facing artefact (ADR-014).
- Reversible. Adding board guest accounts later means adding a role and a row-level policy, not restructuring.
- Write permissions follow the source-of-record split: Finance writes transactions and valuation marks; VC writes health, flags, gates, reserves, memos and deal-close capture.

---

## ADR-006 — Reporting periods are stored as dates; calendar and fiscal labels are derived

**Status:** Accepted

**Context.** Two calendars are in play and they do not agree. Visible.vc labels by **calendar** quarter — the submission due 5 August 2026 is "Q2 2026", covering April–June. The organisation's **fiscal** year starts 1 April, so that same April–June period is fiscal Q1 of FY2026‑27. The prototype stores only a label string (`"2026-Q1"`) on both `kpis[]` and `fund.navHistory[]`, with no indication of which convention it means.

**Decision.** `company_kpi` stores `period_start` and `period_end` as dates. Labels are produced by two functions, `calendar_quarter_label()` and `fiscal_quarter_label()`, the latter parameterised by `fund.fiscal_year_start_month` (4). Ingestion from Visible maps its quarter label to real dates on arrival. No metric, join or sort key is ever a label string.

**Consequences.**
- Ingested KPI data and board-facing reporting can use different conventions without the data being wrong in either.
- The same figure will legitimately appear under two different quarter labels depending on the view. Every screen and report must state which convention it uses, or the discrepancy will be read as an error.
- Same-store revenue growth, FMV growth QoQ/YoY and the NAV bridge become unambiguous, which they are not today.
- The contract keeps emitting a label string; the API chooses which convention to emit per endpoint.

---

## ADR-007 — Valuation marks are semi-annual with explicit carry-forward

**Status:** Accepted

**Context.** The FMV exercise is led by Finance twice a year with data cutoffs at the end of January and the end of July. All other metrics report quarterly. The fiscal year ends 31 March. The prototype treats FMV as a per-company scalar with a `marks[]` audit trail beside it, and maintains `fund.navHistory` by hand.

**Decision.** `valuation_mark` is the only source of company FMV. NAV as at any date is the sum, across companies, of each company's most recent `final` mark on or before that date; companies with no mark yet are held at cost. This is implemented as `company_fmv_asof()`. The carry-forward rule is stated on screen wherever FMV growth appears, in the same manner as the prototype's DPI recycling note.

**Consequences.**
- NAV changes between valuation cycles only through new capital deployed at cost. Two of every four quarters will show near-zero FMV growth, then a step. This is correct behaviour and must be labelled, not smoothed.
- **Resolved (O-1):** 31 January and 31 July are the valuation **effective dates**. Marks are "as at" those dates and are reported to the board two to three months later. `effective_date` carries the 31 Jan / 31 Jul date; `booked_at` carries the date Finance completed entry.
- **Accepted by the VC team lead (D-3).** The two flat quarters per year are understood and the carry-forward labelling is agreed.
- **Resolved (O-2):** the FMV cadence does not change because of this platform. The 31 March fiscal year end continues to be served by a 31 January mark carried forward two months. This is accepted business as usual; the platform's obligation is to label it, not to alter it.
- **The reporting lag has a visible consequence.** Between an effective date and the date Finance books the exercise, the platform shows the *previous* mark as current. A report run in March for a 31 January as-of date will differ from the same report run in April, once the January marks are entered. Board-facing views therefore carry a stamp reading "marks as at *[effective date]*, booked *[booked date]*", and `fund_nav_snapshot.frozen_at` fixes the figures actually issued so a re-run never restates a published number.
- Marks are entered by Finance and treated as final on entry (ADR-008). A `supersedes_id` chain preserves any later restatement.

---

## ADR-008 — Reporting currency is CAD; the schema stays currency-aware

**Status:** Accepted

**Context.** All reporting is in CAD. The prototype hardcodes a single `fund.currency` of `"USD"` and stores money as `$M` floats with no currency on individual amounts.

**Decision.** Reporting currency is CAD. `transaction`, `valuation_mark`, `fund_investment` and `pipeline_deal` each carry a `currency` column defaulting to `CAD` and an `fx_rate_to_cad` where applicable. Amounts are stored in dollars as `numeric(18,2)`, never as floats and never in millions.

**Consequences.**
- Single-currency behaviour today, with no per-transaction FX work required.
- One USD-denominated round or LP commitment in future is a data question, not a migration. The cost of carrying the columns now is close to zero; retrofitting them later touches every financial table and every metric.
- Float arithmetic on money is eliminated. The prototype's `$M` float representation survives only in the JSON contract, produced at serialisation.

---

## ADR-009 — Affinity is the system of record for identity and pipeline; sync is one-way

**Status:** Accepted

**Context.** Affinity is live and disciplined, and is the CRM for both pipeline and portfolio companies. The prototype ingests it as a manual CSV drop with fuzzy header matching, and maps deal status to funnel stage using keyword regexes. It also infers units — dividing a check size by one million if the value exceeds 100,000.

**Decision.** Scheduled nightly pull from the Affinity REST API v2 into `pipeline_deal` and `company`, keyed on `affinity_opportunity_id` and `affinity_org_id`. The platform never writes back. Status mapping moves from regex to the editable `affinity_status_map` table. Units are declared explicitly at the boundary; no value-magnitude inference.

**Consequences.**
- Affinity remains the team's daily working surface. The platform does not compete with it and cannot corrupt it.
- Affinity ids are the entity-resolution spine linking to Visible and to internal records. Companies must be matched on id, never on name.
- A stage mapping change is a row edit, not a code deploy.
- Fields Affinity does not hold — round totals, NB co-investor amounts, ownership, valuations — are explicitly out of scope for this sync (ADR-012).

---

## ADR-010 — Visible.vc is the system of record for company-reported KPIs, including jobs and diversity

**Status:** Accepted

**Context.** Visible is live and disciplined, collecting revenue, burn, cash, FTE and NB FTE quarterly from portfolio companies. The prototype holds `fte`, `fteNB`, `womenCSuite` and `cSuiteSize` as single current values on the company record, separate from the quarterly `kpis[]` series.

**Decision.** Jobs and diversity move into `company_kpi` as columns on the quarterly series. Visible remains the collection workflow; the platform does not rebuild forms, reminders or founder chasing. Metric definitions live in the Visible request wording and are accepted as reported; `company_kpi.request_version` stamps which wording produced each row.

**Consequences.**
- Mandate reporting gains a jobs and diversity trend rather than a snapshot, and any past period can be regenerated.
- `fteAtEntry` becomes derivable — the reading nearest the first investment date — rather than a hand-maintained field that silently goes stale.
- Definitions of "NB employee" and "C-suite" are set by the request text, resolving Q6. Stamping the version means a wording change appears as a documented break in the series rather than an unexplained shift.
- Companies that predate Visible adoption need a manual baseline; `source_system` distinguishes `visible` from `manual` rows.
- **Revenue is period actual, not run-rate (O-5), and is presented as reported (D-2, resolved).** Visible collects the past quarter's actual revenue. The figure is stored and displayed exactly as Visible supplies it; no annualisation is applied. See ADR-013.
- **Diversity fields are not yet collected (O-4), and non-reporters are excluded (D-5, accepted).** `women_csuite` and `csuite_size` must be added to the Visible request. Until then they are NULL, and **NULL must not be rendered as zero**. Reporting "0% of companies have women in the C-suite" when the truth is "not asked" is a materially worse error than reporting nothing. The diversity tile shows the metric alongside its coverage — reported by *n* of *m* companies — and excludes non-reporters from the denominator rather than counting them as zeros. The prototype does not currently make this distinction.

---

## ADR-011 — The platform is the transaction registry; Excel bulk upload is the phase-1 front door

**Status:** Accepted

**Context.** Finance records transactions in spreadsheets and delivers them by email. There is no registry. Every financial metric in the platform depends on this data. Buying a separate registry tool would create two systems that must never disagree about the same dollars.

**Decision.** The `transaction` table is the registry. Phase 1: a strict Excel template completed by Finance and bulk-uploaded, with each upload tagged by `batch_id` for traceability and rollback. Phase 2: an in-application entry form restricted to the `finance` role. Both write to the same table, so the interim solution is not throwaway.

**Consequences.**
- Registry design becomes part of this project rather than a dependency on it.
- Validation moves from convention to constraint: transaction type must match subject, currency must carry an FX rate when not CAD, amounts are always positive with direction implied by type.
- Finance's process changes. The template must be genuinely easy to complete or it will be worked around, and the upload must reject a bad file loudly rather than accept it partially.
- Every transaction carries `entered_by` and `booked_at`, giving the audit trail the prototype lacks entirely.

---

## ADR-012 — Mandate fields are captured at deal close, with completeness monitored

**Status:** Accepted

**Context.** `round_total` drives the leverage KPI and `nb_other` drives the NB co-investment KPI. Neither exists in Affinity, Visible or Finance's spreadsheets. Ownership percentage — which feeds MOIC, leverage and the waterfall — lives in Excel files on SharePoint and in Visible. The deal lead will enter these at close.

**Decision.** *Accepted by the VC team lead (D-4).* A single deal-close form captures round total, co-investors with an NB flag and amounts, ownership after the round, pro-rata rights and post-money, writing to `investment_round`, `round_coinvestor` and `company_ownership`. The SharePoint cap table is retained as the linked source document; the platform holds the structured values. A `v_mandate_completeness` view exposes coverage — what percentage of rounds carry a round total — on the dashboard.

**Consequences.**
- Two mandate KPIs depend on deal-lead discipline at a single moment. Monitoring coverage is what prevents silent decay; without it the leverage number degrades invisibly as rounds accumulate without totals.
- Recording co-investors individually rather than as an aggregate lets `capitalToDirect` and `coInvestsDone` be derived per ADR-002, instead of being hand-maintained on the LP position as they are today.
- Daniel's rule is preserved exactly: a round with a missing or invalid total is **excluded** from leverage, never imputed.
- Historical rounds will have gaps that no form can fill. Coverage will be partial for backfilled history and should be reported as such (ADR-015).

---

## ADR-013 — Metric definitions are frozen at Daniel's implementations

**Status:** Accepted

**Context.** The prototype's metric definitions were settled and validated with the VC team lead. Several are subtly good: leverage excludes bad data rather than guessing, same-store revenue growth requires two KPI periods, direct and LP performance are never blended, net IRR is labelled an estimate. Mandate definitions are also papered in a funding agreement, which has not yet been diffed against the implementations.

**Decision.** The rebuild reproduces Daniel's definitions exactly. No definition is "improved" during the port. Divergences between the funding agreement and the implementations are deferred to a later review.

**Consequences.**
- The rebuild is verifiable. Golden-master tests freeze the prototype's outputs on the demo dataset and assert the metrics package reproduces them; any change to a board number becomes a test failure rather than a discovery.
- The conventions that make these metrics defensible are protected from well-intentioned normalisation by a future developer.
- Known simplifications are inherited deliberately: net IRR as gross minus a fee-drag estimate, invested cost as a proxy for paid-in capital, and the waterfall assumptions in ADR-016. Each keeps its on-screen label.
- **The one divergence is resolved (D-2).** The prototype presented company revenue as run-rate; Visible supplies the past quarter's actual. Revenue is now stored and displayed **as reported**, with no annualisation. The label changes from run-rate to quarterly revenue in the dashboard tile, the memo prefill text and the user guide; the arithmetic is untouched.
- Two second-order effects of D-2 to carry into build. The aggregate revenue figure is now roughly a quarter of the number the same tile showed under the run-rate label, so any board comparison against earlier output needs the basis change stated once. And same-store QoQ growth on actuals now carries seasonality that a run-rate framing masked — a same-quarter year-over-year comparison is the more robust measure for seasonal businesses, and is worth revisiting in phase 2 rather than changing now under ADR-013.
- A definitions review against the funding agreement is no longer required as a blocker. The platform is not the system of submission for provincial reporting (ADR-017), so its mandate figures are management information rather than filed numbers.

---

## ADR-014 — The frontend is ported one-to-one; no visual or content change in phase 1

**Status:** Accepted

**Context.** Daniel is satisfied with what the interface presents. The prototype is roughly 1,700 lines of vanilla JavaScript rendering string templates, with metrics computed inline in view functions and charts drawn with Chart.js.

**Decision.** Views port to React components preserving layout, content, terminology, colour conventions, the eight-tab structure and the drawer interaction pattern. The only structural change is that metric computation moves out of the view layer into the metrics package. Chart.js gives way to Recharts, matched to the existing visual output.

**Consequences.**
- No user retraining, and Daniel can review the rebuild against a running copy of his own tool.
- "Looks identical" is a testable acceptance criterion for phase 1, which keeps redesign discussions out of the migration.
- The prototype's `esc()` discipline is replaced by React's default escaping. Any `dangerouslySetInnerHTML` requires justification.
- **Two content exceptions, both forced by data rather than taste, both now settled.** The revenue label changes to quarterly revenue to match what Visible supplies (D-2), and the diversity tile distinguishes "not reported" from zero and shows coverage (D-5). Everything else holds to the one-to-one rule; any further change is a phase-2 conversation.
- The board PDF is regenerated properly via Playwright rather than `@media print`, since it is now the sole board-facing artefact (ADR-005). This is the one place output will visibly improve.

---

## ADR-015 — Full historical backfill since inception, run as a parallel workstream

**Status:** Accepted

**Context.** Transactions, rounds and valuation marks are to be loaded as far back as records allow. Since-inception gross IRR, the NAV history series and vintage analysis all require full history; a cutover date would make those metrics unavailable for early periods. The source material is Finance's historical spreadsheets, closing documents and past valuation exercises.

**Decision.** Backfill is a distinct workstream beginning immediately and running in parallel with development, not a phase that follows it. Sequence: transactions first (they anchor everything), then rounds, then marks, then ownership. Each batch is loaded with a `batch_id` and reconciled against Finance's own totals before the next begins.

**Consequences.**
- **Backfill is the critical path, not the code.** The application can be built against demo data; it cannot go live without history. Starting it late is the most likely cause of schedule slip.
- Reconciliation is the gate. Loaded totals must agree with Finance's records period by period before any metric built on them is trusted.
- Early rounds will lack round totals and NB co-investor detail, which no process can now recover. Mandate coverage will be lower for older vintages and must be reported honestly rather than imputed.
- Archaeology will surface contradictions between sources. Those decisions need recording as they are made; the reconciliation notes are themselves a deliverable.
- **Depth is greater than the prototype implies (O-6).** Some portfolio companies have funding histories going back fifteen years or more, against a prototype seeded with a 2019 inception and a NAV series beginning in 2024. Round totals and co-investor detail are described as relatively extensive but imperfect. Coverage will therefore taper with age, and the leverage KPI will be materially better supported for recent vintages than for early ones. That taper is reported, not smoothed.

---

## ADR-016 — Waterfall simplifications are retained for phase 1

**Status:** Accepted — revisit deferred

**Context.** The prototype's exit model assumes a 1× non-participating preference, a pari passu stack, the option pool carved pre-money, and no ratchets. These assumptions are stated on screen. A fully accurate waterfall requires the complete share-class structure, which the SharePoint cap table files may not support.

**Decision.** Retain the simplifications and the on-screen statement of them for phase 1. Revisit once structured ownership data has been accumulating for long enough to show whether the underlying detail is available.

**Consequences.**
- Modelling is the lowest-priority tab and does not gate anything else.
- The tool remains useful for directional scenario work and unsuitable for legal-grade proceeds calculation. The on-screen caveat is what makes that distinction honest and must not be removed.
- If a real waterfall is wanted later, the prerequisite is a share-class table with liquidation terms per class — a data problem before it is a modelling problem.

---

## ADR-017 — The platform is management information, not the system of submission

**Status:** Accepted

**Context.** Mandate metrics are consumed by the board, the province and co-investors. The quarterly provincial report is prepared and submitted through an existing process. The open question was whether this platform becomes the system that produces that filing.

**Decision.** It does not. The platform is a management tool: it shows where things stand and gives an early read on what the quarterly provincial report will need to contain. The existing submission process is unchanged, and the platform's mandate figures are management information rather than filed numbers.

**Consequences.**
- Materially lowers the stakes on backfill imperfection. Partial coverage of round totals in older vintages (ADR-015) degrades a management view, not a regulatory filing.
- Removes the funding-agreement definitions diff from the critical path. It remains worth doing before anyone quotes platform figures externally, but it no longer blocks delivery.
- Mandate tiles should carry framing that matches their status. A figure captioned as management information invites a different level of challenge than one presented as a filed number, and that distinction should be visible on screen.
- Reversible in one direction only. If the platform later becomes the source for the filing, the definitions review becomes a hard prerequisite and the mandate coverage gaps become a real problem rather than a caveat.

---

## ADR-018 — Financial records are append-only; corrections are reversals or supersessions

**Status:** Accepted

**Context.** After launch, Finance maintains transactions, valuation marks and LP cashflows directly in the platform. The natural interface design — and the one proposed — is a table view with in-place editing behind a confirmation prompt. For a financial registry that is the wrong default. Editing a transaction in place makes every previously issued board report irreproducible, and it quietly breaks the "what did we report then" property that the frozen NAV snapshots in ADR-007 depend on. A confirmation dialog protects against accident; it does not protect against history changing underneath a published number.

**Decision.** Rows in `transaction`, `valuation_mark` and the LP cashflow set are **append-only**. A transaction entered in error is voided by a dated reversal that references the original. A mark is corrected by a new mark with `supersedes_id` set, the original moving to `superseded`. No original row is mutated or deleted, and there is no grace period during which editing is allowed — a same-session typo is corrected the same way as a two-year-old error.

Records that represent judgement rather than fact — health rating, risk flags, milestones, covenants, reserves, board seats, memos, diligence gates — remain editable in place, with `audit_log` capturing before and after.

**Consequences.**
- Any historical report can be reproduced exactly, because the rows behind it still exist as they were.
- The Finance interface needs a **Reverse** or **Correct** action on financial tables rather than an Edit button. Marginally more friction, deliberately placed.
- Table views default to live rows. Reversed and superseded rows remain visible on demand but stay out of the way, and the running totals shown to Finance are net of reversals.
- `transaction` gains `voided_by_transaction_id`, `voided_at` and `voided_reason`. `valuation_mark` already carries the supersession chain.
- Bulk-loaded historical batches are reversible wholesale by `batch_id`, which is what makes an imperfect first load safe to attempt.

---

## ADR-019 — Finance-supplied data lands in a staging layer, not in production tables

**Status:** Accepted

**Context.** Finance is producing three pools of historical data — transactions, valuation marks, and LP fund activity. The proposal was to have that data match the production SQL column definitions and load it directly. That asks Finance to own things they have no way to know: surrogate keys, foreign-key relationships, enum spellings, the convention that transaction amounts are always positive with direction implied by type, and the currency and FX columns.

**Decision.** Finance fills staging templates expressed in their own terms — company name, date, transaction type in plain language, amount, source document reference. A load pipeline resolves names to keys, validates against the production constraints, applies reconciliation gates, and only then writes. Rows that fail land in an exceptions report with a stated reason and are resubmitted, never force-loaded.

**Consequences.**
- **Entity resolution becomes an explicit first step with an owner.** A company crosswalk — Finance's spreadsheet name → Affinity organisation → internal `company_id` — is the first artifact produced, before any transaction loads. Finance names will not match Affinity exactly: legal versus trading names, companies renamed mid-life, entities acquired or restructured. This reconciliation is routinely the largest hidden cost in a migration of this kind, and it cannot be skipped by matching on name at load time.
- Load order follows dependency: company master → rounds → transactions → marks → LP positions → LP cashflows → ownership.
- Each batch carries a `batch_id`, must tie to Finance's own control totals before the next begins, and is reversible wholesale (ADR-018). Control totals are agreed up front — invested by year, realizations by year, NAV by valuation date, committed and called by LP position.
- Finance can iterate on their extract without a developer in the loop, which they will need to do more than once.
- The same templates and pipeline serve the interim bulk-upload path in ADR-011 phase 1, so none of this work is throwaway when the entry forms arrive.
- **Open question for Finance:** how far back do *per-company* valuation marks exist, as opposed to fund-level NAV? If early history is only fund-level, per-company MOIC and vintage analysis are not reconstructable for those years, and the platform should show that boundary rather than imply continuous coverage.

---

## Resolved open items

| Ref | Item | Resolution |
|---|---|---|
| O‑1 | Valuation effective date vs data cutoff | **Closed.** 31 Jan and 31 Jul are effective dates; results reach the board two to three months later. Reporting lag handled in ADR-007. |
| O‑2 | Whether the 31 March year end warrants a closer mark | **Closed.** Cadence is unchanged by this platform. Business as usual for Finance; the platform labels the carry-forward. |
| O‑3 | Diff funding-agreement definitions against the prototype | **Closed as a blocker.** The platform is not the system of submission (ADR-017). Worth doing before external quotation; no longer gating. |
| O‑6 | Historical availability of round totals and co-investor amounts | **Closed.** Extensive but imperfect, with histories exceeding fifteen years. Coverage tapers with age and is reported rather than imputed (ADR-015). |

## Decisions requiring the VC team lead

**Outstanding — still to be walked through with Daniel.**

| Ref | Decision | ADR | Why it needs him |
|---|---|---|---|
| D‑1 | Confirm the import contract may treat derived fields as advisory, correcting them against the transactions and returning a reconciliation warning | ADR-001 | His stated requirement was that the contract stay intact. This is the one place his workflow behaviour changes. |
| D‑6 | Confirm which quarter convention each screen should display, now that fiscal and calendar labels differ | ADR-006 | Presentation choice across every quarterly view. Both labels are correct; each screen must state which it uses. |

**Settled.**

| Ref | Decision | ADR | Resolution |
|---|---|---|---|
| D‑2 | How revenue is presented | ADR-013, ADR-014 | **Display as reported.** Visible's quarterly actual is stored and shown unchanged; no annualisation. Label moves from run-rate to quarterly revenue in the tile, the memo prefill and the guide. |
| D‑3 | FMV growth showing two flat quarters per year | ADR-007 | **Accepted**, with carry-forward labelled on screen. Cadence unchanged. |
| D‑4 | Deal-close capture of round total, NB co-investors and ownership | ADR-012 | **Accepted.** Deal lead completes the capture form at close; coverage monitored on the dashboard. |
| D‑5 | Diversity tile treatment of non-reporters | ADR-010 | **Accepted.** Non-reporters excluded from the denominator; coverage shown alongside the figure. NULL never renders as zero. |

## Actions in flight

| Ref | Action | Owner |
|---|---|---|
| A‑1 | Add women in C-suite and C-suite size to the Visible quarterly request | VC team |
| A‑2 | Open the historical backfill workstream: transactions, then rounds, then marks, then ownership | Systems & Data Analyst + Finance |
| A‑3 | Issue the staging templates to Finance and reconcile a first batch against agreed control totals | Systems & Data Analyst + Finance |
| A‑4 | Build the company crosswalk — Finance name → Affinity organisation → internal company_id — before any transaction loads | Systems & Data Analyst |
| A‑5 | Establish how far back *per-company* marks exist, as opposed to fund-level NAV only | Finance |
| A‑6 | Walk D‑1 and D‑6 through with the VC team lead | Systems & Data Analyst |
