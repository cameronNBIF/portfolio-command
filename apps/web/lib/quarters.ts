/**
 * Quarter labelling, and the convention each view uses (ADR-006, D-6).
 *
 * Two calendars are in play and they do not agree. Visible.vc labels by
 * CALENDAR quarter -- the submission due 5 August 2026 is "Q2 2026", covering
 * April to June. The organisation's FISCAL year starts 1 April, so that same
 * April-June period is fiscal Q1 of FY2026-27.
 *
 * D-6 settled the split: fiscal labels on Reports and all board-facing output,
 * since that is the calendar the board works to; calendar labels on the
 * Portfolio drawer's KPI history, since that is what Visible showed and what
 * founders reported against.
 *
 * **Every quarterly view must state which convention it is using**, or the
 * same figure appearing under two different labels reads as an error rather
 * than as information. `CONVENTION_NOTE` is that statement.
 */

export type QuarterConvention = 'calendar' | 'fiscal';

/** The fiscal year starts 1 April. Mirrors `fund.fiscal_year_start_month`. */
export const FISCAL_YEAR_START_MONTH = 4;

/**
 * The sentence a view puts on screen to say which convention it is using.
 * Required on every quarterly view (D-6).
 */
export const CONVENTION_NOTE: Record<QuarterConvention, string> = {
  calendar:
    'Calendar quarters, as reported through Visible. The same period appears under a fiscal label on Reports.',
  fiscal:
    'Fiscal quarters; the year starts 1 April. The same period appears under a calendar label on the Portfolio KPI history.',
};

/** `2026-03-31` -> `2026-Q1`. The convention the stored KPI labels already use. */
export function calendarQuarterLabel(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return `${y}-Q${Math.floor(((m ?? 1) - 1) / 3) + 1}`;
}

/** `2026-03-31` -> `FY2025-26 Q4`. Mirrors `fiscal_quarter_label()` in schema.sql. */
export function fiscalQuarterLabel(date: string): string {
  const [y, m] = date.split('-').map(Number);
  const month = m ?? 1;
  const fyStart = (y ?? 0) - (month < FISCAL_YEAR_START_MONTH ? 1 : 0);
  const q = Math.floor(((month - FISCAL_YEAR_START_MONTH + 12) % 12) / 3) + 1;
  return `FY${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')} Q${q}`;
}

/**
 * Relabel a stored calendar quarter string (`2026-Q1`) as fiscal.
 *
 * `fund.navHistory[].q` and `company.kpis[].period` are stored as calendar
 * labels. Reports shows them fiscally, so this converts by taking the quarter's
 * end date and relabelling it.
 */
export function calendarLabelToFiscal(label: string): string {
  const match = /^(\d{4})-Q([1-4])$/.exec(label);
  if (!match) return label;
  const year = Number(match[1]);
  const endMonth = Number(match[2]) * 3;
  return fiscalQuarterLabel(`${year}-${String(endMonth).padStart(2, '0')}-01`);
}
