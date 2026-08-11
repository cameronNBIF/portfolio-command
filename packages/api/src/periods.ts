/**
 * Quarter labels <-> period dates.
 *
 * ADR-006: reporting periods are stored as DATES and labels are derived, never
 * stored and never keyed on. The contract carries a label (`"2026-Q1"`) because
 * the prototype did; storage carries `period_start` / `period_end` because two
 * conventions coexist and a bare label does not say which one it means.
 *
 * THIS MODULE HANDLES THE CALENDAR CONVENTION ONLY, which is what both
 * `kpis[].period` and `fund.navHistory[].q` carry -- Visible reports on calendar
 * quarters (ADR-010, D-6). Fiscal labels are derived in SQL by
 * `fiscal_quarter_label()` for board-facing views and are not produced here.
 *
 * The inverse direction is `calendar_quarter_label()` in schema.sql, and the
 * two must agree: `toCalendarLabel(periodEndOf(q)) === q` for every q. That
 * property is asserted in test rather than assumed.
 */

/** `2026-Q1` and nothing else. Anchored so a stray suffix cannot slip through. */
const QUARTER_LABEL = /^(\d{4})-Q([1-4])$/;

export interface QuarterPeriod {
  /** `YYYY-MM-DD`, first day of the quarter. */
  periodStart: string;
  /** `YYYY-MM-DD`, last day of the quarter. */
  periodEnd: string;
}

/** Last day of each calendar quarter, indexed by quarter number minus one. */
const QUARTER_END = ['03-31', '06-30', '09-30', '12-31'] as const;
const QUARTER_START = ['01-01', '04-01', '07-01', '10-01'] as const;

/**
 * `"2026-Q1"` -> `{ periodStart: '2026-01-01', periodEnd: '2026-03-31' }`.
 *
 * Throws on anything unparseable rather than guessing. An import that has
 * silently dropped a KPI period is worse than one that stops and says which
 * label it could not read.
 */
export function periodOf(label: string): QuarterPeriod {
  const m = QUARTER_LABEL.exec(label);
  if (!m) {
    throw new Error(
      `Unparseable quarter label ${JSON.stringify(label)}. Expected the calendar form "YYYY-Qn", e.g. "2026-Q1".`,
    );
  }
  const year = m[1]!;
  const quarter = Number(m[2]!);
  return {
    periodStart: `${year}-${QUARTER_START[quarter - 1]!}`,
    periodEnd: `${year}-${QUARTER_END[quarter - 1]!}`,
  };
}

/**
 * `'2026-03-31'` -> `"2026-Q1"`. The TypeScript twin of `calendar_quarter_label()`.
 *
 * Takes the date as a string rather than a `Date` on purpose: constructing a
 * `Date` from `YYYY-MM-DD` parses as UTC midnight, and reading the month back
 * with a local-time getter moves the quarter boundary for anyone west of
 * Greenwich. Affinity's timezone bug (CLAUDE.md) is the same mistake made
 * upstream; there is no reason to reproduce it here.
 */
export function toCalendarLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(date);
  if (!m) throw new Error(`Unparseable date ${JSON.stringify(date)}. Expected YYYY-MM-DD.`);
  return `${m[1]}-Q${Math.floor((Number(m[2]!) - 1) / 3) + 1}`;
}
