/**
 * Named selectors layered ON TOP of the `fundMetrics` bag (ADR-022), plus the
 * one sanctioned departure from the verbatim port.
 *
 * Nothing here recomputes anything `fundMetrics` already computed. These read
 * the bag. The moment a selector starts doing arithmetic of its own, the
 * definition has forked, which is what returning a single bag exists to
 * prevent.
 */
import type { Company, PortfolioExport } from '@portfolio-command/contract';

import type { FundMetrics, MetricOptions } from './fund.js';

/** Third-party capital per our dollar, and the attracted total behind it. */
export function leverage(m: FundMetrics): { ratio: number | null; capitalAttracted: number; roundsTotal: number } {
  return { ratio: m.leverage, capitalAttracted: m.capitalAttracted, roundsTotal: m.roundsTotal };
}

/** NB capital invested beside ours, and the outside capital net of it. */
export function nbCoInvestment(m: FundMetrics): { nbCapital: number; outsideCapital: number } {
  return { nbCapital: m.nbCapital, outsideCapital: m.outsideCapital };
}

/**
 * FMV growth off the quarterly NAV history.
 *
 * Two of every four quarters legitimately show near-zero growth and then a
 * step, because marks are semi-annual and carried forward between cycles
 * (ADR-007, D-3). That is correct behaviour and must be labelled on screen,
 * never smoothed.
 */
export function fmvGrowth(m: FundMetrics): { qoq: number | null; yoy: number | null; organicYoY: number | null } {
  return { qoq: m.fmvQoQ, yoy: m.fmvYoY, organicYoY: m.organicYoY };
}

/** The three multiples, together, since they are always read together. */
export function multiples(m: FundMetrics): { tvpi: number | null; dpi: number | null; rvpi: number | null } {
  return { tvpi: m.tvpi, dpi: m.dpi, rvpi: m.rvpi };
}

/**
 * Gross and net IRR. Net is gross less a fee-drag ESTIMATE and carries that
 * label wherever it appears (ADR-013).
 */
export function irr(m: FundMetrics): { gross: number | null; netEstimate: number | null } {
  return { gross: m.grossIRR, netEstimate: m.netIRR };
}

/** Jobs. INHERITED scope: counts exited companies. See INHERITED-COERCIONS.md §1. */
export function jobs(m: FundMetrics): { total: number; inNb: number; atEntry: number; nbSharePct: number | null } {
  return {
    total: m.fte,
    inNb: m.fteNB,
    atEntry: m.fteAtEntry,
    nbSharePct: m.fte > 0 ? (m.fteNB / m.fte) * 100 : null,
  };
}

/** Same-store revenue growth requires two KPI periods; companies with one are excluded. */
export function revenue(m: FundMetrics): { total: number; sameStoreQoQ: number | null } {
  return { total: m.revenue, sameStoreQoQ: m.revQoQ };
}

export interface DiversityCoverage {
  /** Active companies reporting at least one woman in the C-suite. */
  womenCos: number;
  /** Percentage of REPORTING companies, not of all companies. Null when nobody has reported. */
  womenCosPct: number | null;
  womenExecs: number;
  cSuiteTotal: number;
  /** How many active companies reported the field. */
  reported: number;
  /** How many active companies there are. */
  total: number;
  /** `reported / total` as a percentage. Null when there are no active companies. */
  coveragePct: number | null;
}

/**
 * Diversity with coverage -- THE ONE SANCTIONED DEPARTURE from the verbatim
 * port (D-5, ADR-010, ADR-014).
 *
 * `fundMetrics` reproduces the prototype: `(c.womenCSuite || 0) > 0` counts a
 * company that has NOT REPORTED as a company with no women in its C-suite.
 * Reporting "0% of companies have women in the C-suite" when the truth is "we
 * have not asked" is a materially worse error than reporting nothing, and the
 * fields are not yet collected at all (ADR-010, O-4).
 *
 * This function excludes non-reporters from the denominator and returns the
 * coverage alongside, so the tile can say "reported by n of m companies". NULL
 * NEVER RENDERS AS ZERO.
 *
 * NOT golden-mastered, and it cannot be: every company in the reference
 * dataset carries numeric values, so this and `fundMetrics` produce identical
 * output there. It is covered by constructed tests instead (ADR-022).
 */
export function diversityWithCoverage(db: PortfolioExport, opts: Pick<MetricOptions, 'includeAccelerator'>): DiversityCoverage {
  const { includeAccelerator = true } = opts;
  const cs: Company[] = includeAccelerator ? db.companies : db.companies.filter((c) => !c.isAccelerator);
  const active = cs.filter((c) => !c.exited);

  const reporting = active.filter((c) => c.womenCSuite != null);
  const withCSuite = active.filter((c) => c.cSuiteSize != null);

  return {
    womenCos: reporting.filter((c) => (c.womenCSuite as number) > 0).length,
    womenCosPct: reporting.length
      ? (reporting.filter((c) => (c.womenCSuite as number) > 0).length / reporting.length) * 100
      : null,
    womenExecs: reporting.reduce((s, c) => s + (c.womenCSuite as number), 0),
    cSuiteTotal: withCSuite.reduce((s, c) => s + (c.cSuiteSize as number), 0),
    reported: reporting.length,
    total: active.length,
    coveragePct: active.length ? (reporting.length / active.length) * 100 : null,
  };
}
