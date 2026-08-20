# Finance Requirements Register

**Version 2, 19 August 2026** — supersedes v1. Updated with Cameron's review comments on FR-18, FR-19, FR-21, FR-29, FR-32, FR-35 and design questions Q-15 to Q-18.

**What changed in v2:**
- **FR-18 is resolved.** The percentage is *retained value*, not a write-down. This was the single most dangerous ambiguity in v1 and it is now settled.
- **FR-29 is substantially rewritten.** v1 proposed a platform-side exit state controlling portfolio membership. That is wrong: membership follows Affinity's roster status, and the platform needs an **Exited view** rather than its own flag. This also surfaces a defect in the A6 generator.
- **FR-36 is new**, arising from the Q-15 answer: Finance maintains ownership between rounds, ad hoc.
- **FR-02, FR-32 and FR-35 are settled**; FR-19 and FR-21 gained concrete design direction.

**Source:** Portfolio Command finance requirements meeting — Pat McMullon (Director of Finance), Funke Yusuf (Controller), Cameron Horwood.
**Baseline:** `finance-current-state.md`, as built through A9.

Every requirement below is traced to what was said, checked against what the platform already does, and given a disposition. **Nothing here is a design decision yet** — the ones that need one are cross-referenced to `finance-design-notes.md`.

**Reading the columns.** *Schema* flags a database change, which matters because every one of them is materially cheaper before A13 loads fifteen years of history than after. *Size* is S (hours), M (a session or two), L (a phase of its own).

---

## A · Source of truth and system boundaries

### FR-01 · The platform is the single source of truth for transaction records
**Said by:** Pat McMullon. *"If transaction data lives in both this platform and Affinity, there is a risk of maintaining two sets of records that could diverge over time."*
**Current state:** Already the standing decision (ADR-011). `transaction` is the registry; `company.affinity_total_investment` is stored REFERENCE ONLY and never enters a calculation.
**Gap:** None in the platform. The gap is organisational — Affinity currently holds an independently maintained figure.
**Disposition:** Confirmed, no work. Record as ratification of ADR-011 by the Director of Finance.
**Size:** — · **Schema:** No

### FR-02 · Push calculated total invested per company back into Affinity
**Said by:** Pat McMullon, agreed by the group. Next step 2.
**Current state:** The Affinity sync is **one-way inbound** by explicit rule (ADR-009): one-way, upsert never truncate, never delete.
**Gap:** This is the platform's first outbound write to a system of record it does not own. It needs an ADR of its own, not a feature ticket.
**Resolved by Cameron (Q-17):** the sequence is explicit. Until cutover the platform *reads* the figure from Affinity to drive the A6 generator. **At A13 the direction reverses in a single event** — the platform stops reading it, extracts total invested per company from the loaded transaction history, and pushes it to Affinity, where **the field becomes read-only and is never edited by hand again.** Ownership of the figure moves to Portfolio Command.
**One consequence to act on now:** `affinity_total_investment` is currently both the A6 reconciliation anchor and the agreed A13 control total. **Once we write our own figure into it, reconciling against it proves nothing** — the platform would be checking its arithmetic against its own output. A frozen pre-cutover snapshot of Affinity's invested and FMV figures has to be taken **before the first outbound write**, and it should be taken now rather than remembered later.
**REFINED BY CAMERON, 20 August 2026 — the push is *after* A13, not part of it.** Q-17's *"push at A13"* was read as naming the phase. It does not. The push needs total invested extracted from **live transaction history that the finance team has verified**, which is an *output* of A13 rather than a step within it — and putting the platform's first irreversible write to a system it does not own inside the riskiest phase in the programme, on figures whose verification is that same phase's exit criterion, is a sequencing error rather than a wording one. **It has no date and will not get one until the platform's own figures are trustworthy**, at which point it takes its own decision to proceed.

**In the meantime the current workflow is retained unchanged and deliberately:** the platform keeps reading `affinity_total_investment` and `affinity_fmv` nightly, and the A6 generator keeps working backward from them so synthetic transactions and marks roll up to the top-level figures the VC team recognises.

**The snapshot is kept, and its justification is now the stronger one.** It was framed as insurance against the write; with the write indefinite that reading alone would make it look like dead schema. The reason that stands on its own is that **the control totals were agreed at an instant and the columns holding them are synced nightly** — so without a frozen copy, a reconciliation failure at A13 cannot be told apart from Affinity having moved underneath it. See ADR-039's amendment.

**Disposition:** Direction confirmed, **sequencing corrected**. The snapshot is **done** (F0, 19 August 2026 — 82 companies, $47,216,678.00 and $42,030,272.00, to the cent, write-once). The push is **deferred past A13 with no date**, and ADR-039 clause B stays Proposed until it is separately accepted. ADR-009's one-way rule holds in full until then.
**Size:** M when it happens · ~~S for the snapshot~~ done · **Schema:** Minor (a snapshot table, plus sync-state tracking later)

### FR-03 · Historical transaction backfill replaces synthetic data
**Said by:** Cameron Horwood. Next step 1.
**Current state:** This is A13, already the plan, already budgeted as the riskiest phase in the programme. Track B (B1 crosswalk, B3 staging pipeline, B4–B7 batches) exists for it.
**Gap:** None in plan. **The meeting adds urgency to Track B**, which has been running without anything visibly waiting on it.
**Disposition:** No new work. Restate the Track B exit criteria to Pat and Funke and agree the first batch's control totals.
**Size:** L (already planned) · **Schema:** No

---

## B · The round–transaction relationship and entry workflow

### FR-04 · A transaction may exist without a round; a round may exist without our transaction
**Said by:** The group. *"A transaction can exist without a corresponding round (e.g., a standalone investment such as the $350K in Procedure Flow), a round cannot logically exist without at least one associated transaction, though rounds can also occur in which NBIF does not participate."*
**Current state:** The nullable FK on `transaction.investment_round_id` already permits both.
**Gap:** **The two halves of that sentence contradict each other**, and resolving the contradiction requires a schema field the platform does not have. A non-participating round is exactly a round with no transaction. See design note **D-2**.
**Disposition:** **Closed, F1 (20 Aug 2026).** Decided as recommended and lands as ADR-033: `investment_round.nbif_participated` is three-state — `yes` / `no` / `unknown` — defaulting to `unknown`, because a backfilled round genuinely may not know and unknown is not a synonym for no. Backfilled from evidence only (a live linked transaction), never from an assumption. `no` removes the round from the leverage figure in both the SQL view and the ADR-001 export. Both contradictory states are now refused: a round cannot claim we sat it out while holding our cheque, and a cheque cannot be attached to a round that says we sat it out.
**Size:** S · **Schema:** Yes

### FR-05 · A transaction can be associated with a round after the fact
**Said by:** Cameron Horwood. *"A linking mechanism could be implemented where a Deal Close entry references a specific transaction by selecting it from a drop-down."*
**Current state:** **No interface sets this link at all** (finding S-1). The Finance tab renders it read-only and points at the Deal Close tab; the Deal Close capture writes no transaction. Every existing link came from the A6 generator.
**Gap:** A live hole, not a new feature. Whichever way the ordering question is answered, something has to be able to write this field.
**Disposition:** **Closed, F1 (20 Aug 2026).** Built as the `link-transactions` mutation — it sets or clears `transaction.investment_round_id` and touches no other column on that table, which is what puts it behind `CAN_CAPTURE_ROUND` rather than `CAN_WRITE_FINANCIAL` (ADR-033 clause 6). Reachable from both surfaces: an enabled round picker with an explicit *No round — standalone* option on the Finance transaction form, and a *cheques in this round* section on the Deal Close form, which is the only one the `vc` role can reach. D-1's ordering question does not arise, because neither record waits for the other.
**Size:** M · **Schema:** No — plus `transaction.standalone_confirmed_at` / `_by`, which F1 added so that "nobody has reviewed this" and "this correctly has no round" stop being the same state

### FR-06 · Consolidate deal close and transaction entry, or link them explicitly
**Said by:** Pat McMullon preferred a single consolidated entry. Cameron proposed linking as the alternative.
**Current state:** Two tabs, two write paths, two roles — a deliberate split following the source of record (ADR-005, ADR-012).
**Gap:** The tension is real and was named in the meeting: the VC team has the round documentation first, Finance has the accounting classification. Merging the tables would break the role split that A8 was built on; keeping them fully separate is what produces the duplicate-entry risk Funke raised.
**Disposition:** **Mostly closed, F1 (20 Aug 2026).** Decided as recommended — merge the workflow, not the tables (ADR-033). The tables stay separate, so the ADR-005 role split A8 is built on survives; the workflow is joined by one narrow mutation both surfaces call, so neither team has to leave its own screen to reconcile. **What remains open is the explicit Finance confirmation state on the round**, which is the other half of what Pat described when he said Finance "can then verify and confirm that the fields relevant to accounting are correct". That is a state machine on `investment_round`, not a link, and it belongs with the reconciliation surface in F6 rather than being bolted onto F1's mutation.
**Size:** L · **Schema:** Yes (confirmation state on the round) — **still outstanding, F6**

### FR-07 · Deal Close may belong under Finance's purview
**Said by:** Cameron Horwood, noting the accounting implications of the debt/equity distinction.
**Current state:** `CAN_CAPTURE_ROUND` is already `vc`, `finance`, `admin` — Finance can already write rounds.
**Gap:** None technically. The open question is who is *accountable* for the round record, not who is permitted.
**Disposition:** Confirm ownership in the follow-up. Note that debt/equity classification argues for splitting the *instrument* fields from the *mandate* fields rather than reassigning the whole form.
**Size:** — · **Schema:** No

---

## C · Controls, duplicate prevention and reconciliation

### FR-08 · Block duplicate round entries for the same company
**Said by:** Funke Yusuf raised the risk; Cameron confirmed feasibility. *"Two 'Triple Hare Series A' records being created."* Next step 3.
**Current state:** No uniqueness constraint on rounds beyond the primary key. Nothing prevents two Series A rows.
**Gap:** Needs building — but a *hard* block would be wrong. "Series A" and "Series A extension", and a second tranche of the same round, are real and legitimate.
**Disposition:** Build as a **soft block**: detect a same-company, same-normalised-label round, refuse the default path, and require an explicit acknowledgement ("this is a second tranche / extension") that is stored with the row. The precedent is already in the codebase — a round total below our own cheque is *accepted and flagged, never refused*, precisely so the deal lead is not pushed into fudging a figure to get past a form.
**Size:** M · **Schema:** Yes (an override flag and reason)

### FR-09 · Flag discrepancies where VC and Finance have entered conflicting information
**Said by:** Funke Yusuf, Cameron Horwood. Next step 3.
**Current state:** One such disagreement is already detected — `nb_other` versus the sum of NB co-investor amounts — and shown **only inside the capture form** (finding S-10). Nothing else is checked and nothing is surfaced on a screen a person visits deliberately.
**Gap:** Needs a reconciliation surface. The checks are individually small; the value is in having one place that lists them.
**Proposed check set:**

| Check | Meaning |
|---|---|
| Transaction with no round, not marked standalone | Unlinked cheque |
| Round marked participated, no linked transaction | Missing cheque or missing link |
| Round captured by VC, not confirmed by Finance | Awaiting accounting classification |
| Σ co-investor amounts ≠ `nb_other` | Two captures disagree |
| Round total < our cheque | Already flagged, already excluded from leverage |
| FMV below NBV | Provision may be required (see FR-19) |
| Mark whose basis ≠ its predecessor's FMV | An earlier mark was corrected after the fact (see D-3) |

**Disposition:** Build as one view plus one screen. Sequence it *after* the schema changes it depends on.
**Size:** M · **Schema:** No (a view over other changes)

### FR-10 · Prevent money moving before required information is captured
**Said by:** The group. *"To ensure that money is not moved without all required information being captured and reconciled."*
**Current state:** Nothing gates entry on completeness.
**Gap:** Needs scoping. **Careful here** — the platform records events after the fact; it is not in the payment path, so it cannot literally prevent a wire. What it can do is refuse to *record* an incomplete transaction, which is a different and more dangerous thing: the predictable failure is that a real cheque goes unrecorded because the form would not accept it.
**Disposition:** Reframe as a **completeness monitor with escalation**, not a hard gate, consistent with how mandate completeness already works. Confirm the intent with Pat — this needs a question, and it is in the list.
**Size:** M · **Schema:** No

---

## D · Deal close, co-investors and leverage reporting

### FR-11 · Co-investor entry drives leverage automatically
**Said by:** The group, identified as *"a powerful tool for automatically calculating leverage figures."*
**Current state:** **Built and working.** Round total plus per-co-investor amount and NB flag produce NBIF contribution, total NB co-investment and unattributed round capital. Leverage reads 5.9 : 1 from 150 of 177 rounds.
**Gap:** None. Validate the presentation against the pedal report format.
**Size:** — · **Schema:** No

### FR-12 · Region and priority sector on the Deal Close form
**Said by:** The group, for quarterly and annual reporting.
**Current state:** `company.nb_region` (NW/NE/SW/SE) and `company.sector_id` + `company_tag` are synced from Affinity, at company level.
**Gap:** They exist but are not on the form and are not per-round. Decide whether the reporting need is company-level (already met, just needs surfacing) or round-level (a real schema addition — a company can change sector classification between rounds).
**Disposition:** Clarify, then almost certainly surface rather than duplicate.
**Size:** S · **Schema:** Probably not

### FR-13 · Non-investment leverage: grants, IRAP, O&B money
**Said by:** Pat McMullon. Key highlight 8, next step 4. *"Not traditional investors but are included in NBIF's leverage schedule and pedal reports."*
**Current state:** `company_gov_funding` exists with `program_name`, `amount`, `conditions`, `status` — **company-level, no round attribution, and not part of any leverage calculation** (finding S-8).
**Gap:** Needs a round-attributable record and a defined place in the leverage figures.
**The consequential part:** leverage is a published board figure with a frozen definition — `(Σ roundTotal − Σ our invested) / Σ our invested` over rounds with a valid total. **Adding grants changes that number.** This project's convention is that a change moving a published figure needs the VC team lead's sign-off and a golden-master recapture. Recommended shape: capture grants separately, report **investment leverage and total leverage as two figures**, and let the pedal report use the one it needs. Do not silently redefine the existing metric.
**Disposition:** Build after the pedal report review (FR-14). Needs sign-off on the metric definition.
**Size:** M · **Schema:** Yes

### FR-14 · Grants must be addable to a round after the fact without looking like a correction
**Said by:** The group. *"Grants may not be known at the time of the initial investment entry… the round entry should be editable to include that grant amount without it being treated as a data correction error."*
**Current state:** ADR-031 makes every financial edit a versioned change with a reason, and an edit inside a frozen reporting period is flagged as a **restatement**. A grant arriving six months late would therefore be recorded as a restatement of a board figure — which is exactly the framing Pat asked to avoid.
**Gap:** Real, and subtler than it looks. The row's history is right; the *label* is wrong.
**Disposition:** Distinguish **late arrival of new information** from **correction of a previously wrong figure** in the version store, so the change log reads honestly. This is a small, high-value change to the ADR-031 mechanism.
**Size:** S · **Schema:** Yes (a change-kind on the version record)

### FR-15 · Review the pedal report format and confirm required fields
**Said by:** Cameron Horwood. Next step 12.
**Current state:** No pedal report exists in the platform.
**Gap:** The actual artefact has not been seen. **This blocks FR-13's field design.**
**Disposition:** Get the file from Pat before designing the non-investment leverage capture. Treat generating the pedal report directly from the platform as an A11 reporting deliverable.
**Size:** S to review, L to build the report · **Schema:** TBD

---

## E · Fair market value

### FR-16 · Record FMV adjustments against the last known value, not new absolute figures
**Said by:** Funke Yusuf, consensus reached. Key highlight 9, topic 11, next step 5.
**Current state:** `valuation_mark.fmv` stores an **absolute** figure per company per effective date. Every metric, view, export and golden master reads absolutes.
**Gap:** The ask is about **how Finance enters the figure**, and the answer should not be to change what is stored. See design note **D-3** for the recommended model: adjustment in, absolute out, both persisted.
**Disposition:** **Storage half closed, F2 (20 Aug 2026).** Built as recommended and lands as ADR-034: a mark carries `adjustment_type`, `basis_mark_id`, `basis_fmv`, `retention_factor` and `adjustment_amount`, with `fmv` unchanged as the absolute result — computed server-side, never accepted from the client. Every existing metric reads FMV exactly as before. **The automation half is FR-17 and still waits on Q-2 to Q-4.**
**Size:** L · **Schema:** Yes

### FR-17 · Transaction-driven FMV changes apply automatically
**Said by:** The group. *"FMV changes driven by new investments or participation in rounds should be applied automatically by the system, since these are mechanical adjustments based on known transaction data."* Next step 5(a).
**Current state:** No automation. A mark is only what someone types. The system *does* already hold unmarked companies at cost as a fallback rule.
**Gap:** Needs building, and needs a decision about what "automatic" does to ADR-007's sign-off rule. See **D-3** and **D-4**. Two sub-cases behave differently:
- **New money in** — mechanical, at cost. Genuinely automatic.
- **Up or down round** — requires post-money and ownership, both of which are null for SAFEs and convertible notes by design. Not always computable, and involves judgement when it is.
**Size:** L · **Schema:** Yes

### FR-18 · Impairment via a fixed percentage drop-down: 25 / 50 / 75 / 100
**Said by:** Pat McMullon. Key highlight 9, topic 20. *"No provision for upward adjustments outside of actual transaction events."*
**Current state:** FMV is free-entry with a required rationale.
**RESOLVED — Cameron, 19 August 2026.** The percentage is **retained value**, representing what the company is worth relative to its previous valuation:

| Selected | Meaning | Effect |
|---|---|---|
| 100% | Retain 100% of existing FMV | No change |
| 75% | Retain 75% of existing FMV | 25% decrease |
| 50% | Retain 50% of existing FMV | 50% decrease |
| 25% | Retain 25% of existing FMV | 75% decrease |

Two consequences follow, and both are good ones:

- **"No change" has a representation.** 100% is a positive entry meaning *reviewed, held* — not an absence. A review cycle can therefore be a checklist that gets cleared rather than a set of forms that were or were not opened.
- **A total write-off is not on this list**, which confirms the read in v1: writing a position to nil is the wind-down path (FR-28), not an impairment. Whether Finance also wants a 0% option for a company that is worthless but not yet formally wound up is a small open question — **Q-19**.

**Cameron's alternative, and the recommendation.** Storing a **decimal factor** (1.00, 0.75, 0.50, 0.25) rather than a percentage is less ambiguous, and that is the right call for the *stored* value: a factor has one arithmetic meaning — `new FMV = prior FMV × factor` — and cannot be read backwards. The *interface* should still show the percentage with its consequence spelled out and the resulting dollar figure before saving, because that is the language Finance used in the meeting. **Store the factor, display the sentence.**

**Disposition:** **Closed, F2 (20 Aug 2026).** Built as Cameron's recommendation: the stored value is a decimal factor in `ref_fmv_retention_option` — a table rather than a CHECK, so Finance edits the list on the Policies surface (F3) instead of asking for a migration — and the interface shows the sentence and the resulting dollar figure before saving. `impairment` and `hold` are one type, as the FR-18 answer allows. **Q-19's 0% option is now a one-row insert rather than a schema change.** Compounding (Q-1) is asserted in the F2 suite.
**Size:** M · **Schema:** Yes

### FR-19 · FMV review screen shows last value, its date, and everything since
**Said by:** Funke Yusuf. *"Eliminates the need to re-enter transaction data that is already in the system."* Next step 5(c), plus Cameron's proposed per-company sub-table of transactions and rounds.
**Current state:** The mark entry form shows a company picker and empty fields. No context at all.
**Gap:** Straightforwardly needed, and probably the single highest-value usability item in the whole register — it is the screen the semi-annual exercise actually runs on.
**Extended by Cameron:** the surface should also show **the full history of previous FMV entries** — when each adjustment was made, by how much, and the reasoning — alongside the transactions and rounds. Every field this needs already exists: `valuation_mark` carries `effective_date`, `booked_at`, `method_label`, `prepared_by_label` and a **mandatory** `rationale`, and the ADR-031 version store holds the change history behind each row. Nothing new has to be captured to make this work; it has to be *shown*.
**Disposition:** **Read half closed, F2 (20 Aug 2026).** Built as a dedicated FMV Review surface on the Finance tab: a review-cycle queue that can be cleared, and per company the carrying value with its full provenance, the complete mark history with rationale and author, every transaction and round booked since the last mark's **effective** date, and the retention control showing the resulting figure before saving. Cheques name the round they funded, which F1 made possible. **The proposed-adjustments panel still waits on Q-2 to Q-4** — the workspace shows context, not proposals.
**Size:** L, splittable · **Schema:** No

---

## F · Net book value

### FR-20 · Track NBV separately from FMV, with independent adjustments
**Said by:** Pat McMullon. Key highlight 10, topic 12, next step 6. *"NBV reflects the carrying value on NBIF's financial statements (cost minus provisions)… when FMV exceeds cost due to an up round, the NBV does not increase beyond cost."* Explicitly intended to **replace the finance team's existing Excel tracking**.
**Current state:** **Nothing.** No NBV field, no provision record, no concept of carrying value anywhere in the schema.
**Gap:** An entirely new sub-model. Cost is already derivable (`v_company_invested`); provisions are not recorded anywhere.
**Rules stated in the meeting, which the model has to satisfy:**
- NBV = cost − provisions, and **never exceeds cost**.
- FMV rising above cost does not move NBV.
- An impairment reduces NBV only to the extent FMV falls below cost.
- On wind-up both the gross investment and the provision come off the books, even where the net effect is nil (Potential Motors: $2M invested, $2M provisioned, both cleared).
**Disposition:** Design and build. See **D-5**. This one carries the strongest business case in the register — it removes an Excel file from the Director of Finance's month.
**Size:** L · **Schema:** Yes

---

## G · Significant influence

### FR-21 · Configurable significant-influence threshold with automatic flagging and a report
**Said by:** Pat McMullon. Key highlight 11, topic 13, next step 7. 10% is the standard rule; board seats create acknowledged grey areas.
**Current state:** `company_ownership` is dated and structured. `fund_alert_policy` demonstrates the exact pattern needed — effective-dated, portfolio-wide, with a current view and history. Cameron demonstrated it in the meeting.
**Gap:** Three pieces: an accounting-policy record holding the threshold, a derived flag, and a report. Plus an **override** — Pat acknowledged the grey areas, and a purely derived flag cannot express "10.2% but no board seat, so no significant influence".
**Design direction from Cameron — adopted.** Rather than bolting a finance setting onto the Alerts tab, create a **Policies tab** with two sections: *Portfolio Alert Policies* (the existing A9 surface, moved) and *Finance Policies* (the significant influence threshold, and whatever follows it). This is better than the alternatives for a reason worth recording: the Alerts tab was deliberately built as a **working view** — the feed, the flags, the acknowledgements — and configuration sitting inside it was always slightly the wrong shape. Splitting configuration out makes both surfaces honest, and gives the finance policies that will accumulate (retention options, NBV rules, exit vocabularies) somewhere to live that is not the Finance entry tab.

Section visibility follows role: `vc` and `admin` see alert policies, `finance` and `admin` see finance policies, `admin` sees both.

**Design note:** effective-date the threshold. This drives financial statement treatment, and a prior period's classification has to remain reproducible — the same reason `fund_alert_policy` is dated.
**Depends on FR-36** — a derived flag is only as current as the ownership behind it.
**Disposition:** Build the threshold, the derived flag and the report now. The manual override for board-seat grey areas waits on Q-7 and is additive.
**BUILT — F3, 20 August 2026.** `fund_accounting_policy` holds the threshold, effective-dated and superseded rather than updated; `significant_influence_asof(company, date)` is the flag, three-valued, NULL where ownership is unrecorded or no policy is in force; the Policies tab carries the two policy sections with the alert policy moved across from Alerts; the schedule is a fifth **Finance** surface, after Transactions, Valuation Marks, FMV Review and LP Activity, grouping the three states with the ownership entry form on the same screen. **A 10% threshold was set through the screen** during the F3 walkthrough rather than by the migration, which is the point of ADR-035 clause 3 — it is in the development database only, its note says it was entered to exercise the surface, and it is cleared by emptying one box. Still open: the board-seat override (Q-7), which is additive.
**Size:** M · **Schema:** Yes

---

## H · Debt instruments and accrued interest

### FR-22 · Debt-specific fields on the transaction form
**Said by:** The group. Key highlight 12, topic 14, next step 8. Principal, interest rate, conversion terms, maturity date. *"A significant portion of NBIF's investment activity involves convertible debt instruments rather than straight equity, particularly for early-stage companies where a share price cannot yet be established."*
**Current state:** `ref_instrument` carries SAFE, Convertible Note, Debt-to-Note, Preferred Equity, Common Equity — **on the round, not the transaction** (finding S-5). No rate, term, maturity or conversion field exists anywhere.
**Gap:** A new `debt_instrument` sub-model plus instrument classification at transaction level.
**Size:** L · **Schema:** Yes

### FR-23 · Dynamic form fields by equity vs debt classification
**Said by:** Cameron Horwood. Next step 8.
**Current state:** One flat transaction form.
**Gap:** Follows from FR-22. Straightforward once the data model exists.
**Size:** M · **Schema:** No

### FR-24 · Debt-to-equity conversion as a distinct transaction
**Said by:** Pat McMullon. *"At minimum two distinct transaction events: the initial debt issuance and, if conversion occurs, a subsequent conversion-to-equity transaction… capturing the total amount being converted (principal plus accrued interest) and the resulting equity position."*
**Current state:** `txn_type` has no conversion value. The nearest available types are `investment` and `follow_on`.
**Gap:** **This one has a trap in it.** `v_company_invested` sums `investment` and `follow_on`. Booking a conversion as either would count the principal twice — once at issuance, once at conversion — and would add accrued interest that was never cash out the door. **Invested cost, MOIC, TVPI, DPI, IRR and leverage would all inflate silently.** A conversion needs its own transaction type, explicitly excluded from invested cost.
**Disposition:** Build with the exclusion rule asserted in a test.
**Size:** M · **Schema:** Yes

### FR-25 · Separate investments from loans at portfolio level
**Said by:** The group. *"On NBIF's balance sheet, investments and loans are tracked separately, and some portfolio companies have both."*
**Current state:** No transaction-level classification exists to split them.
**Gap:** Follows from FR-22. Adds a portfolio-level presentation requirement — the roster needs an equity/debt split.
**Size:** M · **Schema:** Yes (covered by FR-22)

### FR-26 · Accrued interest tracking with offsetting provisions
**Said by:** Pat McMullon. Topic 15. *"NBIF accrues interest over time but often simultaneously provisions against that interest income when the borrowing company is not performing well."* Currently in Excel.
**Current state:** Nothing.
**Gap:** Gross accrued interest receivable plus an offsetting provision, both tracked. Pat's position was that having principal, rate and start date in the platform is the minimum useful outcome, because it makes the arithmetic possible.
**Disposition:** Build in two steps. **Step one: hold the underlying data and compute accrued interest as at any date** — this is what Pat asked for as the floor. **Step two: the provisioning decision**, which he explicitly deferred.
**Size:** M (step one) / M (step two) · **Schema:** Yes

### FR-27 · Automatic accrued-interest calculation
**Said by:** Cameron asked; the group agreed it would be useful; Pat noted provisioning adds complexity and **deferred the automation question.**
**Current state:** Nothing.
**Disposition:** **Explicitly deferred by Finance.** Build the calculation (step one of FR-26); leave the provisioning automation out until asked. Record the deferral so it does not get quietly re-scoped.
**Size:** — · **Schema:** No

---

## I · Exits, write-offs and leaving the portfolio

### FR-28 · Distinct transaction types for exits, realizations and write-offs
**Said by:** The group. Key highlight 15, topic 16, next step 9. Troj as the exit example, Potential Motors as the write-off.
**Current state:** `realization` and `write_off` are **already valid `txn_type` values** and already have correct metric treatment — `v_company_realized` picks up realizations, and a write-off does not count toward invested. `ref_valuation_method` already carries `Write-off` and `Realized`. `company_exit` exists with a five-value `exit_type` vocabulary.
**Gap:** Much smaller than it appears. The types exist; **no interface creates an exit record** (finding S-4), and no view filters the active portfolio on one.
**Disposition:** Build the workflow over existing schema. Confirm the `exit_type` vocabulary against how Finance reports it.
**Size:** M · **Schema:** Minor

### FR-29 · An Exited view, with membership driven by Affinity
**Said by:** The group. *"Approximately 10 companies on NBIF's portfolio list that have been fully provisioned and are no longer operating… a longstanding data hygiene issue."*

**CORRECTED BY CAMERON, 19 August 2026 — v1 of this entry proposed the wrong mechanism and is superseded.**

The rule is: **the Affinity list carries a Status field, and two views filter on it — Portfolio and Exited.** A company with Status `Portfolio` **is** a portfolio company in Portfolio Command, *regardless of a zero FMV and regardless of a Portfolio Status of "Winding Down"*. It becomes an exited company when, and only when, its Affinity Status changes to `Exited`. **There is no platform-side membership state.** Finance records the transaction representing the departure — that is the economic fact — but it does not move the company between views.

What the platform needs is an **Exited tab complementing the Portfolio tab**, with companies moving between them as Affinity's status changes.

**Current state, and why this is a bigger change than it reads:**
- The sync's own rule is *"membership from Status rather than from which saved view a row arrived in"* — which is exactly the right rule and means this is a matter of **accepting `Exited` as a valid membership status**, not of reading a different view. Good news.
- But `Status` was profiled as **80/80 rows, one distinct value, always `Portfolio`**, and was mapped as *not used* on that basis. The status is **not currently stored anywhere.**
- **The A6 generator has a defect this exposes.** It writes a `company_exit` row wherever Affinity's *lifecycle* status reads "Winding Down" — a different field entirely — and the current dashboard's **7 exited companies are that rule firing.** Under Cameron's clarification, every one of those is still a portfolio company. This is a synthetic-data artefact, not a data-entry error, but it is putting a wrong number on a screen today.
- Widening the sync will pull in companies from the Exited view that **are not currently on the 82-company roster at all.** Roster size, and possibly the invested and FMV control totals, will move.

**Disposition:** Build, with a **read-only discovery step first** — probe Affinity for the actual Status vocabulary and the Exited-view membership, report the counts, and decide before anything is written. Then store the roster status as dated history, split the views, and correct the generator. Roadmap phase **F4**.
**Size:** L · **Schema:** Yes (roster status on the dated state table)

### FR-30 · Capture the reason for departure
**Said by:** The group, for reporting purposes.
**Current state:** `company_exit.exit_type` and `note` exist.
**Gap:** Confirm the vocabulary is the one Finance reports on. The fixture already carries a value (`Strategic acquisition`) that sits outside the original constraint, so the list has moved once already.
**Size:** S · **Schema:** Minor

### FR-31 · Support the write-off mechanics Pat described
**Said by:** Pat McMullon, using Potential Motors: $2M invested, $2M provision, both cleared on wind-up, net impact nil, **both entries still need to come off.**
**Current state:** The platform has no provision concept at all (see FR-20), so it cannot express half of this.
**Gap:** Depends entirely on the NBV model. This is the case that determines whether NBV needs to carry gross cost and provision as separate reportable figures or whether a net carrying value plus history is sufficient. **See question Q-6.**
**Size:** — (folded into FR-20) · **Schema:** Yes

---

## J · LP activity

### FR-32 · Three-stage LP workflow: commitment, drawdown, distribution
**Said by:** Pat McMullon. Key highlight 13, topic 17, next step 10. Concrete example: Concrete Ventures — committed $150, contributed $102, $1.47 unfunded, $32K distribution received.
**Current state:** Partial and uneven.
- **Commitment** is `fund_investment.committed`, a **scalar on the position** — not dated, no document, no way to record an increase as a fact (finding S-7).
- **Drawdown** is a `transaction` typed `capital_call`. Works.
- **Distribution** is a `transaction` typed `distribution`. Works.
**Gap:** The commitment is the missing stage. It should be an event so `committed` becomes derived, which is what ADR-002 requires of everything else.
**RESOLVED — Cameron, 19 August 2026.** The figures attributed to Pat were a transcription error and carry no meaning; disregard them entirely. **The three-stage model itself is confirmed correct**: an adjustable commitment, capital calls (drawdowns) against it, and distributions back from the fund — plus NAV, which is retained (FR-35).

The commitment being described as **adjustable** is the operative word, and it settles the design: a commitment is not a fixed number set once at subscription. It is a dated position that can change, which means it must be an event rather than a column.

**Disposition:** Build. Store the commitment level *as at* a date rather than as a delta — same reasoning as the FMV ledger — and derive `fund_investment.committed` from it, which pays down an outstanding ADR-002 debt. Reconcile the backfill against the workbook's $8,725,000 control total before dropping the column.
**Size:** M · **Schema:** Yes

### FR-33 · NBIF-specific terminology, not "capital call" for everything
**Said by:** Funke Yusuf. Topic 18. *"From the LP fund manager's perspective a capital call is a demand for funds, while from NBIF's perspective the same event is a drawdown against a prior commitment."* Proposed: commitment / commitment drawdown / distribution.
**Current state:** The enum value is `capital_call`; the UI label is "Capital call".
**Gap:** Two options — relabel the display only, or rename the enum. **Renaming the enum is much cheaper now than after A13**, because it touches CHECK constraints, views, the contract and the golden masters, and doing that against 282 synthetic rows is nothing compared to doing it against fifteen years of real history.
**Disposition:** Rename properly, now. Confirm the exact wording with Pat and Funke first — next step 10 asks for this explicitly.
**Size:** M · **Schema:** Yes

### FR-34 · Running balances per LP position
**Said by:** Pat McMullon. *"Track the running balance of committed, drawn, and returned capital for each LP fund investment."*
**Current state:** **Already built.** The Funds tab shows committed, called, unfunded, NAV, distributions, TVPI, DPI, IRR and capital-to-direct per position.
**Gap:** Terminology (FR-33) and the commitment-as-event change (FR-32) will flow through it. The figures themselves exist.
**Size:** S · **Schema:** No

### FR-35 · Decide whether to keep NAV tracking
**Said by:** The group, uncertain of its accounting utility. Key highlight 14, next step 11 — **to be confirmed with Daniel on 18 August 2026.**
**Current state:** `fund_investment_nav` is dated, carries `statement_received_at` so the reporting lag is visible, and holds 69 synthetic quarterly snapshots. **A7 built an entry interface for it.**
**Gap — and this materially changes the decision:** NAV is not an optional field sitting unused. **LP TVPI, RVPI and IRR are all computed from it**, and all three are on the Funds tab today. Removing NAV does not remove a field; it removes three metrics from a live screen and empties the LP position drawer. The question is therefore not "does Finance need NAV for internal accounting" but "is the Funds tab's LP performance reporting worth keeping" — which is a VC-side question, and Daniel's to answer.
**RESOLVED — Daniel, 18 August 2026. NAV stays.** Approved on exactly the grounds above: it informs LP TVPI, RVPI and IRR, and those metrics are worth keeping. No work, no removal, and the open item closes.
**Size:** — · **Schema:** No

### FR-36 · Finance maintains ownership between rounds *(new in v2)*
**Source:** Cameron's answer to Q-15, 19 August 2026.
**Requirement:** Ownership changes caused by events between financing rounds — an option pool expansion, a round NBIF did not participate in, a secondary — are **entered by the finance team, ad hoc, as word of the event reaches them.** No scheduled cadence, no reporting period, no batch.
**Current state:** `company_ownership` is dated, structured and correct in shape — and is written **only** by the Deal Close capture form, as part of capturing a round. There is no way to record an ownership change that is not attached to a round we captured.
**Gap:** A standalone, Finance-owned ownership entry surface. Also a reason field: an ad-hoc adjustment that does not say what caused it is a number nobody can defend six months later, and this table feeds MOIC, the waterfall and — once FR-21 lands — the significant-influence flag that drives accounting treatment.
**Why this matters more than its size suggests:** it is the **prerequisite for FR-21**. A significant-influence flag derived from a stale ownership percentage is worse than no flag, because it looks authoritative. Ad-hoc maintenance is what keeps it current, and nothing currently permits it.
**Disposition:** Build. Roadmap phase **F3**, ahead of the threshold work in the same phase.
**BUILT — F3, 20 August 2026.** `company_ownership` gained `change_reason` and `investment_round_id`, and a standalone entry path (`/api/v1/ownership`, `CAN_CAPTURE_ROUND`) that refuses a figure with no reason. The deal-close path stores the round instead of prose, because there the round is the reason. 177 of 179 existing rows were linked to their causing round from evidence alone; the 2 that were not are real rows whose rounds were later soft-deleted, and they are visible on the schedule rather than absent from it.
**Size:** M · **Schema:** Minor (a reason, and an optional link to the causing round)

---

## K · Already built — confirmed in the demo

Recorded so they are not rebuilt, and so the walkthrough condition in ADR-020 can be marked satisfied for them.

| Capability | State |
|---|---|
| Transaction fields: date, investment type, company, amount, currency + FX, document link, investment vehicle, notes | Built |
| Editing with a **mandatory reason for change** and an edited flag | Built — and stronger than demonstrated: capture is by database trigger, so a change made outside the application is recorded identically |
| Company list driven from the Affinity portfolio view | Built |
| Co-investor capture with NB flag and automatic leverage | Built |
| Running totals net of deletions and reversals | Built |
| Per-row change history with field-level diff | Built |
| Effective-dated policy configuration | Built (A9), and the pattern FR-21 should follow |

---

## Summary by disposition — v2

| Disposition | Requirements | Roadmap |
|---|---|---|
| **Safe to build now** | FR-04, FR-05, FR-08, FR-09, FR-12, FR-14, FR-18, FR-19 *(read half)*, FR-21, FR-28, FR-29, FR-30, FR-32, FR-33, FR-34, FR-36, and the FMV ledger half of FR-16 | **F0–F6** |
| **Already built, confirm only** | FR-01, FR-11, FR-34, FR-35, and all of §K | — |
| **Blocked on Finance answers** | FR-17 *(Q-2, Q-3, Q-4)*, FR-20 *(Q-5, Q-6)*, FR-22 / FR-23 / FR-24 / FR-25 / FR-26 *(Q-11, Q-20)*, FR-31 *(Q-6)*, FR-19 *(proposal half)* | Phase 2 |
| **Blocked on an artefact** | FR-13, FR-15 — the pedal report has not been seen | Phase 2 |
| **Deferred by Finance** | FR-27 — Pat explicitly deferred provisioning automation | — |
| **Deferred to cutover** | FR-02 *(push at A13; snapshot now)*, FR-03 *(A13/Track B)* | F0 partial, then A13 |
| **Needs a decision, not a Finance answer** | FR-06, FR-07 — ownership of the consolidated workflow | F1 settles most of it |

**Sixteen of the thirty-six require a schema change**, and **eleven of those sixteen are now unblocked.** Every one is cheaper before A13 loads fifteen years of history than after — which remains the strongest argument for doing this work now rather than waiting for the second Finance meeting to answer everything at once.
