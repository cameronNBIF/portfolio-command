/**
 * Tests for the Visible -> company_kpi mapping.
 *
 * The cases are the ones that would change a board number or lose a row: domain
 * normalisation (the join key), calendar-quarter derivation (ADR-006), value
 * handling that must never become a float (ADR-008), and the collision rule for
 * a monthly figure inside a quarterly series.
 */
import { describe, expect, test } from 'vitest';

import type { DataPoint, Metric } from '../src/visible/client.js';
import {
  BURN_REQUEST_BASELINE,
  BURN_REQUEST_NET,
  calendarQuarter,
  groupIntoQuarters,
  isQuarterStart,
  METRIC_MAP,
  normalizeDomain,
  parseValue,
  specFor,
} from '../src/visible/map.js';

function metric(over: Partial<Metric> & { id: string; name: string }): Metric {
  return {
    frequency: 'quarterly',
    unit: 'CAD',
    portfolio_company_profile_id: 'profile-1',
    company_id: 'fund-1',
    created_at: null,
    ...over,
  };
}

function point(metricId: string, date: string, value: string | null): DataPoint {
  return { id: `${metricId}-${date}`, date, value, metric_id: metricId };
}

describe('normalizeDomain', () => {
  test('strips scheme, www, path and case', () => {
    expect(normalizeDomain('https://www.Profitual.ai/about')).toBe('profitual.ai');
  });

  test('accepts a bare domain, which is how founders usually type it', () => {
    expect(normalizeDomain('profitual.ai')).toBe('profitual.ai');
  });

  test('strips a port', () => {
    expect(normalizeDomain('http://example.com:8080/x')).toBe('example.com');
  });

  // The old pipeline treats a literal 'N/A' as absent; so does this.
  test('treats blank, N/A and a dash as absent', () => {
    for (const raw of ['', '   ', 'N/A', 'n/a', '-', null, undefined]) {
      expect(normalizeDomain(raw)).toBeNull();
    }
  });

  test('rejects a hostname with no dot rather than inventing a domain', () => {
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('Some Company Name')).toBeNull();
  });

  // The whole point of an exact join: a substring match here would silently
  // attach one company's revenue to another's board line.
  test('does not conflate a domain with one that contains it', () => {
    expect(normalizeDomain('https://a.com')).not.toBe(normalizeDomain('https://ba.com'));
  });

  test('keeps subdomains that are not www, because they are different hosts', () => {
    expect(normalizeDomain('https://app.example.com')).toBe('app.example.com');
  });
});

describe('calendarQuarter', () => {
  // Visible dates a point at the START of the period. The 5 Aug 2026
  // submission covers Apr-Jun and arrives dated 2026-04-01 (ADR-006, D-6).
  test('a Q2 submission spans April to June', () => {
    expect(calendarQuarter('2026-04-01')).toEqual({
      periodStart: '2026-04-01',
      periodEnd: '2026-06-30',
    });
  });

  test('covers all four quarters at their boundaries', () => {
    expect(calendarQuarter('2026-01-01').periodEnd).toBe('2026-03-31');
    expect(calendarQuarter('2026-03-31').periodEnd).toBe('2026-03-31');
    expect(calendarQuarter('2026-07-01').periodEnd).toBe('2026-09-30');
    expect(calendarQuarter('2026-12-31').periodEnd).toBe('2026-12-31');
  });

  // Q1 ends 31 March in every year, leap or not; the ends are literals rather
  // than date arithmetic precisely so February can never come into it.
  test('is unaffected by a leap year', () => {
    expect(calendarQuarter('2024-02-29')).toEqual({
      periodStart: '2024-01-01',
      periodEnd: '2024-03-31',
    });
  });

  test('accepts a full ISO timestamp by reading only the date', () => {
    expect(calendarQuarter('2026-05-15T00:00:00Z').periodEnd).toBe('2026-06-30');
  });

  test('throws on input that is not a date rather than guessing a quarter', () => {
    expect(() => calendarQuarter('Q2 2026')).toThrow();
    expect(() => calendarQuarter('2026-13-01')).toThrow();
  });
});

describe('isQuarterStart', () => {
  test('true only on the four quarter starts', () => {
    expect(isQuarterStart('2026-01-01')).toBe(true);
    expect(isQuarterStart('2026-10-01')).toBe(true);
    expect(isQuarterStart('2026-05-01')).toBe(false);
    expect(isQuarterStart('2026-06-30')).toBe(false);
  });
});

describe('parseValue', () => {
  // The string is what reaches Postgres numeric. If this ever returns a number,
  // money has been through binary floating point (ADR-008).
  test('returns the value as a string, untouched', () => {
    const parsed = parseValue('1234567.89', 'money');
    expect(parsed).toEqual({ value: '1234567.89', problem: null });
    expect(typeof parsed.value).toBe('string');
  });

  test('preserves precision a float would lose', () => {
    expect(parseValue('0.1', 'money').value).toBe('0.1');
    expect(parseValue('9007199254740993', 'money').value).toBe('9007199254740993');
  });

  test('negative burn is a legitimate value, not an error', () => {
    expect(parseValue('-15000', 'money')).toEqual({ value: '-15000', problem: null });
  });

  test('blank, empty and the literal "None" are absent, not zero', () => {
    for (const raw of [null, undefined, '', '  ', 'None', 'n/a']) {
      expect(parseValue(raw, 'money')).toEqual({ value: null, problem: 'blank' });
    }
  });

  test('non-numeric text is named rather than coerced', () => {
    expect(parseValue('about 50k', 'money')).toEqual({ value: null, problem: 'not-a-number' });
  });

  // FTE means full-time EQUIVALENT. Soricimed reports 3.5 every quarter, and it
  // means three full-timers and a half-timer -- a measurement, not a typo.
  // Rounding it would move a mandate number on the company's behalf.
  test('a fractional FTE is stored exactly as reported', () => {
    expect(parseValue('3.5', 'fte')).toEqual({ value: '3.5', problem: null });
    expect(parseValue('59.3', 'fte')).toEqual({ value: '59.3', problem: null });
    expect(parseValue('12.0', 'fte')).toEqual({ value: '12.0', problem: null });
    expect(parseValue('0', 'fte')).toEqual({ value: '0', problem: null });
  });

  // `count` is now only women_csuite / csuite_size, which count people. A
  // fraction there is an error rather than a measurement.
  test('a fractional count is still refused, not rounded', () => {
    expect(parseValue('12.5', 'count')).toEqual({ value: null, problem: 'fractional-count' });
    expect(parseValue('12', 'count')).toEqual({ value: '12', problem: null });
    expect(parseValue('12.5', 'months').value).toBe('12.5');
  });

  // Visible formats every number as a float string, so a count of twelve
  // arrives as "12.0". Postgres rejects that for an int column outright -- this
  // took the whole first sync run down when fte was still an int.
  test('an integral count is spelled as an integer for an int column', () => {
    expect(parseValue('12.0', 'count')).toEqual({ value: '12', problem: null });
    expect(parseValue('12.00', 'count')).toEqual({ value: '12', problem: null });
    expect(parseValue('0.0', 'count')).toEqual({ value: '0', problem: null });
    expect(parseValue('-3.0', 'count')).toEqual({ value: '-3', problem: null });
  });

  // The same "12.0" reaching a numeric column is left exactly as sent: numeric
  // takes it, and rewriting money is not this function's business.
  test('money and percent keep the string Visible sent', () => {
    expect(parseValue('12.0', 'money').value).toBe('12.0');
    expect(parseValue('65.0', 'percent').value).toBe('65.0');
  });
});

describe('METRIC_MAP', () => {
  test('matches the metric names case- and whitespace-insensitively', () => {
    expect(specFor('  Quarterly Revenue  ')?.column).toBe('revenue');
    expect(specFor('QUARTERLY REVENUE')?.column).toBe('revenue');
  });

  test('covers the eight columns Visible supplies today', () => {
    expect(new Set(Object.values(METRIC_MAP).map((s) => s.column))).toEqual(
      new Set([
        'revenue',
        'cash_balance',
        'monthly_burn',
        'fte',
        'fte_nb',
        'runway_months',
        'net_revenue_retention',
        'gross_margins',
      ]),
    );
  });

  // "Net Burn Rate" also exists on all 82 companies and has never once been
  // answered. Mapping it would look harmless and would compete with the two
  // wordings that carry the real series.
  test('the never-answered third burn metric is not mapped', () => {
    expect(specFor('Net Burn Rate')).toBeNull();
    expect(specFor('Monthly Burn Rate')?.column).toBe('monthly_burn');
    expect(specFor('Monthly Net Burn Rate')?.column).toBe('monthly_burn');
  });

  // 864 values from 75 of 82 companies since 2021 Q4. Whole numbers, not
  // fractions: the probe returned "107.0" for 107%.
  test('Net Revenue Retention keeps the reported percent scale', () => {
    expect(specFor('Net Revenue Retention')?.column).toBe('net_revenue_retention');
    expect(parseValue('107.0', 'percent')).toEqual({ value: '107.0', problem: null });
    expect(parseValue('-58.8', 'percent')).toEqual({ value: '-58.8', problem: null });
  });

  test('an unknown metric returns null rather than a nearest neighbour', () => {
    expect(specFor('Revenue')).toBeNull();
    expect(specFor('Employees')).toBeNull();
  });
});

describe('groupIntoQuarters', () => {
  const revenue = metric({ id: 'm-rev', name: 'Quarterly Revenue' });
  const burn = metric({ id: 'm-burn', name: 'Monthly Net Burn Rate', frequency: 'monthly' });
  const fte = metric({ id: 'm-fte', name: 'Full-time Employees', unit: 'number' });
  // Defined on all 82 companies, last answered in 2023, and has no column.
  const yearEnd = metric({ id: 'm-ye', name: 'Year End Revenue', frequency: 'annually' });
  const byId = new Map([revenue, burn, fte, yearEnd].map((m) => [m.id, m]));

  // The live shape: a fractional FTE reaches the row intact rather than being
  // dropped, which is what left Soricimed reading "JOBS 0 / 0" when it reports
  // 3.5 (fixed 13 Aug 2026).
  test('a fractional FTE survives grouping', () => {
    const { rows } = groupIntoQuarters([point('m-fte', '2026-04-01', '3.5')], byId);
    expect(rows[0]!.cells).toEqual([
      { column: 'fte', value: '3.5', sourceDate: '2026-04-01', frequency: 'quarterly', metricName: 'Full-time Employees' },
    ]);
  });

  test('one row per quarter, carrying every column reported in it', () => {
    const { rows } = groupIntoQuarters(
      [
        point('m-rev', '2026-04-01', '250000'),
        point('m-fte', '2026-04-01', '14'),
        point('m-rev', '2026-01-01', '210000'),
      ],
      byId,
    );
    expect(rows.map((r) => r.periodEnd)).toEqual(['2026-03-31', '2026-06-30']);
    expect(rows[1]!.cells.map((c) => [c.column, c.value])).toEqual([
      ['revenue', '250000'],
      ['fte', '14'],
    ]);
  });

  // company_kpi is keyed on (company_id, period_end), so three monthly burn
  // readings must reduce to one. The closing month is what a founder quotes and
  // the reading nearest the period end; an average is a number nobody reported.
  test('a monthly metric collapses to the quarter, keeping the latest month', () => {
    const { rows } = groupIntoQuarters(
      [
        point('m-burn', '2026-04-01', '50000'),
        point('m-burn', '2026-06-01', '61000'),
        point('m-burn', '2026-05-01', '55000'),
      ],
      byId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cells).toEqual([
      {
        column: 'monthly_burn',
        value: '61000',
        sourceDate: '2026-06-01',
        frequency: 'monthly',
        metricName: 'Monthly Net Burn Rate',
      },
    ]);
  });

  // Year End Revenue is defined on all 82 companies and is annual. It must not
  // be quietly attached to a column that looks close enough -- an annual figure
  // landing in quarterly `revenue` would multiply a board total roughly fourfold.
  test('an unmapped metric is ignored, not stored anywhere', () => {
    const { rows } = groupIntoQuarters([point('m-ye', '2023-01-01', '1500000')], byId);
    expect(rows).toEqual([]);
  });

  test('a blank value produces no cell and no complaint', () => {
    const { rows, problems } = groupIntoQuarters([point('m-rev', '2026-04-01', null)], byId);
    expect(rows).toEqual([]);
    expect(problems).toEqual([]);
  });

  test('a non-numeric value is reported with its metric and date', () => {
    const { rows, problems } = groupIntoQuarters([point('m-rev', '2026-04-01', 'TBD')], byId);
    expect(rows).toEqual([]);
    expect(problems).toEqual([
      { metricName: 'Quarterly Revenue', sourceDate: '2026-04-01', detail: expect.stringContaining('not-a-number') },
    ]);
  });

  // Absorbed rather than dropped -- the figure is real -- but named, because a
  // quarterly metric dated mid-quarter means the cadence and the data disagree.
  test('a quarterly metric dated off the boundary lands in its quarter and is flagged', () => {
    const { rows, problems } = groupIntoQuarters([point('m-rev', '2026-05-15', '99')], byId);
    expect(rows[0]!.periodEnd).toBe('2026-06-30');
    expect(problems[0]!.detail).toContain('off a quarter boundary');
  });

  test('a point whose metric is unknown is skipped without throwing', () => {
    expect(groupIntoQuarters([point('m-ghost', '2026-04-01', '1')], byId).rows).toEqual([]);
  });
});

/**
 * The burn rename at 2025 Q3. One series, two Visible metric names, and the
 * only reason company_kpi.request_version is not decoration.
 */
describe('the burn splice', () => {
  const oldBurn = metric({ id: 'm-old', name: 'Monthly Burn Rate' });
  const newBurn = metric({ id: 'm-new', name: 'Monthly Net Burn Rate' });
  const revenue = metric({ id: 'm-rev', name: 'Quarterly Revenue' });
  const byId = new Map([oldBurn, newBurn, revenue].map((m) => [m.id, m]));

  test('both wordings land in one continuous monthly_burn series', () => {
    const { rows } = groupIntoQuarters(
      [
        point('m-old', '2021-04-01', '25000'),
        point('m-old', '2025-04-01', '90000'),
        point('m-new', '2025-10-01', '61000'),
        point('m-new', '2026-04-01', '58000'),
      ],
      byId,
    );
    expect(rows.map((r) => [r.periodEnd, r.cells[0]!.value])).toEqual([
      ['2021-06-30', '25000'],
      ['2025-06-30', '90000'],
      ['2025-12-31', '61000'],
      ['2026-06-30', '58000'],
    ]);
  });

  test('each row records which wording produced it', () => {
    const { rows } = groupIntoQuarters(
      [point('m-old', '2025-04-01', '90000'), point('m-new', '2025-10-01', '61000')],
      byId,
    );
    expect(rows.map((r) => r.requestVersion)).toEqual([BURN_REQUEST_BASELINE, BURN_REQUEST_NET]);
  });

  // 2025 Q3 is the changeover quarter: one company answered the new wording
  // while 55 were still on the old, both dated 2025-07-01. Array order must not
  // decide which is stored.
  test('the current wording wins the same-date overlap, whichever order it arrives in', () => {
    for (const order of [
      [point('m-old', '2025-07-01', '90000'), point('m-new', '2025-07-01', '61000')],
      [point('m-new', '2025-07-01', '61000'), point('m-old', '2025-07-01', '90000')],
    ]) {
      const { rows } = groupIntoQuarters(order, byId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.cells[0]!.value).toBe('61000');
      expect(rows[0]!.requestVersion).toBe(BURN_REQUEST_NET);
    }
  });

  // A company that skipped the burn question still needs a version, and it must
  // fall on the right side of the seam.
  test('a row with no burn answer takes its version from the period', () => {
    const { rows } = groupIntoQuarters(
      [point('m-rev', '2024-01-01', '100'), point('m-rev', '2026-01-01', '200')],
      byId,
    );
    expect(rows.map((r) => r.requestVersion)).toEqual([BURN_REQUEST_BASELINE, BURN_REQUEST_NET]);
  });

  test('the changeover quarter itself counts as the new wording', () => {
    const { rows } = groupIntoQuarters([point('m-rev', '2025-07-01', '100')], byId);
    expect(rows[0]!.periodEnd).toBe('2025-09-30');
    expect(rows[0]!.requestVersion).toBe(BURN_REQUEST_NET);
  });
});
