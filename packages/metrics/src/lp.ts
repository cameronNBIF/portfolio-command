/**
 * Strategic LP positions, ported verbatim from vc-toolkit.html :954-975
 * (ADR-013).
 *
 * NEVER blended with the direct portfolio. Multiples here are on CALLED
 * capital per standard LP convention; direct MOIC is on invested cost. That
 * separation is a settled product decision.
 */
import type { FundInvestment, PortfolioExport } from '@portfolio-command/contract';

import { xirr, type Cashflow } from './xirr.js';

export interface LpMetrics {
  n: number;
  committed: number;
  called: number;
  unfunded: number;
  distributions: number;
  nav: number;
  tvpi: number | null;
  dpi: number | null;
  rvpi: number | null;
  irr: number | null;
  coInvests: number;
  referrals: number;
  toDirect: number;
  womenGPs: number;
}

/** Total value to paid-in, on called capital (:954). */
export function fiTvpi(f: FundInvestment): number | null {
  return f.called > 0 ? (f.nav + f.distributions) / f.called : null;
}

/** Distributions to paid-in, on called capital (:955). */
export function fiDpi(f: FundInvestment): number | null {
  return f.called > 0 ? f.distributions / f.called : null;
}

/**
 * Position IRR over its own call and distribution flows plus current NAV as
 * the terminal value (:956-961).
 *
 * `asOf` dates that terminal value; the prototype read the clock (ADR-021).
 */
export function fiIrr(f: FundInvestment, asOf: string): number | null {
  const flows: Cashflow[] = (f.cashflows || []).map((c) => ({ date: c.date, amt: c.amount }));
  if (!flows.length) return null;
  flows.push({ date: asOf, amt: f.nav });
  return xirr(flows);
}

/**
 * Pooled figures across every LP position (:962-975).
 *
 * NOTE on the label: `irr` is displayed as "Net IRR" on the Funds tab, with no
 * fee drag subtracted. That is correct rather than an oversight -- LP NAVs
 * arrive already net of the manager's fees, so the platform's own `feeDragPct`
 * does not apply here. See INHERITED-COERCIONS.md, "Examined and found sound".
 */
export function lpMetrics(db: PortfolioExport, opts: { asOf: string }): LpMetrics {
  const fs = db.fundInvestments || [];

  const committed = fs.reduce((s, f) => s + f.committed, 0);
  const called = fs.reduce((s, f) => s + f.called, 0);
  const distributions = fs.reduce((s, f) => s + f.distributions, 0);
  const nav = fs.reduce((s, f) => s + f.nav, 0);

  const flows: Cashflow[] = [];
  fs.forEach((f) => (f.cashflows || []).forEach((c) => flows.push({ date: c.date, amt: c.amount })));
  flows.push({ date: opts.asOf, amt: nav });

  return {
    n: fs.length,
    committed,
    called,
    unfunded: committed - called,
    distributions,
    nav,
    tvpi: called > 0 ? (nav + distributions) / called : null,
    dpi: called > 0 ? distributions / called : null,
    rvpi: called > 0 ? nav / called : null,
    // INHERITED: this guard duplicates one xirr already performs.
    irr: flows.length > 1 ? xirr(flows) : null,
    coInvests: fs.reduce((s, f) => s + (f.coInvestsDone || 0), 0),
    referrals: fs.reduce((s, f) => s + (f.referrals || 0), 0),
    toDirect: fs.reduce((s, f) => s + (f.capitalToDirect || 0), 0),
    womenGPs: fs.filter((f) => f.womenSeniorGP).length,
  };
}

/** The prototype's name for `lpMetrics`. Kept as an alias so the port is greppable. */
export { lpMetrics as fiMetrics };
