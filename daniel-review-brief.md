# Portfolio Command — Review Brief for Daniel

**From:** Systems & Data Analyst
**Re:** Architecture decisions needing your sign-off before development starts
**Reading time:** about ten minutes for the three below; the rest is engineering you can skip

---

## What's happened so far

Your v1 prototype has been pulled apart field by field — 148 fields, including the nested ones that never made it into the Data tab schema. Each now has a named source system, a target database table, and a decision reference. Sixteen architecture decisions are written up in `architecture-decisions.md`, and the database schema is drafted in `schema.sql`.

Your two constraints are both being honoured. The JSON schema stays exactly as it is, as the export and import contract — your export → edit → re-import loop doesn't change. And the frontend ports one-to-one: same layout, same content, same terminology, same eight tabs. What changes is only what sits underneath.

Most of the sixteen decisions are engineering and don't need you. Six do. Three of those need actual thought.

---

## The three worth your time

### D‑2 — Revenue is quarterly actual, not run-rate

**This is the one I'd start with.**

The prototype presents company revenue as run-rate — in the dashboard revenue tile, in the memo prefill text ("revenue $X run-rate"), and in the user guide. Visible.vc actually supplies the **past quarter's actual revenue**, not an annualised figure.

The arithmetic still works. Same-store growth on quarterly actuals is arguably a better measure than on run-rate. But the label is wrong against the real data, and the aggregate revenue figure means something different from what it says.

Three options:

1. **Relabel** the tile and memo text as quarterly revenue, leave the arithmetic alone. *Recommended.*
2. **Annualise** by four to preserve the run-rate framing — but this misleads for any company with seasonal or lumpy revenue, which in an early-stage portfolio is most of them.
3. **Show both**, at the cost of more surface on an already dense tile.

This is the only place where "keep the metric definitions frozen" and "change nothing on screen" can't both hold. It's your metric and your label, so it's your call.

### D‑3 — FMV growth will show two flat quarters a year

The FMV exercise runs twice a year, effective 31 January and 31 July. Board reporting is quarterly. Mapping marks onto fiscal quarter ends gives this:

| Quarter end | Most recent mark | Revaluation |
|---|---|---|
| 30 Jun | 31 Jan | none — carried forward |
| 30 Sep | 31 Jul | new mark |
| 31 Dec | 31 Jul | none — carried forward |
| 31 Mar (FYE) | 31 Jan | new mark, two months old |

So the FMV growth tile shows movement in two quarters out of four. NAV still moves in the flat quarters through new capital deployed at cost, but the markup component sits still.

This is correct behaviour rather than a bug, and the cadence isn't changing. The proposal is to carry the last mark forward and say so on screen, the same way you flagged DPI as recycling-based. Worth knowing that a board member will eventually ask why growth was zero last quarter, and the answer needs to be on the tile before they ask.

### D‑4 — Two mandate KPIs depend on a step at deal close

Round total drives leverage. NB co-investor amounts drive NB co-investment. Neither exists in Affinity, Visible or Finance's records — they only exist in the closing documents.

The proposal is a single deal-close form, completed by the deal lead, capturing round total, co-investors with an NB flag and amount, ownership after the round, pro-rata rights and post-money. It takes a few minutes per close.

The reason this needs you specifically: if a deal lead skips it, nothing breaks visibly. The leverage number just quietly gets less accurate as rounds accumulate without totals. There's a coverage monitor on the dashboard showing what percentage of rounds carry a total, so the decay is at least visible — but the discipline has to come from your side, not from software.

Your rule that rounds with missing or bad totals are **excluded rather than guessed** is preserved exactly.

---

## The three that need a nod, not a debate

### D‑1 — Import treats derived fields as advisory
Your JSON contract is unchanged. But if an imported file says `invested: 8.5` and the transactions behind it sum to 8.3, the import will use 8.3 and return a warning naming the discrepancy, rather than silently accepting the number. This is the fix for figures drifting apart from the rounds they're supposed to sum to. Your workflow is otherwise identical.

### D‑5 — Diversity tile should show coverage, not assume zero
Visible doesn't currently collect women in C-suite or C-suite size. Those are being added to the quarterly request, so there'll be a period where most companies have no data. The tile should show the figure alongside "reported by *n* of *m* companies" and leave non-reporters out of the denominator — rather than treating unreported as zero, which would report a diversity figure far worse than reality.

### D‑6 — Which quarter labelling each screen uses
Visible labels on calendar quarters: the submission due 5 August is Q2 2026, covering April–June. Our fiscal year starts 1 April, so that same period is FY2026‑27 Q1. Both labels are correct. The database stores dates and derives either, so this is purely a presentation choice — but each screen needs to state which one it's showing.

---

## What you can skip

The remaining ten decisions are database design, hosting, authentication, ingestion scheduling, backfill sequencing and the waterfall model, which stays as-is for now. They're written up if you want them, but none of them changes anything you see or do.

---

## What happens next

Once D‑2 in particular is settled, the roadmap can be sequenced. The working assumption is Pipeline first as a thin end-to-end slice — Affinity is live and disciplined, so it proves the whole stack on data where being wrong costs nothing — then Portfolio, then Funds.

Running underneath all of it is the historical backfill: transactions, rounds and marks going back as far as the records allow, which for some companies is fifteen years or more. That's the long pole. The application can be built against demo data; it can't go live without history.
