/**
 * The data source for the application.
 *
 * A2 builds against `docs/reference/demo.json` served as a static fixture.
 * This works because ADR-001 makes the export contract and the API response
 * the same shape, so **the fixture IS the contract** the API will satisfy at
 * A3 (ADR-020). Nothing built on top of this gets reworked when the API
 * arrives -- A3 replaces the body of `loadPortfolio()` and nothing else.
 *
 * The fixture is imported from `docs/reference/` rather than copied into the
 * app on purpose: it is also the golden-master input (ADR-022), and a second
 * copy is a second thing that can drift.
 */
import type { PortfolioExport } from '@portfolio-command/contract';

import demoJson from '../../../docs/reference/demo.json';

/**
 * The reporting as-at date.
 *
 * Derived from the data rather than read from the clock. Every metric that
 * dates a cashflow takes this explicitly (ADR-021), and ADR-007 requires
 * board-facing views to state the date their marks are as at -- so the two are
 * the same fact rather than two that can silently disagree.
 *
 * The latest valuation mark is the right anchor: NAV as at any date is the sum
 * of each company's most recent mark on or before it, so dating the terminal
 * cashflow later than the last mark would value the portfolio at a date its
 * marks do not cover.
 *
 * NOTE this is a visible departure from the prototype, and an intended one.
 * The prototype used `new Date()`, so its IRR drifts about a percentage point
 * per quarter with no data change; a side-by-side comparison will show 19.0%
 * here against whatever the prototype happens to render today. The definition
 * is identical -- only the date is now stated rather than assumed.
 */
export function asOfDate(db: PortfolioExport): string {
  const markDates = db.companies.flatMap((c) => c.marks.map((m) => m.date));
  return markDates.length ? markDates.reduce((a, b) => (a > b ? a : b)) : '1970-01-01';
}

/** A3 replaces the body of this with a fetch of `GET /api/v1/export`. */
export function loadPortfolio(): PortfolioExport {
  return demoJson as unknown as PortfolioExport;
}
