# Finance Design Notes

**Version 2, 19 August 2026.** Q-1 is resolved by Cameron's FR-18 comment; Q-15 to Q-18 are resolved; **D-7 is new**, replacing the portfolio-membership design in v1, which was wrong. The question list at the end is restructured as a meeting agenda for Pat and Funke.

Analysis of the decisions that have to be made before the requirements in `finance-requirements-register.md` can be sequenced into a build. Each note states the question, what the current architecture already commits to, the options, and a recommendation with its reasoning.

**These are proposals, not decisions.** The ones marked *needs Finance input* carry an open question at the end of the document.

---

## D-1 · Entry order: transaction first, then attach to a round?

**The question as posed:** does it make sense to record a transaction first, and then associate it with a round when the round is entered?

**What the architecture already commits to.** The foreign key sits on `transaction.investment_round_id`, pointing at the round. That direction is correct and should not change — one round can hold several of our cheques (a round funded from two vehicles is explicitly contemplated by ADR-030), while one cheque belongs to at most one round. The FK on the many side is the only shape that expresses that without a join table.

**What is actually broken.** No interface writes that field (finding S-1). The Finance tab renders it read-only and points at the Deal Close tab; the Deal Close capture writes three tables, none of them `transaction`. Every link in the database today was written by the A6 generator. So the question is not really "which order" — it is "something has to be able to make this link at all, and nothing currently does."

**Why enforcing an order would be the wrong answer.** The two records have different authors working on different clocks. The deal lead has closing documents at close; Finance books the wire when it clears; the two events are days or weeks apart in either direction. An order requirement — either one — guarantees that whoever gets there first is blocked, and the reliable outcome of blocking someone from recording a fact they hold is that the fact goes into a spreadsheet instead. That is the exact failure ADR-031 was written to prevent when it reversed the append-only rule.

**Recommendation.** Support both orders, and make the link writable from both surfaces with different affordances:

- **On the Deal Close form**, a *cheques in this round* section listing unlinked transactions for that company within a date window, multi-selectable. This is the primary path, and it is the one Cameron proposed in the meeting.
- **On the transaction form**, a round picker filtered to that company, enabled rather than read-only. Finance books a follow-on into a round that already exists; making them leave the form to record that is friction with no purpose behind it.

The current read-only note reasons that "which round a cheque belongs to is a deal capture decision, not a Finance correction." That is right about *authorship of the round* and wrong about *the link itself* — the link is a reconciliation between two records, and reconciliation is Finance's work. Recommend amending ADR-012's role note accordingly rather than leaving the field inert.

**Consequence for FR-06.** This is also the answer to the consolidation question. Pat's concern was two parties independently entering data for the same event; Funke's was duplicate records. Neither requires merging the tables — merging them would break the ADR-005 role split that A8 is built on and put Finance's cheque and the deal lead's round total behind a single permission. **Merge the workflow, not the tables**: one capture flow that can create or link the cheque, plus an explicit Finance confirmation state on the round (`finance_confirmed_at`, `finance_confirmed_by`), which is precisely what Pat described when he said Finance "can then verify and confirm that the fields relevant to accounting are correct".

---

## D-2 · Can a round exist without a transaction, and vice versa?

**The question as posed:** does it make sense that a round can exist without a transaction, and a transaction without a round?

**The meeting reached two conclusions that contradict each other.** From topic 6: *"a transaction can exist without a round… but a round cannot exist without at least one associated transaction from NBIF's perspective; however, rounds can also occur in which NBIF does not participate, and these still need to be recorded because they affect FMV and cap table ownership percentages."*

A round we did not participate in **is** a round with no transaction. Both halves cannot hold.

**The resolution is that the round is an event in the company's life, not in ours.** A Series B happens whether or not we write a cheque. Once that is the definition, everything falls out cleanly:

| State | Legal? | Why |
|---|---|---|
| Transaction with no round | **Yes** | A bridge note, a standalone convertible, a secondary purchase. The $350K in Procedure Flow. |
| Round with no transaction | **Yes** | A round we did not participate in — which we must record, because it moves ownership and FMV. |
| Round we *did* participate in, with no transaction | **No** | This is a data error, and it is the rule Pat was actually articulating. |

**The problem is that the database cannot currently tell the third case from the second.** Both are "a round row with no transactions pointing at it", and `ourInvested` reads $0 for both — and also for a cheque that exists but was never linked, and for a plain entry error. **Four states, one representation** (finding S-2).

This is the same class of problem the codebase has already reasoned about twice and resolved the same way both times: a null round total means "unknown" and is excluded from leverage rather than imputed; a null co-investor amount means "the name is known and the figure is not". The convention is that absence must be *distinguishable from* rather than *conflated with* a real value.

**Recommendation.** Add an explicit participation field to `investment_round` — `nbif_participated`, three-state: `yes` / `no` / `unknown`, defaulting to unknown rather than to either answer, because a backfilled historical round genuinely may not know.

Then the rules become checkable rather than aspirational:

- `participated = yes` and zero linked live transactions → **reconciliation exception**, listed on the FR-09 screen. Not a hard block, because the round may be captured before the wire clears.
- `participated = no` → the round is expected to carry no transaction, contributes ownership and FMV signal, and is **excluded from leverage denominators** the same way a null total already is.
- `participated = unknown` → a completeness gap, reported the way mandate coverage already is.

**On transactions without rounds:** keep the nullable FK, and add the same discipline — a way to mark a transaction as *deliberately standalone*, so that a null means "we checked, there is no round" rather than "nobody has looked at this yet". Without it, the FR-09 unlinked-cheque check has no way to ever go green.

---

## D-3 · The FMV model

**The question as posed:** how should FMV activity be recorded, given that some adjustments are automatic (a transaction, an up or down round), some are the semi-annual impairment review, and some are wind-down or exit events?

### The tension

Finance asked to record **adjustments against the last known value** rather than new absolute figures. The platform stores **absolutes**, and every metric, view, export and golden master reads them. `company_fmv_asof()` — which is the definition of NAV, and therefore of TVPI, RVPI and IRR — is a single query for the latest final mark.

Switching to a pure delta chain would mean every read recomputes a running sum from the beginning of a company's life, and one corrected early row silently shifts every figure after it. That is a large change to the most load-bearing function in the system, in exchange for a data-entry convenience.

### The recommendation: adjustment in, absolute out, both persisted

The ask is about **how Finance enters a figure**, not about what is stored. Both can be satisfied at once, and this is the same move ADR-031 made when it dropped append-only entry without dropping the reproducibility guarantee underneath.

A mark becomes an **event** carrying its cause, its basis, its input and its result:

| New column | Holds |
|---|---|
| `adjustment_type` | What caused this mark — see the table below |
| `basis_mark_id` | The mark this was applied to |
| `basis_fmv` | That mark's FMV **at the time this one was written** |
| `adjustment_pct` | For impairments. Constrained to the policy values |
| `adjustment_amount` | For transaction-driven changes |
| `fmv` | **Unchanged. The absolute result — computed, never typed** |

Everything that reads FMV today keeps working untouched. No metric moves, no golden master is recaptured, no board number changes as a consequence of the storage change — which is the property that makes this affordable rather than a rewrite.

### The adjustment types

| Type | Trigger | Input | Resulting FMV | Authority | Status |
|---|---|---|---|---|---|
| `review` | Semi-annual review | Retention factor: 1.00 / 0.75 / 0.50 / 0.25 | Prior × factor | Finance | **Buildable now** |
| `initial` | First investment in a company | — | Cost of that transaction | Automatic | Buildable now |
| `realization` | An exit | Proceeds | Per policy — see Q-12 | Finance | Needs Q-12 |
| `write_off` | Wind-down | — | Zero | Finance | Buildable now |
| `transaction` | An `investment` or `follow_on` is booked | — | Prior + amount | Automatic | Needs Q-3, Q-4 |
| `round_reprice` | A **priced** round is captured with post-money and ownership | — | post-money × ownership % | Proposed, Finance confirms | Needs Q-2, Q-4 |
| `manual` | Free-entry absolute | FMV | As typed | Finance | Backfill and exceptions only |
| `legacy` | Pre-migration rows | — | As stored | — | Backfill label |

**`impairment` and `hold` collapsed into one type after Cameron's FR-18 clarification**, and that is a simplification the answer bought rather than a shortcut. Once 100% is an option *on the same drop-down*, "we reviewed this and held it" and "we reviewed this and took 25% off" are the same action with different inputs — one type, one control, one row. Under the write-down reading they would have been two separate mechanisms, because "no change" would have had no entry in the list at all.

**The retention factor is stored, the percentage is displayed.** `retention_factor numeric(6,4)` has exactly one arithmetic meaning — `new = prior × factor` — and cannot be read backwards by a future maintainer. The form shows *"Retain 75% of existing FMV — a 25% decrease"* and the resulting dollar figure before saving, because that is the language the review is conducted in.

**The vocabulary lives in a reference table**, not a CHECK constraint, so Finance can add or retire an option through the Policies surface (FR-21) without a migration. The meeting's intent — a constrained list, not free entry — is preserved; what changes is who can change the list.

### Four things this exposes that need deciding

**1. ~~The impairment percentages are ambiguous~~ — RESOLVED, 19 August 2026.** Retained value: 100% holds, 75% takes 25% off. Two small residuals remain, and neither blocks the build:

- **Impairment compounds.** The factor applies to the *previous* FMV, so 50% followed by 50% leaves a position at 25% of where it started, not at zero. That is the natural reading of "relative to its previous valuation" and it is almost certainly what is intended — it needs a one-line confirmation, not a discussion (**Q-1**).
- **There is no 0% option**, so a position can be impaired to 25% but not to nil except through the wind-down path. Whether Finance wants to mark a company worthless *before* it is formally wound up is a real scenario worth asking about (**Q-19**).

**2. An up round is not always computable, and is not purely mechanical when it is.** Repricing off a round needs post-money and ownership. `post_money` is **null by design for SAFEs and convertible notes** — which is exactly the instrument class Pat identified as a significant portion of NBIF's activity, *"particularly for early-stage companies where a share price cannot yet be established"*. So the automatic path covers priced rounds only; unpriced rounds can raise a review flag but cannot compute a figure. See Q-2.

**3. FMV becomes a downward ratchet between transactions.** The policy that upward adjustments happen only through transaction events has a direct consequence: an impaired company that recovers stays impaired until a new round or investment reprices it. That is a defensible conservative position and is almost certainly intended — but it should be stated explicitly, because it is the kind of rule that surprises someone two years later.

**4. The one-final-mark-per-date index will break** (finding S-3). Two follow-ons on the same day, or a transaction landing on 31 January, cannot both produce a mark. Either allow several marks per date ordered by a sequence, or key transaction-driven marks to the transaction. Small, and it will bite immediately once automation exists.

### Why `basis_fmv` is stored rather than looked up

If a 2019 mark is later corrected, every subsequent mark's arithmetic silently becomes wrong under a lookup, and nothing says so. Storing the basis at write time turns that into a **detectable** condition — `basis_fmv` no longer matches its predecessor — which becomes a line on the FR-09 reconciliation screen instead of a number nobody can explain.

---

## D-4 · Automatic adjustment versus sign-off

**The problem.** Finance asked for transaction-driven FMV changes to be *"applied automatically by the system"*. ADR-007 says **entry by the Director of Finance is the sign-off** — there is no separate approval step precisely because entry *is* the approval. A figure appearing on a board report that no one entered would hollow that out.

**The reconciliation is to split on whether the adjustment involves judgement.**

- **Mechanical, at cost — automatic and final.** New money in raises FMV by the amount invested. This is arithmetic, and the platform already holds unmarked companies at cost as its fallback rule, so it is the same convention applied consistently rather than a new claim. Auto-write the rationale: *"+$1,200,000 follow-on at cost, transaction #482."* The transaction, which Finance entered, is the authority.
- **Repricing off a round — proposed, not applied.** The system computes post-money × ownership, writes it as a **`draft` mark** (the status value already exists), and shows it in the review queue with the arithmetic visible. Finance accepts it in one click and that acceptance is the mark. Nobody retypes a number, which is what "automatic" was really asking for, and no unsigned figure reaches a board report.

This keeps ADR-007 intact rather than quietly eroding it, and it means the semi-annual review screen has something waiting on it rather than being a blank form. **Confirm with Pat — see Q-4.**

---

## D-5 · The net book value model

**What has to be true**, from Pat's description: NBV is cost minus provisions; it never exceeds cost; FMV rising above cost does not move it; an impairment reduces it only to the extent FMV falls below cost; and on wind-up both the gross investment and the provision come off the books even where the net effect is nil.

**Recommended shape — mirror `valuation_mark` rather than invent a new pattern.** A provision record with `company_id`, `effective_date`, amount, reason, `prepared_by`, `source_document`, `status` and a supersession chain gets the ADR-031 versioning, the `_asof()` reconstruction and the restatement detection **for free**, because all of that is generated from one template over any table that carries the lifecycle columns.

Then:

```
cost_asof(company, date)  = Σ investment + follow_on ≤ date, less derecognitions
nbv_asof(company, date)   = cost_asof − Σ provisions ≤ date, floored at zero
```

Two invariants worth asserting in tests rather than trusting: **NBV never exceeds cost**, and **NBV never goes below zero**.

Two reports fall straight out, and both are things Finance currently finds by reading a spreadsheet: companies where **FMV < NBV** (a provision may be required) and companies where **NBV > 0 while FMV = 0** (one definitely is).

**The open design question is the Potential Motors case.** $2M invested, $2M provisioned, both cleared on wind-up. Whether the platform needs to present gross cost and provision as two separate reportable figures — because that is how they appear on the financial statements — or whether a net carrying value with full history behind it is sufficient, determines whether derecognition is a new event type or just a status. **See Q-6.**

---

## D-6 · Debt, conversion, and the trap in it

The debt sub-model itself is conventional: a `debt_instrument` record carrying principal, rate, day count, compounding, issue and maturity dates, conversion discount, valuation cap and status, linked to the transaction that created it, plus an `accrued_interest_asof()` function and separate provision records against accrued interest.

**The trap is the conversion transaction.** `v_company_invested` sums `investment` and `follow_on`. If a conversion is booked as either:

- the **principal is counted twice** — once at issuance, once at conversion;
- the **accrued interest is counted as invested capital**, though it was never cash out the door.

Invested cost, MOIC, TVPI, DPI, IRR and leverage all inflate, silently and permanently. **A conversion needs its own `txn_type`, explicitly excluded from invested cost**, with the exclusion asserted in a test rather than left as a convention. The conversion row still records the full amount converted (principal plus accrued interest) because that is the fact — it is the *aggregation* that must exclude it.

Worth noting that the schema anticipated something here: `ref_instrument` already carries **Debt-to-Note** alongside Convertible Note, which suggests conversion was contemplated at design time even though no transaction type exists for it.

---

## D-7 · Portfolio membership, and the difference between a status and an event

*New in v2. This replaces the design in v1's FR-29, which was wrong.*

**What v1 got wrong.** It proposed that the platform hold its own exited state, on the reasoning that the Affinity sync never deletes, so a company removed from the active view would keep arriving every night. The premise was right and the conclusion did not follow. The sync's own rule — *membership from Status rather than from which saved view a row arrived in* — already handles this. A company arriving every night with Status `Exited` is not a problem to be worked around; it is the answer.

**The correct model separates two things that v1 conflated.**

| | What it is | Who owns it | Where it lives |
|---|---|---|---|
| **Roster status** | Is this a portfolio company or an exited one? | The VC team, in Affinity | `company_state`, dated, synced |
| **Exit event** | We realized, or wrote off, this position on this date for this reason | Finance, in the platform | `company_exit` + a `realization` / `write_off` transaction |

They will usually agree, and **they do not have to agree at every instant.** Finance may book a write-off in March; the roster status may not change until someone updates Affinity in June. Under v1's design that lag would have silently moved a company out of the portfolio view. Under this one it is visible: the company sits in the Portfolio view carrying an exit event, which is exactly the sort of thing the reconciliation screen should list.

This also follows the rule ADR-009 already sets and ADR-032 reaffirmed when the health-rating workflow was cut: **Affinity is the system of record for company identity and status, the sync is one-way, and the platform does not build an edit box that would disagree with it.** An exited flag maintained in two places would have the nightly sync silently winning the argument — the precise failure the health workflow was cancelled to avoid.

**The consequence that needs care.** The A6 generator currently derives exits from the *lifecycle* status "Winding Down", which is a different Affinity field. Under Cameron's clarification those companies are still portfolio companies, so **the 7 exited companies on the dashboard today are a generator artefact and the correct figure is different.** Fixing it moves a visible number, and widening the sync to accept `Exited` will pull in companies that are not on the current 82-company roster at all — which may move the invested and FMV control totals that A6 reconciles against and that A13 is meant to tie to.

That is enough blast radius to warrant a **read-only discovery step before any code is written**: probe Affinity for the real Status vocabulary and the Exited-view membership, report the counts, and decide with the numbers visible. It is phase F4 in the roadmap and it is deliberately the one phase that starts with a question rather than a migration.

---

## Open questions

**Resolved so far:** Q-1 (retention semantics), Q-15, Q-16, Q-17, Q-18, **Q-23**. Everything below is live, grouped as a meeting agenda rather than a ranked list — the grouping matters because the questions in each block are only answerable together, and asking them out of order tends to produce answers that contradict each other.

Each block says **what it blocks**, so if the meeting runs short you can see what is being paid for by stopping.

---

### Block 1 · FMV automation — *blocks FR-17, the second half of FR-19, and the `transaction` / `round_reprice` mark types*

The manual review path is settled and being built. What is not settled is what the system should do on its own between reviews.

**Q-2 · When we invest, does FMV rise by the cheque, or is the position repriced?**
We put $1.2M into a priced Series A. Does FMV go up by exactly $1.2M — the position held at cost — or is our whole holding repriced at the new round, which would move FMV by considerably more than the cheque? Both are defensible policies; they produce materially different NAV, and NAV is a board number.

**Q-3 · How is an up or down round translated into FMV?**
Is the new FMV **post-money × our ownership %**? Something else? And two edge cases that are not edge cases at all here:
- **A round we did not participate in.** Do we mark *up* on it, or only recognise the *down* rounds? Conservative policy usually means only down — worth confirming, because it is asymmetric.
- **An unpriced round.** Post-money is null by design for SAFEs and convertible notes, which Pat identified as a large share of NBIF's activity. There is no arithmetic available. Does that round raise a flag for manual review, or have no FMV effect at all?

**Q-4 · Should a system-calculated adjustment be final without anyone clicking?**
ADR-007 records that entry by the Director of Finance *is* the sign-off — there is no separate approval step because entry is the approval. A figure reaching a board report that nobody entered would hollow that out. Our proposal is to split it: **mechanical at-cost changes apply automatically** (the transaction Finance already entered is the authority), while **repricing off a round is proposed as a draft** that Finance accepts in one click. Nobody retypes a number, and no unsigned figure reaches the board. Does that match how you want to work?

**Q-1 · Confirming: impairment compounds.** *(one line, not a discussion)*
50% at one review followed by 50% at the next leaves a position at 25% of where it started — each factor applies to the *then-current* FMV, not to a fixed baseline. Correct?

**Q-19 · Is there a 0% option?** *(new)*
The list is 100 / 75 / 50 / 25, so a position can be impaired to a quarter but not to nil. How do you currently mark a company that is worthless but has not formally wound up — impair to 25% and wait, or is there a step we are missing?

**Q-12 · What happens to FMV on an exit?**
Does FMV go to the proceeds received, or to zero once the position is closed? And does a realization require a mark at all, or does the transaction carry the whole story?

---

### Block 2 · Net book value — *blocks all of FR-20 and FR-31, the largest single item in the register*

This is the one that takes an Excel file off your desk, so it is worth the time even if other blocks get cut.

**Q-5 · How is a provision entered — a dollar amount, or a percentage?**
And is a provision *always* triggered by FMV falling below cost, or is it an independent judgement you can take for reasons FMV does not yet reflect?

**Q-6 · Do you need gross cost and provision reported separately, or is a net carrying value enough?**
The Potential Motors example — $2M invested, $2M provisioned, both cleared on wind-up, net effect nil but *both entries still had to come off* — reads like both figures are reportable in their own right. If so, the platform has to carry them as two figures rather than one net number with history behind it. This single answer determines whether wind-up is a new event type or just a status change.

**Q-13 · What cadence do provisions follow?**
FMV runs 31 January and 31 July, and the 31 March year end is served by a January mark carried forward two months — deliberately, and labelled as such. Does NBV tolerate the same lag, or does it need to land on the fiscal year end?

**Q-14 · Who enters marks and provisions?**
ADR-007 names the Director of Finance as preparer, with entry as the sign-off. Does Funke enter as Controller, and if so, does that change what the sign-off means, or is it the same authority exercised by two people?

---

### Block 3 · Debt and convertible notes — *blocks FR-22 to FR-26*

**Q-11 · Interest conventions.**
Day count — ACT/365, ACT/360, 30/360? Simple or compound, and at what frequency? And is interest income recognised each period and provisioned at that point, or only recognised when conversion happens?

**Q-20 · Which instruments are loans on the balance sheet?** *(new)*
The platform knows five instruments: SAFE, Convertible Note, Debt-to-Note, Preferred Equity, Common Equity. To split investments from loans (FR-25) we need to know which side each falls on — and **SAFEs are the interesting case**, since they are neither straightforwardly. How are they treated in your statements?

**Q-21 · Does a convertible note ever partially convert?** *(new)*
Or is it always the whole instrument at once? This decides whether a debt instrument can have several conversion events against it or exactly one, which is a schema question rather than a preference.

---

### Block 4 · Leverage and the pedal report — *blocks FR-13, FR-15*

**Q-8 · Does including grants change the published leverage figure?**
Leverage today is `(round totals − our invested) / our invested` over rounds with a usable total, and it appears on the board dashboard at 5.9 : 1. Adding IRAP, ONB and other grants **changes that number.** Our recommendation is to report **investment leverage and total leverage as two figures** rather than redefine the existing one — but that is your call, and if the published figure moves it needs the VC team lead's sign-off too.

**Also needed: the pedal report file itself.** Not a question — an artefact. The non-investment leverage fields cannot be designed without seeing the format they have to produce.

---

### Block 5 · Controls and workflow — *shapes FR-08, FR-09, FR-10, and refines what is already being built*

**Q-9 · What counts as a duplicate round?** ~~*(open)*~~ **ANSWERED IN PART, 21 August 2026 — and the answer arrived with a new requirement attached. See below.**
Is a "Series A extension" a second Series A, or a distinct round? A second tranche of the same raise? We are building this as a **warning with an acknowledgement**, not a hard block — so a wrong guess is recoverable — but the definition of sameness determines how often it fires, and a rule that fires constantly gets clicked through without reading.

**What was settled.** Funke confirmed that **Finance enters these rounds, not the VC team**, and that Finance is accountable for not creating a second Series A that should not exist. Combined with what F6 measured — 32 same-label pairs in the data, the closest 256 days apart, 29 of them a generator artefact — the rule is **normalised label alone, same company, no date window**. Case-folded, punctuation removed, nothing fuzzy. It fires zero times on today's data, correctly.

**What it opened.** Funke's reason for the false pairs is a requirement in its own right: *"that is called Bridged Funding… it might show up as a qualifier, like an adjective."* A bridge is **under** a round, not a round of its own and not standalone — a state ADR-033's two options cannot express. **Raised as FR-37 and deliberately not designed**; it needs the second meeting, and F6 forecloses none of the three ways it could be modelled.

**What is still open.** Whether the rule should ever become fuzzy — "Series A" against "Series A-2", say. It is one function, `pc.normalise_round_label()`, read by the index, the write path and the reconciliation view alike, so tightening it later changes all three at once and needs no rebuild.

**Q-10 · "Money should not move without all required information."**
Worth being precise about the intent here. The platform records events after the fact; it is not in the payment path, so it cannot stop a wire. What it *can* do is refuse to record an incomplete transaction — which has its own failure mode, where a real cheque goes unrecorded because the form would not take it. Was the intent a hard block, or a completeness monitor with escalation? We recommend the latter.

**Q-22 · Should every active company get a mark each review cycle?** *(new)*
Now that "retain 100%" is a positive entry rather than an absence, the review can be a **checklist that gets cleared** — every active company reviewed, most of them held. Is that how the exercise actually runs, or do you only touch the companies where something changed? This decides whether the review workspace shows a progress figure and chases the gaps, or just accepts entries.

**Q-23 · Exact LP terminology.** ~~*(new — answerable by email before the meeting)*~~ **ANSWERED 21 August 2026 — see the table below. F5 is unblocked and has landed.**
Funke proposed **commitment / commitment drawdown / distribution**. We want to rename the stored value, not just the label, and doing that now costs almost nothing while doing it after the history load is expensive. Are those the exact words? Specifically: "commitment drawdown", or just "drawdown"?

---

### Answered, recorded for completeness

| | Question | Answer |
|---|---|---|
| **Q-1** | Retained value or write-down? | **Retained.** 100% holds, 75% takes 25% off. Compounding still to confirm. |
| **Q-15** | Ownership between rounds? | Finance enters them, **ad hoc**, as word of an event arrives. No cadence. |
| **Q-16** | The Concrete Ventures figures? | Transcription error. Disregard. The three-stage model is correct. |
| **Q-17** | Affinity write-back? | Push **after** A13 — refined 20 Aug 2026, see below; the field becomes **read-only** in Affinity; the platform stops reading it. |
| **Q-18** | Keep NAV? | **Yes**, approved by Daniel — it informs LP TVPI, RVPI and IRR. |
| **Q-23** | Exact LP terminology? | **Committed Capital · Capital Drawdown · Capital Distribution.** Confirmed with Funke. Not the words the register recorded — see below. |

**Q-23, answered 21 August 2026, and worth reading rather than ticking.** The register minuted Funke's proposal as *commitment / commitment drawdown / distribution*. The confirmed terminology differs on **all three**:

| Register | Confirmed |
|---|---|
| commitment | **Committed Capital** |
| commitment drawdown | **Capital Drawdown** |
| distribution | **Capital Distribution** |

The third is the one with a consequence beyond the label. Finding **S-6** records that `fund_distribution` — the fund's own realizations to its shareholder — collides with LP `distribution`, money coming back to *us* from a GP: two opposite directions of travel under one word. `capital_distribution` separates them, and that separation came out of the email rather than out of the design.

**This is why the question was asked ahead of the phase rather than during it.** Three for three, against a minute that was faithful to what was said in the room. The stored values are `capital_drawdown` and `capital_distribution` (`fee` unchanged), renamed across 95 rows in an afternoon; after A13 the same change is a data migration over fifteen years of history. F5 landed 21 August 2026 — migration 0012, ADR-037 accepted.

**Q-17, refined 20 August 2026.** The original answer read *"push at A13"*, and F0 built the roadmap and ADR-039 around that as a phase name. It is not one.

The push extracts total invested per company from **live transaction history the finance team has verified**. That verification is A13's *exit criterion*, so the figures the push depends on are an **output** of the phase, not something available during it. Scheduling the platform's first irreversible write to a system it does not own inside the riskiest phase in the programme — on numbers whose trustworthiness that same phase is still establishing — inverts the dependency.

**So the push has no date.** It happens when the platform's own figures are trustworthy, on its own decision, some time after A13. Until then:

- ADR-009's one-way rule holds **in full**. Nothing outbound is built and none is scheduled.
- The platform keeps **reading** `affinity_total_investment` and `affinity_fmv` nightly, and the A6 generator keeps calibrating synthetic transactions and marks against them so company-level figures roll up to what the VC team recognises. That workflow is retained deliberately, not by omission.
- **The F0 snapshot stays**, and its justification is re-based rather than removed. It was raised as insurance against the write; the reason that survives the write being indefinite is that **the agreed control totals were agreed at an instant while the columns holding them are synced nightly and demonstrably volatile** (ADR-020 records a figure that moved five times in under a minute). Without a frozen copy, a reconciliation failure at A13 cannot be distinguished from Affinity having moved underneath it — and no other artefact in the programme answers that question.

Recorded in full in ADR-039's amendment, which is the authority. FR-02's disposition in the register is updated to match.
