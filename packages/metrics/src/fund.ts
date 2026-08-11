/**
 * Fund-level metrics: the `fundMetrics` bag, ported verbatim from
 * vc-toolkit.html :588-642 (ADR-013).
 *
 * ONE FUNCTION RETURNING ONE BAG, deliberately (ADR-022). Its outputs share
 * intermediates -- `paidIn` feeds three multiples, `roundsTotal` and
 * `oursInRounds` feed both leverage and `capitalAttracted` -- and splitting
 * them into independent functions would recompute those intermediates in ways
 * that are individually defensible and collectively a different
 * implementation. Named selectors are layered on top in `selectors.ts`.
 */
import type { Company, PortfolioExport } from '@portfolio-command/contract';

import { xirr, type Cashflow } from './xirr.js';

export interface MetricOptions {
  /**
   * `YYYY-MM-DD`. Dates the terminal NAV in the IRR cashflow series.
   *
   * REQUIRED, with no default. The prototype read `new Date()` here, which made
   * two consecutive calls on identical data disagree and the figure drift about
   * a percentage point per quarter. A default would silently reintroduce
   * "today" -- the exact failure being removed (ADR-021).
   */
  asOf: string;
  /**
   * Include accelerator positions in fund-wide figures. Default true, which is
   * the prototype's only behaviour and the only golden-mastered path (ADR-013,
   * ADR-022).
   *
   * When false, companies flagged `isAccelerator` are excluded from every
   * company-scoped figure below. FMV growth is UNAFFECTED either way: it reads
   * `fund.navHistory`, which has no company dimension to filter on.
   */
  includeAccelerator?: boolean;
}

export interface FundMetrics {
  invested: number;
  fmv: number;
  realized: number;
  distributions: number;
  tvpi: number | null;
  dpi: number | null;
  rvpi: number | null;
  grossIRR: number | null;
  netIRR: number | null;
  netDeployed: number;
  dryPowder: number;
  leverage: number | null;
  capitalAttracted: number;
  roundsTotal: number;
  nbCapital: number;
  outsideCapital: number;
  fmvQoQ: number | null;
  fmvYoY: number | null;
  organicYoY: number | null;
  fte: number;
  fteAtEntry: number;
  fteNB: number;
  womenCos: number;
  womenCosPct: number | null;
  womenExecs: number;
  cSuiteTotal: number;
  revenue: number;
  revQoQ: number | null;
  nActive: number;
  nExited: number;
  unrealizedGL: number;
}

export function isEvergreen(db: PortfolioExport): boolean {
  return db.fund.style === 'evergreen';
}

export function fundMetrics(db: PortfolioExport, opts: MetricOptions): FundMetrics {
  const { asOf, includeAccelerator = true } = opts;

  // `cs` is ALL companies, exited included. `actC` below is active only. The
  // prototype mixes the two and the port reproduces the mix exactly; the map
  // of which output uses which is in INHERITED-COERCIONS.md §1.
  const cs: Company[] = includeAccelerator ? db.companies : db.companies.filter((c) => !c.isAccelerator);

  const invested = cs.reduce((s, c) => s + c.invested, 0);
  const fmv = cs.reduce((s, c) => s + c.fmv, 0);
  const realized = cs.reduce((s, c) => s + c.realized, 0);
  const distributions = db.fund.distributions.reduce((s, d) => s + d.amount, 0);

  // Paid-in capital proxied by invested cost. A known simplification, kept
  // deliberately and labelled on screen (ADR-013).
  const paidIn = invested;
  const tvpi = paidIn > 0 ? (fmv + distributions) / paidIn : null;
  const dpi = paidIn > 0 ? distributions / paidIn : null;
  const rvpi = paidIn > 0 ? fmv / paidIn : null;

  // Gross IRR from dated cashflows: round outflows, fund distributions, and
  // current NAV as the terminal inflow dated `asOf`.
  const flows: Cashflow[] = [];
  cs.forEach((c) => c.rounds.forEach((r) => flows.push({ date: r.date, amt: -r.invested })));
  db.fund.distributions.forEach((d) => flows.push({ date: d.date, amt: d.amount }));
  flows.push({ date: asOf, amt: fmv });
  const grossIRR = xirr(flows);

  // Both in percentage points. Net IRR is gross less a fee-drag estimate and
  // is labelled an estimate wherever it appears (ADR-013).
  const netIRR = grossIRR != null ? grossIRR - db.fund.feeDragPct : null;

  // Evergreen: realized proceeds recycle into the capital base.
  const netDeployed = invested - distributions;
  const dryPowder = (isEvergreen(db) ? db.fund.capitalBase || 0 : db.fund.committed || 0) - netDeployed;

  // Leverage: third-party capital per our dollar, over rounds we joined.
  //
  // THE EXCLUSION IS THE DEFINITION (ADR-012, ADR-013): a round with a missing
  // or invalid total is dropped, never imputed. This is why the contract
  // carries rounds unfiltered (ADR-021, ADR-023) -- the predicate lives here,
  // once, in one language, under test.
  //
  // INHERITED: the truthiness test on `roundTotal` drops a literal 0 before the
  // `>=` comparison sees it. See INHERITED-COERCIONS.md §12.
  let roundsTotal = 0;
  let oursInRounds = 0;
  cs.forEach((c) =>
    c.rounds.forEach((r) => {
      if (r.roundTotal && r.roundTotal >= r.invested) {
        roundsTotal += r.roundTotal;
        oursInRounds += r.invested;
      }
    }),
  );
  const leverage = oursInRounds > 0 ? (roundsTotal - oursInRounds) / oursInRounds : null;
  const capitalAttracted = roundsTotal - oursInRounds;

  // NB co-investment: of the third-party capital, how much is NB-based.
  //
  // INHERITED, and the sharpest edge in this file: this sums `nbOther` over
  // EVERY round -- including rounds the leverage predicate above just excluded
  // -- and does NOT cap it at that round's third-party capital. The dashboard
  // chart and `v_round_leverage` both do cap and both do exclude, so three
  // implementations of this figure disagree. The `Math.max(0, ...)` clamp
  // below exists precisely because this sum can overshoot. The metrics package
  // reproduces fundMetrics. See INHERITED-COERCIONS.md §2.
  let nbCapital = 0;
  cs.forEach((c) =>
    c.rounds.forEach((r) => {
      if (r.nbOther) nbCapital += r.nbOther;
    }),
  );
  const outsideCapital = Math.max(0, capitalAttracted - nbCapital);

  // FMV growth from the quarterly NAV history.
  //
  // INHERITED: POSITIONAL, not date-keyed. "Year over year" means five rows
  // back, so a gap in the series silently redefines the comparison.
  // See INHERITED-COERCIONS.md §8.
  const nh = db.fund.navHistory || [];
  const nhLast = nh[nh.length - 1];
  const nhPrev = nh[nh.length - 2];
  const nhYoY = nh[nh.length - 5];
  const fmvQoQ = nhLast && nhPrev && nhPrev.nav > 0 ? (nhLast.nav / nhPrev.nav - 1) * 100 : null;
  const fmvYoY = nhLast && nhYoY && nhYoY.nav > 0 ? (nhLast.nav / nhYoY.nav - 1) * 100 : null;
  // Value creation net of new capital deployed.
  const organicYoY = nhLast && nhYoY ? nhLast.nav - nhYoY.nav - (nhLast.cost - nhYoY.cost) : null;

  // Employment. INHERITED: scoped to ALL companies, exited included -- four
  // lines above a diversity block scoped to active only.
  const fte = cs.reduce((s, c) => s + (c.fte || 0), 0);
  const fteAtEntry = cs.reduce((s, c) => s + (c.fteAtEntry || 0), 0);
  const fteNB = cs.reduce((s, c) => s + (c.fteNB || 0), 0);

  const actC = cs.filter((c) => !c.exited);

  // Diversity. INHERITED: `|| 0` makes a company that has NOT REPORTED
  // indistinguishable from one with no women in its C-suite, and contributes 0
  // to the exec-seat denominator. This is exactly what D-5 (ADR-010) reverses;
  // the departure is not applied here because this function is the frozen
  // port. See INHERITED-COERCIONS.md §4 and `diversityWithCoverage` in
  // selectors.ts for the D-5 treatment.
  const womenCos = actC.filter((c) => (c.womenCSuite || 0) > 0).length;
  const womenCosPct = actC.length ? (womenCos / actC.length) * 100 : null;
  const womenExecs = actC.reduce((s, c) => s + (c.womenCSuite || 0), 0);
  const cSuiteTotal = actC.reduce((s, c) => s + (c.cSuiteSize || 0), 0);

  // Underlying revenue, and same-store growth over companies with 2+ periods.
  //
  // INHERITED: the aggregate guards with `|| 0` while the same-store pair one
  // line below does not, so a KPI row missing `revenue` yields NaN there.
  // Revenue is the period actual, displayed as reported (D-2).
  const revenue = actC.reduce((s, c) => s + ((c.kpis && c.kpis[0] && c.kpis[0].revenue) || 0), 0);
  let revNow = 0;
  let revPrev = 0;
  actC.forEach((c) => {
    if (c.kpis && c.kpis.length > 1) {
      revNow += c.kpis[0]!.revenue;
      revPrev += c.kpis[1]!.revenue;
    }
  });
  const revQoQ = revPrev > 0 ? (revNow / revPrev - 1) * 100 : null;

  return {
    invested,
    fmv,
    realized,
    distributions,
    tvpi,
    dpi,
    rvpi,
    grossIRR,
    netIRR,
    netDeployed,
    dryPowder,
    leverage,
    capitalAttracted,
    roundsTotal,
    nbCapital,
    outsideCapital,
    fmvQoQ,
    fmvYoY,
    organicYoY,
    fte,
    fteAtEntry,
    fteNB,
    womenCos,
    womenCosPct,
    womenExecs,
    cSuiteTotal,
    revenue,
    revQoQ,
    nActive: cs.filter((c) => !c.exited).length,
    nExited: cs.filter((c) => c.exited).length,
    // INHERITED: mixes scopes across the subtraction -- `fmv` over all
    // companies, `invested` over active only. See INHERITED-COERCIONS.md §1.
    unrealizedGL: fmv - cs.filter((c) => !c.exited).reduce((s, c) => s + c.invested, 0),
  };
}
