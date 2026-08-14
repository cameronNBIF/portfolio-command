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

  /**
   * A company with NO KPI history has not reported, whatever its scalar says.
   *
   * This second test is not redundant, and real data is what proved it. The
   * diversity scalars are serialised from the latest KPI row (ADR-010); where
   * there is no row the adapter emits 0 rather than null, because the reference
   * fixture carries a literal 0 on its six KPI-less companies and the ADR-001
   * round trip has to reproduce it. So `womenCSuite === 0` is genuinely
   * ambiguous — it means "reported none" for a company with history and "never
   * asked" for one without.
   *
   * On the Affinity roster every company is KPI-less until A5 brings Visible
   * in, and without this the tile read "0% of companies have women in the
   * C-suite, reported by 82 of 82" — the precise false statement D-5 exists to
   * prevent, on a board-facing screen.
   */
  const hasReported = (c: Company) => c.kpis.length > 0;
  const reporting = active.filter((c) => hasReported(c) && c.womenCSuite != null);
  const withCSuite = active.filter((c) => hasReported(c) && c.cSuiteSize != null);

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

/**
 * Whether the fund has a stated capital basis at all.
 *
 * `fundMetrics.dryPowder` is `capitalBase - netDeployed` for an evergreen fund
 * and `committed - netDeployed` for a closed-end one. That definition is frozen
 * (ADR-013) and is correct; what it cannot express is the difference between a
 * capital base of zero and no capital base on record. With neither set --
 * which is the state A4 deliberately left the fund row in, because a capital
 * base nobody supplied would be a fabricated board number -- the subtraction
 * runs anyway and the dashboard reads "dry powder $-47.2M".
 *
 * That is the D-5 error class exactly: a screen stating a precise falsehood
 * where the truth is "not recorded". A6 surfaced it because A6 is the first
 * dataset with real deployment and no capital base; on the reference fixture
 * both were populated and the gap could not appear.
 *
 * So this sits BESIDE the frozen definition rather than changing it, on the
 * `diversityWithCoverage` precedent. The metric still returns its number; the
 * view asks this first and renders "-" when the answer is no.
 */
export function hasCapitalBasis(db: PortfolioExport): boolean {
  const basis = db.fund.style === 'evergreen' ? db.fund.capitalBase : db.fund.committed;
  return typeof basis === 'number' && basis > 0;
}
