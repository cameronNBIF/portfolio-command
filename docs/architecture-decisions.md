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
- **The first of the "should be derived, MVP stores it separately" fields actually went at F5, 21 August 2026.** `fund_investment.committed` was not on the list above — a commitment is not a sum of anything, so ADR-002 had no quarrel with it as a column. What retired it is ADR-037: a commitment is *adjustable*, so it is a dated event, and once the events exist the scalar is a derivation of them. `fund_committed_asof()` reads it and the column is dropped. `fundInvestment.called` and `.distributions` remain listed and remain correct: both are still sums, and both are still computed rather than stored.
- **The four fields sanctioned to stay stored are unchanged** — `reservesDeployed`, `runwayMo`, `fteAtEntry` and `company.instrument` (ADR-027). Measurement showed each is an independent fact with no derivation, and F5 does not disturb that finding.

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

**Amended 19 August 2026 by ADR-034, which was Accepted and landed on 20 August
2026 with F2. Nothing above is reversed, and the sign-off principle in
particular survives untouched — which is the point.**

- **The entry screen changes; the authority does not.** Finance asked to enter FMV
  as an adjustment against the last known value rather than as a new absolute.
  ADR-034 satisfies that without changing what is stored: the mark records the
  adjustment that produced it and stores the resulting absolute, computed rather
  than typed. Entry by the Director of Finance is still the sign-off, and there
  is still no separate approval step.
- **The one-final-mark-per-company-per-date index is relaxed** to one *review*
  mark per company per date. It was written when a second mark on one date could
  only be a mistake; it now blocks two follow-ons on one day and a transaction
  landing on 31 January. Two cheques on one day are two facts, not a conflict.
- **`company_fmv_asof`'s tiebreak is corrected in the same change.** It orders by
  `effective_date desc, booked_at desc`, and two marks written inside one
  database transaction tie on `booked_at`. `valuation_mark_id desc` becomes the
  final term. This is a latent defect today and a live one the moment same-day
  marks are legal.
- **The semi-annual cadence, the carry-forward rule and the 31 Jan / 31 Jul
  effective dates are unchanged.** Nothing in the FMV calendar moves.

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

**Amended twice on 19 August 2026, and the second amendment is the first stated
exception to this ADR's central rule. Both are recorded here rather than only in
the new ADRs, because a reader who finds this one first must not come away with a
rule that is no longer whole.**

- **Roster status becomes a synced field (ADR-036, Proposed, lands with F4).**
  The list's `Status` was profiled as 80 of 80 rows carrying one value, always
  `Portfolio`, and was mapped as unused on that basis. It is not unused; the
  Exited view's companies were simply never in the extract. Status is what
  decides whether a company is a portfolio company or an exited one, it is
  maintained by the VC team in Affinity, and the platform therefore **syncs it
  and does not hold a membership state of its own.** This is the rule this ADR
  already sets, applied to one more field — and it is the same reasoning ADR-032
  used when it cancelled the health-rating workflow: a flag maintained in two
  places is a flag the nightly sync silently wins.
  It lands on `company_state`, the dated table, and is distinct from
  `lifecycle_status` — Affinity's separate Portfolio Status field, whose values
  include "Winding Down", which does **not** move a company out of the portfolio.
- **A first exception to the one-way rule is PROPOSED, and it is not scheduled
  (ADR-039 clause B, amended 20 August 2026).** This ADR says "the platform never
  writes back". The proposal is that it writes back exactly once, for exactly one
  field: calculated total invested per company is pushed to Affinity, the field
  becomes read-only there, and the platform stops reading it. One field, one
  direction, one event — not a two-way sync, and not something the nightly job
  acquires. It is defensible only because ADR-011 already makes the platform the
  registry for that specific figure, and no other Affinity field has that
  property.

  **Until it is separately accepted, this rule holds in full and nothing writes
  to Affinity.** It was originally sequenced into A13 and has been taken back
  out: the push needs total invested extracted from live history that Finance has
  verified, which is an *output* of A13 rather than a step within it. There is no
  date, and there will not be one until the platform's own figures are
  trustworthy. The `Total Investment Amount` and FMV columns continue to sync
  **inbound only**, and the A6 generator continues to calibrate against them
  (ADR-020, ADR-030).

- **Separately and already executed: the agreed control totals are frozen
  (ADR-039 clause A, 19 August 2026).** `affinity_control_snapshot` holds
  `affinity_total_investment` and `affinity_fmv` as they stood at F0, 82
  companies to the cent. That is an **A13 reconciliation artefact in its own
  right**, not merely insurance against the write above: the columns are synced
  nightly and demonstrably volatile, the control totals were agreed at an
  instant, and without a frozen copy a reconciliation failure at A13 cannot be
  told apart from Affinity having moved.

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

**Amended at A8, 17 August 2026 — built, and two questions this ADR left open
answered.** Recorded in place; nothing above is reversed.

- **Who may write it: `vc`, `finance` and `admin` (`CAN_CAPTURE_ROUND`).** This
  ADR says "the deal lead will enter these", and two of the three target tables
  are ADR-031 versioned tables sitting behind `CAN_WRITE_FINANCIAL`, which is
  Finance and admin only. The tension is real and was resolved by following
  ADR-005's rule rather than the table boundary: **our cheque is Finance's fact
  and lives on `transaction`, which is unchanged and still finance-only**, while
  what `investment_round`, `round_coinvestor` and `company_ownership` hold is the
  shape of the round around that cheque — who else was in it, how much they put
  in, what we ended up owning — which is the deal lead's, from the closing
  documents they are the one holding. Finance keeps write access because A13
  loads Finance's own historical rounds through this path. Leadership reads.
- **Where the form lives: a tenth tab, `Deal Close`**, built on the A7 Finance
  tab's pattern rather than inside the company drawer. The drawer is a ported
  prototype surface that ADR-014 freezes; more to the point, this ADR's second
  half is monitoring, and a per-company drawer has nowhere to put the
  portfolio-wide chasing list that makes the coverage figure actionable.
- **The single form is a single mutation, in one database transaction.** Not
  three endpoints called in sequence. The failure mode of splitting it is silent:
  a round total that saves without its co-investors moves the leverage KPI and
  leaves the NB co-investment KPI behind, and no screen would report the
  disagreement.
- **A round total below our own cheque is accepted and flagged, never refused.**
  This ADR's rule is that such a round is *excluded* from leverage, and excluded
  is not the same as refused. Rejecting it at the form would push the deal lead
  into either not recording the round or adjusting a figure to get past
  validation, and both are worse than a captured round the metric declines to
  use.
- **Post-money is captured but is not a completeness field.** A null `post_money`
  is legitimately "not applicable" on a convertible and "not known" on an equity
  round, and the platform cannot tell those apart; counting it would report a
  portfolio of notes as permanently incomplete, which is D-5's error in the other
  direction. `round_total`, `nb_other` and `ownership_after_pct` are counted,
  because all three are facts every round has whether or not anyone wrote them
  down. `captured_at` separately records whether a deal lead has been through the
  form at all, which is a different question from whether a field is filled in.
- **Coverage is surfaced on the dashboard per this ADR, and the taper with it.**
  The share of rounds carrying a total sits on the Leverage tile itself, beside
  the number it qualifies; the detail — including per-year coverage, which
  ADR-015 requires be reported rather than smoothed — is a card at the foot of
  the tab, so every ported element stays where the prototype puts it (ADR-014).
  Read from `v_mandate_completeness`, deliberately outside the frozen ADR-001
  document, on the A5 `v_kpi_coverage` precedent.

**Amended 19 August 2026 by ADR-033, which was Accepted and landed on 20 August
2026 with F1. One line of the A8 amendment above is superseded; the role split it
rests on is not.**

- **The transaction's round link is a reconciliation, not a capture, and
  `CAN_CAPTURE_ROUND` is the right gate for it.** The A8 amendment reasoned that
  "our cheque is Finance's fact and lives on `transaction`, which is unchanged and
  still finance-only", and the transaction form was shipped with the round picker
  read-only on that basis, pointing the user at the Deal Close tab. That is right
  about *authorship of the round* and wrong about *the link itself* — and the
  pointer was a dead end besides, because the Deal Close capture does not write
  `transaction` either. **No interface writes that column at all today; every link
  in the database was written by the A6 generator.**
- **What changes is scoped to the foreign key and nothing else.** ADR-033 adds one
  deliberately narrow mutation that sets or clears `transaction.investment_round_id`
  and touches no other column on that table. Amount, date, type, currency and
  vehicle stay behind `CAN_WRITE_FINANCIAL`. That narrowness is the argument: a
  deal lead attaching a cheque to a round they closed is doing reconciliation, and
  an operation that can move a foreign key and nothing else cannot restate
  Finance's figures.
- **Participation becomes explicit, and leverage reads it.** `nbif_participated`
  distinguishes a round we sat out from a round whose cheque is missing — today
  both are "a round with no transactions" and both read `ourInvested` of $0.
  `v_round_leverage` excludes the former. This ADR's rule that a round with a
  missing or invalid total is *excluded, never imputed* is extended, not altered:
  a round we did not participate in is excluded for the same reason.

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
- **Three content exceptions, each forced by data or by NBIF's own vocabulary rather than by taste, all now settled.** The revenue label changes to quarterly revenue to match what Visible supplies (D-2); the diversity tile distinguishes "not reported" from zero and shows coverage (D-5); and **the three LP stages are named Committed Capital, Capital Drawdown and Capital Distribution** wherever they appear, including on the ported Funds tab, the Reports tab and the LP drawer.

  **The third was added at F5, 21 August 2026 (FR-33, ADR-037 clause 4, Q-23), and it is the one that needed an argument.** The prototype says Committed / Called / Capital call. Funke's point is that a capital call is the *GP's* word — a demand for funds — while the same event from our side is a drawdown against a commitment we already made, and F5 renames the stored value accordingly. Confining the rename to the Finance entry screens would have left the platform naming one event two ways depending on which tab you were on, which is the condition FR-33 exists to end rather than to relocate. Layout, ordering, colour, drawer behaviour and the tab structure are untouched: this is the same one-to-one port with the words corrected.

  Everything else holds to the one-to-one rule; any further change is a phase-2 conversation.
- **The NAV ORDER is not part of the freeze, and was changed on 21 August 2026.** This ADR governs the port: layout, terminology, colour conventions, drawer behaviour, and what each of the eight screens shows. It is not a claim about the order of a nav bar that has since grown from eight items to fourteen. The ported eight keep their relative order — Dashboard, Portfolio, Funds, Pipeline, Modeling, Memo Builder, Reports, Data, each still after the one before it — but they are **no longer contiguous**: Exited is grouped with Portfolio and Funds because it answers a question about the portfolio, the entry tabs and Reconciliation are grouped together because Reconciliation reports on what they wrote, and Data moves last because it renders the ADR-001 export document rather than being somewhere anyone works. **The eight screens themselves are untouched**, which is what the parity criterion is actually about.
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
4. **The Finance entry interfaces are walked through with the Director of Finance before they are built,** using the synthetic dataset. Building an entry workflow entirely without its user, on the strength of a schema, is how you reach cutover with something correct and unusable. — **Satisfied 19 August 2026** for the surfaces the meeting covered; see the amendment at the end.

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

**Amendment, 19 August 2026 — condition 4 is satisfied, and it produced more than a sign-off.**

The walkthrough happened on 19 August 2026 with Pat McMullon (Director of Finance) and Funke Yusuf (Controller), against the synthetic dataset, on the A7 and A8 surfaces as built. **Condition 4 is recorded as met for those surfaces**, and action A-9 — which the build log has been carrying since 17 August — closes with it.

**What it produced is the point.** The session did not confirm the interfaces; it generated thirty-six numbered requirements, seven of which name something the platform cannot currently express at all, and it is now three committed documents: `docs/finance-requirements-register.md`, `docs/finance-design-notes.md` and Track F in `docs/delivery-roadmap.md`. That is condition 4 working exactly as this ADR intended — the alternative was reaching cutover with an entry workflow that was correct against the schema and unusable against the job. Two of the findings were live defects rather than gaps: no interface writes `transaction.investment_round_id`, and the dashboard's 7 exited companies are a generator artefact.

**What condition 4 does not yet cover.** The surfaces the meeting did not reach — net book value, debt instruments and the reconciliation screen — are not walked through, because they do not exist to walk through. Nineteen of the thirty-six requirements are blocked on a second meeting or on an artefact that has not been seen. Condition 4 should be re-read as satisfied *per surface*, not once and for the programme.

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

**Amended at A8, 17 August 2026 — a seventh table, and one narrowing of the
generator exemption.** Recorded in place on the ADR-009 precedent; nothing above
is reversed.

- **`round_coinvestor` joins the versioned set** (migration 0003). It meets this
  ADR's own test — a table holding facts that feed a board number — and was left
  out of 0002 only because nothing could write to it: A6 generated those rows and
  no interface touched them. A8 gives them an edit button, and the rule this ADR
  exists to state is that the button and the guarantee ship together. The
  `round_coinvestor_asof()` round trip is asserted directly, in
  `packages/api/test/round-capture.test.ts`, for the same reason the A7 suite
  asserts the transaction one.
- **The trigger resolves an effective date from the parent round where a table
  has none of its own.** A co-investor is dated by the round it was in. Without
  this, an edit to a co-investor amount inside an already-issued period would
  record `is_restatement = false` and stay out of `v_restatement_log` — silently,
  on a mandate figure. Written as a fallback rather than a per-table branch: it
  fires only when the existing five-column coalesce finds nothing, so
  `transaction`, which carries both a `txn_date` and an `investment_round_id`,
  is untouched.
- **The generator exemption now covers `UPDATE`.** 0002 deliberately excluded it
  and gave a reason — "the generator never issues one" — which has since stopped
  being true: `generate/run.ts` links co-investors to LP positions in a second
  pass with a bulk `UPDATE`, so every regeneration would write a version row per
  linked co-investor describing a demo rebuild. The three conditions are
  otherwise unchanged, and the property the exclusion was protecting survives
  intact: a human editing a synthetic row during a demo carries their own actor
  id and is versioned like anyone else.
- **A defect from 0002 is fixed with it.** Column defaults are applied before a
  `BEFORE` trigger runs, so the exempt path returned with `row_created_at` and
  `row_updated_at` already set microseconds apart by two evaluations of the
  volatile `clock_timestamp()`. 0002 flattened the pair for rows that existed
  when it ran, which is why this had not been seen — it would have surfaced on
  the next `npm run db:generate`, marking the entire synthetic dataset as having
  been edited by someone.
- **Soft delete reaches the round reads.** 0002 wired `deleted_at` into
  `v_transaction_live` and `company_fmv_asof`, which covered every table it could
  then delete from. `investment_round` and `company_ownership` gained the column
  and no reader. Harmless while no write path could set it; a live defect the
  moment A8 shipped the form that can. `v_round_leverage`,
  `v_lp_capital_to_direct`, `v_mandate_completeness`, `company_current_asof` and
  the ADR-001 export adapter's round query now all honour it.

**Amended at F5, 21 August 2026 — an eighth table, and the case that shows the
mechanism was built right.**

- **`fund_commitment` joins the versioned set** (migration 0012). It meets the
  same test: a commitment is the denominator of unfunded capital on a
  board-facing screen. Attaching it cost **one `CREATE TRIGGER` and no new
  code**, which is what 0002 said a seventh table would cost and is the first
  time that claim has been tested against a table 0002 had never heard of. The
  five-column effective-date coalesce already covered `as_of_date`, so even the
  restatement test needed nothing.
- **The migration writes its backfill BEFORE attaching the trigger**, which is
  the order 0002 used for its own backfills and the only order available: a
  migration has no actor to name. `pc.actor_id` is set per request by the API's
  write path, by the person doing the writing, and setting it to the system user
  here would have made the version store say somebody entered sixteen
  commitments that night. Nobody did — the figures had been in the database
  since A6, in a column.
- **A rename of a stored value is not an edit of a financial fact.** The LP
  terminology change (ADR-037 clause 4) updates `txn_type` on 95 rows with
  `zz_version_transaction` scoped off, on the 0006 and 0008 precedent. The event
  is the same event, on the same date, for the same dollars, against the same
  position, in the same direction; what changed is how the platform spells it.
- **But the version store's images are rewritten with it, and that half is not
  optional.** `transaction_asof(t)` reconstructs rows through
  `jsonb_populate_record`, so an image still spelling `capital_call` would
  reconstruct a row whose type is no longer in the vocabulary — and a reproduced
  board pack would drop every LP cashflow from any query filtering on the new
  name, silently. The images are a machine-read reconstruction source, not a
  transcript. `audit_log` is deliberately left alone for the opposite reason: it
  IS a transcript, read by people, and it should keep saying what was actually
  submitted at the time.

**Amended at F6, 21 August 2026 — the version store says WHY, and one defect
was reintroduced by describing a fix instead of copying it.**

- **`financial_row_version.change_kind` lands** (migration 0013), and
  `v_restatement_log` carries it. That view exists to answer "what moved after
  the board saw it", and FR-14's point is that two different events land in it:
  a figure that was wrong, and a figure that was right and incomplete. Without
  the column that view cannot tell them apart, which is the state Pat objected
  to.
- **The kind travels as a session GUC**, `pc.change_kind`, exactly as the reason
  does — so a change made from psql is classified or explicitly unclassified
  like any other, and the trigger stays the only thing that writes history.
- **NULL means unclassified and is never rendered as a default.** The 49 version
  rows written before 0013 genuinely are, and so is any routine change nobody
  chose to classify. Showing them as "Correction" would destroy the distinction
  in the exact direction FR-14 was raised about.
- **A CAUTION FOR THE NEXT MIGRATION THAT TOUCHES THIS TRIGGER.** 0013 has to
  restate `capture_financial_version` in full, because Postgres cannot amend one
  clause of a function body. The first draft retyped it from *this amendment's
  own A8 text* and dropped four lines — the exempt path's
  `new.row_updated_at := new.row_created_at`. That path returns before the
  assignment at the bottom which normally flattens the pair, so every synthetic
  row came back from `db:generate` looking edited: **95 rows across three tables
  claimed to have been edited by nobody**, which is the identical defect the A8
  amendment above records fixing. Caught by measurement, not by review. **Copy
  the body from the migration that last defined it; do not retype it from a
  description of what it does.**

**Amended 19 August 2026 by ADR-038 (Accepted at F6, 21 August 2026). Additive;
nothing in the mechanism changes.**

- **A restatement and a late arrival are not the same event, and the version store
  will say which.** This ADR flags an edit inside a frozen period as a
  restatement, which is right for a corrected figure and wrong for a grant that
  becomes known six months after the round — a real and expected case, and the one
  Pat asked for by name. Both look identical in the change log today, and one of
  them reads as an accusation. **The row's history was right; the label was
  wrong.** `financial_row_version.change_kind` — `correction`, `new-information`,
  `initial-load` — carries the distinction.
- **Nullable, and NULL means unclassified.** Every row written before that
  migration genuinely is, and backfilling a guess would be worse than the gap.
- **`new-information` is offered only inside a frozen period.** Outside one there
  is nothing to restate and the distinction is noise; offering it everywhere would
  train people to pick one at random.

**Amended 19 August 2026 by ADR-033, Accepted and landed 20 August 2026 with F1.
No mechanism change; recorded because it is the first write path that
deliberately relies on this one. Both properties are now asserted in
`packages/api/test/round-transaction-link.test.ts` rather than assumed.**

- The `link-transactions` mutation writes nothing but a foreign key, and gets both
  audit capture and restatement detection **for free** — the trigger fires on any
  `UPDATE` to `transaction`, and `checkRestatement` keys on `txn_date`. Linking a
  2024 cheque inside a frozen period demands a reason and is flagged, which is
  correct: the link moves that round's `ourInvested` and can move leverage. Both
  properties are asserted in the F1 tests rather than assumed.

---

## ADR-032 — Alert thresholds inherit from a fund-level policy; risk flags carry a controlled vocabulary; alerts can be acknowledged

**Status:** Accepted (18 August 2026). Extends ADR-013 and ADR-009 without superseding either.

**Context.** A9 was specified as "alert feed, health rating workflow, watchlist".
Three of those four words survived contact with the code.

The alert feed existed and was frozen. `healthAlerts()` is a verbatim port and
its output is asserted by a golden-master fixture. What it lacked was any way to
*configure* it: `company_threshold` held a per-company runway floor, nullable
with no default, and 68 of the reference fixture's 70 companies carried a
`maxBurnMult` that **no code has ever read**. A company nobody had configured was
silently unwatched, and there was nowhere in the platform to say "our runway
threshold is twelve months".

Risk flags were worse. `company_risk_flag` has existed since A1 with
`raised_at` / `cleared_at` / `raised_by`, and the only writers were the fixture
importer and the A6 generator. No API, no UI, no audit trail. And the frozen
alert code de-duplicated flags against the runway alert **by regex on the flag's
display text** — `!/Runway/i.test(f)` — which is a defensible shortcut when one
person authors the flags in a JSON file and a trap the moment a form exists.

**The health workflow is the word that did not survive.** Affinity is the system
of record for the Risk Assessment that drives health (ADR-009), the sync is
one-way, and the VC team maintains the rating there as part of their existing
practice. There is no workflow for this platform to own. Building an edit box
would create a rating that disagrees with itself across two systems, and the
next nightly sync would silently win the disagreement. **A9 surfaces provenance
instead** — the grade, who set it, when — and offers no way to change it.
`docs/delivery-roadmap.md` is amended accordingly.

### Decision

1. **A fund-level `fund_alert_policy` supplies defaults that any company can
   override.** Effective-dated, for the same reason `company_state` is: a
   watchlist appears in the board pack, ADR-031 exists so an issued pack stays
   reproducible, and a policy that silently rewrote itself would put a company on
   last quarter's watchlist that was never on it. Setting a policy supersedes the
   current row rather than updating it. The export reads the policy **as at the
   requested date**, never the current one.

2. **Three threshold states, and conflating any two of them breaks something.**

   | State | Meaning |
   |---|---|
   | absent | inherit the fund policy |
   | `0` | **disabled** — the company opts out, and the policy does not resurrect it |
   | `n > 0` | the company's own threshold, overriding the policy |

   `0` is the inherited contract meaning of `thresholds.minRunwayMo` and it is
   the **only escape hatch from a portfolio-wide default**. Every layer tests it
   with an explicit null/empty check rather than truthiness, because `0` is falsy
   and is precisely the value that must survive.

3. **Four metrics join runway**: burn multiple, cash floor, quarter-over-quarter
   revenue decline, and NRR. The burn multiple is **quarterly net burn ÷
   quarterly net new revenue** — the definition the stored 1.5 / 2 / 3 thresholds
   plainly came from — and it is silent when revenue is flat or falling, because
   that company has no meaningful multiple and is described by the
   revenue-decline alert instead.

4. **Risk flags gain `ref_risk_flag_category`, and the category declares which
   metric alert it stands in for.** This replaces regex-on-display-text
   de-duplication with a stated relationship. The regex survives exactly once, in
   a one-time backfill, which is the right place for an interpretation of legacy
   text. `flag_text` is still stored verbatim and still what the contract
   serialises — the ADR-026 pattern, identical to `company.sector_label` beside
   `sector_id`.

   **Suppression also becomes conditional.** The prototype dropped a matching
   flag whether or not the metric had fired, so a runway flag on a healthy
   company was invisible everywhere. Measured before changing: all 20 runway
   flags in the reference fixture sit on companies that also breach, so there are
   no orphans and the fixture's output is unchanged.

5. **Alerts can be acknowledged, with a reason and an expiry.** An alert feed
   that cannot be answered becomes wallpaper — a company knowingly at four months
   of runway during a bridge sits red at the top of the dashboard for a quarter,
   everyone learns to scroll past it, and the one alert that mattered is scrolled
   past with it. An acknowledgement is never a delete: the breach is still
   derived and still shown on the company. It lapses three ways — the date
   passes, someone revokes it, or **the reading moves materially past where it
   was signed off**, because knowing about four months of runway is not consent
   to ignore two.

6. **Nothing about a breach is stored** (ADR-002). A breach is a function of a
   KPI row and a threshold and is recomputed every time. Only the human judgement
   about one is persisted, keyed on the alert's *subject* rather than its value,
   so a nightly Visible refresh does not silently orphan an acknowledgement.

7. **The contract goes to `schemaVersion` 3**, adding `alertPolicy`, three
   `Thresholds` fields, `riskFlagDetail`, `acknowledgements`, `Kpi.nrr` and three
   health-provenance fields. **Every addition is optional**, which is not
   politeness to old consumers — it is what lets `docs/reference/demo.json` stay
   frozen at 1 (ADR-022) while remaining a document the metrics package reads.

### What this cost the golden master, exactly

**Four alerts, and they are enumerated in the test rather than absorbed into the
fixture.**

Every A9 addition is gated on data a schemaVersion 1 document does not carry, so
`healthAlerts(demo.json)` is inert on all of them. The single exception is
`maxBurnMult`, which the fixture has always held and nothing has ever read.
Giving it a rule adds four alerts — C001, C002, C008, C009 — and the diff was
measured before the code was written and asserted after:

| | |
|---|---|
| alerts | 39 → 43 |
| added | 4, all burn multiple |
| removed | 0 |
| severity changes on surviving alerts | 0 |
| relative order of the 39 pre-existing alerts | preserved exactly |

**The fixture was not recaptured, because it cannot be.** `capture.ts` produces
it by running the *committed prototype* over `demo.json`, and `verify:fixtures
--check` compares the committed file against that same output — naming
hand-editing as the one thing ADR-013 exists to prevent. A fixture carrying
burn-multiple alerts would fail its own verifier forever. `golden-master.json` is
a **recording of the prototype**, not a record of what this package currently
does, and it stays one. The divergence lives in `golden-master.test.ts` as four
lines of data someone has to delete on purpose.

This is deliberately *not* ADR-024, which was rejected. ADR-024 proposed
permitting divergences where the prototype's behaviour is an implementation
accident. This is a new rule the prototype never had, added on an explicit
decision, with its full effect enumerated.

### Consequences

- A company with no threshold of its own is now watched. On the development
  roster, setting the 12-month policy moved the watchlist from 95 alerts to 107 —
  twelve companies that nobody had configured and nothing had been watching.
- `healthAlerts()` gains an optional second argument. Called without it, it does
  no acknowledgement filtering, which is the pre-A9 behaviour and what keeps the
  frozen fixture producing frozen figures.
- A ninth tab, role-gated to `vc` and `admin`, on the same reasoning that put
  Deal Close and Finance outside the ported eight (ADR-014): the prototype has no
  alert configuration at all, so this cannot be a port of anything.
- `company_threshold.min_runway_months` and `max_burn_multiple` change meaning
  from *no alert* to *inherit the policy*. Indistinguishable until a policy row
  exists, which is why migration 0005 inserts none — the behaviour change lands
  when someone sets a policy, deliberately, not as a side effect of migrating.

---

## ADR-033 — A round is an event in the company's life, participation is explicit, and the cheque-to-round link is writable from both surfaces

**Status:** **Accepted (20 August 2026)**, landed with F1 in migration 0008. Raised as Proposed at F0. Amends ADR-012.

**One clause was found to be incomplete on landing, and is corrected below rather than left as written.** Clause 3 puts the leverage guard in `v_round_leverage`, and that view is marked CONVENIENCE ONLY (ADR-021) and is read by nothing in the API. The published figure is `fundMetrics` over the ADR-001 export. See the amended clause 3.

**Context.** The finance requirements meeting reached two conclusions that cannot both hold: *"a round cannot exist without at least one associated transaction from NBIF's perspective; however, rounds can also occur in which NBIF does not participate, and these still need to be recorded because they affect FMV and cap table ownership percentages."* A round we did not participate in **is** a round with no transaction.

The resolution is a definition rather than an arbitration, and it does not need Finance to pick a side: **the round is an event in the company's life, not in ours.** A Series B happens whether or not we write a cheque. Once that is the definition, three of the four states are legal and the fourth is a data error:

| State | Legal | Why |
|---|---|---|
| Transaction with no round | yes | A bridge note, a standalone convertible, a secondary purchase |
| Round with no transaction | yes | A round we did not participate in, which still moves ownership and FMV |
| Round we *did* participate in, with no transaction | **no** | This is the rule Pat was actually articulating |

**The database cannot currently tell the third case from the second.** Both are a round row with nothing pointing at it, `ourInvested` reads $0 for both — and also for a cheque that exists but was never linked, and for a plain entry error. Four states, one representation.

Worse, **no interface writes `transaction.investment_round_id` at all.** The Finance tab renders it read-only and points at the Deal Close tab; the Deal Close capture writes three tables and `transaction` is not one of them. Every link in the database today was written by the A6 generator.

**Decision.**

1. **`investment_round.nbif_participated` is three-state — `yes` / `no` / `unknown` — and defaults to `unknown`.** Not to either answer: a backfilled 2011 round genuinely may not know, and unknown is not a synonym for no. This is the convention the codebase has already reached twice — a null round total means "unknown" and is excluded from leverage rather than imputed, and a null co-investor amount means "the name is known and the figure is not". Absence must be *distinguishable from* rather than *conflated with* a real value.

2. **The backfill reads evidence, never an assumption.** A round with a live linked transaction becomes `yes`. Everything else stays `unknown`.

3. **Rounds where participation is `no` leave the leverage figure — in `v_round_leverage` *and* in the ADR-001 export.** Leverage measures capital attracted alongside our own money; a round we sat out contributes a round total with no matching cost and would inflate the ratio. No published figure moves on the day this lands, because every generated round carries a cheque and backfills to `yes` — **which is exactly why it goes in now.** The guard is installed before the data that would trip it exists, and it is asserted in a test rather than trusted, because the first non-participating round will arrive months from now with nobody watching.

   **The second half of that sentence is an amendment made at F1, and the reason matters more than the change.** As raised, this clause named only `v_round_leverage`. That view is marked CONVENIENCE ONLY under ADR-021 and **no API path reads it**: the published leverage KPI is `fundMetrics` in `packages/metrics`, computed from the export document, and its predicate is `roundTotal && roundTotal >= invested`. A round we sat out reaches it with `invested` of 0, passes that test, and adds its whole total to `capitalAttracted` against nothing of ours — so **the ratio rises because we did less.** The Capital Attracted chart has the same shape. The guard as originally written would have gone into the one place it could never trip.

   **The predicate therefore sits in `read/export.ts` as well, and that is not a change to the frozen contract.** `packages/metrics` cannot apply it — the contract carries no participation field and ADR-001 freezes the shape — and it does not need to, because the contract's own definition of the type settles the question: `Round` is documented as *"one financing round we participated in"*. A round we did not participate in was never in scope for that array. Excluding it is the export layer reading the contract correctly, and it is the same category as the soft-delete exclusion already there: not ours to report. The rounds that array carries remain **unfiltered by the leverage predicate**, which is the property ADR-021 and ADR-023 actually protect.

   **The cost, recorded rather than discovered later:** a round we sat out will not appear in the company drawer's round history, which reads the export. Its ownership and FMV consequences are still captured and still visible on the Deal Close tab. Giving it a home on the ported screens is a phase-2 conversation under ADR-014, not an F1 one.

   **`<> 'no'`, never `= 'yes'`, in both places.** `unknown` stays in the ratio. Excluding it would mean a historical round nobody has classified silently leaves the leverage figure, and coverage would improve every time somebody failed to answer a question. Only an explicit statement removes a round.

4. **`transaction.standalone_confirmed_at` / `_by` records that a null round link has been looked at.** Without it the reconciliation surface's unlinked-cheque check has no way to ever reach zero, because it cannot tell a cheque nobody has reviewed from one that correctly has no round.

5. **The link is writable from both surfaces, through one deliberately narrow mutation.** `link-transactions` sets or clears `transaction.investment_round_id` and touches no other column on that table. The Deal Close form gets a *cheques in this round* section; the transaction form's round picker is enabled, with an explicit *No round — standalone* option.

6. **That narrowness is what settles the permission question.** `investment_round` is captured by `vc`, `finance` and `admin`; `transaction` is `finance` and `admin` only. A deal lead attaching a cheque to a round is doing **reconciliation**, not restating Finance's figures — so `CAN_CAPTURE_ROUND` is the right gate for an operation that can move a foreign key and nothing else. Amount, date, type and currency stay behind `CAN_WRITE_FINANCIAL`.

**Why not enforce an entry order.** The two records have different authors on different clocks. The deal lead holds closing documents at close; Finance books the wire when it clears; the two events are days or weeks apart in either direction. An order requirement — either one — guarantees that whoever gets there first is blocked, and the reliable outcome of blocking someone from recording a fact they hold is that the fact goes into a spreadsheet instead. That is the exact failure ADR-031 was written to prevent when it reversed the append-only rule.

**Why not merge the two tables**, which is what FR-06 asked for. Merging would break the ADR-005 role split that A8 is built on and put Finance's cheque and the deal lead's round total behind one permission. **Merge the workflow, not the tables** — one capture flow that can create or link the cheque, plus an explicit Finance confirmation state on the round, which is precisely what Pat described when he said Finance "can then verify and confirm that the fields relevant to accounting are correct".

**Consequences.**
- ADR-012's read-only note on the round picker is superseded. That note reasoned that "which round a cheque belongs to is a deal capture decision, not a Finance correction." It is right about *authorship of the round* and wrong about *the link itself*: the link is a reconciliation between two records, and reconciliation is Finance's work as much as the deal lead's.
- Two properties come for free and are asserted rather than assumed. The ADR-031 trigger captures a link change, because it fires on any `UPDATE` to `transaction` — linking is audited with an actor without a line of audit code. And restatement detection works, because `checkRestatement` keys on `txn_date`: linking a 2024 cheque inside a frozen period demands a reason, which is correct, since the link moves that round's `ourInvested` and can move leverage.
- `unknown` becomes a reportable completeness gap, in the same way mandate coverage already is. It should be, rather than being quietly counted as either answer.
- **`v_mandate_completeness` is deliberately NOT changed at F1, and the inconsistency is named rather than left to be found.** That view's `pct_leverage_coverage` is documented as *the share of rounds the leverage figure can see*, and it counts every round with a captured total — including, now, rounds that participation has just removed from the figure. Once a `no` round carries a total, coverage will overstate itself slightly. It is left alone because it moves no number today, because a round we sat out still legitimately wants its total captured (that total is the dilution context ADR-033 exists to preserve), and because what the completeness denominator should be is a question F6 has to answer anyway for the reconciliation surface. **It is an explicit F6 input, not an oversight.**
- **Three surfaces computed a leverage-shaped figure and only one of them was named in this ADR when it was raised.** The lesson generalises past F1: `INHERITED-COERCIONS.md` §2 already records that `fundMetrics.nbCapital`, the dashboard chart and `v_round_leverage` disagree about NB capital. Any future guard on a round-level metric has to state which of the three it is being installed in, and F1's suite asserts the view and the export together for exactly that reason.

---

## ADR-034 — A valuation mark records the adjustment that produced it; the retention factor is the input and the absolute is the fact

**Status:** **Accepted (20 August 2026)**, landed with F2 in migration 0009. Raised as Proposed at F0. Amends ADR-007.

**One clause needed a decision it did not contain, and it is recorded in clause 3 below:** what a review is applied to when the company has never been marked.

**Context.** Finance asked to record FMV **adjustments against the last known value** rather than new absolute figures. The platform stores absolutes, and every metric, view, export and golden master reads them. `company_fmv_asof()` — which is the definition of NAV, and therefore of TVPI, RVPI and IRR — is a single query for the latest final mark.

Switching to a pure delta chain would mean every read recomputes a running sum from the beginning of a company's life, and one corrected early row silently shifts every figure after it. That is a large change to the most load-bearing function in the system, in exchange for a data-entry convenience.

**Decision. Adjustment in, absolute out, both persisted.** The ask is about how Finance *enters* a figure, not about what is stored, and both can be satisfied at once — the same move ADR-031 made when it dropped append-only entry without dropping the reproducibility guarantee underneath.

A mark becomes an **event** carrying its cause, its basis, its input and its result: `adjustment_type`, `basis_mark_id`, `basis_fmv`, `retention_factor`, `adjustment_amount`, and `fmv` unchanged as the absolute result — **computed, never typed.** Everything that reads FMV today keeps working untouched. No metric moves, no golden master is recaptured, no board number changes as a consequence of the storage change, and that property is what makes this affordable rather than a rewrite.

1. **The stored value is a factor, not a percentage, and the distinction is deliberate.** `0.7500` means the position is carried at 75% of its previous FMV — a 25% impairment. A factor has exactly one arithmetic meaning, `new = prior × factor`, and cannot be read backwards six months from now; a bare `75` can. **Store the factor, display the sentence:** the form shows *"Retain 75% of existing FMV — a 25% decrease"* and the resulting dollar figure before saving, because that is the language the review is conducted in.

2. **`fmv` is never accepted from the client on the review path.** The server resolves the prior mark, writes the basis from it, and computes the result. A computed figure that the client can also supply is a computed figure that will eventually disagree with itself.

3. **`basis_fmv` is stored rather than looked up.** If a 2019 mark is later corrected, every subsequent mark's arithmetic silently becomes wrong under a lookup and nothing says so. Storing the basis at write time turns that into a **detectable** condition — `basis_fmv` no longer matching its predecessor — which becomes a line on the reconciliation screen instead of a number nobody can explain.

   **A review may be applied to cost, and therefore a basis VALUE is required where a basis ROW is not (decided at F2).** ADR-007 holds a company with no mark yet at cost, so cost *is* its carrying value — and the first review of a company between its first cheque and its first formal mark is an ordinary thing to run, not an edge case. The constraint is therefore one-directional: `basis_mark_id` may be null while `basis_fmv` is set, and a review must always carry `basis_fmv`. The alternative — refusing, and telling Finance to work out cost × 0.75 by hand and enter it as an absolute — reintroduces exactly the re-entry FR-19 exists to remove, on the path where the platform knows the answer perfectly well.

   The first draft of migration 0009 made the two columns strictly co-null, which made that review unreachable. It was corrected before anything depended on it; the reasoning is here rather than in the build log because the asymmetry looks like an oversight to anyone reading the schema cold.

4. **The retention vocabulary lives in a reference table, not a CHECK constraint,** so Finance can add or retire an option through the Policies surface without a migration. The meeting's intent was a constrained list rather than free entry; what changes is who is able to change the list, not whether it is constrained. Validation is server-side against the active rows, not by the shape of a drop-down.

5. **`impairment` and `hold` are one type, not two.** Once 100% is an option on the same drop-down, "we reviewed this and held it" and "we reviewed this and took 25% off" are the same action with different inputs — one type, one control, one row. This is a simplification the FR-18 answer bought rather than a shortcut: under a write-down reading, "no change" would have had no entry in the list at all and would have needed a mechanism of its own.

6. **The same-date unique index is relaxed to one *review* mark per company per date.** The current index permits one final mark per company per effective date, which blocks two follow-ons on one day and blocks a transaction landing on 31 January. Everything other than a review may repeat: two cheques on one day are two facts, not a conflict. **And `company_fmv_asof`'s tiebreak is fixed in the same change** — it orders by `effective_date desc, booked_at desc`, and two marks written inside one database transaction can tie on `booked_at`, because the ordering was written when a tie was impossible. Adding `valuation_mark_id desc` is one line and it is load-bearing from the moment same-day marks are legal.

7. **The free-entry path survives as `adjustment_type = 'manual'`**, still requiring a rationale — because A13 loads fifteen years of absolute marks through it, and because an escape hatch that exists is better than one that gets improvised.

**What is deliberately not decided here.** The `transaction` and `round_reprice` types are declared in the vocabulary and written by nothing. Whether new money raises FMV by the cheque or reprices the whole position, whether an unpriced round can do anything at all, and whether a system-calculated adjustment is final without anyone clicking are Q-2, Q-3 and Q-4. **None of them changes the shape of a row** — they change which rows get written and by what process — which is why the storage lands now and the automation waits.

**Consequences.**
- ADR-007 is amended, not reversed. Entry by the Director of Finance is still the sign-off; what changes is what the entry screen asks for.
- FMV becomes a downward ratchet between transactions: an impaired company that recovers stays impaired until a new round or investment reprices it. That is a defensible conservative position and is almost certainly intended, but it is stated here because it is the kind of rule that surprises someone two years later.
- Impairment compounds — 50% then 50% leaves a position at 25% of where it started. That is the natural reading of "relative to its previous valuation"; Q-1 is a one-line confirmation, not a discussion.
- There is no 0% option, so a position can be impaired to a quarter but not to nil except through the wind-down path. Whether Finance wants to mark a company worthless before it is formally wound up is Q-19 — **and because the vocabulary is a table, the answer is now a one-row insert through the Policies surface rather than a migration.** That is most of the argument for clause 4.
- **Impairment compounding is asserted in a test rather than left as a reading.** Q-1 is a confirmation rather than an open question, and D-3 calls it "almost certainly what is intended" — but "almost certainly" is not a property, and a successive 50% / 50% impairment landing at 25% of the original is now something the suite would notice stopping.
- **The review path is where the platform first computes a stored figure rather than receiving one.** The arithmetic is done in `numeric` inside Postgres, not in JavaScript: ADR-008 keeps money as strings end to end precisely so it never becomes a double, and `basis × factor` is the one place that has to multiply two of them. Doing it in the application would put a float in the middle of the only computed board number in the schema.

---

## ADR-035 — Ownership is maintained between rounds by Finance, ad hoc; significant influence is a dated policy with a derived flag

**Status:** **Accepted (20 August 2026)**, landed with F3 in migration 0010. Raised as Proposed at F0.

**One clause said less than the schema needed and one consequence was found only by running it.** Clause 2 specifies `fund_accounting_policy` on the `fund_alert_policy` pattern; that pattern is per fund and this table cannot be — see the amended clause 2. And the foreign key clause 1 adds makes delete **order** load-bearing wherever a round is hard-deleted; recorded under Consequences.

**Context.** `company_ownership` is dated, structured and correct in shape — and is written **only** by the Deal Close capture form, as part of capturing a round. There is no way to record an ownership change that is not attached to a round we captured, and Q-15 established that those changes are real and routine: an option pool expansion, a round we did not participate in, a secondary. Finance enters them **ad hoc, as word of the event reaches them.** No cadence, no reporting period, no batch.

Separately, Pat asked for a configurable significant-influence threshold with automatic flagging and a report. 10% is the standard rule; board seats create acknowledged grey areas.

**These two are one ADR because the second is worthless without the first.** A significant-influence flag derived from a stale ownership percentage is worse than no flag, because it looks authoritative.

**Decision.**

1. **`company_ownership` gains `change_reason` and an optional link to a causing round.** An ad-hoc adjustment that does not say what caused it is a number nobody can defend six months later, and this table feeds MOIC, the waterfall and — once the threshold lands — the accounting treatment of the company. The reason is required on the standalone path and not on the Deal Close path, because there **the round is the reason.**

2. **The threshold lives in `fund_accounting_policy`, effective-dated, on the `fund_alert_policy` pattern.** Same shape and same argument: this drives financial-statement treatment, a prior period's classification has to stay reproducible, and a policy that silently rewrote itself would reclassify a company in a board pack that was issued before the change. Setting a threshold **supersedes** the current row rather than updating it.

   **Amended on landing: the table carries no `fund_id`, and that is the one place it departs from the pattern it copies.** `fund_alert_policy` is per fund because a watchlist is a fund's watchlist. Significant influence is not — it is a property of NBIF's holding in an investee, `company_ownership` has no fund dimension at all, and `significant_influence_asof()` takes a company and a date. A `fund_id` here would have to be resolved from a company that has no fund, and that resolution would be an assumption written into SQL: invisible, and wrong the day a second fund exists. The table keeps the name this ADR gave it; what it holds is the accounting policy of the reporting entity. One open row at a time is enforced by a unique index on a constant.

3. **The migration inserts no policy row.** The behaviour change lands when someone sets the threshold on the Policies screen, deliberately, and not as a side effect of running a migration. Migration 0005 followed the same rule for the alert policy and for the same reason.

4. **`significant_influence_asof()` returns NULL, never false, when ownership is unrecorded.** "We hold no ownership figure for this company" and "this company is below the threshold" are different statements, and reporting the second when the first is true is how a company quietly drops off a schedule an auditor expects to find it on. This is D-5's rule — non-reporters are excluded, never counted as zeros — applied where the stakes are highest. NULL is also returned when no policy is in force, for the same reason.

5. **Configuration moves out of the Alerts tab into a Policies tab**, with two role-gated sections: *Portfolio Alert Policies* for `vc` and `admin`, *Finance Policies* for `finance` and `admin`. A clean move, not a copy. This improves the tab it leaves: Alerts was deliberately built as the **working** view — the feed, the flags, the acknowledgements — and configuration sitting inside it was always slightly the wrong shape. It also gives the finance policies that will accumulate (retention options, NBV rules, exit vocabularies) somewhere to live that is not the Finance entry tab.

   **Amended on landing: the tab holds the two policy sections and nothing else.** The significant-influence **schedule** is a fifth Finance surface, after Transactions, Valuation Marks, FMV Review and LP Activity. A rule and the work the rule produces are different things — the threshold is configuration, set rarely and by one role, while the schedule is a register Finance reads and a cap table Finance maintains. Decided by Cameron on the day F3 landed.

6. **Standalone ownership entry is gated to `CAN_CAPTURE_ROUND`**, which is where the table is already permitted. Q-15's expectation is that Finance enters these and Finance already holds that capability; leaving the deal lead able to record a cap-table change they learn about first costs nothing.

**Consequences.**
- The significant-influence report groups companies with no ownership figure separately, under *ownership not recorded* — visible rather than silently absent, and actionable through the entry form on the same screen. **The heading names the cause**: with no threshold in force every company reads NULL and none of them is missing a figure, so in that state the group is headed *not determined — no threshold in force*. Heading it the other way would send Finance chasing 82 cap tables that are already recorded when what is missing is one policy.
- **The causing-round link makes delete order load-bearing wherever a round is hard-deleted.** The foreign key is `no action`, checked at end of statement, so clearing rounds before the positions that name them now fails. That is the constraint doing its job — a round a cap-table position cites should not be destroyable out from under it — and the cost is that the A6 generator's clear step and the A8 test cleanup both had to name the children first. Nothing in the application hard-deletes a round; it soft-deletes, and a soft delete is unaffected.
- **The effective dating is day-grained, in both directions.** A policy set and superseded on the same date covers no date at all, and a classification reproduced for that day reads *not determined* rather than guessing which of the two applied. `fund_alert_policy` behaves identically. Stated here because it looks like a bug the first time it is met and is the honest answer.
- **The ownership figure's age travels with every row of the report.** This ADR's own argument is that a flag over a stale cap table looks exactly as authoritative as one over a current one; the schedule therefore states how old each figure is and leaves the judgement there. No staleness threshold is invented, because nobody has set one.
- Until the board-seat override exists (Q-7) the report carries a note saying the flag is derived from ownership alone and that grey areas are known to exist. The override is additive to a flag that already works, so waiting costs no rework.
- A company at exactly the threshold is flagged. The inclusive reading is what gets built and asserted; Pat confirms it rather than the code assuming it silently.

---

## ADR-036 — Portfolio membership follows Affinity's roster status; the exit event is a separate financial fact that does not move a company between views

**Status:** **Accepted (20 August 2026)**, landed with F4 in migration 0011. Raised as Proposed at F0. Amends ADR-009.

**The probe clause 5 demanded was run first, and it cleared the gate.** 354 list entries, 2 carrying `Exited`, both already on the roster — so the control totals did not move and F4 was a derivation change rather than a data change. The measurement is in the F4 build-log entry and reproducible with `npm run affinity:exits`.

**One clause needed more than it said**, and it is amended in place below: clause 1 decides membership from the roster status, and the rule for *which* status meant what was a hardcoded Set in the sync. See the amended clause 1.

**Context.** The platform needs an Exited view, and the first design for it was wrong. It proposed that the platform hold its own exited state, reasoning that the Affinity sync never deletes, so a company removed from the active view would keep arriving every night. The premise was right and the conclusion did not follow: the sync's own rule — **membership from Status rather than from which saved view a row arrived in** — already handles this. A company arriving every night with Status `Exited` is not a problem to work around; it is the answer.

**Decision. Two things that were conflated are separated, and neither owns the other.**

| | What it is | Who owns it | Where it lives |
|---|---|---|---|
| **Roster status** | Is this a portfolio company or an exited one? | The VC team, in Affinity | `company_state`, dated, synced |
| **Exit event** | We realized, or wrote off, this position on this date for this reason | Finance, in the platform | `company_exit` plus a `realization` / `write_off` transaction |

1. **A company with Status `Portfolio` is a portfolio company, regardless of a zero FMV and regardless of a Portfolio Status of "Winding Down".** Those are different Affinity fields. It becomes an exited company when, and only when, its Affinity Status changes to `Exited`. **There is no platform-side membership state.**

   **Amended on landing: which status means what is answered by `affinity_status_map`, not by a literal.** Membership was a hardcoded Set in `map.ts` — `{Portfolio, Exited, Closed}` — and this clause adds a second question of exactly the same kind. ADR-009 already requires status routing to be a table so a renamed or newly added option is a row edit rather than a deploy; answering the new question in a table while the old one stayed in code would leave the two rules a file apart, and the day they disagree is the day a company is on the roster and in neither view. Both are now columns on that table (`is_portfolio_member`, `is_exited`), the seed states them, and **a status nobody has classified is a member of nothing and exits nothing** — the safe default for an option added in Affinity on a Tuesday.

2. **They will usually agree, and they do not have to agree at every instant.** Finance may book a write-off in March; the roster status may not change until someone updates Affinity in June. Under a platform-side flag that lag would silently move a company out of the portfolio view. Under this model it is visible: the company sits in the Portfolio view carrying an exit event, which is exactly the sort of thing the reconciliation screen should list.

3. **`roster_status` goes on `company_state`, the dated table, not on `company`.** "When did this company leave the portfolio" is a question the board asks, and it deserves an answer with a date on it.

4. **The `exited` derivation carries a fallback, and the fallback is not a hedge.**
   ```
   exited = (roster_status = 'Exited')
         or (roster_status is null and a company_exit row exists)
   ```
   `exited` is in the frozen ADR-001 contract and the golden masters assert against a fixture that has no Affinity roster status at all. The fallback preserves the fixture path and every golden master untouched while making Affinity authoritative wherever it actually speaks. It is the honest expression of two sources with different coverage.

5. **F4 begins with a read-only probe, not a migration.** Status was profiled as 80/80 rows with one distinct value, always `Portfolio`, and was mapped as unused on that basis; the Exited view's companies were never in the extract. Before anything is written: pull the Status field's dropdown options from field configuration rather than observed values (ADR-009's own rule — options exist that no visible row has used), count entries by Status, and report how many carry `Exited`, whether any are already on the roster, and what their invested and FMV figures are. **If they bring new organisations onto the roster, the invested and FMV control totals move** — the same totals A6 reconciles to and A13 must tie to. Stop and decide with the numbers on the table.

**Consequences.**
- This follows the rule ADR-009 already sets and ADR-032 reaffirmed when the health-rating workflow was cut: Affinity is the system of record for company identity and status, the sync is one-way, and the platform does not build an edit box that would disagree with it. An exited flag maintained in two places would have the nightly sync silently winning the argument — the precise failure the health workflow was cancelled to avoid.
- **The A6 generator has a defect this exposes.** It writes a `company_exit` row wherever Affinity's *lifecycle* status reads "Winding Down" — a different field entirely — so **the 7 exited companies on today's dashboard are a generator artefact**, and under this model every one of them is still a portfolio company. Correcting it moves a visible number on the dashboard. That is a correction rather than a regression, and it is merged deliberately with the before and after recorded, not discovered by someone in a meeting.
- The exit-entry screen says on its face that recording an exit does not move the company between views. Otherwise the first person to use it will expect that it does.
- **The Exited view is two groups, and the second one is the point.** *Off the roster* is what Affinity says; *exit recorded, still on the roster* is Finance's half arriving first. Merging them would answer a different question from the one an auditor asks, and hiding the second would put the platform back in the business of picking a winner between two sources. The generated dataset now contains six of them, so the F6 reconciliation surface has something real to find.
- **The exit-type vocabulary is read from the CHECK constraint at both ends** — the form offers what the database accepts and the write path validates against the same list. FR-30 leaves open whether it is the vocabulary Finance reports on; when that is answered it is a migration, rather than two copies that have to be changed together.
- `company_state` appends only on genuine change, so a status transition produces exactly one new row on the night it happens. That convergence property is re-verified after the sync widens: a second run must create zero new rows.

---

## ADR-037 — LP commitments are dated events; `committed` becomes derived

**Status:** **Accepted 21 August 2026**, landed with F5 (migration 0012). Raised at F0 ahead of the code. Two clauses were amended on landing and both amendments are at the end: clause 4 gained the exact words Q-23 came back with, which are **not** the ones proposed here, and clause 5's flag needed a place to live.

**Context.** The LP model has three stages — commitment, drawdown, distribution — and two of them work. A drawdown is a `transaction` typed `capital_call`; a distribution is a `transaction` typed `distribution`. **The commitment is a scalar on the position**: `fund_investment.committed`, not dated, no source document, no way to record an increase as a fact.

Q-16 confirmed the three-stage model and disposed of the figures that had muddied it. The word that settles the design is **adjustable**: a commitment is not fixed at subscription, so it cannot be a column.

**Decision.**

1. **`fund_commitment` holds the commitment as at a date — an absolute, not a delta.** Same reasoning as the valuation ledger: an absolute that can be read directly beats a chain that has to be replayed, and an increase is a new dated row rather than an arithmetic puzzle. `fund_committed_asof()` reads the latest row on or before a date.

2. **Then the column is retired.** Backfill one row per position at inception, assert the total reconciles to the workbook's $8,725,000, run for one cycle with both in place and compared, and drop `fund_investment.committed`. **This pays down one of ADR-002's oldest debts** — the field inventory has listed `called` and `distributions` as "should be derived, MVP stores it separately" since A1, and this is the first of them to actually go.

3. **The contract does not change.** `FundInvestment.committed` stays a `$M` scalar; the API derives it instead of reading a column. `packages/metrics/lp.ts` is untouched, and TVPI, DPI, RVPI and IRR do not move. That is the ADR-001 boundary doing what it exists to do.

4. **The terminology rename changes the stored value, not just the label.** Funke's point stands on its own: from the fund manager's side a capital call is a demand for funds, while from ours the same event is a drawdown against a prior commitment. Renaming touches the `txn_lp_types` CHECK constraint, `TXN_TYPES`, `TXN_TYPE_LABELS`, the export adapter's cashflow-sign mapping, the fixture importer, the A6 LP generator and every test naming the string. **Doing it now costs an afternoon; doing it after A13 costs a data migration over fifteen years of history.**

5. **A drawdown exceeding the commitment in force is accepted and flagged, never refused.** Same principle as a round total below our own cheque, and the same reasoning: it is a real state of real data, and the platform's job is to surface it rather than make it un-recordable.

**Consequences.**
- Unfunded becomes `committed_asof − called to date`, derived at every point in time rather than only now. A commitment raised mid-life leaves the prior level readable at its own date.
- ~~**This phase is gated on one email, not on the meeting.** Q-23 asks Funke for the exact words — "commitment drawdown", or just "drawdown". Do not guess: the whole value of renaming now is that it happens once.~~ **Answered 21 August 2026, and the answer was neither option.** See the amendment below.
- NAV entry is unchanged and stays (Q-18, approved by Daniel). It informs LP TVPI, RVPI and IRR, and removing it would remove three metrics from a live screen rather than remove a field.


**Amended on landing, 21 August 2026.** Two clauses, and the first is the reason the phase was gated on an email.

### Clause 4 — the words are Funke's, and they are not the ones this ADR proposed

FR-33 recorded Funke's suggestion as **commitment / commitment drawdown / distribution**, and Q-23 went back to confirm it. The confirmed terminology is **Committed Capital, Capital Drawdown and Capital Distribution**. Three differences, each of which would have been wrong to guess:

- "Committed Capital", not "commitment" — a noun phrase that stands on its own in a column heading.
- "Capital Drawdown", not "commitment drawdown".
- "**Capital** Distribution", not bare "distribution" — which carries a bonus this ADR did not anticipate. Finding **S-6** records that `fund_distribution`, the fund's own realizations to its shareholder, collides with LP `distribution`, money coming back to *us* from a GP. Two opposite directions of travel under one word, separated now at the point where somebody reads a query.

The stored values are `capital_drawdown` and `capital_distribution`. `fee` is unchanged: a management fee is a fee.

**This is the whole argument for sending the email before the phase rather than during it.** Every one of the three differs from what the register recorded, and the register was a faithful minute of what was said in the room.

### Clause 5 — a flag needs somewhere to be, or it is only a message

The clause said a drawdown beyond the commitment in force is accepted and flagged. It did not say where the flag lives, and "the write path returns a warning" is not sufficient on its own: the warning reaches whoever happened to be typing, once, and nothing afterwards can find the position again.

So it is in two places. `v_lp_position_current.overdrawn` is the queryable state — **three-valued**, because NULL means no commitment is on record and that is not the same as "no, this is fine" (the discipline ADR-035 clause 4 set for significant influence). And `FinancialWriteResult.overdrawn` is the sentence the person who typed it sees, naming the position, both figures and the gap, because "overdrawn" alone sends them back to the ledger to work out by how much. F6's reconciliation surface reads the column rather than re-deriving the rule.

### What did not need amending

Clause 2's "run for one cycle with both in place and compared" had no cycle to run: nothing is deployed and the cashflows are synthetic. **The comparison discharges it instead, and discharges it harder than a cycle would** — migration 0012 raises and aborts if the backfilled ledger does not sum to the cent to what the column held, inside its own transaction, across every position rather than a sample, with the column still in place if it fails. The workbook's $8,725,000 is checked separately and as a *warning*, because a database built from the ADR-001 fixture holds the prototype's LP positions rather than NBIF's and is entitled to a different total.

Clause 3 held exactly as written. `LpCashflow` encodes direction as a **sign** and never names the event, so the rename stopped at one comparison in the export adapter. 252 golden masters and the 22 round-trip assertions passed unchanged.

---

## ADR-038 — The version store distinguishes a correction from information arriving late

**Status:** **Accepted 21 August 2026**, landed with F6 (migration 0013). Raised at F0 ahead of the code. Amends ADR-031. Two clauses were amended on landing and both amendments are at the end: clause 3 gained the place its rule is enforced, and **clause 4's duplicate rule was settled by measurement rather than by the date window it looked like it needed**.

**Context.** ADR-031 makes every financial edit a versioned change with a reason, and an edit inside a frozen reporting period is flagged as a **restatement**. Pat's requirement is that a grant which becomes known six months after the round can be added to that round **without it being treated as a data correction error**.

Under ADR-031 as built, both look identical in the change log, and one of them reads as an accusation. **The row's history was right; the label was wrong.**

**Decision.**

1. **`financial_row_version` gains `change_kind`** — `correction`, `new-information` or `initial-load`.

2. **Nullable, and NULL means unclassified.** Every row written before the migration genuinely is unclassified, and backfilling a guess would be worse than the gap. Required on updates going forward.

3. **`new-information` is selectable only where the row falls inside a frozen period.** Outside one there is nothing to restate and the distinction is noise; offering it everywhere would train people to pick one at random. The existing `ReasonField` component becomes reason plus kind.

4. **The duplicate-round check is a warning with a mandatory acknowledgement, never a hard block.** Detect a same-company, same-normalised-label round; refuse the plain save; require a reason stored on the row. The codebase's own precedent is that a round total below our own cheque is *accepted and flagged, never refused*, because pushing someone into fudging a figure to get past a form is worse than the figure being wrong and visible. "Series A" and "Series A extension", and a second tranche of one raise, are all real.

**Consequences.**
- Q-9 — what counts as a duplicate — tightens the rule later without a rebuild. Built as a warning, it cannot be got wrong in a damaging way: too loose and it under-fires, too tight and it is clicked through.
- The change log becomes readable by someone who was not there. A restatement of a wrong figure and a late-arriving grant stop looking like the same event, which is the whole of FR-14.


**Amended on landing, 21 August 2026.** Two clauses, and the second is the one worth reading.

### Clause 4 — the duplicate rule needed no date window, and the measurement is why

This clause says "detect a same-company, same-normalised-label round". Measured against the data before building it, that rule fired **32 times and was wrong all 32**: the closest same-label pair in the portfolio was **256 days apart**, so every one was a genuinely separate raise years later. The obvious repair was a date window — same label *within N days* — and it would have been a number nobody chose.

**29 of the 32 turned out to be a generator artefact.** `plan.ts` has held the round ladder's rung 25% of the time since A6, with the comment *"a bridge holds the rung"*, and then emitted the parent's label unchanged — so one company raised "Seed" in 2017, 2019 and 2022.

Funke's description of the real thing is the fix, and it arrived while F6 was being specified: bridged funding *"shows up as a qualifier, like an adjective — after a Series A, the company needs funding but doesn't want to go for a Series B, so it goes for a bridge which is still under the Series A."* **Real Finance-entered data disambiguates by name.** The generator was corrected to name its bridges and the false pairs went to zero.

**So the rule is normalised label alone, exactly as this clause specifies, with no window.** A window would have compensated for a defect in the demo data, and it would have quietly stopped catching the case FR-08 actually names: two "Series A" rows entered a year apart because somebody forgot the first one. Finance owns this entry path and is accountable for it; the warning catches the slip.

**Normalisation is deliberately not fuzzy** — case-folded, punctuation removed, nothing else — and it lives in `pc.normalise_round_label()` so the index, the write path and the reconciliation view cannot disagree about what "the same label" means. **Q-9 tightens all three by changing one function.**

### Clause 3 — enforced where the answer is already known

The clause says `new-information` is selectable only inside a frozen period. That is a UI rule as written, and a UI rule is one a caller that is not the UI can ignore. It is enforced in `checkRestatement`, which is the one function that already computes whether a change restates — and it reads the kind from the **session GUC** rather than from a new argument, because `setSessionContext` has to put it there anyway for the capture trigger. Threading it separately would have created a second authority on one answer.

### What clause 4 gained that it did not specify: a status of its own

"Refuse the plain save" needs the client to be able to tell this refusal from any other. A 400 saying "that looks like a duplicate" leaves the form with nothing to offer but the same button again. So the write path raises `DuplicateRoundError` and the route maps it to **409 carrying the colliding round**, which is what lets the form name it and ask the one question that clears it. **A warning the interface cannot act on is a hard block wearing a softer message**, which is what this clause refuses.

---

## ADR-039 — The agreed Affinity control totals are frozen at F0; total invested is pushed back to Affinity only once the platform's own figures are trustworthy

**Status:** **Split, and the two halves now have different statuses** — see the amendment of 20 August 2026 at the end, which is the current authority on both.

- **Clause A, the frozen baseline: Accepted and executed, 19 August 2026.** `affinity_control_snapshot` holds 82 companies at $47,216,678.00 invested and $42,030,272.00 FMV.
- **Clause B, the outbound write: Proposed, and deliberately undated.** It is **not** part of A13. Amends ADR-009 when it lands, and not before.

*The original title read "Total invested is pushed to Affinity at cutover and becomes read-only there; the pre-cutover figures are frozen before the first write." It is restated above because the sequencing in it is wrong — see the amendment.*

**Context.** ADR-009 states the Affinity rule categorically: **the platform never writes back.** ADR-011 makes the platform the registry for transaction records, and Pat's concern in the meeting was the obvious consequence — *"if transaction data lives in both this platform and Affinity, there is a risk of maintaining two sets of records that could diverge over time."* Affinity currently holds an independently maintained Total Investment Amount per company.

Q-17 settles the sequence. Until cutover the platform **reads** the figure to calibrate the A6 generator. **At A13 the direction reverses in a single event:** the platform stops reading it, extracts total invested per company from the loaded transaction history, and pushes it to Affinity, where the field becomes read-only and is never edited by hand again. Ownership of the figure moves to Portfolio Command.

**Decision.**

1. **This is a real exception to ADR-009 and is recorded as one, in ADR-009 itself as well as here.** It is one field, one direction, one event, at cutover — not a two-way sync and not a feature the nightly job acquires. A reader who finds ADR-009 first must not come away with a rule that is no longer whole.

2. **The pre-cutover figures are frozen before the first outbound write, and F0 is where that happens.** `company.affinity_total_investment` and `company.affinity_fmv` are simultaneously the A6 generator's reconciliation anchor, the agreed A13 control totals, and the fields the write will overwrite. **After the write, reconciling against them proves nothing** — the platform would be checking its arithmetic against its own output.

3. **`affinity_control_snapshot` is written once and never again.** It stores the company name verbatim alongside the id, so a later rename in Affinity is visible rather than silently absorbed. **A13 ties to this table, not to the live column.**

4. **It is taken now rather than at A13**, which is the whole point of raising this ADR at F0 rather than at cutover. A snapshot of a figure you are about to overwrite is worth nothing if it is remembered afterwards, and A13 is the phase with the least spare attention in the programme.

**Consequences.**
- The snapshot is insurance with a known expiry: it is the reconciliation baseline for exactly one event and is then a historical record. That is fine — it costs one table and 82 rows.
- The platform's outbound surface is one field. If a second one is ever proposed, this ADR is the precedent to argue against rather than from: the case here rests on ADR-011 already making the platform the registry for *that specific figure*, and no other Affinity field has that property today.
- ADR-020's note that Affinity's figures are "stored as labelled reference columns … never entering a calculation" survives up to cutover and then stops being true in one direction: after A13 the column is our output, and the platform must stop reading it. Both halves are recorded in ADR-009.

**Amended 20 August 2026 — the write moves out of A13, and the snapshot's justification is re-based onto the reason that does not depend on it.** This supersedes the sequencing in the context and in clauses 1, 2 and 4 above, and in the original title. Raised by Cameron; this is the correction a Proposed status exists to make cheap.

### What was wrong

Clause 1 said the write happens "at cutover", reading Q-17's *"push at A13"* as naming the phase. **It does not, and the distinction matters.** The push requires total invested per company to be extracted from **live, trustworthy transaction history that Finance has verified** — which is an *output* of A13, available only after the load has reconciled batch by batch and Finance has signed off on the result. Putting it inside A13 makes the riskiest phase in the programme also the phase that performs the platform's first irreversible write to a system it does not own, on figures whose verification is the same phase's exit criterion. That is a sequencing error, not a wording one.

**Clause B is therefore separated and deliberately left undated.** It happens when the platform's own figures are trustworthy, which is a judgement Finance makes after A13, and it gets its own decision to proceed at that point.

### What does not change, and why the snapshot stays

**In the meantime nothing about the current workflow moves.** The platform continues to read `company.affinity_total_investment` and `company.affinity_fmv` nightly, and the A6 generator continues to work backward from them so synthetic rounds and marks roll up to figures the VC team recognises (ADR-020, ADR-030). No code changes, because the outbound write was never built.

**And the snapshot is kept.** Clause 2 justified it as insurance against the write, which was the reason the meeting surfaced but not the strongest one available — and with the write now indefinite, an insurance-only reading would make the table look like dead schema. **Three reasons stand on their own:**

1. **The agreed control totals were agreed at an instant; the columns holding them are not.** They are synced nightly and VC-team maintained, and ADR-020 already records how volatile that makes them: one deal's Potential Investment Amount ran 1,000,000 → 500,000 → deleted → 1,000,000 → 1,500 → 1,500,000, the fat-finger corrected 33 seconds later. A13 is months away. If the anchor is a live column, then "each batch reconciles to Finance's control totals" is not a reproducible instruction — a failure at A13 cannot be told apart from Affinity having moved underneath it. **The snapshot is what separates "our load is wrong" from "the target moved", and there is no other artefact in the programme that does.**
2. **F4 may deliberately move them.** Its discovery step could bring Exited companies onto the roster who are not among the 82, which changes both totals on purpose. The snapshot is what makes that decision recoverable rather than a one-way door — already stated in the F4 gate.
3. **It is the only one of the three that could not be taken later.** The other two arguments would still be true in six months; the ability to act on them would not.

The cost of keeping it is one write-once table and 82 rows, already reconciled to the cent. The cost of having been wrong the other way is that the moment had passed.

### Consequences of the amendment

- **A13's scope shrinks by one bullet.** The roadmap's A13 entry no longer carries the outbound write; it carries a pointer to this clause instead. A13's exit criteria are unchanged, and the phase remains the one where the platform stops being a demo.
- **ADR-009's stated exception becomes conditional rather than scheduled.** It is recorded there as a Proposed exception with no date, not as something the cutover plan performs. The one-way rule holds in full until clause B is separately accepted.
- **`affinity_control_snapshot` is now correctly read as an A13 control artefact first and write-back insurance second.** Its table comment is updated to say so; migration 0006 is applied and checksummed, so the correction lands as a comment-only migration rather than an edit (the migration runner refuses an edited file, by design).
- **The label `pre-cutover baseline` is still right.** Pre-cutover, not pre-write: it is the state of the anchor before A13 loads anything, which is what the reconciliation needs it to be.

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
| ~~A‑9~~ | ~~Walk the transaction and mark entry workflow through with the Director of Finance before building it~~ — **closed 19 August 2026.** Held with Pat McMullon and Funke Yusuf against the synthetic dataset. Satisfies ADR-020 condition 4 for the A7 and A8 surfaces and produced the finance requirements register, the design notes and Track F. See the ADR-020 amendment. | — |
| A‑10 | Second Finance meeting: the five question blocks in `docs/finance-design-notes.md`. Block 2 (net book value) is the one worth protecting. Blocks FR-17, FR-20, FR-22 to FR-26 and FR-31 | Systems & Data Analyst + Finance |
| A‑11 | One email to Funke: the exact LP wording (Q-23). Gates F5 and nothing else | Systems & Data Analyst |
| A‑12 | Obtain the pedal report file from Pat. The non-investment leverage fields cannot be designed without the format they have to produce | Finance |
| A‑3 | Issue the staging templates to Finance and reconcile a first batch against agreed control totals | Systems & Data Analyst + Finance |
| A‑4 | Build the company crosswalk — Finance name → Affinity organisation → internal company_id — before any transaction loads | Systems & Data Analyst |
| A‑5 | Establish how far back *per-company* marks exist, as opposed to fund-level NAV only | Finance |
| A‑6 | ~~Walk D‑1 and D‑6 through with the VC team lead~~ — **complete, 28 July 2026** | Systems & Data Analyst |