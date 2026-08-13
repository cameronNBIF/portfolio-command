/**
 * Per-field KPI coverage by calendar quarter — A5's exit criterion.
 *
 * DELIBERATELY OUTSIDE THE ADR-001 CONTRACT. This is not portfolio data; it is
 * a statement about how complete the portfolio data is, and the export contract
 * is frozen (ADR-001). Adding a field to `PortfolioExport` to carry it would
 * break the snapshot test for a diagnostic, and Daniel's export/re-import loop
 * has no use for it.
 *
 * It cannot be derived from the exported document either, which is the reason
 * this module exists at all: the adapter coerces a null KPI to `0` because the
 * reference fixture carries literal zeros, so "reported no revenue" and "did
 * not answer" are the same value there. Coverage has to be read from the
 * database, where the null survives.
 */
import { sql, type Kysely } from 'kysely';
import type { DB } from '@portfolio-command/db/generated';

/** One quarter's coverage. Counts, never percentages — see the view's comment. */
export interface KpiCoverageRow {
  /** Calendar quarter label, e.g. '2026-Q2' (ADR-006: Visible reports calendar). */
  period: string;
  periodEnd: string;
  /** Companies with a row this quarter. A company that answered one question counts once. */
  companiesReporting: number;
  /** Companies on the platform, the honest denominator for "who has not reported". */
  companiesTotal: number;
  /** Rows a human entered rather than Visible (ADR-010 manual baselines). */
  manualRows: number;
  fields: { label: string; reported: number }[];
}

/**
 * Newest first, matching `kpis[]` in the contract, and capped because this
 * feeds a panel rather than an analysis. Five years of history is 21 rows and
 * nobody reads the bottom of that.
 */
export async function readKpiCoverage(db: Kysely<DB>, limit = 8): Promise<KpiCoverageRow[]> {
  const { rows } = await sql<{
    period_end: Date | string;
    companies_reporting: string | number;
    companies_total: string | number;
    manual_rows: string | number;
    revenue: string | number;
    monthly_burn: string | number;
    cash_balance: string | number;
    runway_months: string | number;
    fte: string | number;
    fte_nb: string | number;
    net_revenue_retention: string | number;
    gross_margins: string | number;
    women_csuite: string | number;
  }>`select period_end, companies_reporting, companies_total, manual_rows,
            revenue, monthly_burn, cash_balance, runway_months, fte, fte_nb,
            net_revenue_retention, gross_margins, women_csuite
       from v_kpi_coverage
      order by period_end desc
      limit ${limit}`.execute(db);

  return rows.map((r) => {
    // `count()` returns bigint, which pg hands back as a string.
    const n = (v: string | number) => Number(v);
    const periodEnd = typeof r.period_end === 'string' ? r.period_end : r.period_end.toISOString().slice(0, 10);
    const year = Number(periodEnd.slice(0, 4));
    const quarter = Math.ceil(Number(periodEnd.slice(5, 7)) / 3);

    return {
      period: `${year}-Q${quarter}`,
      periodEnd,
      companiesReporting: n(r.companies_reporting),
      companiesTotal: n(r.companies_total),
      manualRows: n(r.manual_rows),
      // Order follows the Visible request, so a reader can scan it against the
      // form founders actually fill in.
      fields: [
        { label: 'Revenue', reported: n(r.revenue) },
        { label: 'Burn', reported: n(r.monthly_burn) },
        { label: 'Cash', reported: n(r.cash_balance) },
        { label: 'Runway', reported: n(r.runway_months) },
        { label: 'FTE', reported: n(r.fte) },
        { label: 'NB FTE', reported: n(r.fte_nb) },
        { label: 'NRR', reported: n(r.net_revenue_retention) },
        { label: 'Gross margin', reported: n(r.gross_margins) },
        { label: 'Women C-suite', reported: n(r.women_csuite) },
      ],
    };
  });
}
