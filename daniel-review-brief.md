# Portfolio Command — Review Brief for Daniel

**From:** Systems & Data Analyst
**Re:** Architecture decisions needing your sign-off
**Status:** Rev 2 — four of six decisions settled. Two left, and neither should take long.

---

## Where this stands

Your v1 prototype has been pulled apart field by field — 148 fields, including the nested ones that never made it into the Data tab schema. Each now has a named source system, a target database table, and a decision reference. Nineteen architecture decisions are written up in `architecture-decisions.md`, and the database schema is drafted in `schema.sql`.

Your two constraints are both being honoured. The JSON schema stays exactly as it is, as the export and import contract — your export → edit → re-import loop doesn't change. And the frontend ports one-to-one: same layout, same content, same terminology, same eight tabs. What changes is only what sits underneath.

Four of the six decisions that needed you are settled. **Two remain: D‑1 and D‑6.**

---

## Still outstanding

### D‑1 — Import treats derived fields as advisory

Your JSON contract is unchanged. The one behavioural difference is on import.

Some figures in the schema can be computed from the records beneath them: `company.invested` is the sum of the rounds, `company.fmv` is the latest mark, `company.realized` is the sum of the realizations. In the prototype those are stored separately from the records they summarise, and nothing enforces that they agree.

In the rebuild, if an imported file says `invested: 8.5` and the transactions behind it sum to 8.3, the import will succeed, use 8.3, and hand back a warning naming the discrepancy — rather than silently accepting a number that contradicts its own detail.

Worth knowing that this also fixes something in the current model: realizations live in two places today, `fund.distributions[]` driving fund DPI and `company.realized` driving company MOIC. They're independent, so they can drift apart without anyone noticing. Both now read the same records.

**What I need from you:** confirmation that a warning-and-correct on import is acceptable, rather than the file being taken at its word.

### D‑6 — Which quarter labelling each screen uses

Visible labels on calendar quarters: the submission due 5 August is Q2 2026, covering April–June. Our fiscal year starts 1 April, so that same period is FY2026‑27 Q1.

Both labels are correct. The database stores real dates and derives either on demand, so this is purely a presentation choice — but each screen needs to say which one it's showing, or the difference reads as an error.

My suggestion: fiscal labels on Reports and anything board-facing, since that's the calendar the board works to; calendar labels on the Portfolio drawer KPI history, since that's what Visible shows and what founders reported against. Dashboard could go either way.

**What I need from you:** agreement on that split, or a different one.

---

## Settled — no action needed

**D‑2, revenue presentation.** Displayed as reported. Visible supplies the past quarter's actual, so that's what gets stored and shown — no annualisation. The label moves from run-rate to quarterly revenue in the tile, the memo prefill and the guide. Two things follow from it: the aggregate revenue figure will be roughly a quarter of what the same tile showed under the run-rate label, so if anyone compares against earlier output the basis change needs saying once. And same-store QoQ growth now carries seasonality that run-rate framing masked — a same-quarter year-over-year comparison would be the more robust measure, but that's a phase-2 conversation, not a change now.

**D‑3, FMV growth showing two flat quarters a year.** Accepted, with the carry-forward labelled on screen the way you flagged DPI as recycling-based.

**D‑4, deal-close capture.** Accepted. The deal lead captures round total, NB co-investors, ownership and pro-rata at close. Coverage is monitored on the dashboard so the leverage metric degrades visibly rather than silently. Your rule that rounds with missing or bad totals are excluded rather than guessed is preserved exactly.

**D‑5, diversity tile.** Non-reporters excluded from the denominator, coverage shown alongside the figure. Unreported never renders as zero.

---

## What you can skip

The remaining decisions are database design, hosting, authentication, ingestion scheduling, backfill sequencing, the Finance data-loading process, and the waterfall model, which stays as-is for now. They're written up if you want them, but none of them changes anything you see or do.

---

## What happens next

Finance has started producing the three historical data pools — transactions, valuation marks, and fund activity — against templates we've issued them. That work runs underneath everything else and is the long pole: the application can be built against demo data, but it can't go live without history, which for some companies goes back fifteen years or more.

On the build itself, the working assumption is Pipeline first as a thin end-to-end slice — Affinity is live and disciplined, so it proves the whole stack on data where being wrong costs nothing — then Portfolio, then Funds.
