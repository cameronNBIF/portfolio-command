# Portfolio Command - Developer Handoff Notes

## What this is

A single-file portfolio management tool for NBIF-style direct investing: portfolio monitoring, strategic LP (fund) positions, deal pipeline, reserves and exit-scenario modeling, IC memo generation, board reporting, and data import/export. Built as a working v1 prototype - the product decisions and metric definitions are settled and validated by the user; the engineering is intentionally simple so you can take it in whatever direction fits your stack.

## Architecture (current state)

Everything lives in **`vc-toolkit.html`**: CSS, HTML shell, and one `<script>` block (~2,000 lines). No build step, no framework, no dependencies except Chart.js 4 loaded from the jsDelivr CDN. Open the file in a browser and it runs.

- **State**: one global object `DB` (companies, fund, fundInvestments, pipeline, memos, meta), seeded by `freshDB()`. Optional persistence to `localStorage` under key `pc_toolkit_v1`, with schema-migration shims in `loadDB()` for older saved states.
- **Rendering**: vanilla JS, string-template views. Each tab has a `renderX()` function registered in `RENDERERS`; `switchView(name)` toggles visibility and re-renders. No virtual DOM - every interaction re-renders the affected view. Fine at 70 companies; if the roster grows 10x, consider incremental rendering.
- **Charts**: Chart.js instances tracked in `CHARTS` and destroyed before re-create (see `makeChart`). Charts are created inside `requestAnimationFrame` after the container is visible - keep that pattern or resizing breaks.
- **Demo data**: 12 hand-built companies (`detailedCompanies()` + `DETAIL_ENRICH`) plus 58 generated deterministically (`generatedCompanies()`, seeded mulberry32 RNG, seed 42). Replace wholesale via the Data tab importers.

## Code map (section headers in the script, in order)

| Section | Contents |
|---|---|
| DATA LAYER | RNG, constants (sectors, stages, funnel, gates, sources), demo data builders, `DETAIL_ENRICH`, `demoFundInvestments()`, `demoFund()`, store/persistence (`loadDB`/`saveDB`/`resetDB`) |
| METRICS ENGINE | `fmt` helpers, `moic`, `fundMetrics()` (all fund-level KPIs), `xirr` (bisection), `healthAlerts()`, DOM helpers |
| VIEW: DASHBOARD | `renderDashboard`, `drawDashboardCharts` |
| VIEW: PORTFOLIO | filter state `PF`, `renderPortfolio`, `pfFiltered`, `openCompany` (detail drawer) |
| VIEW: FUND INVESTMENTS | `fiTvpi/fiDpi/fiIrr`, `fiMetrics()`, `renderFunds`, `openFundInv` |
| VIEW: PIPELINE | `renderPipeline`, `openDeal`, `setGate` |
| Affinity import | `mapAffinityStatus`, `seedGates`, `importAffinityCsv` (fuzzy column detection) |
| VIEW: MODELING | reserves tool (`suggestedReserve`, `renderReservesTool`), scenario tool (`scenarioDefaults`, `runScenario`, `renderScenarioTool`) |
| VIEW: MEMO BUILDER | `MEMO_SECTIONS`, `prefillMemo` (auto-population from DB), export |
| VIEW: REPORTS | `renderReports`, CSV export, exec-summary clipboard |
| VIEW: DATA | `CSV_SPECS`, schema documentation, JSON/CSV importers (`parseCsv` is a hand-rolled RFC-4180-ish parser) |
| BOOT & NAVIGATION | `RENDERERS`, `switchView`, `renderAll`, init |

## Data model

The authoritative, annotated JSON schema is rendered in the app itself: **Data tab -> "JSON Schema (annotated example)"**. CSV column specs for every entity are in the same tab. Conventions: money in $M, percentages as plain numbers (11.2 = 11.2%), dates YYYY-MM-DD, booleans Y/N in CSV.

Key semantic decisions (settled with the user - preserve these):

- `fund.style: "evergreen" | "closed-end"` switches framing app-wide. Evergreen keeps TVPI/DPI/RVPI but labels them since-inception, flags DPI as recycling-based, and uses capital base / net deployed / dry powder instead of committed/called. Dry powder = capitalBase - (invested - realizations).
- Direct portfolio and `fundInvestments` (strategic LP positions) are **never blended**. LP multiples are on called capital; direct MOIC is on invested cost.
- Leverage = (sum roundTotal - sum our invested) / sum our invested, only over rounds with a valid `roundTotal >= invested`. `nbOther` per round splits attracted capital into NB vs outside.
- FMV growth reads `fund.navHistory` (quarterly `{q, nav, cost}`); organic growth = deltaNAV - deltaCost. Same-store revenue growth only uses companies with 2+ KPI periods.
- Gross IRR = XIRR over round outflows, realizations, current NAV terminal. Net IRR = gross - `feeDragPct` (an estimate, labeled as such).
- Waterfall model simplifications (stated on-screen): 1x non-participating pref, pari passu, pool carved pre-money, no ratchets.

## Known limitations / where I'd take it next

1. **Persistence** is localStorage-only and per-browser-context. Obvious first move: a small backend (or SQLite + file sync) behind the same JSON schema; the import/export functions define the contract already.
2. **Single file** was a deliberate constraint (runs as a chat artifact). Splitting into modules/components is safe - views only communicate through `DB` and the render functions.
3. **Affinity**: current integration is CSV drop (fuzzy header matching in `importAffinityCsv`). Affinity has an official MCP connector and a REST API (v2) - a scheduled sync of the pipeline list would replace the manual export.
4. **navHistory is manual** (append a row per quarter). Once full mark history is imported per company, it can be derived: portfolio FMV at date = sum of each company's latest mark <= date.
5. **XIRR** is bisection with a bracket of [-95%, +1000%]; returns null if no sign change. Fine in practice, but no multiple-root handling.
6. **No tests**. The metric functions (`fundMetrics`, `fiMetrics`, `xirr`, `runScenario`, `parseCsv`, `importAffinityCsv` mapping) are pure-ish and easy to extract and unit test - they were verified during development with ad hoc Node harnesses (stub `document`/`Chart`/`localStorage`, eval the script, assert; e.g. TVPI = DPI + RVPI, cashflow reconciliation, CSV round-trips).
7. **Security**: user strings are escaped via `esc()` before interpolation into templates. If you add fields, keep doing that - everything renders through innerHTML.
8. **Print/PDF** relies on `@media print` rules; the Reports tab is the board-ready output.

## Files in this handoff

- `vc-toolkit.html` - the application (single source of truth)
- `portfolio-command-guide.md` - user-facing guide: tab-by-tab usage, import formats, metric conventions, evergreen/mandate KPI definitions
- `DEV-NOTES.md` - this file

A full demo-data snapshot can be produced from the running app: Data tab -> Export full JSON.
