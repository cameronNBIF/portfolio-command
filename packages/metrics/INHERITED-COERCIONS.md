# Inherited coercions

Things the prototype does that look accidental, **ported verbatim anyway** under
ADR-013. This file is the ledger.

Nothing here is a bug report and nothing here is a licence to fix. ADR-013
freezes metric definitions at the prototype's implementations because those
definitions were settled and validated with the VC team lead, and because a
rebuild that quietly improves numbers is a rebuild nobody can verify. The
golden-master fixtures test **fidelity, not correctness** (ADR-022). A green
suite means the port reproduces the prototype, including everything below.

**Where these are asserted.** Most are pinned by the golden-master fixtures in
`test/golden-master.test.ts`. The ones `demo.json` cannot reach — the leverage
exclusion, diversity nulls, the `outsideCapital` clamp, the formatter guards —
have constructed tests in `test/coverage-gaps.test.ts`, each cross-referenced
back to a section here. Every item below is under test, which means **removing
one of these quirks fails the build**. That is the intended behaviour: a
correction should be a deliberate act with a visible diff, not a tidy-up.

**When this file becomes actionable:** A4, A5 and A6, when real Affinity data,
real Visible KPIs and the synthetic financial dataset first meet these code
paths. Most of what follows is invisible on `demo.json` precisely because that
dataset is clean and complete. Real data has gaps, and the gaps are what turn a
coercion from a curiosity into a wrong number on a board report. Corrections
belong to that phase, with the impact measured and the VC team lead consulted
where a board-facing figure moves.

Line references are to `docs/reference/vc-toolkit.html`.

---

## 1 · Scope inconsistencies in `fundMetrics()`

`cs = DB.companies` (all 70). `actC = cs.filter(c => !c.exited)` (64). The bag
mixes the two with no comment marking the boundary.

| Outputs | Scope |
|---|---|
| `womenCos`, `womenCosPct`, `womenExecs`, `cSuiteTotal`, `revenue`, `revQoQ` | `actC` |
| `invested`, `fmv`, `realized`, `leverage`, `roundsTotal`, `capitalAttracted`, `nbCapital`, `outsideCapital`, `fte`, `fteAtEntry`, `fteNB` | `cs` |
| `unrealizedGL` | **both** |

- **:623–625 — jobs count exited companies.** `fte`, `fteAtEntry` and `fteNB` sum
  over `cs`, four lines above the diversity block that sums over `actC`. Zero
  numeric impact on `demo.json` because all six exited companies carry `fte: 0`.
  Real data will not be so tidy, and an exited company's employees are arguably
  not the fund's jobs number.
- **:641 — `unrealizedGL` mixes scopes on either side of the subtraction.**
  `fmv` over all companies minus `invested` over active only. Zero impact here
  for the same reason (`fmv: 0` on every exited company).

## 2 · NB co-investment is computed three different ways

- **:620 — `fundMetrics.nbCapital` sums `r.nbOther` over every round**, including
  rounds the leverage predicate on :609 just excluded, and **without capping** at
  that round's third-party capital.
- **:751 — `drawDashboardCharts` caps it**: `Math.min(other, r.nbOther||0)`, and
  applies the exclusion.
- **`v_round_leverage` (schema.sql) caps it**: `least(coalesce(nb_other,0), …)`,
  and applies the exclusion.

The SQL agrees with the chart; neither agrees with the KPI tile. The
`Math.max(0, capitalAttracted - nbCapital)` clamp on :621 exists because the
author knew `nbCapital` could overshoot. One round in `demo.json` carries
`nbOther` greater than its own third-party capital, so this is live, not
theoretical. Measured delta if the tile were capped and filtered like the other
two: **−$0.50M on $166.7M (−0.30%)**.

The metrics package reproduces **`fundMetrics`**, per ADR-013. The SQL view is
commented convenience-only and is not read by the API (ADR-023).

## 3 · Array position stands in for sort order

Nothing sorts either array. Both happen to be ordered correctly in `demo.json`.

- **`kpis[0]` is assumed newest** (:633, :635, :656, :880).
- **`rounds[0]` is assumed oldest** (:1568, `suggestedReserve`).

Same index, opposite convention, in one codebase. A2's adapter and A5's Visible
sync both need to guarantee the ordering the metrics assume, because the metrics
do not check.

## 4 · Null and zero are not distinguished

- **:628, :630, :631 — `(c.womenCSuite || 0)` and `(c.cSuiteSize || 0)`.** A
  company that has not reported diversity counts as a company with no women in
  its C-suite, and contributes 0 to the exec-seat denominator. This is exactly
  what **D-5 (ADR-010) reverses** — the one sanctioned content departure. Not
  observable on `demo.json`: all 70 companies carry numeric values, so the
  prototype's behaviour and the D-5 behaviour are byte-identical here. The
  departure needs its own constructed tests.
- **:633 — `(c.kpis && c.kpis[0] && c.kpis[0].revenue) || 0`** makes "reported
  zero revenue" and "reported nothing" the same number.
- **:635 — `revNow`/`revPrev` read `kpis[0].revenue` and `kpis[1].revenue` with
  no `|| 0`**, one line after the guarded version. A KPI row missing `revenue`
  yields `NaN` and poisons `revQoQ`.
- **:584 — `moic()` does not guard `fmv` or `realized`.** Absent fields give
  `NaN`, not `null`, and `fmt.x(NaN)` renders `"-"` — so a missing field looks
  identical on screen to a company with no cost basis.
- **:1299 — `(moic(c) || 0).toFixed(2)`** exports a null MOIC to CSV as `0.00`
  rather than blank.

## 5 · Formatter guards are inconsistent

| | `null` | `NaN` | `Infinity` |
|---|---|---|---|
| `fmt.m` :578 | `"-"` | `"-"` | **`"$InfinityB"`** |
| `fmt.x` :579 | `"-"` | `"-"` | `"-"` |
| `fmt.pct` :580 | `"-"` | `"-"` | **`"$Infinity%"`** |

Only `fmt.x` carries the `isFinite` check. Also `fmt.m(-5)` renders `"$-5.0M"`,
with the sign inside the currency symbol, and `fmt.d("")` renders `"-"` because
it tests truthiness rather than nullishness.

## 6 · Division without a zero guard

`fteNB / fte` (:703, :1258), `called / committed` (:1038), `checkSize /
valuation` (:1113), `reservesDeployed / reservesAllocated` (:926), gate progress
(:1117), vintage MOIC (:772). None guards its denominator. The two jobs-share
call sites use *different* guard shapes for the same figure.

## 7 · Display text used as control flow

- **:659 — `if (!/Runway/i.test(f))`** deduplicates risk flags against the runway
  alert by regex-matching the flag's own display string. Renaming a flag
  silently duplicates or silently suppresses an alert.
- **:660, :661** match covenant and government-funding status with
  `/breach|watch/i` and `/pending|risk/i` against free text.

## 8 · Positional access to the NAV history

**:614 — `nh[len-1]`, `nh[len-2]`, `nh[len-5]`.** "Year over year" means *five
rows back*, not four quarters back. A missing quarter silently redefines the
comparison. `demo.json` carries a complete nine-quarter series so the positional
read is correct here by luck, not by construction.

## 9 · Hardcoded year literals

**:1069, :1217, :1218 — the string `"2026"`** determines `closedYtd`,
`exitsYtd` and `newYtd`. These are wrong from 1 January 2027 and no test will
catch it. Note also that `demo.json` carries two exited companies with exit
dates in the *future* (C024 `2029-04-15`, C025 `2027-05-15`).

## 10 · Rounding inside a metric

**:1569 — `suggestedReserve` returns `+(initial*mult).toFixed(1)`.** The
portfolio total on the Modeling tab is therefore a sum of rounded values rather
than a rounded sum. Measured delta on `demo.json`: **$128.9M vs $129.09M**.

## 11 · Zero where `null` is meant

- **:1632 — `runScenario`'s `mo = investedTotal > 0 ? p/investedTotal : 0`**
  returns `0`, where `moic()` returns `null` in the equivalent case. `fmt.x(0)`
  renders `"0.00x"`; `fmt.x(null)` renders `"-"`.
- **:772 — vintage MOIC returns `0`** for a vintage with no invested cost, which
  plots as a zero bar rather than an absent one.

## 12 · Smaller items, recorded without ceremony

- **:609 — `if (r.roundTotal && r.roundTotal >= r.invested)`.** The truthiness
  test drops `roundTotal === 0` before the comparison sees it. Harmless in
  practice; the `>=` would catch it anyway unless `invested` is also 0.
- **:649 — `if (npv(lo)*npv(hi) > 0) return null`.** Strictly `>`, so a root
  sitting exactly on a bracket endpoint proceeds rather than bailing.
- **:650 — 120 bisection iterations** over a bracket of width 10.95 converges to
  roughly 1e-35, far below double precision. About 70 iterations do nothing.
  Kept verbatim: the convergence criterion is explicitly frozen.
- **:663 — the alert sort comparator is two-valued** (`red` vs everything else)
  and relies on `Array.prototype.sort` stability for the rest of the ordering.
  Deterministic on V8, and the port must not substitute a different sort.
- **:972 — `irr: flows.length > 1 ? xirr(flows) : null`** duplicates a guard
  `xirr` already performs on :644.
- **:802 — `[...ranked.slice(0,6), ...ranked.slice(-4)]`** overlaps if fewer
  than ten active companies exist.
- **:1609 — `scenarioDefaults` falls back to a magic `50`** when a company has
  neither ownership nor a last-round post-money. Exercised by exactly the six
  exited companies in `demo.json`.
- **:1621 — `dilutionFactor` can go negative** if the raise and pool exceed the
  post-money.
- **:784–791 — the J-curve `navApprox`** is a modelled interpolation with a
  hardcoded 2019 start and a six-year ramp. It is a chart heuristic, not a
  metric, and should port as a chart helper rather than into this package.
- **`fte` display strings use `Number.toLocaleString()` with no locale**, making
  them environment-dependent. The fixture records the locale it captured under
  (`en-CA`); the TypeScript port must pin one explicitly.

---

## 13 · A sign hardcoded into a label

Found by A6, on the first dataset where the value could go negative.

- **:699 — the dashboard FMV Growth sub-line hardcodes a plus sign in front of
  organic value creation**: `"- organic +"+fmt.m(m.organicYoY)`. `organicYoY`
  is `(nav - navYoY) - (cost - costYoY)`, which is negative whenever a year's
  new deployment exceeds the year's value growth — an ordinary state for an
  early-stage book, and the state the real portfolio is in. The tile renders
  **"organic +$-4.2M"**.

  Every other signed figure on that same line goes through the
  `m.fmvYoY>=0?"+":""` idiom, so this is an oversight in the prototype rather
  than a convention. It is reproduced verbatim under ADR-014 and is NOT fixed:
  the frontend ports one-to-one and the two sanctioned content exceptions are
  D-2 and D-5. Correcting it is a third exception and therefore the VC team
  lead's call, not a tidy-up. **Raised 14 August 2026; awaiting that call.**

  The Reports tab's GROWTH line (:1255) is unaffected — it interpolates
  `fmt.m(m.organicYoY)` with no sign in front and reads correctly.

---

## Examined and found sound

Recorded so the same ground is not re-litigated:

- **:1159 — `prefillMemo`'s `checkSize/valuation * valuation*3 * 0.75`.** Reduces
  to `checkSize × 2.25`. Verbose, but algebraically exactly what the surrounding
  sentence claims: ownership × a 3× exit, less 25% dilution. Correct.
- **:989 — `fiMetrics.irr` labelled "Net IRR" with no fee drag subtracted.** LP
  NAVs arrive net of the manager's fees, so the platform's own `feeDragPct` does
  not apply. Label and arithmetic both stand.
- **Three different gain/loss expressions** — `fmv + realized - invested` on the
  Portfolio tab (:845, :861) versus `fmv - invested` on the dashboard chart
  (:801) and the Reports movers list (:1216). These are two distinct metrics,
  total and unrealized, and each is labelled correctly where it appears.
