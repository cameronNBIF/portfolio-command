/**
 * XIRR by bisection, ported verbatim from vc-toolkit.html :643-652 (ADR-013).
 *
 * DO NOT substitute Newton-Raphson or a library. The bracket, the convergence
 * criterion, the iteration count and the null-on-no-sign-change behaviour are
 * all frozen. This is not a placeholder awaiting a better numeric method --
 * it is the definition of every IRR the board sees.
 */

export interface Cashflow {
  /** `YYYY-MM-DD`. */
  date: string;
  /** $M. Negative is an outflow. */
  amt: number;
}

/** Days per year used to convert the date spread to a fraction. ACT/365.25. */
const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

/** Bracket ends: -95% to +1000%. */
const LO = -0.95;
const HI = 10;

/** Bisection steps. Inherited verbatim -- see the note in the body. */
const ITERATIONS = 120;

/**
 * Annualised internal rate of return over dated cashflows, in PERCENTAGE
 * POINTS (17.5 means 17.5%, not 0.175).
 *
 * Returns null when there are fewer than two flows, or when the NPV does not
 * change sign across the bracket -- the prototype's "no sign change" case.
 * There is no multiple-root handling; a series with several sign changes
 * converges to whichever root bisection reaches first.
 */
export function xirr(flows: Cashflow[]): number | null {
  if (flows.length < 2) return null;

  const times = flows.map((f) => new Date(f.date).getTime());
  const t0 = Math.min(...times);
  const years = times.map((t) => (t - t0) / MS_PER_YEAR);

  const npv = (rate: number): number => {
    let total = 0;
    for (let i = 0; i < flows.length; i++) {
      total += flows[i]!.amt / Math.pow(1 + rate, years[i]!);
    }
    return total;
  };

  let lo = LO;
  let hi = HI;

  // INHERITED: strictly `> 0`, so a root sitting exactly on a bracket endpoint
  // proceeds rather than bailing out. See INHERITED-COERCIONS.md §12.
  if (npv(lo) * npv(hi) > 0) return null;

  // INHERITED: 120 iterations over a bracket of width 10.95 converges to
  // roughly 1e-35 -- far below double precision, so about 70 of these do
  // nothing. Kept because the iteration count is part of the frozen
  // definition, and because changing it could move a final digit.
  for (let i = 0; i < ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid;
    else lo = mid;
  }

  return ((lo + hi) / 2) * 100;
}
