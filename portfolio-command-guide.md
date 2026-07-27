# Portfolio Command - User Guide

One HTML file, no install, no server. Open `vc-toolkit.html` in Edge/Chrome, or use the Cowork artifact. Everything runs in memory in your browser; nothing leaves your machine.

## The 8 tabs

**Dashboard** - Fund KPIs (TVPI, DPI, RVPI, gross/net IRR), FMV vs cost by sector, MOIC distribution, vintage performance, J-curve, allocation donuts, and a live alert feed. Alerts are generated from runway thresholds, risk flags, covenant status, and gov-funding conditions. Click any company name in the alerts to jump to its detail.

**Portfolio** - The full roster. Interactions:
- Click any column header to sort; click again to reverse.
- Use the filter bar (search box, active/exited, sector, stage, health, instrument).
- Click any row to open the detail drawer: rounds and cap-table position, KPIs vs thresholds, reserves, board seat and next meeting, milestones, covenants, gov funding, mark history (the valuation audit trail), and open tasks.
- "Open in Memo Builder" inside the drawer pre-fills a memo from that company's data.

**Funds** - Strategic LP positions, tracked separately from the direct portfolio (they never blend into direct-fund metrics). Own KPI row (committed, called, unfunded, NAV, TVPI/DPI/RVPI on called capital per LP convention, pooled IRR), a commitment-pacing chart showing the vintage stagger with unfunded overhang, NAV by strategy, and a positions table. Click a position for its capital-call/distribution history, next expected call and AGM dates, and the strategic scorecard: co-invest rights, co-investments executed, and pipeline referrals received - the "why we're in this fund" record. Import via `fund_investments.csv` and `fund_cashflows.csv` (specs in the Data tab).

**Pipeline** - Kanban from Sourced to Closed, with the annual platform target tracker up top. Click a deal card for its diligence gates (each gate has a status dropdown you can change) and, where issued, the term-sheet summary. "Draft IC Memo" starts a memo for that deal.

**Modeling** - Two tools:
- *Reserves & Follow-On*: edit the "Allocated" number for any company directly in the table; totals recalculate. "Use suggested" applies the policy heuristic (0.8x initial check for green, 0.5x for yellow, pro-rata holders only).
- *Exit Waterfall & Dilution*: pick a company, adjust the next-round assumptions (raise, pre-money, pool, participation) and exit cases. Ownership after dilution, proceeds, MOIC, and IRR update on every change. The chart shows proceeds across the full exit-value range with your cost as the breakeven line.

**Memo Builder** - Pick any portfolio company or pipeline deal. Terms, cap table, traction, and risks auto-populate; the other sections (thesis, market, team, topgrading, product, returns, recommendation) are yours to draft. "Re-pull data" refreshes the auto sections after data changes. Export to Markdown or Print/PDF.

**Reports** - The board/LP view: fund summary, quarter highlights, watchlist, top/bottom positions, NAV bridge by vintage. "Print / PDF" produces a clean board-ready document (nav and buttons are stripped automatically). "Export portfolio CSV" is the data appendix.

**Data** - Schema documentation, import, export, and persistence.

## Saving your work

By default nothing persists between sessions. Two options:
- **Data tab -> Save locally**: stores the current state in browser storage. Note: browser storage is per-context, so data saved in Edge stays in Edge and data saved in the artifact stays in the artifact.
- **Data tab -> Export full JSON**: downloads everything (companies, pipeline, memos, fund settings) to a file. This is your backup and your migration path. Re-import it any time.

"Reset to demo" wipes saved data and restores the demo portfolio.

## Importing your real data

Two entry points, both in the Data tab:

1. **Full JSON** (recommended): match the annotated schema shown in the Data tab. Easiest path: Export full JSON, edit it (or have me transform your Carta/valuation exports into it), and re-import.
2. **CSV per entity**: four files, exact headers required (shown in the Data tab):
   - `companies.csv` - replaces the roster
   - `rounds.csv`, `marks.csv`, `kpis.csv` - attach to companies by `company_id`

Conventions: money in $M, percentages as plain numbers (11.2 means 11.2%), dates YYYY-MM-DD, booleans Y/N. Import companies first, then the others.

## Edge notes (actions that need context)

- Row clicks, drawers, kanban cards, gate dropdowns, sorting, filters, and Modeling inputs all work when opening the file directly.
- "Export" buttons trigger file downloads - check your Downloads folder and allow the download if Edge prompts.
- "Copy exec summary" uses the clipboard API, which some browsers block for local files. If it does nothing, use the artifact version or Print/PDF instead.
- Charts need internet access once per session (Chart.js loads from a CDN). Offline, tables and everything else still work.

## If you want changes later

Start a new Cowork chat and upload:

1. **`vc-toolkit.html`** - the single source of truth for the entire tool (data model, logic, and UI are all in this one file). Keep your latest copy.
2. **Your exported JSON** (Data tab -> Export full JSON) - only if the change involves your data or you want your data preserved in the rebuilt version.
3. Optionally, a screenshot of what you want changed.

Then describe the change ("add a co-investor field", "change the reserve policy formula", "add a DPI-by-vintage chart"). Any Claude session can read the file, modify it, and hand back the updated version - and can re-publish it as the artifact.

## Evergreen mode

The fund is configured as evergreen (`fund.style: "evergreen"`). The full performance set - TVPI, DPI, RVPI, gross/net IRR - is reported in both modes; evergreen mode changes the framing and interpretation around it. Specifically: metrics are labeled since-inception; DPI is flagged as recycling-based (proceeds return to the fund per policy rather than being distributed, so it reads low relative to a distributing vehicle at equal performance - an on-screen note says so wherever DPI appears in board views); committed/called is replaced by Capital Base, Net Deployed, and Dry Powder = capital base - (invested - realizations); the dashboard's J-curve becomes "Value Creation Over Time"; the Reserves tool draws on dry powder; and Reports adds a RECYCLE highlight stating the distribution policy. Set `fund.style` to `"closed-end"` for a distributing-vehicle presentation.

## Mandate KPIs (leverage, FMV growth, jobs, indirect-to-direct)

Four metrics aimed at an economic-development mandate, all on the Dashboard and in board-report highlights:

- **Leverage**: third-party dollars invested alongside yours in rounds you participated in, expressed as X:1 per your dollar. Driven by `roundTotal` on each round (add `round_total_m` to your rounds CSV). Rounds without a total, or with bad data, are excluded rather than guessed. Shown fund-wide, per year (stacked chart of your capital vs capital attracted), and per round in each company's drawer.
- **FMV growth**: YoY and QoQ NAV growth plus organic value creation (change in NAV minus new capital deployed - the part that is markups, not money in). Driven by `fund.navHistory`, one entry per quarter; append a row each quarter or import history.
- **Portfolio FTEs**: current headcount vs headcount at entry (`fte` / `fteAtEntry` per company), summed fund-wide.
- **Capital to Direct**: per LP position, dollars that fund and its network deployed into your direct portfolio (`capitalToDirect`). This is the indirect sleeve's report card - it exists to attract capital to the direct strategy, and this measures whether it does.

## Impact & ecosystem KPIs (from board feedback)

The Dashboard has a dedicated "Mandate & Impact" tile row, and Reports carries matching REVENUE, IMPACT, and expanded LEVERAGE highlight lines:

- **Sourcing**: every portfolio company carries a `source` channel (university spinout, accelerator, founder referral, fund referral, etc.). A "Where We Find Companies" chart ranks channels by active-company count, and each company's drawer shows how it was sourced.
- **Jobs in and out of NB**: `fteNB` alongside total `fte` per company - the tile shows NB jobs / total jobs, % in NB, and growth since entry; per-company split in the drawer.
- **Women in C-suite**: `womenCSuite` / `cSuiteSize` per company rolls up to % of companies with women in the C-suite and total exec seats held. Fund managers carry `womenSeniorGP`, rolled up as a "Women in GP Leadership" tile on the Funds tab.
- **NB capital separate from ours**: each round can carry `nbOther` ($M from other NB investors, excluding you). The capital-attracted chart now stacks three ways - your capital, other NB capital, outside capital - and the NB Co-Investment tile and LEVERAGE report line show the split. This separates "NB ecosystem depth" from "capital imported into NB."
- **Underlying revenue**: aggregate run-rate revenue across active companies plus same-store QoQ growth (computed only from companies with two or more KPI periods, so mix changes don't distort it).

CSV columns for all of these are in the Data tab specs (companies: source, fte, fte_nb, fte_at_entry, women_csuite, csuite_size; rounds: nb_other_m; fund_investments: women_senior_gp).

## Metric conventions (for board scrutiny)

- MOIC = (FMV + realized) / invested cost, per company.
- Fund MOIC (evergreen) / TVPI (closed-end) = (NAV + realized proceeds) / invested cost. Invested cost proxies paid-in capital; if you want fee-inclusive paid-in, that is a one-line change.
- Gross IRR = since-inception XIRR over all round outflows, realizations, and current NAV as terminal value.
- Net IRR = gross IRR minus the fee drag set in `fund.feeDragPct` (default 2.3 points) - an estimate, not a substitute for your admin's calculation.
- Waterfall model assumes 1x non-participating preference, pari passu stack, pool carved pre-money, no ratchets. Stated on-screen wherever used.
