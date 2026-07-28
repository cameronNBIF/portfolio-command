# Portfolio Command — Decision Record for Daniel

**From:** Systems & Data Analyst
**Status:** Rev 3 — **all six decisions signed off, 28 July 2026.** Nothing outstanding.

---

## Where this landed

Your v1 prototype was pulled apart field by field — 148 fields, including the nested ones that never made it into the Data tab schema. Each now has a named source system, a target database table, and a decision reference. Nineteen architecture decisions are written up in `architecture-decisions.md`; the database schema is in `schema.sql`; the build sequence is in `delivery-roadmap.md`.

Your two constraints are both honoured. The JSON schema stays exactly as it is, as the export and import contract — your export → edit → re-import loop doesn't change. And the frontend ports one-to-one: same layout, same content, same terminology, same eight tabs. What changes is only what sits underneath.

---

## What you decided

**D‑1 · Import treats derived fields as advisory.** Agreed. Where a figure can be computed from the records beneath it — `invested` from the rounds, `fmv` from the latest mark, `realized` from the realizations — the import uses the computed value and returns a warning naming any discrepancy, rather than accepting a number that contradicts its own detail. This also closes a live problem in the prototype: realizations currently sit in two independent places, `fund.distributions[]` driving fund DPI and `company.realized` driving company MOIC, free to drift apart unnoticed. Both now read the same records.

**D‑2 · Revenue is displayed as reported.** Visible supplies the past quarter's actual, so that is what gets stored and shown, with no annualisation. The label moves from run-rate to quarterly revenue in the tile, the memo prefill and the guide. Two consequences to keep in mind: the aggregate figure will be roughly a quarter of what the same tile showed under the run-rate label, so any comparison against earlier output needs the basis change stated once — and same-store QoQ growth now carries seasonality that run-rate framing masked. A same-quarter year-over-year comparison would be more robust, but that is a phase-2 conversation, not a change now.

**D‑3 · FMV growth will show two flat quarters a year.** Accepted, with the carry-forward labelled on screen the way you flagged DPI as recycling-based. Marks are effective 31 January and 31 July; quarters ending 30 June and 31 December carry the prior mark forward. NAV still moves in those quarters through new capital deployed at cost — it is the markup component that sits still.

**D‑4 · Deal-close capture.** Accepted. The deal lead captures round total, NB co-investors with amounts, ownership after the round and pro-rata rights at close. Coverage is monitored on the dashboard so the leverage metric degrades visibly rather than silently. Your rule that rounds with missing or bad totals are **excluded rather than guessed** is preserved exactly.

**D‑5 · Diversity tile.** Accepted. Non-reporters are excluded from the denominator and coverage is shown alongside the figure. Unreported never renders as zero. Visible does not collect these fields yet, so they are being added to the quarterly request and the series will start from whenever that lands.

**D‑6 · Quarter labelling.** Accepted, with the split as proposed: **fiscal labels on Reports and all board-facing output**, since that is the calendar the board works to; **calendar labels on the Portfolio KPI history**, since that is what Visible shows and what founders reported against. Every quarterly view states which convention it is using.

---

## What happens next

Finance has started producing the three historical data pools — transactions, valuation marks and fund activity — against templates issued to them. That work runs underneath everything else and is the long pole: the application can be built against demo data, but it cannot go live without history, which for some companies goes back fifteen years or more.

On the build, the sequence is Pipeline first as a thin end-to-end slice, then Portfolio, then Funds, then Dashboard and Reports. Modeling and Memo Builder come last and may be deferred past launch — you would keep using the prototype for those in the meantime. Full detail, including effort and what a reduced launch scope looks like, is in `delivery-roadmap.md`.

Nothing further is needed from you until there is something to look at, which will be the Pipeline tab.
