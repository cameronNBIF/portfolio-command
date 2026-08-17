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
- **Accepted by the VC team lead (D-1).** Warning-and-correct on import is agreed, rather than the file being taken at its word.
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
- **Accepted by the VC team lead (D-6), with the split agreed:** fiscal labels on Reports and all board-facing output, since that is the calendar the board works to; calendar labels on the Portfolio drawer KPI history, since that is what Visible shows and what founders reported against. Every quarterly view states which convention it is using, so the difference reads as information rather than an error.

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

**Confirmed against the live data, 28–29 July 2026.** Profiling the NBIF Master list exports and a `field-value-changes` response settled the following:

- **One list, not two.** Pipeline and Portfolio are saved views of a single list (`listId 328745`) filtered by Status. A company keeps its identity across the whole journey. An earlier reading of the two exports as separate lists was wrong.
- **Affinity holds the full audit trail.** `GET /v2/lists/{listId}/list-entries/{listEntryId}/field-value-changes` returns every Status transition with changer and timestamp. Affinity is system of record for stage history; the platform keeps a local mirror (`affinity_field_change`) purely for query performance, because the endpoint is per-list-entry and a funnel chart would otherwise fan out to one call per deal.
- **Seed the funnel from field metadata, not observed data.** Observed ranks are 1, 3, 4, 5, 6, 7, 10 and 12; ranks 2, 8, 9 and 11 exist unobserved. A removed option (`Invested`) still appears in history as `referenceType: deleted-entity` with no `dropdownOptionId`, so the sync stores `displayValue` and tolerates the missing id.
- **Sector taxonomy is Affinity's, unchanged.** The eight provincial priority sectors plus Other. No sectors are invented to absorb the Other population; that language is what the mandate is framed in.
- **Risk Assessment drives health.** A / B / C map to green / yellow / red. Accelerator investments carry an `ACC` tag in place of a letter grade and no risk colour.
- **New Brunswick Region (NW/NE/SW/SE) is carried across** as `company.nb_region`, a mandate reporting dimension the prototype lacked.
- **Owners is multi-valued and accumulates.** The platform mirrors the full list. Owners governs pipeline stages; VC Lead governs portfolio.
- **Source of Deal carries through verbatim.** No normalisation — whatever the VC team enters is what the platform shows. Case-folding is applied for chart grouping only.
- **Website is the join key** across Affinity, Visible and Finance's records. It is populated on 80 of 80 portfolio rows and is namespace-independent. Note that the export's `Organization Id` and the v2 API's `entity.id` were observed in different numeric ranges and must not be assumed equivalent.
- **Affinity's FMV and Total Investment Amount are stored as reference only** and never enter a calculation (see ADR-020).

**Amended against API v2 itself, 12 August 2026.** A read-only probe of list 328745
(`npm run affinity:probe`, `functions/src/affinity/probe.ts`) settled three of the
items above, one of them against what this ADR previously said. Field-level detail
is in `docs/affinity-v2-field-map.csv`; endpoint mechanics in
`docs/affinity-v2-endpoints.md`.

- **The identifier namespaces are the same, and the earlier caution was wrong.**
  This ADR recorded that the export's `Organization Id` and the v2 `entity.id`
  "were observed in different numeric ranges and must not be assumed equivalent."
  They match on **162 of 162 rows** across both exports, and `Affinity Row ID` to
  `listEntry.id` on 162 of 162. The apparent two-order spread was age, not
  namespace: long-lived global organisation records carry low ids (Introhive
  1607682, Lastwall 1783269) and recently created ones carry high (307–313
  million). `company.affinity_org_id` is therefore a sound join key. **Website
  remains the crosswalk to Visible and to Finance**, which is a different claim
  and still holds.
- **`field-value-changes` is account-wide and filterable, so the stated reason
  for the mirror no longer holds — but the mirror stays.** This ADR justified
  `affinity_field_change` on the grounds that "the endpoint is per-list-entry and
  a funnel chart would otherwise fan out to one API call per deal."
  `GET /v2/field-value-changes?filter=field.id=…&filter=changedAt>…` returns
  changes across the whole account with full changer identity, making history
  backfill a handful of paginated calls and the nightly delta a single filter.
  The mirror is retained for local query performance, which was always the real
  purpose; only the cost argument was overtaken.
- **The list is 348 entries; the two exports show 162.** Pipeline and Portfolio
  are Status-filtered views, so Passed, Watchlist, Exited and Intake appear in
  neither. **The sync reads the whole list and derives membership from Status**
  rather than reading the two views — a company graduating between nightly runs
  is then a Status change rather than a disappearance from one view and an
  arrival in the other, which is what "one list, not two" means operationally.
  It also makes funnel conversion and drop-off measurable, which the survivors
  alone cannot support.
- **Seeding the funnel from metadata is now a real endpoint, and the unobserved
  ranks were real.** `GET /v2/lists/{listId}/fields/{fieldId}/dropdown-options`
  returns `id`, `text`, `rank` and `color`. Status has all **16** options at ranks
  1–16, including the four this ADR predicted existed unobserved — Intake (2),
  Conditional Approval (8), Approved (9) and Closed (11). `rank` is carried only
  by `ranked-dropdown`; plain and multi dropdowns are unordered.
- **Affinity date fields are confirmed anchored to US Pacific midnight.**
  `Deal Flow Stage Changed` returns `2026-08-11T07:00:00Z`. Pin the timezone on
  extraction or every such date lands a day early for everyone here.
- **People are identified by NAME and by Affinity's Person entity id, never by
  email.** Affinity merges Person entities, so a primary address is not reliably
  the person's `@nbif.ca` one — and keying on it split single people in two
  (`kyle.woods@nbif.ca` and `kyle.woods@creativedestructionlab.com` are one
  person, as are two Jaime Christian addresses). `pipeline_deal_owner` keys on
  the Person entity id, which survives both merging and a rename; `app_user`
  resolution matches `display_name`; the deal-team labels store names. The
  platform is an internal tool for a team who recognise each other by name
  (decision, 12 Aug 2026). Company CEO addresses are unaffected — those are real
  external contacts, not internal Affinity Person entities.
- **Two dropdown vocabularies carry an option whose label is another option's
  id** — Priority Sector id 24621946 labelled `22542067` (the Cybersecurity
  option's id), and Venture Stage id 24621953 labelled `24615561`. Being fixed
  in Affinity, which is where a system-of-record correction belongs; the sync
  carries labels verbatim and does not special-case them (decision, 12 Aug 2026).

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
- **Accelerator investments are included in fund-wide figures (decision, 29 July 2026).** MOIC, leverage and FMV growth are computed across the whole portfolio, accelerator positions included. Where those figures appear on the dashboard a toggle keyed on the `ACC` tag lets the reader exclude them. The default is inclusive; the metric functions take an `includeAccelerator` option so the toggle changes one argument rather than forking the definition.
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
- **Backfill gates launch, not development (revised — see ADR-020).** The application is built against synthetic financial data and does not wait on Finance. The dependency has not disappeared, it has moved: a finished application that cannot go live is still a stalled programme, so Track B must keep moving even though nothing is waiting on it day to day.
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

**Status:** Superseded by ADR-031 (17 August 2026). The reproducibility requirement below survives intact and is the constraint ADR-031 had to satisfy by another mechanism; the append-only interface does not. The judgement/financial split this ADR draws is unchanged and still governs `packages/api/src/write/judgement.ts`.

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

## ADR-020 — Development proceeds on synthetic financial data; real data is a cutover event

**Status:** Accepted. **Condition 3 withdrawn 14 August 2026** — see the amendment at the end.

**Context.** Finance is assembling fifteen-plus years of transactions, valuation marks and LP activity from spreadsheets and closing documents. That work is measured in months and is not under the development team's control. Sequencing the build behind it would idle the only developer available, at a point when development capacity exceeds Finance's extraction capacity.

Meanwhile Affinity and Visible.vc are live, disciplined and API-accessible today. Company identity, pipeline and quarterly KPIs can be real from early in the build. Only the financial spine — transactions, marks, rounds, ownership, LP cashflows — is missing.

**Decision.** The platform is built and tested end to end against a **generated financial dataset attached to real companies pulled from Affinity**. Every feature, including the Finance entry interfaces, alerts, memo builder, reporting and modelling, is completed to production standard against that data. Real financial history is loaded once, as a designed cutover phase, immediately before go-live.

Four conditions attach to this decision, and it is not sound without them.

1. **The synthetic data is dirty on purpose.** Data generated cleanly from Affinity is by construction perfectly resolvable, which is precisely what real data will not be. The generator deliberately produces orphan transactions, unresolvable company names, rounds with missing totals at a rate matching what Finance expects for old vintages, a renamed company, a duplicate, a mark predating its first investment, a non-CAD transaction, and a company reporting no KPIs. Exception handling is built against dirt, not against the happy path.
2. **Every synthetic row is flagged and every environment says so.** `is_synthetic` is set on `transaction`, `valuation_mark`, `investment_round`, `fund_investment_nav` and `company_ownership`. The application reads `v_synthetic_data_status` at start and displays a persistent, unmissable banner on every screen and every PDF export while synthetic rows exist. In a small organisation, a plausible-looking NAV on a screen someone walks past becomes a number in a conversation.
3. ~~**A small real sample arrives early, not with the full backfill.**~~ **Withdrawn 14 August 2026.** Five to ten companies with complete real history were to be requested from Finance during the synthetic-data phase, to discover whether the schema actually fits how Finance holds the data. See the amendment below for what replaced it and what was given up.
4. **The Finance entry interfaces are walked through with the Director of Finance before they are built,** using the synthetic dataset. Building an entry workflow entirely without its user, on the strength of a schema, is how you reach cutover with something correct and unusable.

**Consequences.**
- Development is unblocked from Finance's timeline, which was the largest schedule risk in the programme.
- Synthetic data can be made harder than real data — deliberately adversarial volumes, distributions and edge cases — which makes it a better test bed than a partial real load would be.
- The frontend can be ported against a static seed fixture before any backend exists, because ADR-001 makes the export contract and the API response the same shape. The fixture *is* the contract.
- **Cutover becomes a designed phase carrying real risk**, rather than a configuration change. It requires reconciliation against Finance's control totals, verified removal of every synthetic row, and a parallel run against the prototype for one reporting cycle.
- Condition 3 was written as the load-bearing one, on the reasoning that without a real sample a mismatch between the schema and how Finance actually holds transactions — granularity, aggregation, missing early years, fund-level-only marks — surfaces at cutover, after everything has been built on the assumption. **That reasoning still stands and the risk is now accepted rather than mitigated** (amendment, 14 August 2026).
- **The generator is calibrated to Affinity's real figures (decision, 29 July 2026).** Affinity holds a VC-team-maintained FMV and Total Investment Amount for every portfolio company. These are *not* used as metric inputs — the metrics are ratios across fields, and mixing a real FMV with a synthetic invested cost produces a MOIC that is neither real nor coherent. Instead the generator works backward from them as targets, so synthetic rounds sum to roughly the real invested amount and synthetic marks land near the real FMV. Company-level figures land in the right ballpark, making a pilot with the VC team lead meaningful, while the dataset stays internally consistent and flagged synthetic throughout.
- **Affinity's figures are additionally stored as labelled reference columns** (`company.affinity_fmv`, `company.affinity_total_investment`), displayed in the company drawer as VC-team-maintained values and never entering a calculation. Post-launch they become a standing reconciliation signal between the two systems. The change log justifies the caution: one deal's Potential Investment Amount ran 1,000,000 → 500,000 → deleted → 1,000,000 → 1,500 → 1,500,000, the fat-finger corrected 33 seconds later. Accurate enough to steer by, not to calculate from.
- The metrics golden-master fixtures remain derived from Daniel's demo dataset (ADR-013), not from the synthetic financial data. They test different things: one that the port is faithful, the other that the application survives realistic volume and mess.

**Amendment, 14 August 2026 — condition 3 is withdrawn, and the real load becomes a named phase.**

Condition 3 required a 5–10 company real sample during the synthetic-data phase. It is withdrawn at the VC team lead's direction, and the reasoning is worth recording because the risk it covered has not gone anywhere.

**What changed the calculus.** A6 delivered something the condition did not anticipate. The synthetic spine is not merely attached to real company ids — it **reconciles to Affinity's own per-company `Total Investment Amount` and FMV exactly, to the cent, asserted for all 82 companies before the generator will commit** (ADR-030). The platform therefore already shows the VC team lead numbers he knows by heart, on his own portfolio, through every screen. That demonstrability was most of what the sample was really being asked to buy, and it arrived without occupying a day of Finance's time.

**What the sample was ALSO buying, and is no longer.** Early warning on schema fit. A granularity mismatch — Finance holding one aggregated row per company per year where the schema wants a transaction, or fund-level NAV where it wants per-company marks — now surfaces during the port itself rather than months ahead of it. **That is a real cost and it is accepted, not solved.** Three things reduce it, none of which eliminate it:
  - the load path is built and exercised against deliberately dirty synthetic data (condition 1), so the exception handling exists before the first real row;
  - `batch_id` rollback is proven before the first real batch rather than discovered after a bad one (ADR-018);
  - batches reconcile to Finance's control totals one at a time, so a mismatch shows up on batch one instead of after the whole extract is in.

**And the real load is now a phase with a name.** The roadmap splits cutover into **A13 · Financial history port** and **A14 · Go-live**. A13 is the single operation in which all of Finance's history — transactions, rounds, marks, LP cashflows, NAV, ownership — is loaded, reconciled and the synthetic dataset removed. **After A13 the platform is the system of record for financial data and there is no second import**: Affinity remains authoritative for company identity and pipeline and Visible for company-reported KPIs, both syncing nightly, while every new transaction, mark, round and LP cashflow is entered through the A7 and A8 interfaces. That is why those interfaces are built before the port rather than after it, and why the A6 generator is retired as part of A13 rather than left in a repository that now touches real money.

---

## ADR-021 — The metrics package's input contract and unit boundary

**Status:** Accepted

**Context.** A1 ports the prototype's metric functions into `packages/metrics`. Those functions must be handed something to compute over, and three shapes are available.

The generated database types (`packages/db/src/generated/db.ts`) carry `numeric` as **string** — a property deliberately kept at A0.1 so money cannot silently become a float — plus nullable columns throughout, snake_case names, surrogate integer keys, and amounts in dollars. The views in `schema.sql` sit closer to what a metric needs but are still dollars-and-strings and still shaped by storage concerns. The ADR-001 export contract is denormalised, camelCase, `$M`, plain numbers, and is precisely the tree the prototype's functions already read.

That third option is not merely convenient. ADR-013 freezes the definitions at the prototype's implementations, and the A1 golden-master tests assert the port reproduces them over `docs/reference/demo.json` — which *is* a contract-shaped document. A port that took database rows would need an adapter inside its own test harness before it could be compared against the prototype at all, and that adapter would be untested code standing between the thing under test and the thing it is tested against.

There is also a units question. ADR-008 stores money as `numeric(18,2)` in dollars; ADR-001 emits `$M` in the contract and places the conversion in the API layer, in exactly one place. A metrics package taking dollars would become a second such place, and every golden-master fixture would sit on the far side of a conversion the prototype never performed.

ADR-023 constrains the shape further. `v_round_leverage` applies `where round_total >= our_invested` in SQL, but that predicate *is* the leverage definition, frozen under ADR-013 and owned by TypeScript. A contract that delivered pre-filtered rounds would make the metrics package structurally incapable of reproducing the prototype, because the rows it would need to exclude would already be gone.

Finally, purity. `fundMetrics`, `fiMetrics` and `fiIrr` each call `new Date()` to date the terminal NAV in their IRR cashflow series. This is an undeclared input. Two consecutive calls on identical data return different numbers — measurably so — and the figure drifts roughly one percentage point per quarter with no data change at all. A function that reads the clock cannot be golden-mastered, and a board number that moves on its own cannot be reconciled.

**Decision.**

Metric functions take the **ADR-001 contract shape** as input: denormalised, camelCase, money in `$M` as plain `number`, percentages as plain numbers (11.2 = 11.2%), dates as `YYYY-MM-DD` strings. They never receive a database row type, never receive `numeric`-as-string, and never receive dollars.

The contract types move into a new workspace package, **`packages/contract`** — TypeScript types and nothing else. No runtime code, no I/O, no dependencies. It is imported by `packages/metrics`, by `apps/web` and by the API layer at A3. `docs/reference/demo.json` type-checks against it, which is what makes the fixture and the contract one artefact rather than two that must be kept in step.

**A3 owns an adapter** from view rows to contract objects. It is the single place where dollars become `$M`, `numeric` strings become numbers, and NULL becomes `null` or a documented default. Nothing downstream of it converts anything. This is the same "exactly one place" that ADR-001 already asserts; ADR-021 names where it lives.

**The contract carries rounds unfiltered.** Every round appears with `invested`, `roundTotal` and `nbOther` exactly as stored, including rounds whose `roundTotal` is null or below `invested`. The metrics package applies the exclusion predicate itself. This is the direct consequence of ADR-023: the leverage definition is expressed once, in TypeScript, under test.

**Metric functions are pure in the strict sense** — same input, same output, no ambient reads. Specifically:

- No metric function reads the clock. Where the prototype calls `new Date()`, the port takes a **required** `asOf` (a `YYYY-MM-DD` date) and constructs the terminal cashflow from it. There is no default, because a default would let a caller silently receive "today", which is the failure mode being removed.
- No metric function reads a global. Where the prototype reads `DB` or `DB.fund`, the port takes an explicit parameter: `fundMetrics(db, { asOf, includeAccelerator })` rather than `fundMetrics()`.
- `includeAccelerator` (ADR-013, 29 July 2026) is an option on the same function, never a fork of the definition.

**Consequences.**

- The golden-master comparison is direct. The prototype reads `demo.json`; the port reads `demo.json`; nothing sits between them. This is the property that makes ADR-013's guarantee testable rather than aspirational.
- **`asOf` is the sole departure from a literally verbatim port, and it is a change of signature, not of definition.** Given the same date the arithmetic is identical to the prototype's, character for character. It is taken because the alternative — freezing the clock inside the test harness while the production function still reads `new Date()` — would leave a board number changing daily in production while a green test asserted it was frozen. ADR-013 protects definitions; it does not require preserving an undeclared input.
- **The fixtures pin `asOf = 2026-03-31`**, the effective date of every valuation mark in `demo.json` and the end of its last `navHistory` quarter. Any other date makes the terminal NAV inconsistent with the marks behind it. Gross IRR reads 18.98% at that date against 17.55% at the time of writing — but the latter was never a value the prototype would reproduce the following day, so nothing reproducible has changed.
- In production, `asOf` comes from the same place the report's as-at date comes from, which makes the reporting-lag stamp in ADR-007 and the IRR terminal date the same fact rather than two that can silently disagree.
- `packages/contract` is a fourth workspace package. The cost is one `package.json` and one `tsconfig.json`. The benefit is that `apps/web` at A2 imports the same types the API will satisfy at A3, so the fixture-to-API swap is a change of data source and not of types.
- Kysely's `numeric`-as-string never leaves the data layer, so the property that protects money from float arithmetic is preserved where it matters — in storage and in the adapter — without forcing every metric function to parse strings.
- The metrics package acquires no dependency on `packages/db`. It can be typechecked, tested and reasoned about with no database and no generated types present, which is the whole point of ADR-003's "one person's working memory".
- **The residual risk is adapter drift.** The adapter at A3 is the one component that can produce a well-typed contract object holding wrong numbers, and no golden-master test covers it — the fixtures start at the contract, not at the database. A3 needs its own reconciliation test: build the contract from a seeded database, and assert the aggregates match what the same rows sum to directly.

---

## ADR-022 — Golden-master methodology

**Status:** Accepted

**Context.** ADR-013 freezes metric definitions at the prototype's implementations and names golden-master tests as the mechanism. The mechanism itself has not been specified, and several of the choices are load-bearing enough that making them implicitly would undermine the guarantee.

The prototype is a single HTML file of roughly 1,700 lines with one inline `<script>` block. Its metric functions are pure-ish but reach for `document`, `Chart` and `localStorage` at load, and the module-level `DB` is a `let` binding rather than a global property. Its outputs are consumed on screen as formatted strings, not as floats — a change that alters `2.0787898936170217` without altering `"2.08x"` is invisible to the board, and a change that alters `"$1.09B"` to `"$1092.1M"` is visible to the board while leaving the float untouched. Freezing only one of the two freezes the wrong half.

`docs/reference/demo.json` was replaced this phase with a full export from the prototype. It is byte-identical to the prototype's boot state — verified — which means it is not an arbitrary sample but the canonical demo dataset, reproducible from the committed HTML.

**Decision.**

**The prototype's script is extracted from the committed HTML at test time and never vendored.** The harness reads `docs/reference/vc-toolkit.html`, pulls the single inline `<script>` block, and evaluates it in a `node:vm` context with `document`, `Chart`, `localStorage`, `requestAnimationFrame` and `getComputedStyle` stubbed. No copy of the prototype's JavaScript is committed anywhere in the repository. This mirrors `packages/db/test/migration-parity.test.ts`, which reads `docs/schema.sql` directly rather than trusting a copy: in both cases the reference document is the thing under test, and a stale duplicate is the failure mode being designed out.

Two mechanical consequences follow and are recorded here because both are easy to get wrong once and never notice:

- Top-level `let`/`const` bindings — `DB`, `fmt`, `PF`, `MODEL` — do not become properties of the vm context. The harness appends a short epilogue **inside the same lexical scope** exporting the bindings it needs, including an accessor pair for `DB`. This epilogue is harness code, and it is the only text ever appended to the prototype's source.
- The demo generator's `mulberry32(42)` is a module-level singleton whose stream is consumed at boot by `loadDB()`. Calling `freshDB()` a second time in the same context yields *different* companies. The harness loads the prototype once per run and never calls `freshDB()`.

**The fixture input is `docs/reference/demo.json`, and it is frozen.** Fixtures are captured against the committed file. Re-exporting it from the prototype invalidates every fixture at once, so it is treated as a frozen artefact: it changes only by deliberate decision, and that decision is a full fixture recapture and a line in `BUILD-LOG.md`. To make an accidental drift loud rather than quiet, the harness asserts that `demo.json` still equals the prototype's boot state before capturing anything.

**Fixtures capture both full-precision values and formatted display strings.** Every metric is frozen twice: the raw float, and the string the board actually reads, produced by the prototype's own `fmt.m`, `fmt.x`, `fmt.pct` and `fmt.pct0`. Display strings are asserted **exactly**. Floats are asserted to **1e-12 relative** tolerance, which is loose enough to survive a reassociated sum and tight enough that no change a person would call a change survives it.

**`fundMetrics` ports as one function returning the same field bag.** Its thirty-one outputs share intermediates — `paidIn` feeds three multiples, `roundsTotal` and `oursInRounds` feed leverage and `capitalAttracted` — and splitting them into independent functions would recompute those intermediates in ways that are individually defensible and collectively a different implementation. Named selectors (`leverage(m)`, `fmvGrowth(m)`) are layered **on top of** the returned bag, so the ergonomics improve without the arithmetic forking. The same applies to `fiMetrics`.

**`includeAccelerator: true` is the only golden-mastered path.** The prototype has no ACC concept, so it can only ever produce the inclusive figure; a fixture for the exclusive path would be a fixture for something the prototype never computed. The exclusion path gets ordinary unit tests with hand-constructed inputs, asserting that excluding an ACC-tagged company removes exactly its contribution and nothing else.

**`meta.savedAt` is normalised out of the ADR-001 contract snapshot.** It is a wall-clock stamp written by `saveDB()`; it is `null` in the committed export only because that export was taken from an unsaved session. Leaving it in the snapshot would make a future re-export fail the build for a reason that has nothing to do with the contract. The snapshot asserts `schemaVersion`, field names, nesting and units; `savedAt` is replaced with a sentinel before comparison.

**The harness fails loudly or not at all.** If the prototype throws, if a metric returns `undefined` where the fixture expects a number, or if the `demo.json` identity check fails, the harness exits non-zero and writes **no** fixture file. A partially written fixture set is worse than none: it freezes the subset that happened to succeed and silently drops the rest.

**Consequences.**

- Editing `vc-toolkit.html` breaks the golden-master run immediately, which is correct — it is the reference document, not a build input, and it should not be edited at all.
- Capturing display strings catches a whole class of change the floats do not. `fmt.m` switches from `"M"` to `"B"` at an absolute value of 1000, and `roundsTotal` on this fixture is 1092.1 — so the `"B"` branch is exercised, and a refactor that dropped it would fail.
- Asserting floats at 1e-12 relative rather than exact equality is a deliberate loosening. Exact bit equality would make the tests hostage to summation order, and reordering a `reduce` is not a change to a board number. Anything that survives 1e-12 and matters will also change the display string.
- **A pinned `asOf` (ADR-021) is part of the fixture, recorded in its header.** Without it the IRR fixtures could not be written at all: two consecutive calls to `fundMetrics()` on identical data currently return different values.
- The fixture file carries a header stating what it was captured from — the `demo.json` sha-256, the prototype's sha-256, the pinned `asOf` — and, explicitly, **which metrics it does not meaningfully exercise**. The demo dataset does not exercise every path: no round fails the leverage predicate, no diversity field is null, and only seven companies of sixty-four carry the two KPI periods that same-store growth requires. A fixture that freezes a trivial or null result is not a golden master, and the header is what stops a reader mistaking one for the other.
- Paths the fixture cannot reach are covered by conventional unit tests with constructed inputs, and those tests are held to the same standard: they assert the prototype's rule, not a rule that seems reasonable.
- `runScenario` returns a closure (`proceedsAt`) inside its result bag. The fixture captures it as a sampled series at fixed exit values rather than dropping it, since it is the function the waterfall chart is drawn from.
- **This methodology tests fidelity, not correctness.** A golden-master suite passing means the port reproduces the prototype, including its mistakes. The mistakes are inventoried separately in `packages/metrics/INHERITED-COERCIONS.md` (ADR-013), and that file is where a future correctness review starts. Passing tests are not evidence that a number is right.

---

## ADR-023 — Views aggregate facts; the metrics package computes ratios

**Status:** Accepted

**Context.** ADR-002 settled that derived values are never *stored*. It did not
settle where they are *computed*, and the schema has quietly answered that
question twice. `v_lp_position_current` computes `tvpi` and `dpi` in SQL;
`fiMetrics` computes the same two figures in JavaScript. `v_round_leverage`
carries `capital_attracted`, `nb_capital` and `outside_capital`, and applies the
round-exclusion predicate that ADR-013 freezes as part of the leverage
definition; `fundMetrics` applies its own. These are independent implementations
of the same board numbers — the exact failure mode ADR-002 was written to
prevent, relocated from two columns to two languages.

The golden-master tests built in A1 guard the TypeScript implementations only. A
SQL implementation that no test covers, serving values the frontend renders, is
strictly worse than no second implementation at all: it fails silently, and the
build stays green.

**Decision.** A view may **aggregate facts**. It may sum, count, filter to live
rows, pick the latest row by date, and join. It may produce `invested`,
`realized`, `called`, `distributions`, `nav`, `round_total`, `our_invested`,
`fte`, and any other quantity that is a sum of stored rows.

A view may **not compute a metric**. MOIC, TVPI, DPI, RVPI, IRR, leverage,
FMV growth, same-store revenue growth, ownership-weighted figures, suggested
reserve and every scenario output belong to `packages/metrics` and nowhere else.

The practical test is a ratio: **if the expression divides one aggregate by
another, or compares one period to another, it belongs in TypeScript.**

Two carve-outs, both narrow:

1. **Operational and diagnostic views** that never feed the ADR-001 contract are
   exempt. `v_mandate_completeness` reports coverage for internal monitoring, not
   a board figure, and may stay as it is.
2. **Period-labelling functions** (fiscal and calendar quarter derivation per
   ADR-006) are formatting, not metrics, and stay in SQL where the dates live.

**Consequences.**

- **`v_lp_position_current.tvpi` and `.dpi` become convenience-only.** They are
  never serialised into the contract and never read by the API. A SQL comment on
  each states this explicitly. They are candidates for removal, but are retained
  for now because Finance's ad-hoc reconciliation queries are the one legitimate
  consumer. Note that `create or replace view` cannot drop a column: removal
  requires `drop view ... cascade` and a recreate in a forward migration.
- **`v_round_leverage` is convenience-only for the same reason**, and carries a
  subtler cost. Its `where r.round_total >= ours.our_invested` predicate *is* the
  leverage definition, frozen under ADR-013. Since the metrics package must apply
  that predicate itself to reproduce the prototype exactly, the contract has to
  deliver rounds **unfiltered**, with `roundTotal` and `invested` per round, and
  let TypeScript do the excluding. The prototype's rule — a round with a missing
  or invalid total is dropped, never imputed (ADR-012) — is therefore expressed
  once, in one language, under test.
- **A3's read path is: views assemble aggregates → the API layer converts dollars
  to $M and assembles contract objects → the metrics package computes.** Nothing
  is computed in a React component (ADR-003) and nothing is computed twice.
- **The cost is arithmetic moving from Postgres to Node.** At roughly 70
  companies and a few thousand transactions this is irrelevant. If it ever stops
  being irrelevant, the answer is caching the contract payload, not pushing
  definitions back into SQL.
- **Review heuristic, deliberately crude:** a `/` operator in a view definition is
  a smell. Not every instance is a violation, but every instance deserves a look
  before the migration merges.
- **The residual risk is external consumers.** Anyone pointing Power BI or a
  spreadsheet at `v_lp_position_current.dpi` gets a figure the platform itself
  does not use. The SQL comments are the mitigation; the real fix is deleting the
  columns once Finance's reconciliation queries have moved to the API.

---

## ADR-024 — Reframe the golden master as a change ledger

**Status:** Rejected, 11 August 2026. Recorded here so the number is not reused
and the reasoning is not re-derived.

It would have permitted accepted divergences from the prototype where its
behaviour is an implementation accident rather than a validated definition. Ten
candidate repairs were measured against `demo.json`: eight were provably
zero-impact, two moved board numbers by 0.30% and 0.15%. The decision was to
continue the verbatim port, because A4/A5/A6 — real Affinity data, real Visible
KPIs, a synthetic financial dataset — is the point at which it becomes possible
to tell which coercions actually matter rather than guessing. The measurements
are preserved in `packages/metrics/INHERITED-COERCIONS.md` so the work is not
repeated. See BUILD-LOG.md, 2026-08-11.

---

## ADR-025 — Fund-level distributions remain a stored series; the ADR-002 correction is deferred

**Status:** Accepted

**Context.** ADR-002 states that transactions are the only stored financial
facts, and names this divergence explicitly as the thing it resolves: the
prototype holds realizations twice, with `fund.distributions[]` driving fund
TVPI and DPI while `company.realized` drives company MOIC. ADR-013 freezes the
metric definitions at the prototype's implementations, and A1's golden-master
fixtures assert them. A3 is where the two meet, and on this dataset they cannot
both hold.

The gap on `demo.json` is $5.5M, and it decomposes exactly:

| | |
|---|---|
| Cobalt Harbor $4.0M, Solvine $27.5M | present in **both** representations |
| Nimbus Grid $6.9M, Quorum Capital OS $6.5M, Greyline Data $8.1M = **$21.5M** | company-level **only** |
| two "Generated exits" aggregate rows = **$16.0M** | fund-level **only** |

$21.5M − $16.0M = $5.5M. The prototype's demo generator itemised three exits per
company and then wrote two aggregate rows at fund level covering the same events,
rather than the same three. The divergence is an artifact of how the fixture was
generated, not a definition anyone validated.

Deriving `fund.distributions[]` from realization transactions, as ADR-002
requires, was measured against the frozen fixtures. Five board numbers move, and
all five move visibly in the display string, not merely in the float:

| Figure | Frozen (A1) | ADR-002-derived |
|---|---|---|
| TVPI | 2.08x | 2.10x |
| DPI | 0.16x | 0.18x |
| Gross IRR | 19.0% | 19.1% |
| Net IRR | 16.7% | 16.8% |
| Dry powder | $146.7M | $152.2M |

There is also a structural obstacle independent of the arithmetic.
`transaction`'s `txn_one_subject` constraint requires every row to carry either a
`company_id` or a `fund_investment_id`. Two of the four fixture distributions can
satisfy neither: `"Generated exits"` is an aggregate with no company, and
`"Solvine"` does not match the roster's `"Solvine (exited)"`. The transaction
registry as designed has nowhere to put a fund-level realization that is not
attributable to a current portfolio company — which is a real gap for historical
data too, not only for this fixture.

**Decision.** For A3, `fund.distributions[]` is served from a stored
`fund_distribution` table and the frozen values survive unchanged. The
correction ADR-002 calls for is **deferred to A6/A13**, when real data makes it
possible to tell whether the divergence is a generator artifact or a real
property of how realizations are recorded.

The table is deliberately a separate object rather than a nullable-subject
`transaction` row. An exception that is greppable is an exception that gets
removed; one hidden as a nullable column is one that quietly becomes permanent.
Its SQL comment names this ADR.

**Consequences.**

- **A3 keeps its strongest available test.** With every board number identical
  either side of the storage swap, any figure that moves during A3 is an adapter
  bug rather than an intended change. Deriving now would forfeit exactly the
  signal the phase exists to produce, at the one moment the adapter is least
  proven. This is the primary reason for the decision.
- **`company.realized` and `fund.distributions[]` are never summed together**,
  and nothing in the contract invites it. Each drives its own frozen metric, as
  the prototype does. The double-representation ADR-002 objects to is preserved
  under a stated exception with a stated end date, not resolved.
- The precedent is ADR-024's rejection, and the reasoning is the same one: a
  correction made against synthetic data is a guess, and A4/A5/A6 is when
  guessing stops being necessary.
- **This is a known unpaid debt, not a settled position.** ADR-002 remains the
  standing rule. When the correction lands it will move published board numbers,
  so it needs the VC team lead's sign-off and a golden-master recapture — which
  is precisely why it should happen once, on real data, rather than twice.
- The schema gains the place a fund-level realization can live, which historical
  backfill (ADR-015) is likely to need regardless of how this resolves: fifteen
  years of history will contain realizations from companies that predate the
  roster.

---

## ADR-026 — The importer preserves contract strings verbatim and resolves reference keys opportunistically

**Status:** Accepted

**Context.** ADR-001 freezes the export contract field for field, which means
whatever goes in must come back out unchanged. The storage model underneath
normalises to controlled vocabularies with foreign keys. Loading the reference
fixture through that model surfaced the collision between the two, in six
places at once:

- **Sectors.** The fixture carries ten generic values — `AI / ML Infra`,
  `Enterprise SaaS`, `Defense & Space`. `ref_sector` holds the nine real Affinity
  provincial priority sectors — `ICT`, `Digital Health`, `Agritech`, `Oceans`.
  They overlap on `Cybersecurity` and nothing else.
- **Valuation methods.** `ref_valuation_method` holds the six canonical methods.
  The fixture's marks carry fourteen free-text variants — `Revenue multiple,
  discounted`, `Last round + backlog coverage`, `Scenario-weighted (PWERM)`.
- **Source channels.** Eight generic fixture values against fourteen seeded
  Affinity channels, overlapping on none.
- **Pipeline sources**, which are free text with parentheticals: `Founder
  referral (Northline CEO)`, `Conference (Compute Summit)`.
- **Exit types.** The fixture carries `Strategic acquisition`; the `company_exit`
  CHECK constraint permits only `Acquisition`, `IPO`, `Secondary`,
  `Shutdown / write-off`.
- **Covenant statuses**, which are free text carrying their own explanation:
  `breached - waiver signed 2026-05`, `watch - 1.9x in Q1`.

Three responses were available. Normalising to the nearest reference value
loses information the contract must return, so the export would no longer
reproduce its input. Inserting the fixture's vocabulary into the reference
tables keeps the round trip but pollutes the Affinity taxonomy that ADR-009
makes Affinity the system of record for, and leaves A4 arriving into a table it
has to clean before it can populate. Widening every CHECK constraint to
free text discards the validation that makes the constraints worth having.

**Decision.** Where a contract field is free text over a normalised column, the
importer stores **both**: the verbatim string, and a resolved reference key
where — and only where — an exact match exists. The adapter serialises the
verbatim string. The reference key is what queries, groups and filters.

No importer invents a reference row, and no importer coerces a value to its
nearest neighbour. An unresolvable value leaves the key null, is counted, and is
named in the import's reconciliation report alongside the D-1 derived-field
warnings.

**Consequences.**

- **The contract round-trips exactly**, which is what makes A3's verification a
  real test rather than an assertion that the adapter agrees with itself.
- **The Affinity taxonomy stays clean**, so A4 is a clean overwrite rather than a
  cleanup. This matters more than it looks: the fixture roster is temporary, and
  every fixture value written into `ref_sector` would have to be found and
  removed later by someone who no longer remembers it was put there.
- **Unresolved keys are visible rather than silent.** A null `sector_id` across
  the whole fixture roster is the correct and informative state — it says the
  demo roster is not the Affinity roster, which is true.
- The cost is one extra column on six tables and a slightly wider `company` row.
  Against roughly 70 companies this is not a consideration.
- **The verbatim columns are not permanent fixtures of the schema.** Once the
  roster is real and its vocabulary is Affinity's, most will hold values
  identical to their resolved reference row. They become redundant at that point
  and are candidates for removal — but only for values Affinity actually governs.
  Covenant status and pipeline source are free text at source and stay that way.
- Widening the `company_exit` and `company_covenant` CHECK constraints is
  handled separately and narrowly: `Strategic acquisition` joins the exit-type
  vocabulary because it is a genuine exit type the original list omitted, while
  covenant status keeps its three-value constraint and gains a verbatim detail
  column, because `breached - waiver signed 2026-05` is a status plus a
  narrative and the schema should hold them apart.

---

## ADR-027 — Four fields in ADR-002's derived inventory are independent facts and are stored

**Status:** Accepted. **Amends ADR-002.**

**Context.** ADR-002 lists eighteen fields as Derived and states they must not be
stored. A3 is the first phase that has to actually produce all eighteen from
storage, and four of them cannot be produced, because the values in the contract
are not a function of anything else in it. This was established by measurement
against `docs/reference/demo.json`, not by inspection:

| Field | ADR-002 says | What the data shows |
|---|---|---|
| `reservesDeployed` | Derived | Disagrees with any round sum on 4 of 70 companies. C001 reads $1.5M against a $3.5M follow-on round; C004 reads $6.0M against $8.0M of follow-ons. |
| `kpis[].runwayMo` | Derived | `cash / burn` reproduces it on **10 of 71** KPI rows. C004 reports 99 months against a computed 610. |
| `fteAtEntry` | Derived | The KPI series covers 2025-Q3 to 2026-Q1. Every entry headcount predates it, by up to a decade for old vintages. |
| `company.instrument` | Derived | C009 reads `Debt-to-Note` while its latest round is `Preferred Equity`, so it is neither the first nor the last round's instrument. |

The distinction that matters is the one ADR-002's own prohibition is phrased
around — *"if you find yourself adding a column that duplicates a sum, stop."*
None of these four duplicates a sum. Each is an independent fact that the
inventory classified as derived on the reasonable-looking assumption that a
derivation existed. `invested`, `fmv`, `realized`, `called`, `distributions`,
`capitalToDirect` and the rest genuinely are sums, and remain derived.

Each of the four also has a reason to be independent that survives the arrival
of real data, which is what distinguishes an inventory error from fixture dirt:

- **`runwayMo` is company-reported.** Visible collects months of runway as a KPI.
  A founder nets committed-but-undrawn capital and expected inflows against
  burn; the platform is not the system of submission (ADR-017) and does not get
  to overrule the submitter. It also drives the runway health alert, so
  substituting a computed figure would change which companies appear on the
  watchlist.
- **`reservesDeployed` is an investment-team decision.** A follow-on can be
  funded from a fresh allocation rather than the reserve, and a reserve can be
  released without ever being deployed.
- **`fteAtEntry` is a point-in-time snapshot** taken before quarterly reporting
  existed for that company. No future KPI arrival makes it reconstructable.
- **`company.instrument` is the headline instrument**, a characterisation of the
  position rather than a mechanical read of one round.

**Decision.** The four are stored: `reserve_allocation.deployed`,
`company_kpi.runway_months`, `company.fte_at_entry`, and `company.instrument_id`
with its ADR-026 verbatim label. ADR-002's derived inventory is reduced from
eighteen fields to fourteen. Everything else in it stays derived, and the
prohibition stands unchanged in substance: **a column that duplicates a sum is
still forbidden.**

**A separate and narrower case: three LP fields are *carried*, not reclassified.**
`coInvestsDone`, `referrals` and `capitalToDirect` are genuinely derivable —
`v_lp_capital_to_direct` already derives all three from `round_coinvestor`. But
that table is populated by the ADR-012 deal-close capture form, which arrives at
A8, and the ADR-001 contract carries no co-investor detail to reconstruct it
from. For an imported legacy position the carried scalar is the only value in
existence. They are therefore stored on `fund_investment` as nullable carried
values, and the distinction from the four above is deliberate: these have a
derivation that works, waiting on data, whereas those have no derivation at all.
When a position's co-investor rows exist, the derived figure is authoritative
and the carried one becomes a reconciliation signal — the same relationship
`company.affinity_fmv` already has with `valuation_mark` (ADR-009).

**Consequences.**

- The round trip becomes possible. Without this the export cannot reproduce its
  input, and A3's central verification could not exist.
- **`runway_months` is nullable and carries no computed fallback.** A company
  that has not reported runway shows nothing rather than a number the platform
  invented — the same rule D-5 applies to diversity, for the same reason.
- **ADR-002's inventory should be treated as a design-time estimate that A3
  tested, not as a verified list.** The remaining fourteen were checked against
  the fixture during A3 and do derive: `vintage` is exactly the year of the first
  round on all 70 companies, `invested` is exactly the sum of round cheques,
  `fmv` is exactly the latest mark, and LP `called` and `distributions` are
  exactly their cashflow sums.
- The risk this leaves is that a stored independent fact can drift from the
  transactions that ought to relate to it — precisely the failure mode ADR-002
  exists to prevent. It is accepted narrowly here because the alternative is
  fabricating a derivation that the source data contradicts. `reservesDeployed`
  against follow-on totals is a sensible future data-quality check, in the same
  spirit as `v_mandate_completeness`, and is not one at A3.

---

## ADR-028 — The funnel is stored at Affinity's resolution and grouped for display; the contract gains `funnelGroups` at schemaVersion 2

**Status:** Accepted (12 August 2026)

**Context.** Affinity's `Status` field carries **sixteen** values — New, Intake,
Reached Out, First Meeting, Second Meeting, Team Pitch, Diligence, Conditional
Approval, Approved, With Legal, Closed, Portfolio, Exited, Did Not Agree to
Terms, Passed, Watchlist. The prototype's pipeline board has **six** columns plus
a list of passed deals underneath, and that vocabulary reached it through a CSV
import that mapped Affinity's statuses onto it with keyword regexes (ADR-009).

Three vocabularies were therefore in play — the prototype's seven, Affinity's
sixteen, and a July hybrid of the two seeded from *observed* values that matched
neither — and an earlier attempt at A4 resolved the conflict the wrong way: it
made the six display bins first-class in `ref_funnel_stage` and demoted the real
statuses to a free-text `funnel_label`. The data survived, but it stopped being a
vocabulary. It could not be ranked, ordered or referenced, nothing prevented a
typo becoming a stage, and a company's exact position in the deal flow was
recoverable only by reading a string.

**These sixteen are working terminology.** "Second meeting", "with legal",
"conditional approval" is how the investment team discusses where a deal stands.
Flattening them at the storage boundary loses that between the two systems, and
ADR-009 already makes Affinity the system of record for pipeline.

**Decision.**

1. **`ref_funnel_stage` holds Affinity's sixteen statuses**, each with Affinity's
   own rank, seeded from the field-metadata snapshot. `pipeline_deal.funnel_stage_id`
   is a deal's **exact** position, not a bin.
2. **`ref_funnel_group` is the display layer** — the prototype's six columns, plus
   Passed and Watchlist. Each stage names its group. The grouping is **monotonic
   in Affinity's rank**, so a deal moving forward never appears to move backwards.
3. **Terminality lives on the group**, not the stage. `is_terminal` is what
   "active deals" means, and `show_on_board` is a *separate* flag because the two
   genuinely differ: Closed is terminal but renders as a column, while Passed and
   Watchlist are listed beneath the board.
4. **The export contract gains `funnelGroups` and `meta.schemaVersion` becomes 2.**
   It is reference data, so it sits at the document root once rather than repeated
   on every deal. `PipelineDeal.funnel` now carries the exact status.
5. **`affinity_status_map` is retained despite becoming an identity mapping**, as
   the seam ADR-009 requires: a renamed or newly-added Affinity status is routed
   onto an existing stage by editing a row.

**Consequences.**

- **No field was removed or retyped, so the ADR-001 freeze holds.** `PipelineDeal.funnel`
  was already `'Sourced' | … | string`, and the contract snapshot fingerprints
  *paths and types*, not values — so carrying sixteen values where seven used to
  be changes nothing it guards. The addition of `funnelGroups` is what bumps the
  version, and it is optional precisely because `docs/reference/demo.json` stays
  at schemaVersion 1: it is the prototype's own boot state and re-exporting it
  would invalidate every golden-master fixture (ADR-022). **The API emits 2 and
  the reference fixture is 1; they legitimately differ.**
- **The frontend stops hardcoding the funnel.** Columns, their order, which groups
  render at all, and the active test all come from the contract
  (`apps/web/lib/funnel.ts`). A re-binning is a row edit, per ADR-009. The
  probability weights stay in the view layer keyed on the **group** name, so the
  prototype's five numbers apply unchanged and no board figure moves (ADR-013) —
  verified: 2/5 closed, 8 active, $15.8M probability-weighted, identical to A2.
- **Watchlist gains a group and it is not cosmetic.** At 114 of 347 it is the
  largest single bucket in Affinity and appears in neither CSV export, so it was
  invisible when the prototype was built. Terminal, because watchlisted companies
  are parked rather than worked — folding them into Sourced would take "active
  deals" from ~84 to ~198.
- **Four `ref_funnel_stage` rows are marked `source = 'prototype-fixture'`.**
  `Sourced`, `Screening`, `IC Review` and `Term Sheet` exist only in the reference
  fixture and have no Affinity equivalent; they keep it loading against a NOT NULL
  key and are deleted with a one-line query when A6 retires its pipeline section.
- **`pipeline_deal.funnel_stage_id` is `NOT NULL`**, closing the item ADR-026
  deferred to A4.

---

## ADR-029 — Visible ingestion: exact-domain matching, and one KPI column may be fed by more than one request wording

**Status:** Accepted (13 August 2026)

**Context.** A5 connects Visible.vc, which ADR-010 makes the system of record for
company-reported KPIs. Reconnaissance against the live account raised two
questions that ADR-010 does not answer, both of them discovered only by looking
at five years of real data rather than at the current quarter.

**First, the join does not fully land.** ADR-009 names `website` as the crosswalk
between Affinity, Visible and Finance. Both systems fill it on 82 of 82
companies, and normalised to bare domains they agree on 69. The thirteen misses
are not missing data: they are the same company recorded under a different
domain — rebrands (`simptekinc.com` / `climative.ai`), subdomains
(`app.trippl.ca` / `trippl.ca`), TLD swaps (`trelent.net` / `trelent.com`).

**Second, one metric changed its name mid-series.** The burn question was asked
as `Monthly Burn Rate` from 2021 Q2 to 2025 Q2 — 774 answers from 73 companies —
and as `Monthly Net Burn Rate` from 2025 Q3 onward. A third name, `Net Burn
Rate`, is defined on all 82 companies and has never been answered. Reading only
the current name, which is what a "latest value" CRM sync correctly does, starts
the platform's burn history in October 2025.

**Decision.**

1. **Companies match on exact normalised domain and nothing else.** No fuzzy
   fallback, no crosswalk table. Where the two systems disagree, the fix is
   upstream in the website field itself. Every miss is reported in both
   directions on every run.
1a. **Affinity's portfolio is the master list of companies, and the two
   directions of a miss mean different things.** A Visible profile with no
   Affinity company is **expected residue**, not a defect: MyCodev wound down and
   left Affinity while its Visible profile outlived it. Its metrics are
   deliberately not stored, because a KPI row hanging off it would put a company
   on the platform that exists nowhere else. An Affinity company with no Visible
   profile leaves its KPIs **blank**, which is honest — SiMBi is a position old
   enough that contact was lost before Visible was adopted — and is a prompt to
   either create a profile and start collecting or accept that nobody reports on
   it any more.
1b. **`fte` and `fte_nb` are `numeric`, not `int`.** A full-time *equivalent* of
   3.5 is three full-timers and a half-timer: a measurement, not a typo. As
   integer columns those readings were refused, and the platform showed a company
   reporting 3.5 staff as having none — the same class of error as rendering an
   unreported diversity figure as zero (D-5). Stored exactly as reported and
   never rounded, because rounding moves a mandate number in one direction or the
   other on the company's behalf and the platform is not the system of submission
   (ADR-017). `women_csuite` and `csuite_size` stay `int`: they count people.
2. **`monthly_burn` is fed by both burn wordings**, spliced into one continuous
   series, with `company_kpi.request_version` recording which wording produced
   each row (`2021-baseline` / `2025Q3-net-burn`). Where a company answered both
   in the changeover quarter, the current wording wins.
3. **`net_revenue_retention` and `gross_margins` are stored but not exported.**
   Both are collected today, neither is in the frozen ADR-001 contract.

**Consequences.**

- **A pure domain join makes a rebrand silently lose a company's KPIs**, which is
  the cost of not holding a crosswalk. It is mitigated, not removed, by the sync
  naming every unmatched company on both sides on every run: the failure is loud
  rather than invisible, but it still needs somebody to read the warnings and fix
  a website. This was chosen over a crosswalk table deliberately (13 August 2026)
  on the grounds that correcting the source improves both systems rather than
  papering over them.
- **`request_version` stops being a theoretical safeguard.** ADR-010 introduced
  it for a definition change that might happen; one already had, four years into
  the series, and nothing else records where the seam falls.
- **The seam is real, not clerical.** "Burn Rate" and "Net Burn Rate" plausibly
  differ by whether revenue is netted off. A quarter-on-quarter comparison
  spanning 2025 Q3 is comparing two questions, and any view that crosses it must
  say so rather than drawing a step change as though it were performance.
- **Two columns exist that no screen shows.** That is the intended state:
  displaying them is a change to a frozen contract and a separate decision.

---

## Resolved open items

| Ref | Item | Resolution |
|---|---|---|
| O‑1 | Valuation effective date vs data cutoff | **Closed.** 31 Jan and 31 Jul are effective dates; results reach the board two to three months later. Reporting lag handled in ADR-007. |
| O‑2 | Whether the 31 March year end warrants a closer mark | **Closed.** Cadence is unchanged by this platform. Business as usual for Finance; the platform labels the carry-forward. |
| O‑3 | Diff funding-agreement definitions against the prototype | **Closed as a blocker.** The platform is not the system of submission (ADR-017). Worth doing before external quotation; no longer gating. |
| O‑6 | Historical availability of round totals and co-investor amounts | **Closed.** Extensive but imperfect, with histories exceeding fifteen years. Coverage tapers with age and is reported rather than imputed (ADR-015). |

## ADR-030 — The investment vehicle is an attribute of the transaction, not of the company; and A6 reconciles to Affinity's control totals rather than inventing its own

**Status:** Accepted (14 August 2026)

**Context.** A6 generates the synthetic financial spine — transactions, rounds,
marks, ownership and LP activity — against the real company roster A4 brought
in. Two questions arose that no earlier ADR answers, and both were raised by
looking at the operator's own portfolio export rather than at the schema.

**First, NBIF invests through three vehicles and nothing modelled it.** The
Affinity portfolio export carries a `Fund` column reading `VCF`, `SIF` or `ACC`
— the venture capital fund, the startup investment fund and the accelerator
programme — split 40 / 20 / 20 across the eighty portfolio companies. The schema
had a `fund` table with one row, described as the reporting entity, and no link
from any company, round or transaction to a vehicle. The column is also **not in
Affinity's profiled field metadata** (`docs/affinity-v2-field-map.csv`, 78
fields), so the A4 sync cannot fetch it and no amount of re-probing will make it
appear on its own.

**Second, the generated data needed a definition of "right".** Finance has not
supplied per-transaction history (ADR-011), so every date, cheque size, round
label and mark in the generated dataset is invented. Without an anchor,
"looks plausible" is the only available standard — and a plausible portfolio
that adds up to $41M when the team knows it is $47M is worse than no portfolio
at all.

**Decision.**

**1. Vehicle attribution lives on `transaction` and `investment_round`, never on
`company`.** A new `ref_investment_vehicle` holds the three codes;
`transaction.investment_vehicle_id` and `investment_round.investment_vehicle_id`
are nullable references to it. Affinity records one vehicle per company because
its record *is* the company, but a dollar belongs to the vehicle that wrote the
cheque, and an accelerator position followed on from the VC fund is a normal
progression that a company-level column cannot express. It is also the shape
Finance books in, so the A13 backfill arrives in this form rather than needing
to be decomposed into it.

**2. The column is NULLABLE and is never defaulted.** Two roster companies —
Alongside and Potential Motors — are absent from the Status-filtered export the
`Fund` column came from, so their vehicle is genuinely unknown. They carry NULL.
Guessing `VCF` on the strength of a cheque size would put $3.7M of real
deployment into a vehicle it may never have come from, and a year from now the
guess would be indistinguishable from a fact.

**3. `company.affinity_total_investment` and `company.affinity_fmv` are the
generator's control totals.** Both are synced nightly from Affinity by the A4
job and were already stored, marked REFERENCE ONLY — never an input to a
calculation. They are still not an input: the generator does not *display*
them, it *reconciles to* them. Every company's generated transactions sum to
the first, exactly; its final valuation mark equals the second, exactly; and
`run.ts` re-reads both out of Postgres after the write and **aborts the
transaction** if any of the 82 disagrees by a cent. Reading the targets from the
database rather than from the supplied spreadsheet means a correction made in
Affinity today is picked up by a regeneration tomorrow, with no file to
re-export.

**4. No realizations are generated** (VC team lead's call, 14 August 2026). The
export carries invested and FMV and nothing else. Realized proceeds would move
DPI, TVPI, IRR and the fund distributions series — four board numbers — with no
source. DPI reads 0.00x and TVPI 0.89x, which is what the supplied data says.
Write-offs *are* generated, because an FMV of zero is in the data; a
`company_exit` row additionally requires Affinity's lifecycle status to read
`Winding Down`, because a write-down and a closure are different assertions and
fifteen companies carry a zero FMV without that status.

**5. `fund.capital_base` stays NULL** (VC team lead's call, 14 August 2026),
continuing A4's refusal to invent one. This surfaced a real defect rather than
merely a blank tile — see the consequences below.

**Consequences.**

- **The FX rate became load-bearing for the first time.** `fx_rate_to_cad` had
  been stored since A1 and read by nothing, because every row in the reference
  fixture was CAD. A6's deliberately non-CAD tranche made four aggregates
  understate by the spread. `v_transaction_live` now exposes `amount_cad`
  (`amount * coalesce(fx_rate_to_cad, 1)`), and `v_company_invested`,
  `v_company_realized`, `company_fmv_asof`, `v_round_leverage`,
  `v_lp_position_current` and the export adapter's per-round sum all read it.
  The rate is the one at the transaction date, not today's: re-translating a
  historical cheque nightly would make a board number drift on data that has
  not changed (ADR-021).
- **A missing capital base produced a false number, not an absent one.**
  `fundMetrics.dryPowder` is `capitalBase - netDeployed`, frozen under ADR-013
  and correct; what it cannot express is the difference between a capital base
  of zero and no capital base on record. With neither set the dashboard read
  *"dry powder $-47.2M"* — the D-5 error class exactly, on a board-facing tile.
  The frozen definition is untouched; `hasCapitalBasis()` sits beside it on the
  `diversityWithCoverage` precedent and the four display sites render `-`.
- **`FundInvestment.womenSeniorGP` cannot express "not reported".** The contract
  types it `boolean`. The LP workbook carries no such column and these are real,
  named firms, so the generator leaves it NULL rather than asserting anything
  about identifiable people — and the Funds tab renders *"0 / 16 positions with
  women senior partners"*, which is the same false statement D-5 exists to
  prevent. Recorded, not fixed: correcting it is an ADR-001 contract change and
  a separate conversation.
- **The three carried LP mandate fields are set from the generated co-investor
  rows.** `capital_to_direct`, `co_invests_done` and `referrals` are carried
  rather than derived until the A8 capture form exists (ADR-027); the generator
  writes them consistently with the `round_coinvestor` rows it creates, so the
  stored figure and the derivable one agree instead of the tile reading zero
  against sixty-two co-investments in the table beneath it.
- **The generator is deterministic and per-company seeded.** `mulberry32` from
  the prototype, seeded on `company_id`, so adding a company to the roster or
  regenerating one position leaves every other company's history byte-identical.
  A regeneration is reviewable in a diff rather than merely plausible.
- **Every generated financial row carries `is_synthetic` (ADR-020)** and the
  banner is live on every screen. Clearing is scoped by that flag where the
  column exists and by authorship against the system principal where it does
  not, so an allocation a person edited through the ADR-018 judgement path
  survives a regeneration.
- **Leverage is a generator parameter, and it was checked rather than guessed.**
  Our participation is drawn at 4–32% of a round, giving portfolio leverage of
  5.9:1. `company.cb_total_funding_usd` is documented as a cross-check and never
  a leverage input; used as a cross-check it says the generated round totals
  ($243M) sit *below* the real Crunchbase funding ($460M) for the 55 companies
  that carry it, so the figure is conservative rather than inflated. It remains
  a dial, not a finding.

---

## ADR-031 — Financial records are editable in place, over a versioned store that keeps history reproducible

**Status:** Accepted (17 August 2026). Supersedes ADR-018.

**Context.** ADR-018 made `transaction`, `valuation_mark` and the LP cashflow
set append-only: an error was voided by a dated reversal or superseded by a new
mark, and the Finance interface was to offer **Correct** and **Reverse** rather
than **Edit**. A7 is the phase that builds that interface, and the requirement
was revisited before it was built rather than after.

**The objection is about who operates this, and it is a good one.** Reversal
discipline is borrowed from double-entry accounting systems, where it is
mandatory because the ledger is the statutory record and a reversing entry is
itself an accounting event with a period. This platform is not a general ledger.
It is a portfolio registry of roughly 280 transactions across 82 companies,
maintained by a Finance team whose entire working practice is Excel, where every
cell is editable and a mistake is fixed by retyping it. Presenting that team
with a registry in which a same-session typo must be corrected by booking a
compensating negative row — and in which the table then shows three rows where
one cheque was written — asks them to learn an accounting formalism in order to
fix a fat-fingered digit. The predictable failure mode is not that they learn
it. It is that entry migrates back to a spreadsheet and the platform stops being
the registry ADR-011 says it is.

**What ADR-018 was actually protecting was never the interface.** Re-read its
context: the stated harm is that "editing a transaction in place makes every
previously issued board report irreproducible", and that a confirmation dialog
"does not protect against history changing underneath a published number". That
is a claim about the *storage model*, not about the *verb on the button*.
Append-only is one way to keep every past state of the data retrievable. It is
not the only one, and it is the one that puts the entire cost on the operator.

**Decision.** Financial rows become **editable and deletable in place**, and the
reproducibility property is preserved underneath by versioning rather than by
accumulation.

1. **The base tables hold current state.** `transaction`, `valuation_mark`,
   `investment_round`, `company_ownership`, `fund_distribution` and
   `fund_investment_nav` continue to hold exactly one row per fact, and that row
   is what every existing view, aggregate and metric reads. **No metric, view or
   golden master changes as a consequence of this ADR** — which is the property
   that made the change affordable at A7 rather than a rewrite.

2. **Every mutation writes the prior row image to `financial_row_version`**, in
   full, as `jsonb`, with the interval it was true for, the actor, and a reason.
   Capture is by **database trigger, not by application code.** An `UPDATE`
   issued from psql at 9pm by someone who has never read this file is versioned
   identically to one issued through the API. This is the difference between a
   guarantee and a convention, and it is the whole basis on which the append-only
   requirement was safe to drop.

3. **The actor is mandatory at the database level.** The trigger reads a session
   variable, `pc.actor_id`, and **raises** if it is unset. A financial row cannot
   be modified anonymously by any route, including a direct connection. ADR-005
   already keeps roles in `app_user` rather than in Entra claims precisely so
   that "who was allowed" and "who did it" cannot drift apart; this extends the
   same property to writes that bypass the application entirely.

4. **History is queryable, not merely retained.** `transaction_asof(t)`,
   `valuation_mark_asof(t)` and their siblings return each table as it stood at
   any past instant, reconstructed from the base row and the version images.
   Reproducing a superseded board pack is a query with a timestamp in it. This
   is the clause that discharges ADR-018's requirement, and it is deliberately
   built in A7 alongside the edit interface rather than deferred to A11 — a
   reconstruction path that does not exist yet is a reproducibility guarantee
   that does not exist yet.

5. **Editing inside an issued period warns and demands a reason.**
   `fund_nav_snapshot.frozen_at` marks the periods actually published to the
   board (ADR-007). An edit to a row whose effective date falls on or before the
   latest frozen `period_end` is permitted, but the form states that it restates
   a published figure, requires a restatement reason, and flags the version
   record. Every number that moved after publication is therefore a list, not an
   archaeology exercise. Finance is not blocked — the VC team lead, not the
   database, decides whether a restatement is acceptable.

6. **Deletion is soft.** `deleted_at`, `deleted_by` and `deleted_reason` remove a
   row from every view and every total while leaving it retrievable and
   restorable. A row booked against the wrong company gets deleted and re-entered,
   which is what the operator will do anyway; the alternative is editing it into
   an unrelated fact and leaving a version chain that reads as nonsense.

7. **Reversal survives where it is genuinely the right tool, and only there.**
   `reverses_transaction_id`, `voided_by_transaction_id` and the mark supersession
   chain are retained, because a clawback, a rescinded distribution or a
   renegotiated tranche is a real economic event with its own date and belongs in
   the register as a second row. What is withdrawn is the requirement to use that
   mechanism for **data-entry errors**, which are not economic events and were
   never well served by being recorded as though they were. `batch_id` wholesale
   rollback is untouched and remains load-bearing for A13.

**Consequences.**

- **Finance gets the interface their working practice implies**, which is the
  substance of the change and the reason it was raised.
- **The reproducibility property is preserved but its cost moves.** Under
  append-only, "what did we report then" was free — the rows were still there
  and a dated filter answered it. It is now a reconstruction, which means it is
  code, which means it can have bugs that silence itself. The A7 test suite
  therefore asserts the round trip directly: mutate a row, reconstruct as of
  before the mutation, assert the original figures return.
- **A published number can now move, where previously it could not.** This is a
  real reduction in guarantee and should be stated plainly rather than absorbed.
  Clause 5 makes each instance visible and attributable; it does not make it
  impossible. That is the trade taken, with the operator's agreement, and the
  mitigation is a list someone reads rather than a constraint that holds by
  itself.
- **The `financial_row_version` table grows without bound and is never pruned.**
  At this transaction volume that is immaterial for the platform's lifetime.
  Saying so here means a future reader does not have to rediscover that it was
  considered.
- **`is_synthetic` and the ADR-020 banner are unaffected.** Versions inherit the
  flag with the row image; a synthetic row edited in a demo is still synthetic.
- **A13 is slightly cheaper.** The port's exception path can now correct a
  mis-loaded row by editing it, rather than by reversing and rebooking, and
  `batch_id` rollback remains available for the wholesale case.

**Not decided here.** Whether restatements should additionally trigger a
notification to the VC team lead. The list exists and is queryable; whether
anyone is pushed at is an A9 alerts question, not a storage one.

---

## Decisions requiring the VC team lead

**All settled as of 28 July 2026.** No architecture or data decision remains open.

| Ref | Decision | ADR | Resolution |
|---|---|---|---|
| D‑1 | Import contract may treat derived fields as advisory | ADR-001 | **Accepted.** Import corrects against the transactions and returns a reconciliation warning rather than accepting a contradicting figure. |
| D‑2 | How revenue is presented | ADR-013, ADR-014 | **Display as reported.** Visible's quarterly actual stored and shown unchanged; no annualisation. Label moves from run-rate to quarterly revenue. |
| D‑3 | FMV growth showing two flat quarters per year | ADR-007 | **Accepted**, with carry-forward labelled on screen. Cadence unchanged. |
| D‑4 | Deal-close capture of round total, NB co-investors and ownership | ADR-012 | **Accepted.** Deal lead completes the capture form at close; coverage monitored on the dashboard. |
| D‑5 | Diversity tile treatment of non-reporters | ADR-010 | **Accepted.** Non-reporters excluded from the denominator; coverage shown alongside. NULL never renders as zero. |
| D‑6 | Quarter convention per screen | ADR-006 | **Accepted.** Fiscal on Reports and board-facing views; calendar on the Portfolio KPI history. Every view states which it uses. |

## Actions in flight

| Ref | Action | Owner |
|---|---|---|
| A‑1 | Add women in C-suite and C-suite size to the Visible quarterly request | VC team |
| A‑2 | Historical backfill: transactions, rounds, marks, ownership. Runs asynchronously; gates launch, not development (ADR-020) | Systems & Data Analyst + Finance |
| ~~A‑8~~ | ~~Request a 5–10 company **real sample** with complete history~~ — **withdrawn 14 August 2026**, see the ADR-020 amendment | — |
| A‑9 | Walk the transaction and mark entry workflow through with the Director of Finance before building it | Systems & Data Analyst |
| A‑3 | Issue the staging templates to Finance and reconcile a first batch against agreed control totals | Systems & Data Analyst + Finance |
| A‑4 | Build the company crosswalk — Finance name → Affinity organisation → internal company_id — before any transaction loads | Systems & Data Analyst |
| A‑5 | Establish how far back *per-company* marks exist, as opposed to fund-level NAV only | Finance |
| A‑6 | ~~Walk D‑1 and D‑6 through with the VC team lead~~ — **complete, 28 July 2026** | Systems & Data Analyst |