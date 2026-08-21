# Portfolio Command — Finance Current State

**As built through A9, 18 August 2026.** This is the baseline the finance requirements are measured against. Everything below is what the platform does *today*, not what it is intended to do.

Three things frame every entry in this document:

1. **All financial data is synthetic** (ADR-020). 282 transactions, 177 rounds, 1,015 marks, 16 LP positions and 69 NAV snapshots hang off the real 82-company Affinity roster and reconcile to Affinity's own control totals — $47,216,678 invested and $42,030,272 FMV, to the cent. Real history lands once at A13.
2. **Nothing derivable is stored** (ADR-002). Invested, FMV, realized, MOIC, TVPI and every other scalar is computed from transactions, rounds and marks at read time. There is no "total invested" column anywhere that a person maintains.
3. **Money is stored in dollars** as `numeric(18,2)`, never floats, never millions. The API converts to $M in exactly one place on the way out, because Daniel's export contract is expressed in $M.

---

## 1. The financial entities

### 1.1 `transaction` — the registry

**Every dollar that moves is a row here, and nothing else stores money movement** (ADR-011). This is the table the meeting agreed should be NBIF's source of truth.

| Column | Type | Notes |
|---|---|---|
| `transaction_id` | bigint PK | |
| `txn_date` | date | The effective date. |
| `booked_at` | timestamptz | When it was entered. |
| `txn_type` | text | `investment`, `follow_on`, `realization`, `write_off`, `capital_call`, `distribution`, `fee` |
| `company_id` | text FK | Direct portfolio subject. |
| `fund_investment_id` | text FK | LP position subject. |
| `investment_round_id` | bigint FK | **Nullable.** The round this cheque belongs to. |
| `investment_vehicle_id` | int FK | VCF / SIF / ACC (ADR-030). NULL = unrecorded, never defaulted. |
| `amount` | numeric(18,2) | **Always positive.** Direction is implied by `txn_type`. |
| `currency` / `fx_rate_to_cad` | char(3) / numeric | Rate at the transaction date, not today's (ADR-021). |
| `source_document` | text | SharePoint or bank record link. |
| `note` | text | |
| `entered_by` | uuid FK | |
| `batch_id` | uuid | Groups a bulk load; reversible wholesale. |
| `is_synthetic` | boolean | Drives the ADR-020 banner. |
| `voided_at` / `voided_by_transaction_id` / `reverses_transaction_id` | | Legacy reversal columns, retained for real economic reversals (clawbacks) and for legacy history at A13. |
| `row_created_at` / `row_updated_at` / `deleted_at` / `deleted_by` / `deleted_reason` | | ADR-031 lifecycle. |

**Four database constraints, all enforced:**

- `txn_one_subject` — exactly one of `company_id` or `fund_investment_id`. Never both, never neither.
- `txn_direct_types` — a company transaction must be `investment`, `follow_on`, `realization` or `write_off`.
- `txn_lp_types` — a fund transaction must be `capital_call`, `distribution` or `fee`.
- `txn_fx_present` — a non-CAD amount must carry an FX rate.

### 1.2 `investment_round` — the round, and the mandate fields

| Column | Type | Notes |
|---|---|---|
| `investment_round_id` | bigint PK | |
| `company_id` | text FK | |
| `round_date` | date | |
| `label` | text | Free text: "Seed", "Series A". The round is called what it is called. |
| `instrument_id` | int FK | **NOT NULL.** From `ref_instrument`. |
| `investment_vehicle_id` | int FK | |
| `round_total` | numeric | **Drives the leverage KPI.** NULL means unknown and is *excluded* from leverage, never imputed. |
| `nb_other` | numeric | Capital from *other* NB investors, excluding ours. **Drives the NB co-investment KPI.** |
| `post_money` | numeric | NULL for SAFE / convertible note by design. |
| `ownership_after_pct` | numeric(19,16) | |
| `lead_investor` | text | |
| `note` / `source_document` | text | |
| `captured_by` / `captured_at` | | Records that a deal lead has been through the capture form. |

Constraints: `round_total >= 0`; `nb_other <= round_total`. Deliberately **not** constrained: a round total below our own cheque, which is accepted, flagged, and excluded from leverage rather than refused.

### 1.3 `round_coinvestor`

`investor_name`, `fund_investment_id` (set when the co-investor is one of our own LP positions), `is_nb_based`, `amount` (**nullable by design** — ADR-015: early rounds carry names without figures and no process can now recover them).

### 1.4 `valuation_mark` — the only source of FMV

| Column | Notes |
|---|---|
| `company_id`, `effective_date` | 31 January and 31 July are the effective dates. |
| `booked_at` | Trails `effective_date` by two to three months. |
| `fmv` | numeric, `>= 0`. **An absolute figure, not a delta.** |
| `valuation_method_id` / `method_label` | Resolved key + verbatim string (ADR-026). |
| `rationale` | **NOT NULL.** The audit narrative. |
| `prepared_by` / `prepared_by_label` | Set from the authenticated user — entry *is* the sign-off (ADR-007). |
| `status` | `draft` / `final` / `superseded` |
| `supersedes_id` | The restatement chain. |

**Unique index:** one `final` mark per company per effective date.

### 1.5 `company_ownership`

Dated cap-table position: `as_of_date`, `ownership_pct`, `pro_rata_rights`, `fully_diluted`, `source_document`. Unique on (company, date). Written only by the Deal Close capture form.

### 1.6 `company_exit`

`exit_date`, `exit_type` (`Acquisition`, `Strategic acquisition`, `IPO`, `Secondary`, `Shutdown / write-off`), `note`, `recorded_by`. **The table exists; no interface writes to it.** The A6 generator creates a row only where Affinity's lifecycle status reads "Winding Down".

### 1.7 LP positions

- **`fund_investment`** — `committed` is a **scalar on the position**, not an event. Also `manager_name`, `strategy`, `vintage_year`, `co_invest_rights`, `women_senior_gp`, `next_call_est`, `agm_date`, `ir_contact`, `rationale`, plus three carried-not-derived fields (`co_invests_done`, `referrals`, `capital_to_direct`) that ADR-027 wants derived from `round_coinvestor` once capture exists.
- **`fund_investment_nav`** — dated GP capital-account statements: `as_of_date`, `nav`, `statement_received_at` (so the reporting lag is visible).
- **Capital calls and distributions are `transaction` rows** typed `capital_call` / `distribution` / `fee` against a `fund_investment_id`.
- **`fund_distribution`** — a *separate* table for fund-level realizations from the direct portfolio (ADR-025). **This is not an LP distribution and the name collision is a live hazard.** Currently empty, no UI, and a stated exception to ADR-002 with an end date of A13.

### 1.8 Supporting tables that finance work will touch

- **`company_gov_funding`** — `program_name`, `amount`, `conditions`, `status`. Company-level, **not round-level, and not in any leverage calculation.**
- **`fund_nav_snapshot`** — `period_end`, `nav`, `cumulative_cost`, `frozen_at`. Once frozen, never recomputed.
- **`fund_alert_policy`** — effective-dated portfolio-wide thresholds (A9). The pattern the significant-influence threshold should copy.
- **`reserve_allocation`**, **`company_state`**, **`company_risk_flag`**, **`alert_acknowledgement`**.

### 1.9 Reference vocabularies

| Table | Values |
|---|---|
| `ref_instrument` | SAFE, Convertible Note, Debt-to-Note, Preferred Equity, Common Equity |
| `ref_valuation_method` | Last round, Revenue multiple, Calibrated last round, Scenario-weighted, Write-off, Realized |
| `ref_investment_vehicle` | VCF, SIF, ACC |

---

## 2. Relationships as they stand

```
company ──< transaction >── investment_round        (transaction.investment_round_id, NULLABLE)
        │                          └──< round_coinvestor
        ├──< valuation_mark
        ├──< company_ownership
        ├──< company_exit
        └──< company_gov_funding

fund_investment ──< transaction        (capital_call | distribution | fee)
                └──< fund_investment_nav
```

**The cardinality that is actually enforced today:**

| Relationship | Enforced | Consequence |
|---|---|---|
| Transaction → 0 or 1 round | Yes, nullable FK | A standalone cheque is legal. Correct. |
| Round → 0..n transactions | Yes, by implication | **A round with no transaction is legal and indistinguishable from three other states** — see §4. |
| Round cannot be deleted while transactions point at it | Yes | Guarded in `rounds.ts` with a message naming the count. |
| Transaction has exactly one subject | Yes, CHECK constraint | |
| One final mark per company per date | Yes, unique index | **Blocks a second same-day mark** — see §4. |

---

## 3. Derived metrics — the current definitions

Nothing here is stored. Every figure is computed at read time from the three fact tables.

### Views and functions

| Object | What it does |
|---|---|
| `v_transaction_live` | Live rows only — excludes voided, reversals and soft-deleted. Adds `amount_cad` using the transaction-date FX rate. |
| `v_company_invested` | `Σ amount_cad where txn_type in (investment, follow_on)`, plus `first_investment_date`. |
| `v_company_realized` | `Σ amount_cad where txn_type = realization`. |
| `company_fmv_asof(company, date)` | Latest `final` mark on or before the date. **Falls back to cost when a company has no mark.** |
| `v_round_leverage` | Rounds with a usable total. |
| `v_lp_capital_to_direct` | Derived from `round_coinvestor`. Reads $40.66M across 15 positions. |
| `v_mandate_completeness` (+ `_by_year`) | Capture coverage. Currently **84.7%** of rounds carry a total, with the ADR-015 taper visible by year. |
| `v_company_current` | Current-state roll-up per company. |
| `v_financial_change_log` / `v_restatement_log` | ADR-031 audit surfaces. |
| `<table>_asof(timestamptz)` | Reconstructs any of six financial tables as at a past instant. |

### Metric definitions (`packages/metrics`)

| Metric | Definition |
|---|---|
| **MOIC** | (FMV + realized) / invested — direct portfolio, on invested cost |
| **TVPI** | (NAV + realized proceeds) / invested cost |
| **DPI** | realized proceeds / cost |
| **RVPI** | NAV / cost |
| **Gross IRR** | Since-inception XIRR of round outflows, realizations, and current NAV as terminal value |
| **Net IRR** | Gross − `feeDragPct`, labelled an estimate on screen |
| **Dry powder** | `capitalBase − invested + realizations` (evergreen framing) |
| **Leverage** | `(Σ roundTotal − Σ our invested) / Σ our invested`, over rounds with a valid total only. Currently **5.9 : 1 from 150 of 177 rounds** |
| **NB co-investment** | `Σ nb_other` |
| **LP TVPI / DPI / RVPI** | On **called** capital, per LP convention — never blended with direct MOIC |
| **LP IRR** | Position XIRR over calls and distributions with current NAV as terminal value |

**NAV** = the sum across companies of each company's most recent final mark on or before the date, with unmarked companies held at cost. It changes between valuation cycles only through new capital deployed at cost, which produces two near-flat quarters a year followed by a step. That is correct behaviour and is labelled on screen, not smoothed.

---

## 4. What is built, and where the seams are

### Built and working

- **Finance tab** (`finance`, `admin` only) — transaction entry with filters, valuation-mark entry, LP NAV entry, running totals net of deletions, and a per-row change history with a field-level diff.
- **Deal Close tab** (`vc`, `finance`, `admin`) — round total, co-investors with NB flag and amounts, ownership after the round, pro-rata rights, post-money. **One mutation, one database transaction, three tables** — a round total cannot save without its co-investors.
- **Edit with a mandatory reason.** Every mutation writes the prior row image to `financial_row_version` **by database trigger**, so an `UPDATE` typed into psql is captured identically to one through the form. The trigger raises unless the session names an actor. No financial row can change anonymously by any route.
- **Restatement detection.** Editing inside a frozen `fund_nav_snapshot` period is permitted, flagged, and requires a reason. `v_restatement_log` is the list.
- **Soft delete and restore.** `deleted_at` removes a row from every view and total, and is reversible.
- **Leverage auto-calculation** from co-investors with the NB split, with coverage reported beside it.
- **Effective-dated policy configuration** (`fund_alert_policy`), with three distinct threshold states: absent means inherit, `0` means disabled, `n` means override.

### The seams — as-built gaps, before any new requirement is considered

These are findings from reading the current build, not requests from the meeting. Each is relevant to the finance work.

**S-1 · Nothing in the UI links a transaction to a round.** ~~*As built.*~~ **Closed 20 August 2026 by F1** — `link-transactions`, reachable from both surfaces. The original finding is kept below because it is what the fix was measured against. The Finance tab shows `investmentRoundId` **read-only**, with a note saying it is set on the Deal Close tab. The Deal Close capture writes `investment_round`, `round_coinvestor` and `company_ownership` — and, in the build log's own words, *"a capture writes no transaction"*. The API accepts `investmentRoundId` on a transaction and the tests set it directly, so the field is writable; **no screen sets it.** Every link in the current database was written by the A6 generator.

**S-2 · A round with no transaction is four states collapsed into one.** ~~*As built.*~~ **Closed 20 August 2026 by F1** — `nbif_participated` separates (a), and `transaction.standalone_confirmed_at` separates (c) from a cheque nobody has reviewed. The original finding is kept below. It may mean: (a) we did not participate; (b) we participated and the cheque is not yet booked; (c) we participated, the cheque is booked, and nobody linked it (see S-1); (d) an entry error. `ourInvested` reads $0 in all four cases. There is no participation flag.

**S-3 · One final mark per company per effective date blocks legitimate same-day marks.** ~~*As built.*~~ **Closed 20 August 2026 by F2** — the index now constrains one *review* per company per date, and gained `deleted_at is null` so it agrees with the application check. The original finding is kept below. Two follow-ons on one date, or a transaction landing on a review date, cannot both produce a mark under the current unique index.

**S-4 · `company_exit` has no write path.** ~~*As built.*~~ **Closed 20 August 2026 by F4** — `/api/v1/exits` and the Exited tab, gated on `CAN_WRITE_FINANCIAL`. The original finding is kept below because it is what the fix was measured against. The second half of it was answered differently than it was posed: no view filters the active portfolio on an exit event, and none should — membership follows Affinity's roster status (ADR-036), and the exit event is a separate fact that deliberately does not move a company between views. The table, the `exit_type` vocabulary and the `write_off` / `realization` transaction types all exist. No interface creates an exit, and no view filters the active portfolio on one.

**S-5 · Transactions carry no instrument.** `instrument_id` is on the *round*, and `company.instrument_id` is a separate independent fact. A cheque itself has no debt/equity classification, so a company holding both equity and a loan cannot be split at transaction level.

**S-6 · `fund_distribution` has a write path and no UI**, is empty, and is a stated exception to ADR-002 whose resolution is deferred to A13. ~~Its name collides with LP distributions, which are `transaction` rows.~~ **The name collision closed 21 August 2026 by F5**, as a side effect rather than as its object: FR-33's confirmed terminology makes the LP row a `capital_distribution`, so the two opposite directions of travel no longer share a word. The rest of S-6 stands — the table is still empty, still has no UI, and its ADR-002 exception is still deferred to A13.

**S-7 · LP `committed` is a scalar, not an event.** ~~*As built.*~~ **Closed 21 August 2026 by F5** — `fund_commitment` holds the commitment **as at** a date, `fund_committed_asof()` reads the level in force, and `fund_investment.committed` was dropped in the same migration after the backfilled ledger reconciled to the column to the cent and to the workbook's $8,725,000. The original finding is kept below. There is no commitment date, no commitment document, and no way to record an increase to a commitment as a dated fact.

The second half of it was answered more fully than it was posed: the date and the document are columns now, and so is the *reason* — a commitment that cannot say what set it is a number nobody can defend, which is the rule F3 established for ownership (ADR-035 clause 1) applied to the same shape of fact.

**S-8 · `company_gov_funding` is disconnected from leverage.** Grants are captured per company with no round attribution and enter no calculation.

**S-9 · Affinity integration is one-way inbound.** ADR-009's rules are explicit: one-way, upsert never truncate, never delete. `company.affinity_total_investment` and `company.affinity_fmv` are stored **REFERENCE ONLY, never an input to a calculation** — and they are also the control totals the A6 generator reconciles against.

**S-10 · Two mandate figures can legitimately disagree and only the capture form shows it.** ~~*As built.*~~ **Closed 21 August 2026 by F6** — `v_reconciliation` surfaces the disagreement on a screen people visit deliberately, naming both figures side by side, and the Reconciliation tab lists it with the seven other checks. The original finding is kept below. `nb_other` and the sum of NB-flagged co-investor amounts are separate captures. The KPI uses `nb_other`. No dashboard surfaces the disagreement.

**The finding held; the demo data did not.** Building the check exposed that the A6 generator drew `nb_other` and each co-investor's amount as independent draws over the same quantity, so 59 of the 81 eligible rounds disagreed — by 3–6×, not by rounding — and the check would have fired on 73% of what it could see on the day it shipped. The generator now allocates the NB co-investor amounts to sum to `nb_other`, leaving roughly one round in ten disagreeing on purpose. `nb_other` itself is untouched: it feeds the mandate KPI, and re-deriving it from the co-investors would have moved a board figure to fix a data-quality artefact.

---

## 5. Roles

Four roles from ADR-005: `vc`, `finance`, `leadership`, `admin`. Authorisation is a role check against `app_user.role` — Entra proves identity, the platform decides permission.

| Capability | Roles | Covers |
|---|---|---|
| `CAN_READ` | all four | Leadership reads everything and writes nothing. |
| `CAN_WRITE_FINANCIAL` | `finance`, `admin` | transactions, valuation marks, LP NAV, fund distributions |
| `CAN_CAPTURE_ROUND` | `vc`, `finance`, `admin` | rounds, co-investors, ownership |
| `CAN_EDIT_JUDGEMENT` | `vc`, `admin` | health, flags, milestones, covenants, reserves, thresholds |

**The split follows the source of record, not the table boundary.** Our cheque is Finance's fact and lives on `transaction`. The shape of the round around it — who else was in, for how much, what we ended up owning — is the deal lead's, from closing documents they hold. Finance keeps round access because A13 loads historical rounds through the same path.

---

## 6. Where this sits in the delivery plan

**Done:** A0–A9. Foundations, metrics port, API, Affinity sync, Visible sync, synthetic dataset, Finance entry interfaces, Deal Close capture, alerts and policy.

**Remaining:** A10 memo builder · A11 reports and board PDF · A12 modelling · **A13 financial history port** · A14 go-live.

**Two things the build log has been carrying that this meeting directly answers:**

> *"A-9 still stands: walk the workflow through with the Director of Finance before this is relied on. ADR-020 condition 4 asks for it before building, and it has not happened — the interface was built to the roadmap's description. Treat the current forms as a proposal to walk through, not a finished spec."*

That walkthrough has now happened. The requirements register is its output.

The second is A13's standing risk: *does the schema match how Finance actually holds the data?* B2 — the early 5–10 company real sample — was withdrawn on 14 August, which moved that question to cutover on everything at once. **This meeting is the first real evidence about the answer, and it arrived before A13 rather than during it.** Several requirements below are schema-shaped, and they are far cheaper now than they will be with fifteen years of history loaded.
