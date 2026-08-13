/**
 * The Visible-data-point-to-company_kpi transform. Pure: no network, no
 * database, no clock. The half of A5 worth testing is testable without either.
 *
 * Three things this module decides, and one it deliberately refuses to.
 *
 * DECIDES
 *  1. Which Visible metric name lands in which `company_kpi` column, and in
 *     what unit. The names come from NBIF's live Visible->Affinity pipeline
 *     (`config.py`), which has been running against this exact account.
 *  2. How a data point's date becomes a CALENDAR quarter. Visible dates a point
 *     at the START of the period it covers and the platform stores
 *     `period_start`/`period_end` as dates, never a label (ADR-006).
 *  3. That values stay STRINGS from the API to Postgres numeric. Visible sends
 *     them as strings for precision; parsing to a float and back would be the
 *     one place money could quietly lose a cent (ADR-008).
 *
 * REFUSES
 *  4. To invent a period for a metric whose cadence is not quarterly. A monthly
 *     burn figure could be the quarter's last month, its mean, or its worst
 *     month, and those are three different board numbers. The reducer is passed
 *     in by the caller; this module reports the cadence and will not guess.
 */

import type { DataPoint, Metric, MetricFrequency } from './client.js';

/** Columns on `company_kpi` that Visible supplies. */
export type KpiColumn =
  | 'revenue'
  | 'monthly_burn'
  | 'cash_balance'
  | 'runway_months'
  | 'fte'
  | 'fte_nb'
  | 'women_csuite'
  | 'csuite_size'
  | 'net_revenue_retention'
  | 'gross_margins';

export interface MetricSpec {
  column: KpiColumn;
  /**
   * How the value is validated.
   *
   * `count` is the only integer kind and it exists for `women_csuite` /
   * `csuite_size`, which count people. `fte` is deliberately NOT a count: a
   * full-time *equivalent* of 3.5 is three full-timers and a half-timer, and
   * rounding it would move a mandate number in one direction or the other on
   * somebody's behalf.
   */
  kind: 'money' | 'count' | 'months' | 'percent' | 'fte';
  /** What the Visible request is understood to ask for. Quoted in the field map. */
  note: string;
  /**
   * Which request wording this name represents, stamped onto the row
   * (`company_kpi.request_version`). Only set where a column is fed by more
   * than one metric name over time; see BURN_CHANGEOVER below.
   */
  requestVersion?: string;
  /**
   * Tie-break when two metric names feed one column on the SAME date. Higher
   * wins. Absent means 0.
   */
  precedence?: number;
}

/**
 * The one definitional change the data actually shows, and the reason
 * `request_version` exists rather than being a theoretical nicety.
 *
 * Measured on 13 August 2026:
 *
 *   "Monthly Burn Rate"      2021-04-01 .. 2025-07-01   774 values, 73 companies
 *   "Monthly Net Burn Rate"  2025-07-01 .. 2026-04-01   128 values
 *   "Net Burn Rate"          never answered at all        0 values
 *
 * One series under two names, handed over in 2025 Q3. Mapping only the current
 * name -- which is right for a CRM field showing the latest value, and is what
 * the NBIF Visible->Affinity pipeline does -- would start the platform's burn
 * history in October 2025 and discard 774 reported figures.
 *
 * So both feed `monthly_burn`, and every row records which wording produced it.
 * The seam is REAL: "Burn Rate" and "Net Burn Rate" may differ by whether
 * revenue is netted off, so a quarter-on-quarter comparison spanning 2025 Q3 is
 * comparing two questions. Stamping it is what lets a chart say so instead of
 * drawing a step change as though it were performance.
 */
export const BURN_REQUEST_BASELINE = '2021-baseline';
export const BURN_REQUEST_NET = '2025Q3-net-burn';
/** First period in which the renamed question was answered by anyone. */
export const BURN_CHANGEOVER_PERIOD_END = '2025-09-30';

/**
 * Visible metric name -> `company_kpi` column.
 *
 * Keyed on the LOWERCASED, TRIMMED name. Visible metric names are typed by
 * whoever created the request and casing drifts; the pipeline that has been
 * running in production matches case-insensitively for exactly that reason.
 *
 * Names come from the live account and every one of them was confirmed against
 * it by the probe on 13 August 2026, with its fill rate measured.
 */
export const METRIC_MAP: Readonly<Record<string, MetricSpec>> = {
  'quarterly revenue': {
    column: 'revenue',
    kind: 'money',
    note: "The past quarter's actual, stored and displayed as reported. No annualisation (ADR-010, D-2).",
  },
  'cash position': {
    column: 'cash_balance',
    kind: 'money',
    note: 'Cash on hand at the period end as reported.',
  },
  // Both names feed monthly_burn. See BURN_CHANGEOVER_PERIOD_END above: the
  // current wording wins a same-date tie, because one company answered both in
  // 2025 Q3 and the newer question is the one that continues.
  'monthly net burn rate': {
    column: 'monthly_burn',
    kind: 'money',
    note: 'A MONTHLY rate reported on a quarterly cycle. Negative renders as cash-flow positive.',
    requestVersion: BURN_REQUEST_NET,
    precedence: 2,
  },
  'monthly burn rate': {
    column: 'monthly_burn',
    kind: 'money',
    note: 'The pre-2025Q3 wording of the same question. Retired after 2025 Q3; kept for history.',
    requestVersion: BURN_REQUEST_BASELINE,
    precedence: 1,
  },
  'full-time employees': {
    column: 'fte',
    kind: 'fte',
    note:
      'MANDATE: jobs. Definition lives in the Visible request wording (ADR-010). ' +
      'Fractional values are stored as reported, never rounded.',
  },
  'nb full-time employees': {
    column: 'fte_nb',
    kind: 'fte',
    note: 'MANDATE: NB jobs. Fractional as above; constrained fte_nb <= fte by the schema.',
  },
  'months of runway remaining': {
    column: 'runway_months',
    kind: 'months',
    note: 'AS REPORTED, never computed from cash/burn (ADR-027).',
  },
  'net revenue retention': {
    column: 'net_revenue_retention',
    kind: 'percent',
    note:
      'Percent as a WHOLE NUMBER -- 107.0 is 107%, matching the contract convention. ' +
      'Collected since 2021 Q4, answered by 75 of 82. Added at A5; stored, not yet exported.',
  },
  'gross margins': {
    column: 'gross_margins',
    kind: 'percent',
    note:
      'Percent as a WHOLE NUMBER -- 65.0 is 65%. Collected since 2025 Q1, answered by 65 of 82. ' +
      'Added at A5; stored, not yet exported.',
  },
};

/**
 * Candidate names for the two diversity fields, which action A-1 is adding to
 * the quarterly request. None of these is confirmed to exist yet -- the probe
 * looks for them so the day they appear is noticed rather than waited on.
 * NULL until then, and NULL must never render as zero (D-5, ADR-010).
 */
export const DIVERSITY_CANDIDATES: Readonly<Record<string, KpiColumn>> = {
  'women in c-suite': 'women_csuite',
  'women in the c-suite': 'women_csuite',
  'women c-suite': 'women_csuite',
  'c-suite size': 'csuite_size',
  'c-suite headcount': 'csuite_size',
};

/** Lowercase-and-trim, the one place metric names are normalised for lookup. */
export function metricKey(name: string): string {
  return name.trim().toLowerCase();
}

export function specFor(name: string): MetricSpec | null {
  return METRIC_MAP[metricKey(name)] ?? null;
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

/**
 * A URL as a bare, comparable domain: 'https://www.Profitual.ai/about' ->
 * 'profitual.ai'.
 *
 * Website is the join key across Affinity, Visible and Finance (ADR-009), and
 * the two systems hold it in different shapes: Affinity supplies an already-bare
 * `entity.domain`, Visible a founder-typed `website_url`. Normalising both ends
 * to the same form is what makes the join an equality test rather than a
 * fuzzy match -- and nothing here is fuzzy on purpose. 'a.com' must never match
 * 'ba.com'.
 */
export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.trim().toLowerCase();
  if (text === '' || text === 'n/a' || text === 'na' || text === '-') return null;

  if (!/^https?:\/\//.test(text)) text = `https://${text}`;

  let host: string;
  try {
    host = new URL(text).hostname;
  } catch {
    return null;
  }

  if (host.startsWith('www.')) host = host.slice(4);
  host = host.split(':')[0] ?? '';

  // A hostname with no dot is not a domain -- 'localhost', or a founder who
  // typed a company name into the website box.
  if (!host.includes('.')) return null;
  return host;
}

// ---------------------------------------------------------------------------
// Periods (ADR-006)
// ---------------------------------------------------------------------------

export interface Period {
  /** YYYY-MM-DD. */
  periodStart: string;
  /** YYYY-MM-DD, inclusive. The unique key on company_kpi is (company_id, period_end). */
  periodEnd: string;
}

const QUARTER_ENDS = ['03-31', '06-30', '09-30', '12-31'] as const;
const QUARTER_STARTS = ['01-01', '04-01', '07-01', '10-01'] as const;

/**
 * The CALENDAR quarter containing a date.
 *
 * Calendar, not fiscal, and deliberately: Visible labels by calendar quarter --
 * the submission due 5 August 2026 is "Q2 2026", covering April to June -- while
 * the organisation's fiscal year starts 1 April. Both labels are DERIVED in SQL
 * from these two dates, so storing the wrong one here would be invisible until a
 * board pack disagreed with a founder (ADR-006, D-6).
 */
export function calendarQuarter(isoDate: string): Period {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.slice(0, 10));
  if (!match) throw new Error(`Not an ISO date: ${isoDate}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`Not a month: ${isoDate}`);

  const q = Math.floor((month - 1) / 3);
  return {
    periodStart: `${year}-${QUARTER_STARTS[q]}`,
    periodEnd: `${year}-${QUARTER_ENDS[q]}`,
  };
}

/**
 * True when a date sits exactly on a calendar quarter boundary.
 *
 * Visible dates a data point at the start of the period it covers, so a
 * genuinely quarterly submission lands on 1 Jan / 1 Apr / 1 Jul / 1 Oct. A
 * quarterly metric dated 15 May means the cadence and the data disagree, which
 * is worth a warning rather than silent absorption into Q2.
 */
export function isQuarterStart(isoDate: string): boolean {
  const suffix = isoDate.slice(5, 10);
  return (QUARTER_STARTS as readonly string[]).includes(suffix);
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export type ValueProblem = 'blank' | 'not-a-number' | 'fractional-count';

export interface ParsedValue {
  /** The value as a STRING, ready for a numeric parameter. Never a float. */
  value: string | null;
  problem: ValueProblem | null;
}

/**
 * Validates a Visible value without ever converting it to a number for storage.
 *
 * `Number(text)` is used to TEST the string and is then thrown away; the string
 * itself is what reaches Postgres. That keeps the money path free of binary
 * floating point end to end (ADR-008), which matters because these figures are
 * summed into board-facing aggregates.
 */
export function parseValue(raw: string | number | null | undefined, kind: MetricSpec['kind']): ParsedValue {
  if (raw === null || raw === undefined) return { value: null, problem: 'blank' };

  const text = String(raw).trim();
  // Visible has been observed returning the literal string 'None' for a blank.
  if (text === '' || text.toLowerCase() === 'none' || text.toLowerCase() === 'n/a') {
    return { value: null, problem: 'blank' };
  }

  const n = Number(text);
  if (!Number.isFinite(n)) return { value: null, problem: 'not-a-number' };

  // `count` is for women_csuite / csuite_size, which count people and are int
  // columns. A fraction there is a reporting error rather than a measurement, so
  // it is refused and named rather than rounded into something plausible.
  if (kind === 'count') {
    if (!Number.isInteger(n)) return { value: null, problem: 'fractional-count' };

    // Visible float-formats every number: a count of twelve arrives as "12.0",
    // which Postgres refuses for an integer column. Stripping a zero-only
    // fraction is a change of spelling, not of value.
    const integral = text.replace(/\.0+$/, '');
    return { value: /^[+-]?\d+$/.test(integral) ? integral : n.toFixed(0), problem: null };
  }

  // `fte` reaches a numeric column and keeps whatever the founder reported,
  // fraction and all. "12.0" and "3.5" both pass through untouched.
  return { value: text, problem: null };
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export interface KpiCell {
  column: KpiColumn;
  value: string;
  /** The data point's own date, kept so a mis-cadenced point can be named. */
  sourceDate: string;
  frequency: MetricFrequency | null;
  /** The Visible metric name that produced it. Feeds request_version. */
  metricName: string;
}

export interface KpiPeriodRow extends Period {
  cells: KpiCell[];
  /**
   * Which Visible request wording produced this row (`company_kpi.request_version`).
   * Derived from the burn cell where there is one, because the burn rename is
   * the only definitional change the data shows; otherwise from the period, so
   * a row with no burn answer still sits on the right side of the seam.
   */
  requestVersion: string;
}

/** The wording a row should be stamped with. See BURN_CHANGEOVER_PERIOD_END. */
export function requestVersionFor(cells: readonly KpiCell[], periodEnd: string): string {
  const burn = cells.find((c) => c.column === 'monthly_burn');
  if (burn) {
    const spec = specFor(burn.metricName);
    if (spec?.requestVersion) return spec.requestVersion;
  }
  return periodEnd < BURN_CHANGEOVER_PERIOD_END ? BURN_REQUEST_BASELINE : BURN_REQUEST_NET;
}

export interface GroupProblem {
  metricName: string;
  sourceDate: string;
  detail: string;
}

export interface GroupResult {
  rows: KpiPeriodRow[];
  problems: GroupProblem[];
}

/**
 * Folds one company's data points into one row per calendar quarter.
 *
 * Collisions -- two points for the same column in the same quarter -- are
 * resolved by LATEST DATE, then by request-wording precedence. Two things
 * produce them:
 *
 *   - a metric reported more often than quarterly, where the latest date is the
 *     quarter's closing reading: what a founder would quote, and the one nearest
 *     the period end the row is keyed on. A choice, not an average, because an
 *     average of three months is a number nobody reported (ADR-010).
 *   - the burn rename, where both wordings were answered in 2025 Q3 on the same
 *     date. Precedence settles it in favour of the question that continues,
 *     rather than leaving it to array order.
 */
export function groupIntoQuarters(
  points: readonly DataPoint[],
  metricsById: ReadonlyMap<string, Metric>,
): GroupResult {
  const byPeriod = new Map<string, KpiPeriodRow>();
  const problems: GroupProblem[] = [];

  const ordered = [...points].sort((a, b) => a.date.localeCompare(b.date));

  for (const point of ordered) {
    const metric = metricsById.get(point.metric_id);
    if (!metric) continue;

    const spec = specFor(metric.name);
    if (!spec) continue;

    const parsed = parseValue(point.value, spec.kind);
    if (parsed.value === null) {
      // A blank is the normal state of an unanswered question and is not worth
      // reporting; the other two are data quality findings.
      if (parsed.problem !== 'blank') {
        problems.push({
          metricName: metric.name,
          sourceDate: point.date,
          detail: `${parsed.problem}: ${JSON.stringify(point.value)} -> ${spec.column}`,
        });
      }
      continue;
    }

    if (metric.frequency === 'quarterly' && !isQuarterStart(point.date)) {
      problems.push({
        metricName: metric.name,
        sourceDate: point.date,
        detail:
          'quarterly metric dated off a quarter boundary; absorbed into the containing quarter',
      });
    }

    const period = calendarQuarter(point.date);
    const row = byPeriod.get(period.periodEnd) ?? { ...period, cells: [], requestVersion: '' };
    const existingIndex = row.cells.findIndex((c) => c.column === spec.column);
    const cell: KpiCell = {
      column: spec.column,
      value: parsed.value,
      sourceDate: point.date,
      frequency: metric.frequency,
      metricName: metric.name.trim(),
    };

    if (existingIndex < 0) {
      row.cells.push(cell);
    } else {
      // `ordered` is ascending, so a strictly later point always wins. On the
      // same date -- which is what the 2025 Q3 burn overlap looks like -- the
      // higher-precedence wording wins instead of whichever arrived first.
      const existing = row.cells[existingIndex]!;
      const samePoint = existing.sourceDate === cell.sourceDate;
      const winsOnPrecedence =
        (specFor(cell.metricName)?.precedence ?? 0) > (specFor(existing.metricName)?.precedence ?? 0);
      if (!samePoint || winsOnPrecedence) row.cells[existingIndex] = cell;
    }
    byPeriod.set(period.periodEnd, row);
  }

  const rows = [...byPeriod.values()].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  for (const row of rows) row.requestVersion = requestVersionFor(row.cells, row.periodEnd);

  return { rows, problems };
}
