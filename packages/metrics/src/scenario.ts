/**
 * Exit waterfall and dilution scenarios, ported verbatim from
 * vc-toolkit.html :1608-1637 (ADR-013).
 *
 * MODEL SIMPLIFICATIONS, retained for phase 1 and stated on screen (ADR-016):
 * a 1x non-participating preference, a pari passu stack, the option pool
 * carved pre-money, and no ratchets. This is directional scenario work and is
 * NOT suitable for legal-grade proceeds calculation. The on-screen caveat is
 * what makes that distinction honest and must not be removed.
 */
import type { Company } from '@portfolio-command/contract';

export interface ScenarioInputs {
  /** New money raised, $M. */
  raise: number;
  /** Pre-money valuation, $M. */
  pre: number;
  /** Option pool, percentage points, carved pre-money. */
  pool: number;
  participate: boolean;
  /** Our follow-on, $M. Null means take our pro-rata. */
  partAmt: number | null;
  /** Total liquidation preference ahead of and beside us, $M. */
  totalPref: number;
  /** Years to exit, for the IRR approximation. */
  yrs: number;
  bear: number;
  base: number;
  bull: number;
}

export interface ScenarioCase {
  /** Exit enterprise value, $M. */
  E: number;
  /** Our proceeds, $M. */
  p: number;
  /** Multiple on total invested. */
  mo: number;
  /** Annualised, percentage points. Null when the multiple is zero or non-positive years. */
  irr: number | null;
}

export interface ScenarioResult {
  post: number;
  newInvPct: number;
  poolPct: number;
  dilutionFactor: number;
  partAmt: number;
  ownAfter: number;
  investedTotal: number;
  ourPref: number;
  totalPref: number;
  /** Our proceeds at an exit value. Kept as a function -- it is the waterfall curve. */
  proceedsAt(exitValue: number): number;
  cases: [string, ScenarioCase][];
}

/**
 * Default scenario inputs for a company (:1608-1616).
 *
 * INHERITED: enterprise value falls back to the last round's post-money and
 * then to a magic 50 when the company has neither ownership nor a post-money.
 * Every derived input is rounded to a whole number. On the reference dataset
 * the fallback is exercised by exactly the six exited companies.
 * See INHERITED-COERCIONS.md §12.
 */
export function scenarioDefaults(c: Company): ScenarioInputs {
  const ev = c.ownershipPct > 0 ? c.fmv / (c.ownershipPct / 100) : c.rounds.at(-1)?.postMoney || 50;
  return {
    raise: +Math.max(5, ev * 0.2).toFixed(0),
    pre: +(ev * 1.2).toFixed(0),
    pool: 10,
    participate: c.proRata,
    partAmt: null,
    totalPref: +(ev * 0.35).toFixed(0),
    yrs: 4,
    bear: +(ev * 0.5).toFixed(0),
    base: +(ev * 1.5).toFixed(0),
    bull: +(ev * 3).toFixed(0),
  };
}

/**
 * Run one dilution and waterfall scenario (:1617-1637).
 *
 * INHERITED, two things. `dilutionFactor` can go negative if the raise and
 * pool together exceed the post-money. And the case multiple returns 0 rather
 * than null when there is no invested total -- the opposite convention to
 * `moic()`, so it renders "0.00x" where moic renders "-".
 * See INHERITED-COERCIONS.md §11 and §12.
 */
export function runScenario(c: Company, s: ScenarioInputs): ScenarioResult {
  const post = s.pre + s.raise;
  const newInvPct = (s.raise / post) * 100;
  const poolPct = s.pool;
  const dilutionFactor = 1 - newInvPct / 100 - poolPct / 100;

  const partAmt = s.participate ? (s.partAmt != null ? s.partAmt : +((c.ownershipPct / 100) * s.raise).toFixed(2)) : 0;
  const ownAfter = c.ownershipPct * dilutionFactor + (partAmt / post) * 100;
  const investedTotal = c.invested + partAmt;

  // 1x non-participating assumption (ADR-016).
  const ourPref = investedTotal;
  // The stack grows by the new round.
  const totalPref = Math.max(s.totalPref + partAmt + (s.raise - partAmt), ourPref);

  const proceedsAt = (E: number): number => {
    if (E <= 0) return 0;
    // Pari passu preference distribution.
    if (E <= totalPref) return E * (ourPref / totalPref);
    // The greater of the preference or the converted position.
    return Math.max(ourPref, (ownAfter / 100) * E);
  };

  const mk = (E: number): ScenarioCase => {
    const p = proceedsAt(E);
    const mo = investedTotal > 0 ? p / investedTotal : 0;
    const irr = s.yrs > 0 && mo > 0 ? (Math.pow(mo, 1 / s.yrs) - 1) * 100 : null;
    return { E, p, mo, irr };
  };

  return {
    post,
    newInvPct,
    poolPct,
    dilutionFactor,
    partAmt,
    ownAfter,
    investedTotal,
    ourPref,
    totalPref,
    proceedsAt,
    cases: [
      ['Bear', mk(s.bear)],
      ['Base', mk(s.base)],
      ['Bull', mk(s.bull)],
    ],
  };
}
