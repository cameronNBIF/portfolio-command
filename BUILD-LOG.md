# Build Log — Portfolio Command

A running record of what was built, in what order, and what changed. Complements `docs/architecture-decisions.md`: **ADRs capture decisions with lasting consequence; this file captures what actually happened.**

Newest entries at the top. Update at the end of every working session — an entry with nothing under "Changed" or "Outstanding" is still worth writing, because the gaps are what future-you needs.

---

## Entry format

```
## YYYY-MM-DD · Phase ref · Short title

**Built**
- What now exists that did not before.

**Changed**
- Anything altered from the plan, the schema, or an earlier build. Say why.

**Decided**
- Judgement calls made in passing. If it has lasting consequence, also raise an ADR.

**Outstanding**
- What is blocked, deferred, or needs someone else.
```

Phase refs come from `docs/delivery-roadmap.md` — A0, A1, A2 and so on, suffixed for sub-tasks (A0.1, A0.2). Track B and C items use B and C refs.

---

## 2026-08-20 · F0.1 · The as-built baseline lands, and ADR-039 loses its date

Two things, one of which is a correction to a decision raised yesterday. **No code, no schema, no number moves** — migration 0007 rewrites two comments and nothing else.

### Built

**`docs/finance-current-state.md` is committed**, closing the one F0 exit criterion that was left open. Every S-number cited across Track F — S-1 through S-10 — now resolves to a document in the repository, and "cite the S-number in a Track F commit message" becomes an instruction someone can actually follow. It is listed in `CLAUDE.md`'s document table beside the register and the design notes, and the open items in the F0 roadmap entry and the F0 build-log entry are struck through rather than deleted.

### Changed

**ADR-039 is split, and the outbound write to Affinity moves out of A13 with no date.** Raised by Cameron; this is exactly the correction a **Proposed** status exists to make cheap.

F0 read Q-17's *"push at A13"* as naming the phase, and built the roadmap, the ADR and `CLAUDE.md`'s non-negotiable 7 around that. **It does not name the phase.** The push extracts total invested per company from live transaction history **that the finance team has verified**, and that verification is A13's *exit criterion* — so the figures the push depends on are an **output** of the phase rather than something available during it. Scheduling the platform's first irreversible write to a system it does not own inside the riskiest phase in the programme, on numbers whose trustworthiness that same phase is still establishing, inverts the dependency. A sequencing error, not a wording one.

The ADR now carries two clauses with different statuses:

| | | |
|---|---|---|
| **Clause A** | The frozen control totals | **Accepted and executed**, 19 August 2026 |
| **Clause B** | The outbound write | **Proposed, and deliberately undated.** Not part of A13 |

**The current workflow is retained unchanged and deliberately.** The platform keeps reading `affinity_total_investment` and `affinity_fmv` nightly, and the A6 generator keeps working backward from them so synthetic transactions and marks roll up to the top-level figures the VC team recognises (ADR-020, ADR-030). No code changed, because the outbound write was never built — what changed is six documents that described it as scheduled.

**ADR-009's one-way rule therefore holds in full again**, and is restated that way in ADR-009 itself: nothing outbound is built, none is scheduled, and clause B needs its own decision before anyone writes it. `CLAUDE.md` non-negotiable 7 previously read that the exception existed; it now reads that one is proposed.

### Decided

**The snapshot is kept, and its justification is re-based rather than trimmed.** Worth recording the reasoning, because the question asked was genuinely open — with the write indefinite, an insurance-only reading makes `affinity_control_snapshot` look like dead schema awaiting a phase that may never come, and the next person wanting the table gone would drop the trigger rather than ask why it is there.

**The reason that survives on its own has nothing to do with the write.** $47,216,678 and $42,030,272 are the control totals A13 ties to batch by batch, and **they were agreed at an instant. The columns holding them are not** — synced nightly, maintained by hand by the VC team, and ADR-020 already records how volatile that makes them: one deal's figure ran 1,000,000 → 500,000 → deleted → 1,000,000 → 1,500 → 1,500,000, the fat-finger corrected 33 seconds later. A13 is months away. **Without a frozen copy, "each batch reconciles to Finance's control totals" is not a reproducible instruction**, because a failure could not be told apart from Affinity having moved underneath us — and no other artefact in the programme answers that question.

Two more, neither sufficient alone: F4's discovery step may deliberately widen the roster with Exited companies and move both totals, and the snapshot is what makes that decision recoverable; and clause B, if it ever lands, still wants a copy taken beforehand. The through-line is that all three want it taken **before**, and before is a moment that has already passed by the time anyone remembers to. The cost of keeping it is one write-once table and 82 rows, already reconciled to the cent.

**Migration 0007 exists to fix two comments, which is a low bar for a migration and was still the right call.** 0006 is applied and its checksum recorded — the runner refuses an edited file by design, and correctly so. The comments on `affinity_control_snapshot` described it purely as insurance against the write, which is now both mis-sequenced and misleading about what the table is for. Comments in this schema are load-bearing: `\d+` is the only documentation available inside psql at 9pm, and a comment that has quietly become wrong is worse than no comment. No DDL, no data change, safe to re-run.

### Outstanding

Unchanged from the F0 entry apart from the closed item, and repeated because the list is the point:

- **A-11 · the Q-23 email to Funke** on the exact LP wording — "commitment drawdown", or just "drawdown". It gates F5 and nothing else in Track F, and it can go today.
- **A-10 · the second Finance meeting.** Agenda is the five question blocks in `docs/finance-design-notes.md`; Block 2, net book value, is the one worth protecting if it runs short.
- **A-12 · the pedal report file**, which FR-13's field design cannot start without.
- FR-25's equity-versus-loan categorisation still waits on Q-20.
- **New:** clause B has no owner and no trigger condition beyond "the platform's own figures are trustworthy". That is deliberately vague because Finance makes the judgement, but it means nothing will surface it on its own. It should be an explicit item on the A13 close-out rather than something rediscovered by a reader of this ADR in 2027.

---

## 2026-08-19 · F0 · Finance groundwork — a fourth track, seven ADRs, and the snapshot that stops being possible later

**A new track.** The finance requirements meeting with Pat McMullon and Funke Yusuf produced thirty-six numbered requirements, nineteen of which are blocked on a second meeting or on an artefact nobody has seen. **Seventeen are not**, and sixteen of the thirty-six need a schema change. That is the whole argument for Track F and for its position in the sequence: a schema change costs an afternoon against 284 synthetic transactions regenerable from a seed, and costs a data migration over fifteen years of history once A13 has run. **Track F is the work that has to happen while changing the schema is still free**, and it goes before A13.

F0 is the phase that buys the options. Nothing in it changes a calculation, no metric moves, and no golden master was touched — 252 metrics tests, 95 API tests, 39 db tests and 63 functions tests all pass unchanged.

### Built

**The three finance documents are in `docs/`.** `finance-requirements-register.md` and `finance-design-notes.md` verbatim; the roadmap addendum merged into `docs/delivery-roadmap.md` as **Track F**, which is now a fourth track beside A, B and C. The roadmap goes to v2.2. Notes on the Stage 3 and Stage 4 headings say where Track F sits, the outbound Affinity write is an explicit A13 bullet, and Track F is added to the minimum launchable product with the order to cut in if it has to give — F6, then F3, then F4, because F0, F1, F2 and F5 are the four that touch the schema in ways A13 would make expensive.

**Seven ADRs raised as Proposed, ADR-033 to ADR-039**, each moving to Accepted as its phase lands. An ADR written after the code is a summary; one written before it is a decision. The theses are in the Track F section of the roadmap and the records themselves are in `docs/architecture-decisions.md`.

**Four existing ADRs amended in place**, which is the part worth insisting on. A reader who finds ADR-009 first must not come away with a rule that is no longer whole:

| ADR | What changed |
|---|---|
| ADR-007 | The same-date mark index relaxes to one *review* mark per date; `company_fmv_asof` gains `valuation_mark_id desc` as a tiebreak. The FMV cadence, the carry-forward rule and the sign-off principle are untouched — only the entry screen changes |
| ADR-009 | **Twice.** Roster status becomes a synced field (ADR-036), and the one-way rule gains its **first stated exception** at cutover (ADR-039) |
| ADR-012 | The transaction's round link is a reconciliation rather than a capture, which is why `CAN_CAPTURE_ROUND` is the right gate for a mutation that can move a foreign key and nothing else |
| ADR-031 | The version store will distinguish a correction from information arriving late (ADR-038) |

**ADR-020 condition 4 is recorded as satisfied** for the A7 and A8 surfaces, and action **A-9 closes with it** after carrying since 17 August. Three new actions open in its place: the second Finance meeting (A-10), the Q-23 email to Funke (A-11), and the pedal report file (A-12). Condition 4 is re-read as satisfied *per surface* rather than once for the programme — net book value, debt instruments and the reconciliation screen have not been walked through because they do not exist to walk through.

**Migration 0006 · `affinity_control_snapshot`, and the reason it could not wait.** `company.affinity_total_investment` and `company.affinity_fmv` are doing three jobs at once: the A6 generator's per-company reconciliation anchor, the agreed A13 control totals, and — per Q-17 — the fields the platform **overwrites with its own figure at cutover**. The third destroys the other two. After the outbound write, reconciling against those columns proves nothing; the platform would be checking its arithmetic against its own output and would agree with itself perfectly while being wrong.

`npm run snapshot:affinity-controls` froze **82 companies, $47,216,678.00 invested and $42,030,272.00 FMV, to the cent**, asserted against the agreed totals before anything was written. It refuses on a second run rather than upserting, because a baseline that quietly restates itself is not a baseline.

**Migration 0006 · `transaction.instrument_id`,** with the picker beside the vehicle picker on the Finance form, and the read path, write path, A6 generator and fixture importer all carrying it. 180 of 284 rows backfilled from the linked round; the other 104 left NULL and honest about it.

**A test suite for both**, `packages/api/test/finance-groundwork.test.ts`, seven tests.

### Changed

- **`v_transaction_live` is deliberately not widened.** 0002 rewrote it with an explicit column list precisely so a later migration adding a column could not silently widen a view the ADR-001 export reads from. This is the first migration since to add one, and the Finance read path selects from `pc.transaction` directly. FR-25 is the change that will want it in the view.
- **The A6 generator and the fixture importer resolve `instrument_id` in the INSERT** from the round the cheque is being linked to. Without this the F0 backfill would be silently undone by the next `npm run db:generate`, which deletes and reinserts the whole synthetic spine — and an exit criterion that holds until someone runs `db:reset` is not one.
- `CLAUDE.md` non-negotiable 7 now states the ADR-039 exception, and the document table carries the two new finance documents.

### Decided

Three judgement calls the F0 spec did not anticipate. All three are recorded here because each one is a place a future reader would otherwise have to reverse-engineer an intention.

**1. The version trigger is scoped off for the instrument backfill, and for one specific reason.** `zz_version_transaction` fires on every `UPDATE` and would have fired on all 180 backfilled rows. Writing 180 version rows describing a migration is arguably honest noise. **The problem is `new.row_updated_at := now_ts`**, which the trigger sets unconditionally: the Finance screen reads `row_updated_at > row_created_at` as "this row has been edited since it was entered" and draws a pill, so 180 transactions would claim permanently and on screen to have been edited by someone. Nobody edited them.

That failure is not new. Migrations 0002 and 0003 both hit it and both fixed it the same way — flattening `row_updated_at = row_created_at` after their backfills, which 0003's comment says in as many words. Neither could reuse that fix here, because in both cases the trigger was not yet attached and the flattening `UPDATE` would itself fire it now. So the precedent the codebase has already set twice is honoured by scoping the trigger off to exactly that statement, inside the migration's own transaction, re-enabled immediately after.

**The ADR-031 guarantee is not weakened, and the distinction is precise.** That guarantee is about financial *facts*: no dollar figure, date, subject or classification changes without an attributed, reconstructable version record. The backfill changes none of those. It copies a value already in the database, from a row the transaction already points at, into a column nothing reads, by a derivation reproducible from the schema alone. Verified after the fact: `financial_row_version` unchanged at 35 rows, and the only two transactions showing as edited are the two that were genuinely edited on 18 August.

**2. `affinity_control_snapshot` carries no foreign key to `company`, overriding the F0 design note, which specified one.** `truncate pc.company cascade` truncates every table that references it and **fires no row-level trigger** — and the fixture importer issues exactly that statement over eight root tables on every `npm run import:fixture` and every round-trip test run. The FK would therefore have meant the frozen A13 anchor was destroyed, silently and completely, by a routine developer command, through the one door nobody would think to check. Found while writing the tests, not by reasoning about it.

Dropping it is also the more honest model: this is a record of what *another system* said about a company at an instant, and its worth does not depend on the platform's current roster row still existing. That is already the reasoning behind storing `company_name` verbatim rather than joining for it. Referential integrity at write time is not lost either way — the populate script selects straight out of `pc.company` and cannot produce an id that was never there. A `before truncate` statement trigger closes the remaining door on the snapshot table itself.

**3. `txn_instrument_direct_only`.** An LP capital call, distribution or fee bought no instrument. The form hides the picker, the write path gives Finance a readable message, and the constraint is what makes both true for a caller that is neither — which is the pattern `validateTransaction` already follows for the other four transaction constraints: Postgres enforces, TypeScript supplies the sentence a person can act on.

### Outstanding

- ~~**`finance-current-state.md` was not supplied**, and the S-numbers cited throughout Track F — S-1, S-2, S-3, S-4, S-5, S-7, S-8, S-10 — have no committed document behind them.~~ **Closed 20 August 2026**, see the entry above. The baseline is committed and every S-number resolves.
- The equity-versus-loan categorisation (FR-25) waits on **Q-20**. SAFEs are neither straightforwardly, and a column encoding a guess about how NBIF's statements treat one is worse than no column. The instrument is captured; the bucket is not.
- **A-11 · the Q-23 email to Funke** should go before F5 starts, and can go today. It gates F5 and nothing else in Track F. "Commitment drawdown", or just "drawdown" — the whole value of renaming now is that it happens once.
- **A-10 · the second Finance meeting.** The agenda is the *Open questions* section of `docs/finance-design-notes.md`, grouped into five blocks each stating what it blocks. Block 2 — net book value — is the one worth protecting if the meeting runs short.
- **A-12 · the pedal report file.** FR-13's non-investment leverage fields cannot be designed without the format they have to produce.
- F1 will find the `investmentRoundId` note on the transaction form still pointing at the Deal Close tab, which is a dead end: that tab does not write the column either, and nothing in the platform does (S-1). The note is left in place and flagged in the code rather than removed, because F1 is the change that replaces it with a working picker.

---

## 2026-08-18 · A9 · Alerts, health and watchlist — three surfaces, and one word in the spec that did not survive

**The phase as written was "alert feed, health rating workflow, watchlist".** The feed existed and was frozen. The watchlist existed. **The health workflow should not be built at all**, and the reason is a decision already in the ADRs.

Affinity is the system of record for the Risk Assessment that drives health (ADR-009), the sync runs one way, and the VC team maintains the rating there as part of how they already work. There is no workflow for this platform to own. An edit box here would produce a rating that disagrees with itself across two systems, and the next nightly sync would silently win the argument. `docs/delivery-roadmap.md` is amended and the line is struck through rather than deleted, because "we considered it and here is why not" is worth more than a line that was quietly never done.

**What A9 actually needed was configuration, and there was none.** `company_threshold` held a per-company runway floor. A company nobody had configured was silently unwatched, and there was nowhere in the platform to record that the runway threshold is twelve months. Setting that one policy on the development roster took the watchlist **from 95 alerts to 107** — twelve companies that nothing had been watching.

### Built

- **`fund_alert_policy`** — portfolio-wide thresholds that any company inherits unless it sets its own. **Effective-dated**, for the same reason `company_state` is: a watchlist goes in the board pack and ADR-031 exists so an issued pack reproduces. Setting a policy closes the current row and opens a new one; the export reads the policy **as at the reporting date**, never the current one.
- **Three threshold states, kept distinct at every layer.** Absent means inherit, `0` means **disabled**, `n` means override. `0` is the inherited contract meaning of `minRunwayMo` and **the only escape hatch from a portfolio-wide default** — so every layer tests it with an explicit null check rather than truthiness, because `0` is falsy and is exactly the value that must survive. There is a test whose whole job is that one property.
- **Four metrics joined runway**: burn multiple, cash floor, quarter-over-quarter revenue decline, NRR.
- **`ref_risk_flag_category`** — fourteen categories, each declaring which derived metric alert it stands in for. `company_risk_flag` has existed since A1 and nothing but the fixture importer and the A6 generator could ever write to it: no API, no UI, no audit trail. It has all three now.
- **`alert_acknowledgement`** — a time-boxed, reasoned judgement that an alert is understood and accepted. It lapses three ways: the date passes, someone revokes it, or **the reading moves materially past where it was signed off**. Never a delete — the breach is still derived and still shown on the company.
- **A ninth tab, role-gated to `vc` and `admin`**, on the same reasoning that put Deal Close and Finance outside the ported eight (ADR-014). The Dashboard feed is unchanged in shape and stays the board-facing port.
- **Health provenance on the drawer** — grade, who set it, when — read-only, **with the reason stated on screen**, because a greyed-out field with no explanation reads as a missing feature rather than a deliberate one.

### The regex, and why it had to go

`healthAlerts()` de-duplicated risk flags against the runway alert **by regex on the flag's display text** — `!/Runway/i.test(f)`. That is a fine shortcut when one person authors the flags in a JSON file. It is a trap the moment a form exists: "Runway getting tight" vanishes from the feed with nothing on screen saying it was suppressed, and "Cash under 3 months" duplicates the alert it meant to annotate.

The category declares the relationship now. **The regex survives exactly once**, in a one-time backfill, which is the right place for an interpretation of legacy text — and it lives in a SQL function with two callers, the backfill and the fixture importer, rather than a TypeScript copy that would drift from the SQL one the first time either was edited.

**The backfill was wrong on its first run and the database said so.** "Hiring plan behind schedule" landed in `revenue`, claimed by the pattern on the word "plan" before the team pattern got a look. Six rows. A hiring problem filed under revenue is a category nobody trusts again after they spot one, so `team` now precedes `revenue` and the short tokens carry word boundaries — without them `doe` matches "does" and `board` matches "onboarding", which is the exact failure mode the vocabulary exists to remove, reintroduced in the backfill. All nine distinct strings now classify correctly with nothing falling through to `other`.

**Suppression also became conditional, and it was free.** The prototype dropped a matching flag whether or not the metric had fired, so a runway flag on a company comfortably above its threshold was invisible everywhere. Measured before changing it: all twenty runway flags in the reference fixture sit on companies that also breach, so there are no orphans and the fixture output is unchanged. Confirmed live afterwards — before the policy was set, Soricimed showed its "Runway below policy" flag and no runway alert; after, the alert appeared and the flag correctly stepped aside.

### What it cost the golden master: four alerts, and not one more

Every A9 addition is gated on data a schemaVersion 1 document does not carry — `alertPolicy`, the new threshold fields, a `nrr` reading, an `asOf` for acknowledgements — so `healthAlerts(demo.json)` is inert on all of them. **One exception**: `maxBurnMult` has been in the contract since v1, sits on 68 of the fixture's 70 companies, and the prototype **stored it and never computed anything with it**.

Measured before the code was written, asserted after:

| | |
|---|---|
| alerts | 39 → 43 |
| added | 4, all burn multiple (C001, C002, C008, C009) |
| removed | 0 |
| severity changes on surviving alerts | 0 |
| relative order of the 39 pre-existing alerts | preserved exactly |

**The fixture was not recaptured, because it cannot be.** `capture.ts` produces it by running the *committed prototype* over `demo.json`, and `verify:fixtures --check` compares the committed file against that same output — its error message names hand-editing as the one thing ADR-013 exists to prevent. A fixture carrying burn-multiple alerts would fail its own verifier forever. `golden-master.json` is a **recording of the prototype**, not a record of what the metrics package currently does, and it stays one: `verify:fixtures` still reports 39 alerts and still passes. The divergence lives in `golden-master.test.ts` as four lines of data someone has to delete on purpose.

### Decided

- **Burn multiple is quarterly net burn ÷ quarterly net new revenue**, which is where the stored 1.5 / 2 / 3 thresholds plainly come from. It is **silent when revenue is flat or falling** — that is the definition, not defensive coding. The denominator goes to zero and the ratio to infinity, which would park every struggling company at the top of the feed behind a meaningless number; that company is described by the revenue-decline alert instead.
- **Revenue decline is quarter over quarter**, on the period actual (D-2). Noisier than year over year and far faster, which is what an alert is for. The acknowledge-with-reason path is what absorbs a seasonal quarter.
- **A breach is never stored** (ADR-002). Only the judgement about one, keyed on the alert's *subject* rather than its value, so a nightly Visible refresh does not silently orphan an acknowledgement.
- **The flag vocabulary is seeded by migration 0005 rather than `seed.ts`**, against the convention, because the migration's own backfill runs in the same transaction and cannot classify against an empty table.
- **`docs/schema.sql` is untouched, and that is the convention rather than an omission.** `packages/db/test/migration-parity.test.ts` asserts it is a *verbatim* copy of migration 0001 — it is the A1 design document, not a living picture of the current schema, and 0002 and 0003 are absent from it for the same reason 0005 is. Discovered by breaking it: A9's DDL was written into `schema.sql` first, on the assumption it tracked every migration, and the parity test said otherwise.

### Verified

- **88 API tests, 252 metrics tests, all green**; lint and typecheck clean. 38 tests are new, and the three carrying the most weight are: an explicit `0` escapes the fund policy, a flag suppresses the metric its **category** declares rather than the one its **text** mentions, and a materially worse reading re-fires an alert before its acknowledgement expires.
- **End to end in the browser**, not just in tests: set the 12-month policy through the UI, watched the feed go 95 → 107 with `policy` and `company` provenance pills distinguishing the source of every threshold, raised a flag on Soricimed and confirmed the row, its composed display string (`Runway — Bridge under negotiation`), its resolved category and its `audit_log` entry in Postgres. The test flag was then removed; the audit row stays, which is what an audit log is for.
- **`docs/schema.sql` loads clean into an empty database**, checked by loading it.

### Outstanding

- **The 12-month policy is set in the development database** and is a real NBIF figure, so it stays. The other four metrics are deliberately unset — cash floor, burn multiple, revenue decline and NRR have no agreed portfolio-wide number yet, and inventing one would put companies on a watchlist on the strength of a figure nobody chose. **That is a conversation with the VC team, not a default.**
- **`RISK_FLAG_CATEGORIES` in `alerts-api.ts` mirrors the database vocabulary** so the picker needs no round trip. The write path resolves against the real table and refuses an unknown code, so this list cannot invent a category — but it can go stale and show one option fewer than exists. Visible and harmless; worth an endpoint if the vocabulary ever starts moving.
- **Acknowledgements are not surfaced in the board pack.** A11 builds the Reports PDF and the watchlist in it currently filters on health colour rather than reading the alert feed. An alert that has been acknowledged with a reason is exactly the kind of thing a board wants to see stated rather than hidden, and that is an A11 decision.
- **Nothing re-fires an acknowledgement on a *threshold* change.** The trip wire watches the reading, not the policy: tightening the runway floor from 12 to 15 does not disturb an acknowledgement signed under the old one. Arguably correct — the judgement was about the company, not the number — but it is not a decision anyone has actually made.
- Carried from A8.2: nothing enforces "one roster per database"; `fund.capital_base` is still NULL and renders blank on the dashboard; `company.visible_company_id` is still never populated.

---

## 2026-08-17 · A8.2 · The demo database serves NBIF only, and the thing that kept wiping it is finally named

**Why this session happened.** A platform demonstration to Daniel is coming, and the dashboard was serving **152 companies — 70 of them the prototype's fictional roster**, with nothing on any screen saying which were which. Solvine, Cobalt Harbor and Vantara Systems sat beside Introhive, Soricimed and Beauceron Security, and the fund at the top of every board-facing screen read **"Ridgeline Direct Investments", in USD, on a $400M capital base**.

**Nothing was broken.** This is the state `import:fixture` and `affinity:sync` produce *when both are correct*. The importer truncates and replaces, so a fixture load into an empty database is clean; the sync INSERTS, and its id allocator deliberately skips `C001-C070` so "a roster loaded beside the reference fixture cannot collide". Each command did exactly what it says. What did not exist was the inverse — a way to take the fixture back out of a database that had since been synced — so the two correct commands composed into a portfolio that was 46% fiction.

### The wipes: attributed, four days late

A8.1 closed with *"I could not attribute the final instance."* It is attributable now, and it was still running.

```
node vitest.mjs run -w packages/api      started 13 Aug 15:45, still alive 17 Aug
```

**`-w` is vitest's `--watch` flag, not npm's workspace flag.** The command reads as "run the tests in packages/api" and means "watch the whole repository, filtering to paths matching `packages/api`". Executed from the repo root, where there is no `vitest.config.ts`, so **`setupFiles` never loaded and the `<database>_test` redirect never applied** — every re-run, on every file change, for four days, went at `portfolio_command` and truncated it. It wiped the database twice during this session alone, once while I was mid-investigation, which is what exposed it: `audit_log` carried an `__import__` row stamped 60 seconds after a command I had not run.

This also explains A8.1's marker-row alibi. `npm test` was innocent every time it was tested, because `npm test` is not what was doing it.

**Killed.** If tests are ever wanted in watch mode: `npm test -w @portfolio-command/api -- --watch`, or `npx vitest --root packages/api`. Never `vitest -w <path>` from the root.

### Built

- **`npm run fixture:purge`** (`packages/api/src/import/purge-fixture.ts`, `purge-cli.ts`) — the inverse of `import:fixture`. Removes only rows it can prove the fixture wrote, on three exact discriminators rather than heuristics: `company.affinity_org_id is null` (the same signal A8.1's guard reads, and exact for the same reason — two writers, one always sets it), `pipeline_deal.affinity_row_id is null`, and **the import's own batch id, recovered from the `__import__` ledger row the importer already writes to `audit_log`**. `--dry` reports and rolls back.
- **The fund-level rows are the half that would have been missed.** LP cashflows and fund distributions hang off the fund, not off a company, so removing the roster leaves them behind — **$47.5M of fictional realizations sitting in the fund's DPI**, plus nine NAV-history quarters on the dashboard chart. NAV snapshots are matched on the whole `(period_end, nav, cumulative_cost)` triple to the cent, so a figure the generator computed cannot be mistaken for one the fixture asserted, and a **frozen** snapshot is never touched.
- **It refuses to touch two things** and says so: a company without an Affinity id that holds a financial row which is not synthetic, and one named by a fund distribution outside the import batches. Neither is reachable today; both are what a hand-entered holding would look like, and eating one silently would be a worse bug than the one this fixes.
- **`packages/db/src/fund-identity.ts`** — the fund row's configuration, extracted from `seed.ts` unchanged. Two commands now create that row and they must agree; a purge that restored a different name than the seed creates would be a silent divergence between a rebuilt database and a purged one. Financial fields are deliberately absent from it: the purge sets `capital_base`, `committed`, `called`, fee drag, the two policy strings and the follow-on budget back to NULL rather than carrying the fixture's figures forward under NBIF's name (ADR-020).
- **`assertTestDatabase()`** in `use-test-db.ts`, called by `fixture-purge`, `round-trip` and `import-guard` immediately before they connect. **A setup file cannot defend against its own absence** — the redirect above it is correct and has been verified repeatedly, and the database was destroyed anyway because the file never ran. This fires however the redirect comes to be missing, and turns a wiped database into a failed assertion. Verified by pointing the round-trip suite at `portfolio_command` on purpose: it refused, and the 70 rows in front of it were untouched.
- **`packages/api/test/fixture-purge.test.ts`** — ten tests over the exact mixed state the command exists for: fixture imported, real roster inserted beside it, a hand-entered company carrying a real transaction, a fund distribution nobody imported. Both halves are asserted, because *"the fixture is gone"* is worthless if the answer to *"and is the roster still there?"* is no.

### Changed

- **`import:fixture` and `fixture:purge` at the repo root now invoke `tsx` directly**, as `db:generate` and `affinity:sync` already did. The nested `npm run … -w @portfolio-command/api` form **silently ate every flag**: `npm run fixture:purge -- --dry` reached npm as `--dry-run` (npm warned and expanded it) and the CLI ran a *committing* purge. By the same mechanism **`npm run import:fixture -- --force` has never worked** — npm consumed `--force` as its own flag and the documented recovery path was a no-op. Only the guard test caught nothing, because it spawns the CLI directly.

### Verified — the demo database

Rebuilt in place rather than through `db:reset`: purge, then `affinity:sync`, `visible:sync`, `db:generate`. Same end state, without dropping the volume.

| | |
|---|---|
| companies | **82, every one carrying an `affinity_org_id`** |
| pipeline deals | **350, every one carrying an `affinity_row_id`** |
| KPI rows | **999, all `source_system = 'visible'`** |
| transactions | 282, all `is_synthetic` |
| fund | **NBIF, CAD, inception 2003, capital base blank** |
| fixture rows | **0** |

On screen: 75 active / 7 exited, no fixture name anywhere in the DOM on Dashboard, Portfolio or Pipeline, no console errors, and the ADR-020 synthetic banner still on every screen — the financial spine is still generated, and the demo must keep saying so.

Company ids reallocated from `C001` because the purge ran before the sync, so the fixture no longer occupied the first seventy. Per-company synthetic histories are re-rolled as a consequence (the A6 generator seeds on `company_id`); the control totals are unchanged, being reconciled to Affinity's own FMV and total-investment figures.

### Decided

- **The fixture stays in the repository and stays loadable.** ADR-020 makes it the development dataset and the round trip is asserted against it; the problem was never that it exists, only that it had no way out of a database. `import:fixture` is unchanged and `demo.json` is untouched.
- **A purge, not a read-path filter.** Hiding the rows behind a `where` clause in the export adapter would have left the fund's DPI, NAV history and leverage denominators reading fictional figures, since those aggregate rows the filter would not have reached.

### Outstanding

- **Nothing enforces "one roster per database".** `affinity:sync` will happily insert beside a fixture again — that is its documented behaviour and the id allocator supports it deliberately. The purge is the cure, not a prevention. A warning in the sync's summary when `company.affinity_org_id is null` rows are present would be about four lines, and is not written.
- **`fund.capital_base` is NULL and renders blank on the dashboard** ("capital base not set", "Recycled — dry powder —"). That is honest and it is what the seed intends, but it is a visible gap in a demo. It needs a real figure from Finance, not a restored fixture one.
- **`company.visible_company_id` is never populated** — the Visible sync matches on website and stores KPIs without recording the profile id. Harmless, and it makes that column useless as a discriminator; noted because the purge checks it and gets nothing from it.
- Carried: the A8.1 note that `importContract` itself is unguarded by design, and the `npm audit` dev-tooling findings.

---

## 2026-08-17 · A8.1 · The thing that kept wiping the development database

**Closes the item A8 left open.** It was `npm run import:fixture`, and it had been hiding behind a much more plausible suspect for two phases.

**What was actually happening.** `importContract` truncates eight root tables with `cascade` before it loads. That is correct for what it asserts — the ADR-001 contract reproducing itself out of an empty schema — and the round-trip test needs it. But `importContract` is also what the **CLI** calls, against `DATABASE_URL` itself, which locally is the database someone is working in. Running it took the real roster, five years of Visible history and the whole A6 financial spine, and said nothing about having done so.

**Why it took so long to find, which is the part worth recording.** A6 hit this twice, diagnosed it as the round-trip *test*, and built `<database>_test` isolation to fix it. That diagnosis was right about the mechanism and incomplete about the entry points: the isolation covered the test path and left the CLI path issuing the identical truncate one directory away. So every subsequent investigation started from "is the test suite leaking?", and the answer was always no — correctly. A marker row planted in the dev database survived a full `npm test` twice, once with the real roster present. The suspect had an alibi, and it kept its alibi while the database kept being wiped.

**Verified, both directions:**
- `npm run import:fixture` against the real roster now **refuses**, naming what it would destroy: 82 companies synced from Affinity, 999 KPI rows, 282 transactions, 177 rounds.
- Against a fixture-only or empty database it **proceeds silently**, which is the case CI runs and the case a developer runs daily.
- `npm test` with the real roster present leaves 82 companies / 999 KPIs / 302 co-investors untouched. The A6 isolation was working all along.

**Built**
- **The guard, on the CLI rather than the library.** One trigger — `company.affinity_org_id is not null` — because it is the only exact discriminator: the importer never writes it, the sync always does. `--force` overrides and announces what it is overwriting.
- **The CLI now prints its target database before touching anything.** "Which database did that just run against" was the single hardest question to answer while this was undiagnosed.
- **`packages/api/test/import-guard.test.ts`** — three tests, driving the real CLI end to end. A guard nothing exercises is a guard someone deletes in a refactor.

**Decided — one trigger, not three.** The first version probed three signals and two of them were false positives that only showed up against the real database: `company_kpi.source_system = 'visible'` fires on fixture data because the column defaults to `visible`, and `transaction.is_synthetic` fires because the fixture genuinely *is* synthetic and sets the flag exactly as ADR-020 requires. It refused to load a fixture over a fixture. **A guard that fires on the normal path is worse than no guard**, because it gets routed around with `--force` out of habit and then does not fire on the abnormal one. The three probes collapsed to one exact signal, with the rest reported as consequences rather than used as triggers. Both false positives are now pinned by a test.

**Also built — `0004_transaction_round_index.sql`, on measurement rather than instinct.** `transaction` carried three indexes and none on `investment_round_id`, so the per-round lateral in the ADR-001 export adapter and in `readRounds` sequential-scanned the whole table once per round — on `page.tsx`, which is `force-dynamic` because board numbers must never come from a cache. Measured on the A6 dataset: 889 buffers unindexed against 360 indexed, both under a millisecond. **It buys nothing today and that is stated in the migration.** It goes in for the shape: the work is O(rounds × transactions) and only the constant is small, and A13 loads Finance's full history since inception. On the smaller reference fixture the planner correctly ignores the index entirely, which is the right call at three pages.

**Outstanding**
- **The CLI is guarded; `importContract` itself is not, deliberately.** The library truncates on request because the round-trip test needs exactly that. Any *future* caller of it inherits the old hazard, and the guard would have to be repeated. Acceptable at two callers; worth revisiting if a third appears.
- **`db:generate` and `db:seed` were reviewed and need no guard.** The generator's deletes are scoped by `is_synthetic` or by system-principal authorship and it never truncates a root table; the seed is idempotent and asserts as much in CI. `db:reset` is destructive and says so in its name.
- **I could not attribute the final instance.** The mechanism is proven and fixed, and I observed it wiping the database directly. Who invoked it at 17:16 is not something I can see from here, and I have not invented a cause for it.

---

## 2026-08-17 · A8 · Deal-close capture, and the soft delete 0002 left half wired

**A8 exit criteria — met.** *"Capture form: round total, co-investors with NB flag and amount, ownership, pro-rata, post-money. `v_mandate_completeness` surfaced on the dashboard."* Both, on the real portfolio. The phase turned out to be less about the form than about the three things that had to be true before the form was safe to ship.

**The schema was already there, and that was the trap.** `investment_round.round_total`, `nb_other`, `post_money`, `ownership_after_pct`, the whole `round_coinvestor` table and `company_ownership.pro_rata_rights` have existed since A1, and `v_mandate_completeness` since 0001 — unread by anything. So A8 looked like UI work. What it actually was: giving three tables a write path, two of which had a reproducibility guarantee and one of which did not.

**Decided — three questions ADR-012 left open, all raised before building.**

- **`CAN_CAPTURE_ROUND` is `vc`, `finance`, `admin`** (your call). ADR-012 says the deal lead; `investment_round` and `company_ownership` are ADR-031 versioned tables behind `CAN_WRITE_FINANCIAL`, which is finance-only. Resolved by ADR-005's rule rather than the table boundary: **our cheque is Finance's fact and stays on `transaction`, still finance-only**; the shape of the round around it — who else was in, for how much, what we ended up owning — is the deal lead's, from closing documents they hold. Finance keeps access because A13 loads its own history through this path.
- **A tenth tab, `Deal Close`**, on A7's pattern rather than inside the company drawer (your call). The drawer is a ported surface ADR-014 freezes, and more practically ADR-012's second half is monitoring — a per-company drawer has nowhere to put the chasing list that makes a coverage figure actionable.
- **`round_coinvestor` joins the ADR-031 versioned set** (your call, migration 0003). It meets ADR-031's own test and was left out of 0002 only because nothing could write to it. Shipping the edit button without the guarantee would have put NB co-investment and `v_lp_capital_to_direct` — two mandate figures — outside the property the whole of A7 was priced on.

**Built**
- **`packages/db/migrations/0003_round_capture.sql`** — `round_coinvestor` gains `is_synthetic` and the lifecycle block, the capture trigger and `round_coinvestor_asof()`; two amendments to the trigger; four reads taught to honour `deleted_at`; `v_mandate_completeness` corrected and extended, plus `v_mandate_completeness_by_year`.
- **`packages/api/src/write/rounds.ts`** — ADR-012's "single deal-close form" made literal: **one mutation, one transaction, three tables.** Not three endpoints called in sequence, because that fails silently — a round total saved without its co-investors moves the leverage KPI and leaves the NB one behind, and no screen would say so.
- **`packages/api/src/write/session.ts`** — the actor GUC, the restatement test and the money/date validators, extracted from `financial.ts` when `rounds.ts` became the second module writing to a trigger-backed table. Same rules, one copy.
- **`packages/api/src/read/rounds.ts`** — rounds with their co-investors in one query, per-round completeness and exclusion flags, the coverage scalars and the by-year taper, and the reference lists.
- **`/api/v1/rounds`** (GET + POST, with `?completeness=` and `?reference=`).
- **A tenth tab, `Deal Close`**, and **`apps/web/components/entry.tsx`** — A7's form scaffolding extracted so the two entry surfaces cannot drift into looking like two products.
- **The dashboard's mandate surface**: the coverage qualifier on the Leverage tile, and a `Mandate Capture Coverage` card at the foot.
- **`packages/api/test/round-capture.test.ts`** — nine tests, including the one this phase is priced on: capture an NB co-investor amount, correct it, reconstruct as of before, assert the published figure returns.

**Three defects found on the way in, none of them A8's own**
- **Nothing honoured `deleted_at` on `investment_round` or `company_ownership`.** 0002 added the columns and wired the reads for the two tables it could then delete from. `v_round_leverage`, `v_lp_capital_to_direct`, `v_mandate_completeness`, `company_current_asof` and **the ADR-001 export adapter's round query** all read deleted rows. Latent while no write path could set the column — and live the moment this phase shipped the form that can.
- **Every freshly generated row would have claimed to have been edited.** A7 fixed this for rows existing at migration time by flattening `row_created_at`/`row_updated_at`. It did not fix the ongoing path: column defaults are applied *before* a `BEFORE` trigger runs, so the generator-exemption branch returns with the pair already set microseconds apart by two evaluations of the volatile `clock_timestamp()`. It would have surfaced on the next `npm run db:generate` — the whole synthetic dataset wearing an "Edited" pill. Verified fixed: 302 co-investors, zero flagged.
- **`round_coinvestor` carried no `is_synthetic`**, though ADR-020 requires every generated financial row to. Backfilled from the parent round; the generator now sets it.

**Changed**
- **The generator exemption now covers `UPDATE`.** 0002 excluded it and said why — "the generator never issues one" — which stopped being true when A6 added the second-pass co-investor→LP link. The property it protected survives: a human editing a synthetic row in a demo carries their own actor id and is versioned. Verified: `financial_row_version` reads **0** after a full regeneration.
- **The trigger inherits an effective date from the parent round** where a table has none of its own. `round_coinvestor` is dated by its round; without this an edit inside an issued period would record `is_restatement = false` and stay out of `v_restatement_log`. Written as a fallback, so `transaction` — which has both a `txn_date` and an `investment_round_id` — is untouched.
- **Post-money is captured but is not a completeness field.** A null is legitimately "not applicable" on a convertible and "not known" on equity, and the platform cannot tell them apart; counting it would report a portfolio of notes as permanently incomplete, which is D-5's error inverted. `captured_at` separately answers "has a deal lead opened this at all", which is the different question.
- **A round total below our own cheque is accepted and flagged, never refused.** ADR-012 says such a round is *excluded* from leverage; excluded is not refused. Rejecting it would push the deal lead into not recording the round, or into adjusting a figure to get past the form.
- **A7's outstanding "no investment-vehicle picker" item is closed.** ADR-030 makes the vehicle an attribute of the transaction and Finance should own it; it shipped read-only because the reference list was behind no endpoint. A8 needed the same list, so the picker is now live on the transaction form. The round link stays read-only — which round a cheque belongs to is a capture decision, not a Finance correction.

**Verified** — **386 tests pass**, up from 371. The 202 golden masters and the ADR-001 round trip are untouched: **no board number moved**. Then in the browser, against the real roster:
- Dashboard reproduces every A6 figure exactly — $47.2M invested, $42.0M FMV, 75 active / 7 exited, TVPI 0.89x, leverage 5.9:1, FMV growth +5.6% — so the five new `deleted_at` predicates moved nothing.
- **Leverage now reads `5.9 : 1 · From 150 of 177 rounds (84.7% captured)`**, and the taper is visible on the card: 2009–2015 runs 0–100% on tiny counts, 2018 onward settles at 85–93%. That is ADR-015's shape, reported rather than smoothed.
- **A real capture end to end over HTTP**: filled in a Climative round that had never carried a total. One request wrote the round, two co-investors and the ownership row; coverage moved **84.7% → 85.3%**, missing totals 27 → 26; capital attracted **$245.0M → $247.0M** and NB co-investment **$31.6M → $32.4M**, both by exactly the captured amounts; **invested cost stayed at $47.2M**, because a capture writes no transaction. The History panel showed the four-field diff with the actor and the reason.
- `v_lp_capital_to_direct` still reads **$40.66M across 15 positions**, the A6 figure.
- No console errors.

**Outstanding**
- **A-9 still stands, and now covers this form too.** The A7 entry screens have still not been walked through with the Director of Finance, and the capture form has not been walked through with the VC team lead. ADR-012 records D-4 as accepted in principle; the form built against it is a proposal to walk through, not a finished spec.
- ~~**The dev database was found reset to the fixture mid-session and I could not reproduce it.**~~ — **found and fixed, same day. See the entry below.**
- **`round_coinvestor` has no `entered_by`.** Every other financial table does. The version store's `create` entry names the actor, which is the same information by another route, so this is a consistency gap rather than a hole.
- **The Climative round now carries a genuine, non-synthetic capture** on a synthetic round in the dev database. `db:generate` clears it by cascade; harmless, and worth knowing before wondering where it came from.
- **`v_mandate_completeness` counts synthetic rounds** — it reports the count separately but does not exclude them. Correct while the ADR-020 banner is up and the whole dataset is generated; worth revisiting at A13 when the mix is real.
- **No screen yet shows the co-investor set beside the `nb_other` field it disagrees with**, except inside the capture form. The two are separate captures and the metric uses `nb_other`; the form shows the gap, the dashboard does not.
- Carried from A7: `fund_distribution` still has no UI surface; rows predating 0002 carry no `create` entry. Carried longer: `FundInvestment.womenSeniorGP` cannot express "not reported"; `organic +$-4.2M` on the dashboard; `ytdPlatformsClosed` reads 0 against Reports' 12; `fund.capital_base` and four other fund facts still NULL; Entra unconfigured; deploy not wired (A0).

---

## 2026-08-17 · A7 · Finance entry interfaces, and ADR-018 reversed

**A7 exit criteria — met.** Transaction, valuation-mark and LP NAV entry, with filters, running totals, and a change history on every row. The phase opened with a decision that changed what it was building.

**Decided — ADR-018 is superseded by ADR-031. Financial rows are editable.**

Raised by the operator before the interface was built rather than after: Finance works in Excel, where every cell is editable, and ADR-018 would have handed them a registry in which a same-session typo must be fixed by booking a compensating negative row. The predictable failure is not that they learn the formalism — it is that entry migrates back to a spreadsheet and the platform stops being the registry ADR-011 says it is.

**What ADR-018 was actually protecting was the storage model, not the button.** Its own context says the harm is that editing "makes every previously issued board report irreproducible". Append-only is one way to keep every past state retrievable; it is not the only one, and it is the one that puts the whole cost on the operator. So the requirement survives and the mechanism changed:

- Base tables hold current state and are edited in place. **No view, metric or golden master changed** — that is what made this affordable at A7 rather than a rewrite, and the 250 metrics tests plus the round-trip suite assert it.
- Every mutation writes the prior row image to **`financial_row_version`, by database trigger**. An `UPDATE` typed into psql at 9pm is captured identically to one through the API. This is the whole basis on which dropping append-only was safe: a convention can be bypassed, a trigger cannot.
- The trigger **raises unless the session sets `pc.actor_id`**. No financial row can be modified anonymously by any route.
- `<table>_asof(timestamptz)` reconstructs any of the six tables as it stood at a past instant. Built now, not deferred to A11: a reconstruction path that does not exist yet is a reproducibility guarantee that does not exist yet.
- Editing inside a frozen `fund_nav_snapshot` period is permitted, flagged, and requires a restatement reason. `v_restatement_log` is the list.
- Deletion is soft; `deleted_at` removes a row from every view and total and is restorable.
- Reversal survives for genuine economic events (a clawback is a real dated fact). What is withdrawn is the obligation to use it for typing errors.

**Built**
- **`packages/db/migrations/0002_financial_row_versioning.sql`** — the lifecycle columns on six tables, `financial_row_version`, `current_actor_id()`, the capture trigger, six `*_asof()` functions generated from one template, `v_financial_change_log` and `v_restatement_log`.
- **`packages/api/src/write/financial.ts`** — create/update/delete/restore for transactions, marks, LP NAV and fund distributions. Role gate, actor GUC, restatement detection, and the four `transaction` check constraints restated in TypeScript so Finance reads a sentence instead of a constraint name.
- **`packages/api/src/read/finance.ts`** — the three listings, running totals net of deletions, and a per-row history with a server-computed field-level diff.
- **`/api/v1/financial`** (GET + POST) and **`/api/v1/financial/history`**.
- **A ninth tab, `Finance`**, role-gated to `finance` and `admin`, with a **History** panel in the existing drawer.
- **`packages/api/test/financial-versioning.test.ts`** — six tests, including the round trip ADR-031 is priced on: mutate, reconstruct as of before, assert the original figures return.

**Changed**
- **The API speaks dollars, not `$M`.** A deliberate divergence from ADR-001, which governs the export contract — this is a new internal entry API whose only caller is a form the Director of Finance types into. Asking them to express $5,000,000 as `5` would invent the exact class of error `units.ts` exists to prevent, on the one path where the figure has not yet been checked against anything. Money stays a string end to end.
- **`importContract` now names an actor.** The trigger found it on the first test run — a real write path that never identified itself. Exactly what the trigger is for.
- **`v_transaction_live` has an explicit column list** where 0001 had `select *`. Forced by `create or replace view` refusing to widen a view, and worth keeping: a future column addition can no longer silently reshape a view the export reads from.
- **`packages/api` tests run one file at a time.** `round-trip.test.ts` truncates every root table; run concurrently with the new suite it interleaved and the *golden-master assertion* failed. An alarm that means "a board number moved" must not cry wolf on a scheduling race.
- `ValidationError` moved to `write/errors.ts` — having `financial.ts` import it from `judgement.ts` implied a relationship ADR-018 spent an ADR establishing does not exist.

**Two bugs the verification caught, both worth recording because neither would have shown up in a test I thought to write first:**
- **The edit form silently nulled `investment_round_id`.** The API takes a complete row on update rather than a patch (a patch cannot distinguish "leave alone" from "clear"), and the form supplied only the fields it drew — so an amount correction destroyed a transaction's link to its round. Found by reading the History panel's own diff on the first real edit. The form now round-trips every column it writes and shows the preserved ones.
- **Every pre-existing row claimed to have been edited.** `clock_timestamp()` is volatile and evaluated per column, so `row_created_at` and `row_updated_at` landed microseconds apart on the four tables without a `booked_at` to backfill from, and the UI's "edited" pill keys on `row_updated_at > row_created_at`. The migration now flattens the pair explicitly.

**Outstanding**
- **A-9 still stands: walk the workflow through with the Director of Finance before this is relied on.** ADR-020 condition 4 asks for it *before* building, and it has not happened — the interface was built to the roadmap's description. Treat the current forms as a proposal to walk through, not a finished spec.
- **No investment-vehicle picker on the transaction form.** ADR-030 makes the vehicle an attribute of the transaction and Finance should own it, but the reference list is not exposed through any endpoint yet. Currently preserved on edit, never set. Needs a small reference-data route; naturally belongs with A8's capture form.
- **`fund_distribution` has a write path but no UI surface.** The ADR-025 exception table is still empty and still the exception; wiring a screen to it before A13 resolves the double-count would invite someone to populate it.
- **Rows created before this migration carry no `create` entry** in their history, only their edits. Immaterial for synthetic data, and A13 loads real history after this point, so the real portfolio will be complete from creation.
- The A13 note in the roadmap should be revisited: the port's exception path can now correct a mis-loaded row by editing it rather than reversing and rebooking, which makes that phase slightly cheaper than budgeted.

---

## 2026-08-14 · A6 · Synthetic financial dataset on the real roster — reconciled to Affinity's own totals

**A6 exit criteria — met.** *"A full, messy, realistic dataset attached to the real roster and reconciling to the control totals the VC team already knows; the banner works; the platform is demonstrable end to end on it."* The criterion was restated this session when B2 was withdrawn — see the decision below.

**Built**
- **`packages/db/src/generate/`** and **`npm run db:generate`** (`-- --dry` generates, reconciles, reports and rolls back). Five files, split so the half worth testing has no database in it, on the `functions/src/affinity/map.ts` precedent:
  - **`rng.ts`** — the prototype's `mulberry32` verbatim (`vc-toolkit.html:197`), the precedent the roadmap names. **Seeded per company**, so adding a company to the roster or regenerating one position leaves every other company's history byte-identical. One shared stream would reshuffle the whole portfolio every time Affinity gained a row.
  - **`plan.ts`** — the company planner. Rounds, cheques, dates, instruments, round totals, co-investors, ownership, marks, reserves, write-offs.
  - **`lp.ts`** — the LP planner. Capital calls, NAV, vintages.
  - **`dirt.ts`** — the ADR-020 defects, each targeted at a named company and printed on every run.
  - **`run.ts`** — reads the real facts, writes, reconciles, reports. Aborts the transaction if any company disagrees with its control total.
- **38 tests** in `packages/db/test/generate.test.ts`, over the pure planners.
- **`packages/db/data/investment_vehicle.json`** and **`lp_fund.json`**, from the two supplied workbooks. Committed because neither figure exists in any system the platform syncs.
- **`ref_investment_vehicle`**, and `investment_vehicle_id` on `transaction` and `investment_round` (**ADR-030**).
- **A dedicated test database.** See below — this is the one item that is infrastructure rather than data, and it is here because it bit twice in one session.

**The property the whole phase rests on**

Finance has not supplied per-transaction history (ADR-011), so every date, cheque size, round label and mark is invented. The totals are not. For all 82 companies:

| | generated | Affinity |
|---|---|---|
| invested | **$47,216,678.00** | $47,216,678.00 |
| FMV | **$42,030,272.00** | $42,030,272.00 |

and for the LP sleeve, against the workbook:

| | generated | workbook |
|---|---|---|
| committed | **$8,725,000.00** | $8,725,000.00 |
| called | **$4,152,160.00** | $4,152,160.00 |

`run.ts` re-reads all four **out of Postgres after the write** — not from the plan objects — and rolls back on any disagreement. Checking the database rather than the plan is what catches a bad cast, a lost row, a currency that never got converted and a constraint that silently dropped something. Arithmetic is in integer cents throughout, because a control total out by $0.01 is indistinguishable from one out by $10,000 when the assertion is exact.

**Verified**
- **371 tests pass.** The A1 golden master is untouched: no metric definition moved.
- **The generator is deterministic and idempotent.** Two consecutive runs leave an md5 over the whole transaction table byte-identical.
- **Distribution is realistic, and matches what the roadmap asked for**: vintages spread **2009–2025** (17 years); 39 companies at one round, 27 at two or three, 11 at four, 5 with five to seven; 24 rounds with no captured total; 7 write-offs.
- **In the browser**: dashboard reads $47.2M invested / $42.0M FMV / 75 active / 7 exited, marks as at 2026-07-31, TVPI 0.89x, DPI 0.00x, leverage 5.9:1, FMV growth +5.6% YoY. Portfolio tab sorts on real MOIC with Sonrai at 2.81x and Eigen at 0.64x. Funds tab reads $8.7M committed / $4.2M called / NAV $5.5M / TVPI 1.32x. Company drawers show full round histories, per-round leverage, marks, reserves, board seats, milestones and government funding. **The ADR-020 banner is on every screen.**

**Decided**
- **The vehicle is an attribute of the transaction, not the company** (ADR-030, your call). The export's `Fund` column (VCF 40 / SIF 20 / ACC 20) is **not in Affinity's profiled field metadata at all**, so the sync cannot fetch it and it is committed as a keyed data file instead. Two roster companies are absent from the Status-filtered export and carry a NULL vehicle rather than a guess — $3.7M of real deployment that nobody has attributed.
- **No realizations are generated** (your call). The export carries invested and FMV and nothing else, so proceeds would be four board numbers with no source. DPI reads 0.00x, which is what the data says. Write-offs *are* generated; a `company_exit` row additionally requires the Affinity lifecycle status to read `Winding Down`, because a write-down and a closure are different assertions — 15 companies carry a zero FMV without that status and are not exits.
- **`fund.capital_base` stays NULL** (your call), and it surfaced a defect rather than a blank tile. See below.
- **Marks start at the 2016 exercise, not at first investment.** A formal semi-annual valuation policy has a start date; generating exercises back to 2009 would invent seventeen years of them. Older positions are held at cost until then, which is what `company_fmv_asof` already does with no mark on or before the date — so the oldest vintages now exercise that path instead of merely asserting it.
- **A quarter of priced rounds name an LP position we actually hold** as a co-investor. Without it `v_lp_capital_to_direct` had nothing to aggregate and the Funds tab read "CAPITAL TO DIRECT $0.0M / 0 co-invests" — a mandate KPI reporting zero. It now reads $40.7M across 55 co-investments.
- **Leverage is a generator dial, and it was checked rather than guessed.** Participation is drawn at 4–32% of a round, giving 5.9:1. `cb_total_funding_usd` is documented as a cross-check and never a leverage input; used as one it says the generated round totals ($243M) sit **below** real Crunchbase funding ($460M) for the 55 companies carrying it. Conservative, not inflated.
- **`women_senior_gp` is left NULL on all sixteen LP positions.** These are real, named firms; a guess about a real manager's senior team is a claim about identifiable people and a demo is not worth it.

**Fixed — three defects only this dataset could surface**
- **`fx_rate_to_cad` had been stored since A1 and read by nothing.** Every row in the reference fixture was CAD, so the first genuinely non-CAD transaction showed that `v_company_invested`, `v_company_realized`, `company_fmv_asof`, `v_round_leverage`, `v_lp_position_current` and the export adapter's per-round sum were all summing the booked amount and ignoring the currency. `v_transaction_live` now exposes `amount_cad` and all six read it. Sonrai's USD 171,291 at 1.35 books as $231,242.85 and the company still reconciles to $713,243 exactly.
- **A missing capital base produced a false number, not an absent one.** With `capital_base` NULL the dashboard read **"dry powder $-47.2M"** and Reports read "CAPITAL BASE $0.0M" — the precise D-5 error class, on board-facing tiles. `fundMetrics.dryPowder` is frozen under ADR-013 and is correct; what it cannot express is the difference between zero and not-recorded. `hasCapitalBasis()` sits beside it on the `diversityWithCoverage` precedent, and the four display sites render `-`. **The frozen bag is untouched.**
- **A young company could be given a first round predating its own founding.** Reserving room for seven rounds at ten-month spacing pulled the start date back sixty months, and the founding-year floor lost to the spacing clamp. The round count now bends to the available time, never the other way round. Caught by a test, not by inspection.

**Fixed — the test suite was destroying the development database**
Carried from A5 as "a separate test database is the real fix". It stopped being a note and became urgent: **the ADR-001 round-trip test truncates every root table and reloads `demo.json`, and it wiped the real roster, five years of Visible KPIs and the whole A6 dataset twice during this session** — once mid-build, with no signal except the dashboard suddenly showing the prototype's fictional companies.
- **`testDatabaseUrl()`** derives `<database>_test` from `DATABASE_URL`, so isolation is the default rather than something to remember. `TEST_DATABASE_URL` overrides it.
- **`packages/api/test/db-setup.ts`** (vitest `globalSetup`) creates and migrates that database; **`use-test-db.ts`** (`setupFiles`) redirects each worker onto it. `setupFiles` rather than `globalSetup` for the redirect because the latter runs in the main process and its `process.env` does not reliably reach workers.
- CI gets it free: its database job points `DATABASE_URL` at a throwaway container, and the derived `_test` name is created inside the same one.
- **Verified**: `npm test` now runs 371 tests green and leaves the dev database's 82 companies, 999 KPI rows and 282 transactions untouched.

**Deliberately dirty (ADR-020) — seven targeted defects, printed on every run**
Each lands on a named company and none of them moves a control total, which is deliberate: a defect that quietly broke the roll-up would destroy the only assertion that can catch a real generator bug.

| Defect | On | What it exercises |
|---|---|---|
| Non-CAD transaction | Sonrai Security | `fx_rate_to_cad`, and the six aggregates that were ignoring it |
| Duplicate cheque, reversed | Eigen Innovations | ADR-018 correction by reversal; both rows excluded by `v_transaction_live` |
| Mark predating first investment | Introhive | `company_fmv_asof` will return it for an early as-of date |
| Round total below our cheque | Smart Skin Technologies | `v_round_leverage`'s exclusion predicate; the export still carries it unfiltered |
| Unresolvable co-investor name | Picketa Systems | `"Concrete Venture"` against the LP position `"Concrete Ventures"` — exact-match resolution (ADR-026) leaves the FK NULL and the mandate KPI silently understates |
| Superseded valuation mark | ProcedureFlow | `supersedes_id` and the partial unique index permitting one final mark per date |
| Transaction on another company's round | Beauceron Security | The orphan class. A literal orphan is refused by `txn_one_subject`, but nothing stops a transaction referencing another company's round |

Four of the roadmap's list needed no fabrication and that is worth recording rather than papering over: **six companies genuinely have no KPI history**; the roster already carries renames spelled into the name (`AccessSync (Elandas)`, `snapB2B (Snap Accounts Payable)`); missing round totals are modelled at the real rate (45% before 2015, 8% after 2020); and two companies have genuinely unknown vehicle attribution.

**Decided after the build, same session — B2 is withdrawn and A6 is met**

Your call, 14 August 2026. The 5–10 company real sample is no longer being requested from Finance, and A6's exit criterion is restated without it.

- **What changed the calculus.** The sample's real job was two things: prove the schema fits how Finance holds data, and get something demonstrable in front of the VC team lead. A6 delivered the second outright — the platform now shows him his own portfolio, reconciling to the invested and FMV figures he already knows, on every screen. That did not need a day of Finance's time.
- **What is genuinely given up, and it is not nothing.** Early warning on schema fit. A granularity or aggregation mismatch — one aggregated row per company per year where the schema wants transactions, fund-level NAV where it wants per-company marks — now surfaces during the port instead of months ahead of it. **Accepted, not solved.** Three things reduce it: the load path is exercised against deliberately dirty synthetic data before it sees a real row; `batch_id` rollback is proven before the first real batch rather than after a bad one; and batches reconcile to control totals one at a time, so a mismatch shows on batch one rather than after the lot is in.
- **The real load becomes a named phase, and cutover splits in two.** **A13 · Financial history port** is the single operation in which all of Finance's history loads, reconciles and the synthetic dataset is removed — including retiring `npm run db:generate`, which has no business existing in an environment holding real money. **A14 · Go-live** is the parallel run, the backup rehearsal and the MSP runbook. They are separated because a perfect load into a system nobody can restart at 9pm is not a launch, and neither failure should be able to mask the other.
- **After A13 there is no second import.** Affinity stays authoritative for company identity and pipeline and Visible for company-reported KPIs, both syncing nightly; everything financial is entered and maintained through the A7 and A8 interfaces from that point. That is now the stated reason those interfaces are built *before* the port rather than after it.
- Recorded as an **amendment to ADR-020 in place** (condition 3 withdrawn, on the ADR-009 precedent), in the roadmap at version 2.1, and by striking action A‑8.

**Outstanding**
- **`FundInvestment.womenSeniorGP` cannot express "not reported".** The contract types it `boolean`, so sixteen NULLs render as **"0 / 16 positions with women senior partners"** — the same false statement D-5 exists to prevent, on the Funds tab. Fixing it is an ADR-001 contract change and needs your call.
- **The dashboard renders `organic +$-4.2M`.** The prototype hardcodes the plus sign (`vc-toolkit.html:699`) while every other signed figure on that line uses the `>=0?"+":""` idiom. Reproduced verbatim under ADR-014 and recorded in `INHERITED-COERCIONS.md §13`; correcting it would be a third sanctioned content exception, so it waits on your call. The Reports tab's equivalent line is unaffected.
- **`ytdPlatformsClosed` reads 0 while Reports lists 12 new investments YTD.** The first comes from Affinity-derived pipeline close dates (only 5 are credible, per A4's same-day rule), the second from generated round dates. Both are internally correct and they measure different things; the screen does not say so.
- **`fund.capital_base`, `annual_followon_budget`, `fee_drag_pct`, `distribution_policy` and `reserves_policy` are all still NULL.** Net IRR therefore equals gross. These are real fund facts, not generator output.
- **The vehicle mapping is a committed file, not a sync.** If `Fund` is added to Affinity's field metadata, it should move to the A4 sync and the file should go.
- **Regenerating discards operator edits to `board_seat`**, which has no authorship column to scope the delete by. Every other generated table is cleared by `is_synthetic` or by system-principal authorship.
- Carried: Entra app registration unconfigured, no MSAL sign-in UI; memos untested against real content; `v_lp_position_current.tvpi`/`.dpi` and `v_round_leverage` still convenience-only; `fund.currency` USD/CAD mismatch; `eslint-config-next` not wired; `npm audit` dev-tooling findings; branch protection; deploy not wired (A0).

---

## 2026-08-13 · A5 · Visible.vc integration — five years of real quarterly KPIs

**Built**
- **`functions/src/visible/client.ts`** — the Visible client. **GET-only by construction**, which matters more here than it did for Affinity: Visible's API *does* expose `PUT /data_points`, so a stray write would edit what founders reported. Page-numbered pagination, resource-named envelopes, 429 backoff.
- **`functions/src/visible/probe.ts`** (`npm run visible:probe [-- --full --match]`) — read-only reconnaissance. Metric inventory with cadence, unit and fill rate; website/currency/fiscal-year coverage; batching test; history depth; domain reconciliation against the A4 roster. Output gitignored — it is the real portfolio.
- **`functions/src/visible/map.ts`** — the pure layer: metric name → column, data point date → calendar quarter, value handling, quarter folding. **38 tests.**
- **`functions/src/visible/sync.ts`** and **`npm run visible:sync`** (`-- --dry` reads, reports, rolls back). Five rules at the top of the file: one-way inbound; **full refresh, not incremental** (a founder can restate a past quarter, and "since last run" would never see it); never touch a `manual` row; never invent a company; **never write the diversity columns at all**, because writing NULL nightly would erase a manual entry.
- **`functions/src/functions/visible-sync.ts`** — timer Function at **07:00 UTC, an hour after the Affinity sync**, so a website corrected in Affinity overnight is matchable the same night. Daily despite quarterly data: submissions trickle in for weeks after the due date.
- **`docs/visible-endpoints.md`** and **`docs/visible-metric-map.csv`** — 30 rows, every metric with its measured fill rate and a Yes/New/No call with the reason.
- **ADR-029** — exact-domain matching, and one KPI column fed by more than one request wording.
- **`v_kpi_coverage` and the Data tab's coverage panel** — the phase's exit criterion. Per-field, per-quarter counts of who actually answered what. **The one panel in the app with no prototype ancestor**, so it is a third departure from ADR-014's one-to-one rule; it sits on the Data tab rather than the Dashboard because it is a chasing list, not a board figure. Read through `packages/api/src/read/kpi-coverage.ts`, **deliberately outside the ADR-001 document**: coverage is a statement about the data rather than part of it, and the contract is frozen.
  - It also **cannot** be derived from the exported document, which is why the view exists. The adapter coerces a null KPI to `0` because the reference fixture carries literal zeros, so within the contract "reported no revenue" and "did not answer" are the same value. A test in `round-trip.test.ts` pins that distinction.
  - It immediately earned itself: **in 2025 Q4, 53 companies submitted and only 42 answered the burn question.** That gap is invisible in every other view.

**Verified** — against live Visible, then in the browser:
- **999 KPI rows across 81 companies, 2021 Q2 to 2026 Q2**, from 6,341 data points in 107 API calls. (First pass was 877 rows across 69; the websites were corrected in Affinity and Visible the same day, taking the join from 69/82 to **81/82**.)
- **It converges.** A second run reports 999 unchanged, zero updates.
- **Four warnings, all correct**: MyCodev is in Visible but not Affinity, SiMBi in Affinity but not Visible — the two sides of the master-list rule — and two genuine data-quality findings where NB FTE exceeds total FTE.
- **The dashboard reads real mandate numbers for the first time: jobs 590 NB / 1,068.5 total, portfolio revenue $38.4M quarterly as reported.** Financial figures remain $0.0M, correct until A6.
- **The diversity tile reads `-`, "reported by 0 of 82"**, and the drawer reads "Not reported" — D-5 holding on real data.
- **The drawer shows a 19-quarter history** with calendar labels; the same rows label fiscal on board-facing views (2026-04-01→2026-06-30 is calendar 2026-Q2 and fiscal FY2026-27 Q1). D-6 proven on real data rather than on the fixture.

**Decided**
- **`metric_id` must be bracketed.** `metric_id=a&metric_id=b` returns a valid 200 carrying only the **last** id's points. A sync built on it would store one company's history and silently drop the other 81. Measured four encodings; the finding is in the client's header comment because it is invisible from the response.
- **The burn question was renamed mid-series and both wordings are spliced** (ADR-029). `Monthly Burn Rate` ran 2021 Q2–2025 Q2 (774 answers); `Monthly Net Burn Rate` runs 2025 Q3 on. Reading only the current name — which is what the existing NBIF Visible→Affinity pipeline correctly does for a CRM field — would have started the platform's burn history in October 2025. **`request_version` stops being theoretical**: it was designed for a definition change that might happen, and one already had.
- **Companies match on exact normalised domain, with no crosswalk table** (your call, 13 Aug). The fix for a mismatch is upstream in the website field. The sync names every miss in both directions on every run, because a pure domain join has no other way to make a rebrand visible.
- **`net_revenue_retention` and `gross_margins` added to `company_kpi`** (approved 13 Aug). Both collected today, neither in the frozen ADR-001 contract, so both are stored and not displayed. `revenue`'s stale `-- run-rate` comment corrected to `-- period actual` per D-2.
- **Change detection runs in Postgres, not JavaScript.** Visible sends more precision than the columns hold (`141.6666666666666` into `numeric(8,2)`), so six rows compared unequal forever and rewrote themselves plus an `audit_log` entry every night. The `UPDATE`'s `WHERE` clause now casts through the column type and asks the only question that matters: would storing this change what is stored?
- **The sync writes `audit_log` on change only.** `fte` and `fte_nb` are mandate fields so every change is auditable, but a full nightly refresh over five years would otherwise put ~4,400 rows through the audit log daily and bury the one quarter a founder actually restated.

**Fixed — two defects only real data could surface**
- **Visible float-formats every number, so a count of twelve arrives as `"12.0"`** and Postgres rejects it for an `int` column. This took the entire first sync run down. Integral counts are now spelled as integers before they reach the two remaining int columns; a genuine fraction there is still refused and named.
- **`frequency` has a fifth value the documentation does not list** — `annually`, on 41 metrics. Caught by the compiler against a type built from the docs.

**Changed after the first pass, same session**
- **`fte` and `fte_nb` are `numeric(10,2)`, not `int`** (your call, 13 Aug). A full-time *equivalent* of 3.5 is three full-timers and a half-timer — a measurement, not a typo. As int columns, five companies' readings were refused and **Soricimed's drawer read "JOBS 0 / 0" when it reports 3.5**, which is the D-5 error class applied to jobs. The 23 fractional-count warnings are gone; the contract still emits `fte` as a **number** (`3.5`), so the frozen ADR-001 shape is untouched and the golden master does not move. `women_csuite` and `csuite_size` stay `int`: they count people. The export adapter now runs both through `toNumber`, since `numeric` reaches pg as a string.
- **The master-list rule is encoded** (ADR-029 1a). Affinity's portfolio is the master company list, and the two directions of a miss are different things: `visible-only` is expected residue — MyCodev wound down, left Affinity, and its Visible profile outlived it, so its metrics are deliberately not stored — while `no-visible-profile` is a prompt rather than a fault, since SiMBi predates Visible adoption and blank KPIs are the honest answer.
- **The websites were corrected in Affinity and Visible**, taking the join from 69/82 to **81/82**. The only two left are the two the rule covers.

**Outstanding**
- **Two quarters report NB FTE above total FTE** — C032 at 2024 Q3 (5 of 1) and C067 at 2024 Q4 (4 of 3) — which the schema refuses. NB FTE is dropped for those quarters and the rest of the row kept. Both are founder reporting errors and would be corrected in Visible, not here.
- **Action A-1 is still open and now has a measured cost.** No diversity metric exists in Visible at all. The KPI series is five years deep for everything else; diversity starts from zero on the quarter the request changes.
- **Two later-stage opportunities, both confirmed as not-yet-asked rather than not-yet-read** (13 Aug). The ONB/ACOA/IRAP/BDC/SRED funding fields exist in Visible but have never been part of the quarterly request sent to portfolio companies, so adding them carries the same "the series starts when the request changes" cost as A-1 — and they are the leverage and NB co-investment inputs. Separately, the portfolio properties for `Total Invested`, `Fair Market Value`, `Ownership %`, `Shares Owned`, `Entry Pre Money Valuation` and `Investment Date` are unfilled, and **whether Visible should hold rounds, funds and transactions — act as NBIF's transaction register — is an open organisational question.** Until it is answered ADR-011 stands and A6 generates the financial spine synthetically.
- **`npm test` truncates the shared dev database** (the fixture round-trip test), which wipes the real roster and every KPI row. Run `npm run db:reset && npm run visible:sync` after a test run, not before.
- Carried: `v_company_current.fmv` still reads `current_date`; `npm audit` transitive dev-tooling findings; deploy not wired (A0).

---

## 2026-08-12 · A4 · Affinity integration — real roster, real pipeline, nightly sync

**Built (stage 6 — the staff roster, derived close dates, real filter options)**
- **`packages/db/data/app_user.json`** — NBIF's nine staff with their Entra object ids, loaded by `db:seed`. **Identity is re-asserted every run; authorisation is not.** `role` and `is_active` apply when the row is created and are never overwritten, because ADR-005 and the A3 decision put role changes in the database rather than in a deploy — a seed that re-asserted them would silently revert an operator. `display_name` is load-bearing: the sync resolves leads and owners on it.
  - **All 82 companies now resolve a VC Lead, and all 320 pipeline owners resolve.** One name is left: **Jeff White**, VC Secondary on Picketa Systems and Eigen Innovations, who is not in the roster.
  - **Fixed a latent conflict in the `DEV_ADMIN_EMAIL` block.** It wrote `display_name = the email address`, which would have broken name resolution for that person, and forced `role='admin'` on conflict — quietly promoting a roster member because a developer had pointed the variable at their own address. It now creates a row only when the address is absent from the roster.
- **`closed_date` derived from the change log**, with the guard that matters: **76 of 82 portfolio companies entered "Portfolio" on 2025-12-01**, the day the Affinity list was bulk-loaded. Introhive did not close in December 2025, it was *entered* in December 2025. A close date is credible only where the transition happened **after** the list entry existed, so same-day means migrated and keeps a NULL for A6/B4 to fill from Finance. TrojAI is the case that proves the rule — added and moved to Portfolio on the same day, correctly excluded. **"Platforms Closed YTD" reads 5 / 25** rather than 0 or a fabricated 82.
- **Portfolio filter options derived from the roster** (`optionsFrom`). The sector dropdown was offering "Enterprise SaaS" and "Fintech" to a portfolio filed under ICT, Agritech and Oceans. Known values keep the prototype's order and new ones are appended alphabetically, so the reference fixture renders exactly as before (ADR-014); stage and instrument fall back to the constants until A6 supplies them, because an empty dropdown looks broken where a stale one merely looks unused.
- **`npm run db:reset`** — down, up, migrate, seed, sync in one command, because the round-trip test truncates the shared dev database.

**Built (stage 5 — people by name, not by address)**
- **Email addresses are gone from the deal-team fields.** Affinity merges Person entities, so a person's primary address is not reliably their `@nbif.ca` one — and the email was *splitting one person into two*: `kyle.woods@nbif.ca` and `kyle.woods@creativedestructionlab.com` are the same Kyle Woods, as are the two Jaime Christian addresses. Switching to names collapsed the unresolved-lead warning from **nine values to seven people**, which is the count of actual humans. The platform is an internal tool for a team who recognise each other by name (decision, 12 Aug 2026).
  - `company.owner_label` / `secondary_label` now hold **names**.
  - `app_user` resolution matches on `display_name` rather than `email`.
  - **`pipeline_deal_owner.owner_email` replaced by `affinity_person_id`** — Affinity's Person entity id, which survives both the merging that makes an address unreliable *and* a rename, which a name does not. A like-for-like swap that is strictly more robust than either alternative.
  - `company.ceo_email` is untouched: a founder's address is a real external contact, not an internal Affinity Person entity.

**Fixed — a silent env-loading bug that made the fix invisible**
- **`seed.ts` read `process.env` at module scope before `.env` was loaded.** `requireDatabaseUrl()` was the only thing that called dotenv, and it runs *after* the module-level `FUND` constant is evaluated. So the fund row was written with placeholder values while the warning that exists to flag exactly that ran later, saw the now-loaded real values, and stayed silent — the worst possible combination. `loadEnv()` is now exported separately and called first. Verified: the row reads NBIF / 2003 / evergreen / April / target 25.

**Built (stage 4 — history, fund identity, the timer)**
- **`functions/src/affinity/history.ts`** — the `affinity_field_change` mirror. **Full then incremental**: the first run pages all of Status history, later runs filter on `changedAt` past the newest stored row. The primary key is Affinity's **own** change id, so an overlapping re-run is idempotent by construction rather than by careful bookkeeping. **816 transitions in 11 API calls; the nightly delta is 1.**
- **`v_deal_stage_history` now has data**, so time-in-stage is measurable for the first time: New 51 days on average, Reached Out 21, First Meeting 23, Diligence 103, Watchlist 163.
- **The fund row is seeded** — created **once**, so an operator's later edit is never reverted. Style (`evergreen`) and the April fiscal start are hardcoded because both are confirmed; **name and inception year come from `.env` and are not invented**, since `docs/field-inventory.csv` marks them "Platform (user entry)". Financial fields stay NULL — a capital base nobody supplied would be a fabricated board number. The seed prints a loud provisional warning until `FUND_NAME` and `FUND_INCEPTION_YEAR` are set.
- **`functions/src/functions/affinity-sync.ts`** — the timer-triggered Function (06:00 UTC) plus `host.json` and `@azure/functions`. All logic stays in `sync.ts`/`history.ts`, which know nothing about Azure, so the sync remains runnable from the CLI — which is how it has actually been exercised, and how the MSP would re-run it at 9pm without a deployment. **Not yet deployable: the Azure resources do not exist (A0, still open).**
- **`NBIF_MASTER_LIST_ID` collapsed to one definition** in `client.ts`; it had been declared in four files.

**Fixed — two real defects that only real data could surface**
- **`resolveAsOf` threw on an unfinanced database, taking the whole application down.** It refuses to fall back to the clock, and rightly: ADR-021's objection is that "today" makes a number **drift** between two runs on identical data. But with **no marks at all** there are no cashflows and no NAV, so every metric is zero or null whatever date is chosen and nothing can drift. It now uses the clock in exactly that case, and still throws when marks exist but none is final — which is a genuine data problem that a plausible-looking report would hide.
- **The diversity tile stated the precise falsehood D-5 exists to prevent.** On the real roster it read *"0% of companies have women in the C-suite, reported by 82 of 82"* — board-facing. Cause: the diversity scalars serialise from the latest KPI row, and where there is none the adapter emits `0` rather than `null`, because the reference fixture carries a literal `0` on its six KPI-less companies and the ADR-001 round trip must reproduce it. So `womenCSuite === 0` is genuinely ambiguous. **`diversityWithCoverage` now also requires KPI history**, which is the unambiguous signal, and the tile reads `-` / "reported by 0 of 82". A test pins the A4 case. The frozen `fundMetrics` bag is untouched (ADR-013).

**Verified (stage 4)** — 290 tests pass. Clean cycle end to end: `down -v` → `db:up` → `db:migrate` → `db:seed` → `affinity:sync`, then **in the browser against live Affinity data**:
- **Dashboard renders**: 82 active companies, Affinity's real sector taxonomy (ICT, Advanced Manufacturing, Agritech, Oceans, Cybersecurity, Digital Health, Energy, Other), health 12 green / 26 yellow / 24 red derived from Risk Assessment, and the `Porfolio Intro` typo showing verbatim in the sourcing chart exactly as ADR-009 requires.
- **Pipeline renders on real deals**: 83 active, 67 passed, Watchlist correctly excluded from active. Each card carries its **exact Affinity status** as a pill inside the grouped column — the "Sourced" column showing 41 deals each labelled `New` — which is the whole point of storing the funnel at Affinity's resolution.
- All financial figures are $0.0M and every ratio reads `-`, which is correct and honest until A6.

**Built (stage 3 — the write path)**
- **`functions/src/affinity/sync.ts`** and **`npm run affinity:sync`** (`-- --dry` reads, reports and rolls back). Upserts the whole list into `company`, `company_state`, `company_tag`, `pipeline_deal`, `pipeline_deal_owner` and `pipeline_deal_pass_reason`. Five rules govern it, each stated at the top of the file: one-way inbound; **upsert, never truncate**; **never delete**; exact-match reference resolution; membership from Status rather than from which saved view a row arrived in.
- **Display-id allocation that survives a rebuild.** `Cnnn`/`Pnnn` are allocated in **Affinity `entity.id` order**, skipping taken numbers, with existing rows keeping whatever they already hold. Array order from the API is not guaranteed stable, so allocating from it would reshuffle every exported id on a rebuild.
- **More schema the mapping CSVs had targeted for a month and which did not exist**: `company.owner_user_id`, `secondary_user_id`, `last_email_date`, `last_meeting_date` — the same class of gap as `company_tag`. Plus `company.owner_label` / `secondary_label`, on the ADR-026 pattern, because VC Lead is filled on **100%** of portfolio companies while `app_user` is populated only as staff are granted access; without them every lead assignment would be lost silently, since the foreign key is nullable.
- **`pipeline_deal.affinity_opportunity_id` removed and `affinity_row_id` made unique.** NBIF Master is a company-type list, so the list entry *is* the deal and no Opportunity entity is involved. A unique column that would stay permanently null is a trap rather than a placeholder.

**Verified (stage 3)** — against the live list, 347 entries in **4 API calls**:

| | rows |
|---|---|
| `company` | 82 |
| `company_state` | 82 |
| `company_tag` | 43 |
| `pipeline_deal` | 347 |
| `pipeline_deal_owner` | 320 |
| `pipeline_deal_pass_reason` | 166 |

- **It converges.** A second run reports the same counts, creates **zero** new `company_state` rows, and leaves an md5 over the company table byte-identical. State history appends only on genuine change — a nightly sync that appended unconditionally would bury real transitions under 347 identical rows a day.
- Board distribution: Sourced 41, Screening 35, Diligence 6, IC Review 1, Closed 82, Passed 67, Watchlist 115. No Term Sheet, because nothing is currently `With Legal`.
- Ids allocated as designed: C001 Encore Interactive (`entity.id` 1545040), C002 Introhive (1607682), C004 Smart Skin (1656466).
- **The only warnings are real and correct**: nine VC Lead and five VC Secondary addresses match no `app_user`. The sync **deliberately does not create those rows** — a CRM field must never confer platform permissions (ADR-005). The verbatim address is stored, so nothing is lost.

**Built (stages 1–2)**
- **Schema additions**, applied to `docs/schema.sql` and `0001_init.sql` together per the A1/A3 precedent (nothing is deployed; the parity test guards the `schema.sql ≡ 0001` invariant):
  - **`company_tag`** — which both mapping CSVs have targeted since July and which **had never actually been created**. Carries the Priority Sector remainder, Product/Service Industry and the enriched categories, with a `source` column because the three have very different authority.
  - **`pipeline_deal_pass_reason`** — Pass Reason is `dropdown-multi` at 127/347 and is the only structured record of why deals die. Invisible in both CSV exports, because both views are Status-filtered.
  - **`pipeline_deal.follow_up_date`**, **`company.year_founded`**.
  - **`pipeline_deal.funnel_stage_id` is `NOT NULL` at last**, as ADR-026 said it would be at A4.
- **`npm run affinity:vocab`** → `docs/affinity-vocabularies-v2.json`, a committed snapshot of Affinity's dropdown-option metadata. **Deliberately a file rather than a live call from `db:seed`**: CI's database job has no Affinity key, and a seed that varies by the day it runs makes the idempotency assertion meaningless. Refreshing is one command plus a commit, which keeps a vocabulary change reviewable.
- **`packages/db/src/seed.ts` rewritten.** `ref_sector` and `ref_source_channel` now come from live Affinity metadata rather than July's CSV of observed values; `affinity_status_map` is seeded with all sixteen statuses; and the seed **throws if Affinity gains a Status nobody has mapped**, rather than letting the nightly sync silently drop those deals at 2am. The ~80 lines of CSV parsing are gone with it.
- **`functions/src/affinity/map.ts`** — the Affinity-entry-to-platform-rows transform, pure and free of network and database, so the half worth testing is testable without either. **21 tests** covering every judgement call, each traceable to a decision in the field map or a shape the probe actually found.

**Built (stage 1 — reconnaissance)**
- **`functions/src/affinity/client.ts`** — the v2 client. Bearer auth, cursor pagination following `pagination.nextUrl` verbatim, 429/5xx backoff honouring `Retry-After`, and a request counter so the sync's API budget is measured rather than estimated. **GET-only by construction**: the module exposes no method parameter, so ADR-009's "the platform never writes to Affinity" is a property of the code rather than a rule someone has to remember.
- **`functions/src/affinity/probe.ts`** — read-only reconnaissance, `npm run affinity:probe`. Confirms v2 access, dumps field metadata across all four field types, pulls every dropdown vocabulary with rank, samples and optionally paginates every entry, computes fill rates, tests the account-wide change endpoint, reconciles the team's CSV exports against live metadata and checks the identifier namespaces. Output is gitignored — it is the real roster.
- **`docs/affinity-v2-endpoints.md`** — endpoint mechanics, the v1→v2 delta, identifier namespaces, sync cost, the Pacific-midnight rule.
- **`docs/affinity-v2-field-map.csv`** — the A4 decision table. 78 rows, every field with its real fill rate over all 348 entries, its target table and column, and a Yes/Reference/No/New call with the reason. **Supersedes the earlier v1-based field mapping**, which was not portable: v1 field ids, per-entry `/field-values` calls and secondary `/persons` lookups all disappear under v2.

**Verified** — probed live against list 328745, 23 requests, nothing written.
- **348 entries in 4 paginated calls.** The Pipeline and Portfolio exports show 82 and 80; both views are Status-filtered, so **186 entries — Passed, Watchlist, Exited, Intake — are invisible to the CSVs**.
- **The identifier namespaces match on 162/162 rows, both of them.** `Organization Id` ≡ `entity.id`, `Affinity Row ID` ≡ `listEntry.id`.
- **`GET /v2/field-value-changes` is account-wide and filterable**, returning `dropdownOptionId`, `rank`, `actionType` and full changer identity.
- **Status carries all 16 options at ranks 1–16**, including the four ADR-009 predicted existed unobserved (Intake, Conditional Approval, Approved, Closed). `rank` is present only on `ranked-dropdown`.
- **The Pacific-midnight rule is real**: `Deal Flow Stage Changed` returns `2026-08-11T07:00:00Z`.
- **Two dropdown options are labelled with another option's id** — Priority Sector `24621946` labelled `22542067`, Venture Stage `24621953` labelled `24615561`.
- **The scoring apparatus is entirely dead** — 45 fields across five reviewers, 0% filled, with five saved views built to drive them.
- **`created-at` and `time-in-current-status` are absent from `GET /lists/{id}/fields`** but present on every entry payload at 348/348. A sync building its field list from metadata alone silently drops `date_added`.

**Verified (stages 1–2)** — 289 tests pass, 22 of them new. Full clean database cycle re-run end to end: `docker compose down -v` → `db:up` → `db:migrate` → `db:seed` → `db:types` → `import:fixture`. 51 relations. Seed re-run is byte-identical. **The fixture round trip still reproduces `demo.json` exactly**, narrowed by the single known v2 addition and nothing more — that exactness is what proves the schema, seed and contract changes moved no board number.

**Verified in the browser.** The Pipeline tab, now rendering from `funnelGroups` rather than from a hardcoded column list, reproduces A2's recorded figures exactly: **2/5 platforms closed, 8 active deals, 1 at term sheet, $44.5M active check, $15.8M probability-weighted, 1 passed**, six columns in the prototype's order. No console errors. The rework is behaviour-preserving on fixture data while being fully data-driven.

**Decided (stages 1–2)**
- **The funnel is stored at Affinity's resolution and grouped for display.** Three vocabularies were in play and conflating them was the trap: the prototype's six-column board plus Passed (which `demo.json` uses and which carries the hardcoded probability weights and the "N at term sheet" tile), Affinity's sixteen Status options, and a July hybrid seeded from observed values that matched neither.
  - **`ref_funnel_stage` holds Affinity's sixteen, with their own ranks.** These are the terms the investment team speaks — "second meeting", "with legal", "conditional approval" is how a deal's position gets discussed — so a company's exact place in the deal flow is never lost between the two systems. **This reverses an earlier decision taken within the same session**, which made the six display bins first-class and demoted the real statuses to a free-text label: the data survived but stopped being a vocabulary, so it could not be ranked, ordered or referenced.
  - **`ref_funnel_group` is new and holds the board columns** — the prototype's six, plus Passed and Watchlist. Sixteen columns do not fit on a screen; ADR-014 keeps the board as it is.
  - **No ADR-001 amendment was needed**, which is what made this cheap. `PipelineDeal.funnel` is already typed `'Sourced' | … | string`, and the contract snapshot fingerprints **paths and types, not values** — so carrying the exact Affinity status through the API leaves the frozen shape untouched.
  - **Terminality lives on the group, not the stage.** It is a property of where a deal came to rest, and storing it twice invites the two to disagree.
- **The grouping is monotonic in Affinity's rank.** A deal moving forward in Affinity must never appear to move backwards on the board. That rules out the otherwise tempting `Team Pitch → IC Review`, which July's vocabulary CSV proposed: Team Pitch is rank 6, *before* Diligence at 7, while IC Review sits *after* Diligence on the board, so a deal would visibly regress on entering diligence. Team Pitch groups into Screening; IC Review is fed by Conditional Approval and Approved.
- **Watchlist is its own terminal group.** It is the **largest single bucket in Affinity — 114 of 347** — and appears in neither CSV export, so it was invisible when the prototype was built. Folding it into Sourced would take "Active Deals" from ~84 to ~198 and swamp the top column. Terminal means parked rather than worked.
- **Four stage rows are marked `prototype-fixture`.** `Sourced`, `Screening`, `IC Review` and `Term Sheet` exist only in `demo.json` and have no Affinity equivalent, so they are seeded to keep the reference fixture loading against a `NOT NULL` key while it is still the financial dataset. Tagged rather than blended so **A6 retires them with a one-line delete** rather than an archaeology exercise. The fixture's other three values — Diligence, Closed, Passed — are real Affinity statuses and need no row of their own.
- **`ADR-028` written**, covering the whole funnel decision and the contract bump.
- **`ref_funnel_group.show_on_board` is separate from `is_terminal`**, because the two genuinely differ and collapsing them would have put a hardcoded `"Closed"` back into the UI: Closed is terminal but renders as a column, since a closed deal is an outcome worth seeing, while Passed and Watchlist are listed beneath the board so dead and parked deals take no space.
- **The export contract gains `funnelGroups` at `schemaVersion` 2**, and the frontend reads the board from it (`apps/web/lib/funnel.ts`) rather than from `lib/constants.ts`. **No field was removed or retyped, so the ADR-001 freeze holds** — `PipelineDeal.funnel` was already `'Sourced' | … | string` and the snapshot fingerprints paths and types, not values. `funnelGroups` is **optional** because `demo.json` stays at version 1: it is the prototype's own boot state and re-exporting it would invalidate every golden-master fixture (ADR-022). The API emits 2, the fixture is 1, and they legitimately differ.
- **Probability weights stay in the view layer, keyed on the group.** They never lived in `packages/metrics` and are not moving there; keying them on the group name means the prototype's five numbers apply unchanged and no board figure moves (ADR-013).
- **`affinity_status_map` became an identity mapping and was kept anyway.** Once `ref_funnel_stage` holds Affinity's own vocabulary the table maps each status to itself, which looks like dead weight. What it buys is the seam ADR-009 asks for: a renamed or newly-added Affinity status can be routed onto an existing stage by editing a row. The sync resolves through it and never matches text against `ref_funnel_stage` directly.
- **Portfolio and Exited entries get a `pipeline_deal` row too**, mapped to the terminal Closed stage with `converted_company_id` set. Funnel conversion and win rate need a denominator, which is the whole reason for syncing the full list rather than the two views. Note there is **no Affinity Status of "Closed" at all** in the live data — deals go Approved straight to Portfolio — so the board's Closed column is fed by Portfolio and Exited rather than by a status of the same name.
- **"Primary sector" is deterministic, not positional.** `Priority Sector` is `dropdown-multi` and v2 returns an *unordered* array, so keying on array position would let a company's sector flip between nightly syncs with no data change — and move a mandate KPI when it did. The rule is: the single non-`Other` value where there is exactly one, otherwise the lowest `dropdownOptionId`. A test asserts the result is invariant under reordering.
- **A4 replaces the company roster; the thin-financials window is accepted and A6 follows immediately.** Coexistence was rejected because `fundMetrics` iterates all companies, so 70 synthetic beside ~80 real makes every fund-level denominator ambiguous and leaves a permanent `company_id` crosswalk. Folding A6 into A4 was rejected because it destroys the property that made A3 trustworthy — identity, sector, stage, owner and region are all verifiable with no financial data present, and generating synthetic finance at the same moment makes a sync bug indistinguishable from a generator artefact. The window is narrower than it looks: **the Funds tab is untouched** (LP positions key to `fund_investment`, not to companies) and **the Pipeline tab goes fully real**.
- **The sync reads the whole list and derives Pipeline/Portfolio membership from Status.** Syncing per saved view would reintroduce the two-list model ADR-009 exists to correct, and a company graduating between nightly runs would read as a disappearance and an arrival rather than a Status change. It also makes funnel conversion measurable, which the 162 survivors cannot support.
- **Vocabulary duplicates are fixed in Affinity, not mapped around.** Source of Deal carries five options for one channel (`Porfolio Intro`, `Portfolio company`, `Portfolio Company`, `Portfolio Company Introduction`, `Portfolio Introduction`). Affinity is system of record, so a correction there fixes the VC team's daily surface too. The sync carries labels verbatim and does not special-case them.
- **The Affinity KPI cluster is not synced; ADR-010 stands unamended.** Nine global fields hold what ADR-010 assigns to Visible — Quarterly Revenue, Cash Position, FTE Total, FTE (New Brunswick), Months of Runway Remaining, Net Revenue Retention, Metrics Last Updated, and *two* burn fields where one superseded the other and both still hold data. Fill runs 11–20%. Visible stays the single source, `fte_at_entry` sources from `company_kpi` at A5 as ADR-027 intended, and `runwayMo` stays a stored fact sourced from Visible.
- **Priority Sector is `dropdown-multi`; the primary value takes `sector_id` and the remainder becomes `company_tag` rows.** **"Primary" must be deterministic** — the API returns an unordered array, so keying on array position would let a company's sector flip between syncs and move a mandate KPI with no data change. Rule: the single non-`Other` value where there is exactly one, otherwise the lowest `dropdownOptionId`.
- **`CEO (Email)` wins where present; the `CEO` person field fills the gaps and is the sole source for `ceo_name`.** These are two separate fields, not a projection, and they disagree: AccessSync, Gray Wolf, Passiv and StockCalc all carry an older or off-domain address in the typed field than the contact record holds. That was raised and the precedence chosen with it visible — the typed value is the deal lead's deliberate choice.
- **ADR-009 amended in place** with the namespace resolution, the change-endpoint correction, the whole-list decision, the dropdown-metadata seeding, the timezone confirmation and the corrupt-label note. The mirror `affinity_field_change` is retained: query performance was always its real purpose, and only the cost argument was overtaken.

**A4 exit criteria — met.** *"Real pipeline visible and refreshing nightly. Company roster is real."* 82 companies and 347 deals from Affinity, zero non-Affinity rows; the Pipeline tab renders 83 active deals with each card carrying its exact Affinity status; `affinity_status_map` is seeded and editable; company identity, sector, sourcing channel, CEO and HQ are all real. The nightly Function is written but cannot be scheduled until the Azure resources exist (A0).

**Outstanding**
- **`npm test` still wipes the local Affinity roster** — the round-trip test truncates `ROOT_TABLES` and reloads `demo.json` against the same dev database. `npm run db:reset` puts it back in one command, but a **separate test database** is the real fix and would let the round trip and a synced roster coexist. CI is unaffected: its database job is a throwaway container.
- **Jeff White has no `app_user` row**, so `secondary_user_id` is null on Picketa Systems and Eigen Innovations. The name is stored and the screens read correctly. If he is a former employee the roster precedent is Kamrul Arefin — `is_active: false`, which preserves historical attribution without granting access.
- **The July "two non-nbif.ca VC Leads" item is closed, and was never really about mail domains.** Both were merged Affinity Person entities; keying on the name resolved them to the same people. Nothing needs fixing in Affinity.
- **The Azure Function is written but not deployable** — no Azure resources exist yet (A0). It needs `AFFINITY_API_KEY` and `DATABASE_URL` as Key Vault references, never app settings holding literals.
- **The sync never deletes, by design, and nothing yet surfaces staleness.** Unseen rows are reported as warnings and keep a stale `synced_at`; no view or screen exposes that.
- **Only `Status` is mirrored into `affinity_field_change`.** The endpoint is account-wide so an unfiltered backfill would pull every change to every field in the workspace; Status is the one with a consumer today. Owners and Priority Sector history would be cheap to add if wanted.
- **`apps/web/lib/constants.ts` still hardcodes `SECTORS`, `STAGES` and `INSTRUMENTS`.** Its own header says all of them move behind the API at A4; `FUNNEL` has, those three have not. They drive filter dropdowns and now show prototype vocabulary against a real roster.
- `apps/web/lib/constants.ts` still exports `SECTORS`, `STAGES` and `INSTRUMENTS` as hardcoded prototype vocabularies. Its own header says they "move behind the API" at A4; `FUNNEL` has now done so and the other three have not. They drive filter dropdowns, so they matter once the roster is real.
- **`website` is not the universal crosswalk key it was taken for.** 130 of 347 entries have no domain. It is still right for the portfolio end (80/80 in July); the gap is early-stage pipeline, where there is often no company website yet.
- **Source of Deal still carries its five duplicate options.** Priority Sector's corrupt `22542067` member **was fixed in Affinity during this session** and the snapshot regenerated; the Source of Deal merge has not happened yet. Re-run `npm run affinity:vocab` and re-seed when it does.
- **`Venture Stage` carries the same corrupt-label bug** — option 24621953 is labelled `24615561`. Not synced (2% fill), so it is cosmetic for now.
- **Two VC Lead addresses still will not resolve against `app_user`** (`kyle.woods@creativedestructionlab.com`, `jaime.a.christian@gmail.com`). Carried from July; the sync must tolerate a null join rather than fail.
- **`Portfolio Status` has grown two more pipeline-looking values** — `In Legal` and `Low on cash` alongside the `Diligence` flagged in July.
- **`Co-investors` is no longer empty** (11/348, was 0/76). Still not a leverage source — ADR-012's capture form remains authoritative — but the July note that it "confirms deal-close capture is the only path" is now weaker than it was.
- Carried from A3: Entra app registration unconfigured and no MSAL sign-in UI; memos untested against real content; `v_lp_position_current.tvpi`/`.dpi` and `v_round_leverage` still convenience-only; `fund.currency` USD/CAD mismatch; `eslint-config-next` not wired; `npm audit` dev-tooling findings; branch protection; deploy not wired.

---

## 2026-08-11 · A3 · API and persistence — the frontend now runs on Postgres

**Built**
- **`packages/api`** — a fifth workspace package holding the read path, the write path, authorisation and the unit boundary. It knows nothing about HTTP, so the logic worth testing is testable without a server; the Next route handlers are thin wrappers.
- **`src/units.ts`** — the ADR-001 `$M`/dollars conversion, in both directions, in **one** place. The literal `1e6` appears nowhere else in the repository.
- **The ADR-001 document importer** (`src/import/`) — the real D-1 import path, not a dev seed. Derived fields advisory, reconciliation warnings named, every row `is_synthetic` and `batch_id`-tagged so a load reverses wholesale. `npm run import:fixture`.
- **The adapter** (`src/read/export.ts`) — database rows to the frozen contract. Rounds delivered unfiltered so the leverage predicate stays in `packages/metrics` (ADR-021, ADR-023).
- **Authorisation** — the four ADR-005 roles, an Entra seam with a working dev provider, and full JWKS bearer validation for when the registration is configured.
- **`audit_log` on every write**, capturing before and after against a real `app_user`.
- **`GET /api/v1/export`** and **`POST /api/v1/judgement`**.
- **The ADR-020 synthetic-data banner**, which did not exist. A2 had a fixture so the flag was never real; it now reads from `v_synthetic_data_status` through `meta.demo`, appears above the header on every screen, has no dismiss control, and carries into the print stylesheet.

**Verified** — the round trip is **exact**. `demo.json` → Postgres → contract reproduces the document field for field, all 70 companies, 11 deals, 6 LP positions and the fund. Every A1 golden-master metric reproduces over the **database-built** document, which is what closes the residual risk ADR-021 names. 267 tests pass (17 new). In the browser: the dashboard renders from Postgres at $300.8M invested, $577.8M FMV, TVPI 2.08x, DPI 0.16x, gross IRR 19.0%, leverage 2.6:1, 39 alerts of which 13 critical, 64 active / 6 exited — every figure identical to A2. Role enforcement exercised live: `leadership` reads the export at 200 and is refused a gate edit at 403. A financial-table edit through the judgement endpoint is rejected by construction.

**Decided**
- **ADR-025 · `fund.distributions[]` stays a stored series and the ADR-002 correction is deferred.** The fixture's fund-level distributions ($47.5M) and per-company realizations ($53.0M) disagree by exactly $5.5M, and the decomposition is now known: three exits itemised per company against two "Generated exits" aggregate rows covering the same events. Deriving one from the other moves **five board numbers visibly** — TVPI 2.08x→2.10x, DPI 0.16x→0.18x, gross IRR 19.0%→19.1%, net IRR 16.7%→16.8%, dry powder $146.7M→$152.2M. Keeping them frozen is what makes A3's round trip a real test: any number that moved during the storage swap is an adapter bug, not an intended change. Approved this session.
- **ADR-026 · The importer preserves contract strings verbatim and resolves reference keys on exact match only.** Six vocabulary collisions surfaced at once — the fixture's sectors are generic-VC (`AI / ML Infra`, `Enterprise SaaS`) against Affinity's real provincial taxonomy (`ICT`, `Agritech`, `Oceans`), overlapping on `Cybersecurity` alone. Coercing to a nearest neighbour would break the round trip; inserting fixture values into `ref_sector` would pollute the taxonomy ADR-009 makes Affinity the system of record for. Both stored instead, and 61 of 70 companies correctly carry a null `sector_id`. **Directly informed by the steer this session that A4/A5 should bring as much real data as possible** — it makes A4 a clean overwrite rather than a cleanup job.
- **ADR-027 · Four fields in ADR-002's derived inventory are independent facts and are stored.** Established by measurement, not inspection: `reservesDeployed` disagrees with any round sum on 4 of 70 companies; `runwayMo` equals `cash/burn` on **10 of 71** KPI rows; `fteAtEntry` predates the KPI series by up to a decade; `company.instrument` is neither the first nor the last round's on C009. Each also has a reason to stay independent once real data arrives — runway is company-reported through Visible and the platform is not the system of submission (ADR-017). Three LP fields (`coInvestsDone`, `referrals`, `capitalToDirect`) are **carried rather than reclassified**: they have a working derivation from `round_coinvestor`, waiting on the A8 capture form.
- **The as-of parameter reaches exactly one column.** `v_company_current`'s `current_date` TODO is resolved as `company_current_asof(p_as_of date)`. Only `fmv` takes the date. `invested`, `realized` and `exited` deliberately do not: two exits in the fixture are dated **after** the pinned as-of (Nimbus Grid 2029, Quorum 2027), so filtering realizations by date would erase $13.4M and move company MOIC.
- **`ownership_after_pct` widened to `numeric(19,16)`.** The contract carries a computed float (`10.521185332909226`) and `numeric(7,4)` truncated it on four rows. Scale is contract fidelity, not a claim about cap-table accuracy.
- **Roles come from `app_user.role`, never from an Entra app-role claim.** Entra proves identity; the platform decides permission. The app registration needs only sign-in configured, changing someone's role is a database update rather than a tenant change, and the row that granted the permission is the row `audit_log` attributes the write to.
- **`0001_init.sql` amended in place again**, per the A1 precedent and its stated expiry: nothing is deployed, the runner aborts loudly on a checksum mismatch, and the `schema.sql ≡ 0001` invariant is worth more than an empty forward migration. **This stops being available the moment anything reaches Azure.**
- **`page.tsx` calls the API layer directly rather than fetching its own endpoint.** Both paths run the same authorisation and the same adapter; a server component fetching its own origin adds a hop and a token it already has the identity for. `GET /api/v1/export` exists for the export contract and external consumers.
- **`PipelineDeal.valuation` corrected to `number | null`** in the contract types. Two deals in the fixture are genuinely unpriced; the type said `number` and was already inaccurate. The JSON shape is unchanged, so this is not a contract change.

**Outstanding**
- **The Entra app registration is created but otherwise unconfigured.** `AUTH_MODE=entra` is implemented and validates properly, but nothing can obtain a token until the registration has a redirect URI, an exposed API scope and the frontend MSAL flow. Running on `AUTH_MODE=dev` locally. **No MSAL sign-in UI exists yet** — that is the honest gap in A3's auth exit criterion; the authorisation half is complete and enforced.
- **Memos are untested against real content.** `demo.json` carries an empty `memos` object, so the memo import and export paths round-trip nothing. The write path was exercised directly.
- **`v_lp_position_current.tvpi`/`.dpi` and `v_round_leverage` are still present and still convenience-only** (ADR-023). Now that the API exists, removing them is finally cheap.
- **`fund.currency` is `USD` in the fixture while transactions store CAD**, because the contract carries no per-transaction currency. Flagged as an import warning rather than resolved silently; harmless on demo data, needs a real answer before any non-CAD position exists.
- **`pipeline_deal.funnel_stage_id` is nullable at A3 only.** Restore `NOT NULL` at A4 when every stage resolves against Affinity's real vocabulary.
- **`docs/reference/demo.json` remains the only dataset.** A6's generator and the real Affinity roster replace it; the importer is written to take either.
- Carried: `eslint-config-next` not wired into the flat config; `npm audit` transitive dev-tooling findings; `ref_funnel_stage` seeding from Affinity metadata; branch protection not configured; deploy not wired.

---

## 2026-08-11 · A2 · Frontend ported against the seed fixture — all eight tabs

**Built**
- `apps/web/app/globals.css` — the prototype's `<style>` block **verbatim**. That stylesheet is what delivers "looks identical to the prototype", so it is extracted rather than rewritten. Two marked additions at the end, both structural: Chart.js drew tooltips on canvas where Recharts renders DOM, and a body scroll-lock class behind the open drawer.
- **Shell** (`components/AppShell.tsx`) — header, eight-tab nav, scrolling main, drawer, overlay, toast, plus Escape-to-close and overlay-click-to-close.
- **Eight tabs**: Dashboard, Portfolio, Funds, Pipeline, Modeling (two sub-tools), Memo Builder, Reports, Data.
- **Three drawers**: company, LP position, pipeline deal.
- **Twelve charts** ported from Chart.js to Recharts at visual parity.
- `packages/contract` consumed end to end — every component reads the ADR-001 shape and nothing else.
- Root `npm run dev`.

**Verified** — in a browser, tab by tab, against the golden-master fixture. Dashboard invested $300.8M / TVPI 2.08x / gross IRR 19.0% / leverage 2.6:1 / 39 alerts of which 13 critical; Portfolio 64 active with Cobalt Harbor top at 5.24x and G/L +50.9, sort flips on a second click, exited filter shows six with ownership "-"; all six LP positions match their frozen TVPI, DPI and IRR; Pipeline 2/5 closed and $15.8M probability-weighted; Reserves policy-suggested $128.9M matching the frozen rounded-sum total; the waterfall pays pari passu below the pref stack and the greater of pref or as-converted above it; memo prefill for Vantara shows 2.91x; Reports reads FY2025-26 Q4. Gate and reserve edits write through and survive a drawer close and reopen.

**Decided**
- **`asOf` is derived from the latest valuation mark, not the clock.** This is the one place A2 looks different in a side-by-side: gross IRR reads 19.0% against whatever the prototype renders today, which drifts about a point per quarter. Same definition, stated date — and it makes the IRR consistent with the marks it is built on, which ADR-007 wants stamped on board-facing views anyway.
- **The J-curve stayed out of `packages/metrics`.** It is a modelled interpolation, not a metric, so it ports with the chart code. It now takes `asOf` rather than reading the clock, and reads inception from `fund.vintage` rather than a hardcoded 2019 — which *is* 2019 here, so nothing moves.
- **The hardcoded `"2026"` in the pipeline closed-YTD filter now reads the year from `asOf`.** Identical output on this data; it simply stops being wrong on 1 January.
- **`lib/editable.tsx` draws the ADR-018 line explicitly.** Gates, reserves and memos are judgement records and are freely editable; nothing in that provider can reach a transaction, a mark or an LP cashflow. State is lifted above both tab and drawer so an edit made in the drawer survives closing it. A3 replaces it with API writes into `audit_log` and the shape above does not change.
- **The Data tab's schema block and CSV specs are extracted from the prototype at build time**, not transcribed, so 55 lines of contract documentation cannot drift by typo.
- **Import is shown as unavailable rather than faked.** There is nothing to import into a read-only fixture. The D-1 advisory-fields rule is stated on screen for when it arrives at A3.
- **`next.config.ts` gains an `extensionAlias`** so webpack resolves the metrics package's NodeNext `.js` specifiers. The bundler bends rather than the library, which would otherwise fail its own typecheck and vitest run.

**Both sanctioned content exceptions are live and marked in place.** D-2: revenue is labelled quarterly-as-reported on the dashboard tile, the Portfolio column note, the memo prefill and the Reports highlight; the arithmetic is untouched. D-5: the diversity tile excludes non-reporters from the denominator and states coverage, the drawer shows "Not reported" rather than "0 of 0", and the Reports impact line names the reporting count. Every quarterly view states its convention per D-6 — calendar on the Portfolio KPI history, fiscal on Reports.

**Outstanding**
- **Side-by-side sign-off against the prototype is the exit criterion and has not formally happened.** The Dashboard was reviewed and accepted; the other seven tabs have been verified against the fixture by value, not by eye against the prototype.
- **One inherited disagreement is now visible on screen**: the NB Co-Investment tile and the Capital Attracted chart do not quite reconcile, because the tile neither caps nor excludes and the chart does both (`INHERITED-COERCIONS.md §2`). Present in the prototype too, reproduced deliberately.
- The Reports print path is the browser's. A11 replaces it with Playwright, which is when it becomes the board-facing artefact ADR-005 requires.
- `eslint-config-next` is installed but not wired into the flat config; Next warns on each build. Harmless, worth doing when A2's review settles.
- Carried: `v_company_current.fmv` still reads `current_date`; `npm audit` transitive dev-tooling findings; `ref_funnel_stage` seeding from Affinity metadata.

---

## 2026-08-11 · A0 (deferred item) · CI on GitHub Actions; capture made platform-independent

**Built**
- `.github/workflows/ci.yml`. Two jobs, split by whether they need a database. Closes the last open A0 exit criterion except deploy, which waits for the Azure resources — a deploy step wired to nothing is worse than none.
- **`verify`** (no services): `npm ci`, lint, typecheck, test, **golden-master reproducibility**, then the web build.
- **`database`** (postgres:17 service): migrations apply to an empty database; migrate and seed are then re-run to **assert idempotency** rather than assume it; `db:types` is regenerated and diffed to prove the committed generated types still match the schema.

**Changed**
- **The capture harness is now platform-independent.** Adding a Linux runner surfaced two ways the capture was silently bound to the machine that ran it, neither of which could show up while development was Windows-only:
  1. **Digests were computed over raw bytes.** The working copy is CRLF here and LF on a runner, so the same committed file hashed two different ways. Digests are now taken over line-ending-normalised content — the same normalisation `migration-parity.test.ts` already does. Metric values were never affected: `demo.json` parses identically either way.
  2. **The fixture recorded the runtime locale.** `resolvedLocale` came from `Intl.NumberFormat().resolvedOptions()`, which is `en-CA` here and whatever the runner defaults to there. The harness now pins `DISPLAY_LOCALE` itself and records the pin, and the capture formats job counts through it.
- Fixture recaptured. **Only three provenance fields moved** — the two digests, the script byte count, and the locale field's name and note. Every metric value is untouched and all 249 tests passed before and after.

**Decided**
- **The harness defines its own `DISPLAY_LOCALE` rather than importing the one in `src/format.ts`.** The harness must not depend on the implementation it exists to check (ADR-022), so the constant is deliberately duplicated — and `golden-master.test.ts` asserts the two agree, which is what stops the duplication rotting.
- **CI re-captures and verifies the fixture with `--check`, not with `git diff`.** The check catches three distinct things a passing test suite would not: an edit to `vc-toolkit.html` (a reference document that should not be edited at all), a re-export of `demo.json` (which invalidates every fixture at once), and a hand-edited fixture made to silence a failing test — the one thing ADR-013 exists to prevent. All three verified by tampering deliberately: a 0.3% value edit is caught, and so is a display-string-only edit that a float comparison alone would miss.
- **`git diff --exit-code` was the wrong check and the first CI run proved it.** It asserts bit-identical floats across operating systems, which JavaScript does not offer. **`Math.pow` is implementation-approximated in ECMAScript** — not required to be correctly rounded — so `runScenario`'s `Math.pow(mo, 1/yrs)` returns `49.30267835392137` on Windows and `49.30267835392135` on the Linux runner. A relative difference of 4e-16, with an identical display string. `xirr` is unaffected: 120 bisection halvings of a fixed bracket converge to a stable point either way. `--check` compares structure and strings exactly and floats within `FLOAT_TOLERANCE`, keeping every drift property without failing on the last bit.
- **`FLOAT_TOLERANCE` lives in the harness and the golden-master test imports it**, so the tolerance is one number rather than two that can drift apart.
- **The database job asserts idempotency explicitly.** Forward-only migrations mean a re-run must be a no-op and the seed is written to be re-runnable. A migration that is not safe to re-run is otherwise discovered at the worst possible moment.
- Node pinned to major 22 via a workflow-level env var rather than tracking `latest`, so a Node release cannot turn into a mystery failure.
- The `database` job's Postgres password is a literal in the workflow. It is an ephemeral throwaway inside the runner with nothing real reachable from it, so it is not a secret — but it is worth stating rather than leaving a reader to wonder.

**Outstanding**
- **Deploy is not wired.** Arrives with the Azure resources at A0.
- Branch protection is not configured; CI reports status but nothing yet requires it to pass before merge. Worth turning on now that there is something worth blocking on.
- Carried: `v_company_current.fmv` still reads `current_date`; `npm audit` transitive dev-tooling findings; `ref_funnel_stage` seeding from Affinity metadata.

---

## 2026-08-11 · A1 (stage 3) · Metrics package ported, golden master green, contract snapshot

**Built**
- **`packages/contract`** — the ADR-001 export contract as TypeScript types and nothing else. No runtime code, no I/O, no dependencies. Imported by `packages/metrics` now and by `apps/web` and the API at A2/A3.
- **`packages/metrics/src`** — the port, as pure functions over the contract shape. `format.ts` (the `fmt` object plus the three call-site formatters the prototype inlines), `xirr.ts`, `company.ts` (`moic`, `suggestedReserve`, the two gain/loss definitions), `fund.ts` (the 31-field `fundMetrics` bag), `lp.ts`, `alerts.ts`, `scenario.ts`, `selectors.ts`.
- **`test/golden-master.test.ts`** — 202 assertions against the committed fixtures. Display strings exact, floats to 1e-12 relative.
- **`test/coverage-gaps.test.ts`** — 46 constructed tests for the paths `demo.json` cannot reach.
- **`test/contract-snapshot.test.ts`** — the ADR-001 guard.

**Verified**
- **249 metrics tests pass; the port reproduces every prototype number on the first run.** No fixture was touched at any point.
- **The suite was mutation-tested rather than trusted.** Applying the per-round cap to `nbCapital` — the exact "fix" the rejected ADR-024 would have made — failed two assertions and reported the delta as `166.19999999999996 vs frozen 166.69999999999996`. The suite catches a 0.3% change to a board number and names the field.
- Re-running the capture harness after the port reproduces the committed fixture byte for byte, so the harness and the port agree independently.
- `typecheck`, `lint` and the migration parity test all pass.

**Decided**
- **`fundMetrics` keeps `cs` (all companies) and `actC` (active only) exactly as the prototype mixes them**, with the map in `INHERITED-COERCIONS.md §1`. Reproduced, not tidied.
- **The contract snapshot fingerprints structure, not values.** It walks the document and emits `path: type` for every field, unioning types across array elements and collapsing arrays to `[]`, so adding a company cannot change it but adding a field to a company must. Alongside it sit explicit unit assertions — money is `$M` not dollars, percentages are plain numbers not fractions, dates are `YYYY-MM-DD`. Those matter because a dropped `$M` conversion would multiply every figure by ~1e6 while leaving every field name identical, and a name-and-type snapshot alone would not notice.
- **`DISPLAY_LOCALE` pinned to `en-CA`.** The prototype calls `toLocaleString()` with no locale, so job counts rendered differently per environment. The port pins it, and a test asserts the fixture was captured under the same locale — otherwise a CI failure would report a metric change when the truth is a locale difference.
- **`diversityWithCoverage` implements D-5 as a separate function** rather than changing `fundMetrics`. The frozen bag keeps the `|| 0` coercion; the D-5 selector excludes non-reporters from the denominator and returns coverage alongside. Both are tested. This is the only sanctioned departure and it lives beside the frozen definition rather than replacing it.
- **`lpMetrics` is the port's name for `fiMetrics`**, with `fiMetrics` kept as an alias so the prototype's name stays greppable.
- **Two of my own test expectations were wrong and were corrected, not the code.** A one-year doubling solves to 99.716%, not 99.8% — 2024 is a leap year, so the span is 366 days against an ACT/365.25 year. And a loss worse than −95%/yr returns `null` rather than clamping to the bracket floor, because the NPV stays negative at both ends and the sign-change test bails. Both are now asserted as the frozen behaviour.

**Outstanding**
- **`packages/metrics/src` is the definition layer only.** Nothing consumes it yet — A2 wires it into the frontend.
- The J-curve `navApprox` (`vc-toolkit.html :784–791`) was **not** ported. It is a modelled chart interpolation with a hardcoded 2019 start and a six-year ramp, not a metric; it belongs with the chart code at A2. Recorded in `INHERITED-COERCIONS.md §12`.
- The pipeline probability weights (`:1071`) and the `"2026"` year literals (`:1069`, `:1217`, `:1218`) are **not** ported either — they live in view functions and move at A2, when there is a view to move them into.
- **Still no CI.** `npm test` now runs 250 assertions that would catch a changed board number, and nothing runs them automatically. This is the point at which a GitHub Actions workflow starts earning its keep (A0 exit criterion, still open).
- Carried: `v_company_current.fmv` still reads `current_date`; `npm audit` transitive dev-tooling findings; `ref_funnel_stage` seeding from Affinity metadata.

---

## 2026-08-11 · A1 (stages 1–2) · Metrics reconnaissance, ADR-021/022, golden-master harness

**Built**
- `packages/metrics/test/harness/prototype.ts` — loads the prototype under Node. Extracts the single inline `<script>` from `docs/reference/vc-toolkit.html` at run time and evaluates it in a `node:vm` context with `document`, `Chart`, `localStorage`, `requestAnimationFrame` and `getComputedStyle` stubbed. **Nothing is vendored** — mirrors `migration-parity.test.ts`, which reads `docs/schema.sql` directly for the same reason.
- `packages/metrics/test/harness/capture.ts` — the capture entry point (`npm run capture:fixtures -w @portfolio-command/metrics`). Refuses to write anything if the prototype throws, if `demo.json` no longer matches the prototype's boot state, or if a captured value comes back `undefined`.
- `packages/metrics/test/fixtures/golden-master.json` — 7,034 lines. Every metric frozen twice: full-precision value **and** the display string the board reads. Covers the 31-field `fundMetrics` bag, `fiMetrics`, per-position `fiTvpi`/`fiDpi`/`fiIrr`, `xirr` over the fund cashflow series independently of `fundMetrics`, per-company `moic` and `suggestedReserve`, all 39 `healthAlerts` in order, and `runScenario` over `scenarioDefaults` for all 70 companies.
- `packages/metrics/INHERITED-COERCIONS.md` — twelve categories of prototype behaviour that look accidental, ported verbatim under ADR-013, with measured impact where it is non-zero. Plus three items examined and found sound, recorded so they are not re-litigated.
- **ADR-021** (metrics input contract and unit boundary) and **ADR-022** (golden-master methodology), written into `docs/architecture-decisions.md`.

**Verified**
- `demo.json` is **byte-identical to the prototype's boot state** — it is `freshDB()` serialised, not an arbitrary sample. The harness asserts this before capturing; perturbing `demo.json` was tested and correctly aborts with exit 1 and an untouched fixture.
- Capture is **byte-reproducible across runs**. Confirmed by `cmp` on repeated runs.
- Clean database cycle re-run after the schema change: `docker compose down -v` → `db:up` → `db:migrate` → `db:seed` → `db:types`. 47 relations, `moic` gone from the generated types. `typecheck`, `lint` and the migration parity test all pass.

**Changed**
- **`v_company_current.moic` removed** (`docs/schema.sql`, `0001_init.sql`). It divided one aggregate by another, which ADR-023 defines as a metric, and MOIC is named in its prohibition list. Removed now rather than at A3 because the view has no dependents yet and `create or replace view` cannot drop a column — the required `drop view … cascade` gets more expensive with every view A3 stacks on top.
- **Amended `0001_init.sql` in place rather than adding `0002`**, and rebuilt the local database. A0.1 established forward-only migrations; that protects deployed state, and nothing is deployed yet. What it buys is the `schema.sql ≡ 0001` invariant the parity test exists to guard — a `0002` would have kept that test green while making `docs/schema.sql` describe a schema that no longer exists. **Forward-only becomes binding the moment anything reaches Azure.**
- `v_lp_position_current.tvpi/.dpi` and `v_round_leverage` carry the convenience-only SQL comments ADR-023 requires, including the note that `v_round_leverage`'s `least()` cap matches the prototype's dashboard chart but **not** its `fundMetrics`.
- `tsx` added to `packages/metrics` devDependencies for the capture script.

**Decided**
- **`asOf` is a required argument on every metric function that dates a cashflow.** `fundMetrics`, `fiMetrics` and `fiIrr` call `new Date()` for their terminal NAV — an undeclared input. Two consecutive calls on identical data return different numbers, and the figure drifts roughly a point per quarter with no data change. This is the **sole** departure from a literally verbatim port: a change of signature, not of definition. No default, because a default would silently reintroduce "today". (ADR-021.)
- **Fixtures pin `asOf = 2026-03-31`** — the effective date of every valuation mark in `demo.json` and the end of its last `navHistory` quarter. Gross IRR reads 18.98% rather than the 17.55% a run on 11 August produces; the latter was never reproducible the following day.
- **`fundMetrics` ports as one function returning the same field bag**, with named selectors layered on top rather than the internals split. Its outputs share intermediates; splitting them would recompute those intermediates into a different implementation. (ADR-022.)
- **`includeAccelerator: true` is the only golden-mastered path.** The prototype has no ACC concept, so the exclusion path gets conventional constructed tests instead.
- **ADR-024 was proposed and rejected.** It would have reframed the golden master as a change ledger, permitting accepted divergences where the prototype's behaviour is an implementation accident rather than a validated definition. Ten candidate repairs were measured against `demo.json`: eight were provably zero-impact, two moved numbers by 0.30% and 0.15%. **Decision: continue the verbatim port.** The prototype is the artefact handed over by the VC team lead, and A4/A5/A6 — real Affinity data, real Visible KPIs, the synthetic financial dataset — is when it becomes possible to tell which coercions actually matter rather than guessing. Corrections belong to that phase. The measurements are preserved in `INHERITED-COERCIONS.md` so the work is not repeated.

**Outstanding**
- **Stage 3 not started.** The TypeScript port into `packages/metrics/src`, the vitest assertions against the fixtures, and the ADR-001 export-contract snapshot test.
- **`packages/contract` not yet created** (ADR-021). Needed before the port, since the metric signatures depend on it.
- **`v_company_current.fmv` still calls `company_fmv_asof(…, current_date)`**, making the view non-deterministic and pinning "now" to the database clock. Flagged with a TODO in `schema.sql`; becomes an as-of parameter when A3 designs the read path. Deliberately not guessed at ahead of A3.
- **Four coverage gaps recorded in the fixture header**, each needing constructed unit tests because `demo.json` cannot reach them: no round fails the leverage exclusion (all 78 are valid); no diversity field is null, so the D-5 departure is unobservable; same-store revenue growth runs over 7 companies of 64; the `outsideCapital` clamp never binds at aggregate level.
- **`fte` display strings are locale-sensitive** — `toLocaleString()` with no locale. The fixture records `en-CA`; a CI run under a different locale will fail on a locale difference, not a metric change. The port must pin one.
- Carried from A0.1: `npm audit` transitive dev-tooling findings; `ref_funnel_stage` to be seeded from Affinity field metadata.

---

## 2026-07-29 · A0.1 · Repository scaffold, local database, migrations, reference seed

**Built**
- npm workspaces monorepo (Node 22): `apps/web` (minimal Next.js 15 App Router scaffold, no UI — A2 ports the prototype), `packages/metrics` (empty, vitest wired — A1 fills it), `packages/db`, `functions/` (placeholder — Azure Functions runtime scaffold arrives at A4).
- `docker-compose.yml` at root: `postgres:17`, credentials from the gitignored `.env`; `.env.example` committed with placeholders only.
- Custom plain-SQL migration runner (`packages/db/src/migrate.ts`): sorted `NNNN_name.sql` files, one transaction each, sha-256 checksums in `public.schema_migrations`, advisory-locked, forward-only. Migration `0001_init.sql` is a **verbatim copy** of `docs/schema.sql`; `packages/db/test/migration-parity.test.ts` fails the build if they ever diverge. `docs/schema.sql` was not modified.
- Reference seed (`packages/db/src/seed.ts`), idempotent: ref_sector (9), ref_funnel_stage (8, Closed/Passed terminal), ref_source_channel (14, incl. the Propel/Apex/AVF/ONB/AllNB split) from `docs/affinity-vocabularies.csv`; ref_stage (6) and ref_instrument (5) from the prototype constants; ref_valuation_method (6). The CSV's health and nb_region sections are CHECK constraints, not tables, and are not seeded.
- Type generation from the live database: `db:types` runs kysely-codegen into `packages/db/src/generated/db.ts` (47 tables and views, committed so typecheck never needs a running database).
- Root scripts: `db:up`, `db:down`, `db:migrate`, `db:seed`, `db:types`, `lint`, `typecheck`, `test`.

**Verified** — full clean cycle (`docker compose down -v` → `db:up` → `db:migrate` → `db:seed`) run end to end:
- `docs/schema.sql` applies cleanly to a fresh database with **no changes required**. Nothing in it was wrong.
- `db:migrate` re-run is a no-op ("up to date"); `db:seed` re-run yields identical counts.
- Reference tables: sector 9, funnel stage 8 (Closed/Passed terminal), source channel 14, stage 6, instrument 5, valuation method 6. Casing normalised (Breakthru, Investor Connection); the Propel/Apex/AVF/ONB/AllNB row split into five channels as intended.
- `db:types` generates all 47 relations including every derived view (`v_synthetic_data_status`, `v_mandate_completeness`, `v_round_leverage`, `v_company_current`, …). `typecheck`, `lint` and the parity test all pass against it.

**Decided**
- Custom ~110-line migration runner over node-pg-migrate/dbmate — zero extra dependencies, wholly readable, nothing fighting hand-written SQL. Forward-only; a bad migration is corrected by the next one. (Approved this session.)
- ref_valuation_method seeded with the six methods the prototype produces: Last round, Revenue multiple, Calibrated last round, Scenario-weighted, Write-off, Realized. Free-text variants in the demo marks ("Revenue multiple, discounted") belong in the mark's rationale. (Approved this session.)
- Kysely + kysely-codegen as the typed query builder and type source — types come from introspecting the live DB, never hand-maintained; Kysely is the query builder A3 will use anyway. Not an ORM. Two properties worth keeping: `numeric` generates as **string**, not `number`, so money cannot silently become a float (ADR-008); and the schema's SQL `comment on` text carries through as JSDoc, putting the ADR rationale in the types themselves.
- `postgres:17` locally to match what a new Azure Flexible Server provisions; pin the exact minor at the A0 Azure step.
- eslint-config-next deferred to A2 (no React code yet); root typescript-eslint flat config covers everything for now.

**Outstanding**
- `npm audit` reports transitive high-severity findings, all in dev tooling (an old minimatch chain under eslint and kysely-codegen; postcss/sharp pinned by next). Nothing reachable in this scaffold; revisit when next/eslint publish patched pins.
- TODO carried in `seed.ts`: ref_funnel_stage must eventually be seeded from Affinity's Status dropdown-option metadata, not the CSV — ranks 2, 8, 9 and 11 exist unobserved (ADR-009).

---

## 2026-07-29 · Pre-development · Architecture and data design complete

**Built**
- Nothing in code yet. This entry records the design phase so the log starts from a known state.

**Decided** — the full set is in `docs/architecture-decisions.md`; the ones that shape day-to-day work:
- ADR-001 · The prototype's JSON schema is the frozen API and export contract; the storage model underneath is normalised.
- ADR-002 · Transactions are the only stored financial facts. Eighteen prototype fields are derived and must not be stored.
- ADR-003 · TypeScript end to end, reversing an earlier recommendation of a Python metrics service. Rationale: solo maintainer, non-development MSP for coverage.
- ADR-006 · Reporting periods stored as dates; fiscal and calendar quarter labels both derived. Fiscal year starts 1 April; Visible reports on calendar quarters.
- ADR-007 · Valuation marks effective 31 January and 31 July, carried forward between cycles. Two of four quarters show no revaluation, labelled on screen.
- ADR-011 · The platform is the transaction registry. Excel bulk upload first, in-app Finance forms second, same table.
- ADR-013 · Metric definitions frozen at the prototype's implementations, guarded by golden-master tests.
- ADR-014 · Frontend ports one-to-one. Two sanctioned content exceptions.
- ADR-018 · Financial rows append-only; corrections are reversals or supersessions.
- ADR-019 · Finance data lands in staging templates in their own terms, not production schema.
- ADR-020 · Development runs on synthetic financial data calibrated to Affinity's real figures. Real history is a cutover event.

**Outstanding**
- **A-8 · Request a 5–10 company real sample from Finance.** Highest-leverage open item. Validates that the schema fits how Finance actually holds data, before everything is built on the assumption.
- **A-7 · Confirm Affinity v2 and Visible.vc API access on current plan tiers.**
- **A-1 · Add women in C-suite and C-suite size to the Visible quarterly request.** The series begins only from the quarter the request changes.
- **Verify the identifier namespace.** The CSV export's `Organization Id` (224–313 million) and the v2 API's `entity.id` (1,783,269) were observed in different ranges. Confirm before using either as a crosswalk key; `website` is the intended join.
- Start capturing round totals and NB co-investors on paper for deals closing before the capture form exists.

---

## 2026-07-29 · Data source confirmation · Affinity live data profiled

**Built**
- `docs/affinity-field-mapping.csv` — field-by-field mapping for both list views, with fill rates, transforms and controlled vocabularies ready to seed the reference tables.

**Changed**
- **Corrected an error.** An earlier reading treated Affinity's Pipeline and Portfolio as two separate lists that lose history at the boundary, and proposed a `pipeline_stage_history` table to reconstruct it by nightly snapshotting. They are two saved *views* of one list (`listId 328745`) filtered by Status. The table was removed.
- Replaced it with `affinity_field_change`, a local mirror of Affinity's own change log. Affinity remains system of record; the mirror exists because the endpoint is per-list-entry and a funnel chart would otherwise fan out to one API call per deal.
- Added `company.nb_region` (NW/NE/SW/SE) — a mandate reporting dimension the prototype lacked.
- Replaced `company_state.affinity_risk_grade` with `risk_grade` constrained to A/B/C/ACC, and extended `health` with `acc`.
- Added `company.affinity_fmv` and `company.affinity_total_investment` as reference-only columns.
- Added `pipeline_deal_owner` — Affinity's Owners field is person-multi and accumulates; the platform mirrors the full list rather than picking one.

**Decided**
- Sector taxonomy is Affinity's eight provincial priority sectors plus Other, unchanged. No invented sectors to absorb the Other population.
- Risk Assessment drives health. A/B/C map to green/yellow/red; ACC carries no risk colour.
- Accelerator investments are **included** in fund-wide MOIC, leverage and FMV growth, with a dashboard toggle keyed on the ACC tag. Metric functions take an `includeAccelerator` option so the toggle changes an argument rather than forking the definition.
- Owners governs pipeline stages, VC Lead governs portfolio stages. Ownership commonly changes hands at diligence.
- Source of Deal carries through verbatim; case-folding applied for chart grouping only.
- Affinity's FMV and Total Investment Amount are reference-only and never enter a calculation. The synthetic generator is calibrated to them so company-level figures land in a plausible range.

**Outstanding**
- Seed `ref_funnel_stage` from the Status field's dropdown-option metadata, not from observed values — ranks 2, 8, 9 and 11 exist unobserved.
- Handle `referenceType: deleted-entity` in the sync: store `displayValue`, tolerate the absent `dropdownOptionId`.
- Affinity date-only fields arrive at US Pacific midnight in UTC. Pin the timezone on extraction.
- Two VC Lead records in the export carry non-`nbif.ca` addresses and will not resolve against Entra. Fix in Affinity.