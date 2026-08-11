/**
 * Company-level metrics, ported verbatim from vc-toolkit.html (ADR-013).
 */
import type { Company } from '@portfolio-command/contract';

/**
 * Gross multiple on invested cost (:584).
 *
 * Null when there is no cost basis. INHERITED: `fmv` and `realized` are not
 * guarded, so an absent field yields NaN rather than null -- and `fmt.x(NaN)`
 * renders "-", identical on screen to the no-cost-basis case. Note also that a
 * total write-off returns exactly 0, which renders "0.00x", not "-".
 * See INHERITED-COERCIONS.md §4.
 */
export function moic(c: Company): number | null {
  const cost = c.invested;
  return cost > 0 ? (c.fmv + c.realized) / cost : null;
}

/** INHERITED: truthiness on `exited`, not `=== true` (:585). */
export function activeCompanies(companies: Company[]): Company[] {
  return companies.filter((c) => !c.exited);
}

/**
 * Policy-suggested follow-on reserve, $M (:1565-1570).
 *
 * Excluded entirely: exited positions, companies without pro-rata rights, and
 * anything rated red. Otherwise 0.8x the initial cheque for green, 0.5x for
 * yellow.
 *
 * INHERITED, two things. `rounds[0]` is taken as the FIRST round
 * chronologically and nothing sorts it -- the opposite convention to `kpis[0]`,
 * which is read as the most recent. And the result is rounded to one decimal
 * INSIDE the metric, so the portfolio total is a sum of rounded values rather
 * than a rounded sum ($128.9M against $129.09M on the reference dataset).
 * See INHERITED-COERCIONS.md §3 and §10.
 */
export function suggestedReserve(c: Company): number {
  if (c.exited || !c.proRata || c.health === 'red') return 0;
  const mult = c.health === 'green' ? 0.8 : 0.5;
  const initial = c.rounds.length ? c.rounds[0]!.invested : c.invested;
  return +(initial * mult).toFixed(1);
}

/**
 * Total gain/loss including realizations, $M, as the Portfolio table shows it
 * (:845, :861).
 *
 * Distinct from `unrealizedGain` and correctly so -- both appear on screen
 * under their own labels. See INHERITED-COERCIONS.md, "Examined and found sound".
 */
export function totalGainLoss(c: Company): number {
  return c.fmv + c.realized - c.invested;
}

/**
 * Unrealized gain/loss, $M, as the dashboard top/bottom chart (:801) and the
 * Reports movers list (:1216) show it. Excludes realizations by design.
 */
export function unrealizedGain(c: Company): number {
  return c.fmv - c.invested;
}
