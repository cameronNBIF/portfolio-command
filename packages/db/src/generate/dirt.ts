/**
 * The deliberate defects (ADR-020, and the A6 line in the delivery roadmap).
 *
 * A6 exists to find out whether the schema survives contact with data that is
 * not tidy, while changing it is still cheap. Clean synthetic data proves
 * nothing: every constraint passes, every view returns a number, and the first
 * real batch from Finance in A13 is where the gaps surface instead.
 *
 * TWO RULES GOVERN EVERY DEFECT HERE.
 *
 * 1. **Each one is targeted, named and listed.** Random corruption is
 *    unreviewable -- if a number looks wrong six weeks from now, nobody can
 *    tell a generator artefact from a real bug. Every defect below names the
 *    company it lands on and the class of problem it represents, and the
 *    generator prints the whole list on every run.
 *
 * 2. **None of them breaks the control totals.** The roll-up to Affinity's
 *    invested and FMV figures is the property the whole phase is built on, so
 *    a defect that quietly moved it would destroy the only assertion that can
 *    catch a real generator bug. The duplicate cheque is the interesting case:
 *    it is booked AND reversed, so `v_transaction_live` excludes both and the
 *    total still reconciles -- which is precisely the ADR-018 correction path
 *    working, demonstrated rather than described.
 *
 * Some of the roadmap's list needed no fabrication at all, and that is worth
 * recording rather than papering over:
 *   - "a company with no KPIs"  -- six on the real roster already have none.
 *   - "a renamed company"       -- the roster carries "AccessSync (Elandas)"
 *                                  and "snapB2B (Snap Accounts Payable)",
 *                                  which are renames spelled into the name.
 *   - "missing round totals"    -- modelled at 45% before 2015 in `plan.ts`.
 *   - unresolvable attribution  -- Alongside and Potential Motors are absent
 *                                  from the Status-filtered export, so their
 *                                  vehicle is genuinely unknown and is left
 *                                  NULL rather than guessed.
 *
 * One defect the roadmap asks for CANNOT be built, and the reason is a good
 * one: an orphan transaction with no subject is refused by the `txn_one_subject`
 * CHECK constraint. The class is still covered -- see `crossCompanyRound` --
 * by a transaction pointing at a round that belongs to a different company,
 * which the schema does permit and which nothing had noticed.
 */

import type { CompanyPlan } from './plan.js';

export interface Defect {
  /** Company name the defect lands on, or a table name for schema-level ones. */
  subject: string;
  /** Short class label, printed in the run report. */
  kind: string;
  detail: string;
}

/** A booked-then-reversed duplicate, and the extra rows the writer must insert. */
export interface DuplicatePair {
  companyId: string;
  /** Index into the plan's transactions -- the row being duplicated. */
  transactionIndex: number;
}

export interface DirtPlan {
  defects: Defect[];
  /** Company ids whose first round carries a USD tranche. */
  usdTranche: Set<string>;
  /** Company ids getting a duplicate cheque plus its ADR-018 reversal. */
  duplicates: DuplicatePair[];
  /** Company ids getting a valuation mark dated before the first investment. */
  markBeforeInvestment: Set<string>;
  /** Company ids whose newest round total is below our own cheque. */
  roundTotalBelowCheque: Set<string>;
  /** Company ids gaining a co-investor whose name nearly matches an LP fund. */
  nearMissCoinvestor: Set<string>;
  /** Company ids gaining a superseded mark beside the final one. */
  supersededMark: Set<string>;
  /** Company ids gaining a transaction tied to another company's round. */
  crossCompanyRound: Set<string>;
}

/**
 * Where each defect lands.
 *
 * Chosen by NAME rather than by `company_id`, because the ids are allocated in
 * Affinity entity order and a name is what a reviewer can actually check. A
 * target that is not on the roster is skipped and reported, never silently
 * dropped.
 */
const TARGETS = {
  usdTranche: 'Sonrai Security',
  duplicate: 'Eigen Innovations',
  markBeforeInvestment: 'Introhive',
  roundTotalBelowCheque: 'Smart Skin Technologies',
  nearMissCoinvestor: 'Picketa Systems',
  supersededMark: 'ProcedureFlow',
  crossCompanyRound: 'Beauceron Security',
} as const;

/** The near-miss name. One character from `Concrete Ventures`, which we hold. */
export const NEAR_MISS_NAME = 'Concrete Venture';

export function planDirt(
  plans: Map<string, CompanyPlan>,
  namesById: Map<string, string>,
): DirtPlan {
  const idByName = new Map<string, string>();
  for (const [id, name] of namesById) idByName.set(name, id);

  const defects: Defect[] = [];
  const dirt: DirtPlan = {
    defects,
    usdTranche: new Set(),
    duplicates: [],
    markBeforeInvestment: new Set(),
    roundTotalBelowCheque: new Set(),
    nearMissCoinvestor: new Set(),
    supersededMark: new Set(),
    crossCompanyRound: new Set(),
  };

  const target = (name: string, kind: string, detail: string): string | null => {
    const id = idByName.get(name);
    if (!id || !plans.has(id)) {
      defects.push({
        subject: name,
        kind: `${kind} (SKIPPED)`,
        detail: 'Target is not on the roster. Defect not applied.',
      });
      return null;
    }
    defects.push({ subject: `${name} (${id})`, kind, detail });
    return id;
  };

  const usd = target(
    TARGETS.usdTranche,
    'non-CAD transaction',
    'Largest round split into a USD tranche at 1.35 plus a CAD remainder. Exercises ' +
      'fx_rate_to_cad, which had been stored since A1 and read by nothing.',
  );
  if (usd) dirt.usdTranche.add(usd);

  const dup = target(
    TARGETS.duplicate,
    'duplicate cheque, reversed',
    'A follow-on booked twice, then voided by a dated reversal (ADR-018). Both rows ' +
      'are excluded by v_transaction_live, so the control total still reconciles.',
  );
  if (dup) {
    const plan = plans.get(dup)!;
    const idx = plan.transactions.findIndex((t) => t.type === 'follow_on');
    if (idx >= 0) dirt.duplicates.push({ companyId: dup, transactionIndex: idx });
  }

  const early = target(
    TARGETS.markBeforeInvestment,
    'mark predating first investment',
    'A valuation mark dated eighteen months before the first cheque. Nothing in the ' +
      'schema forbids it and company_fmv_asof will happily return it for an early as-of date.',
  );
  if (early) dirt.markBeforeInvestment.add(early);

  const below = target(
    TARGETS.roundTotalBelowCheque,
    'round total below our cheque',
    'An impossible round: the whole round is smaller than our participation in it. ' +
      'v_round_leverage excludes it by predicate; the export still carries it unfiltered (ADR-021).',
  );
  if (below) dirt.roundTotalBelowCheque.add(below);

  const near = target(
    TARGETS.nearMissCoinvestor,
    'unresolvable co-investor name',
    `Co-investor recorded as "${NEAR_MISS_NAME}" against the LP position "Concrete Ventures". ` +
      'Exact-match resolution (ADR-026) leaves fund_investment_id NULL, so the capital never ' +
      'reaches v_lp_capital_to_direct and the mandate KPI silently understates.',
  );
  if (near) dirt.nearMissCoinvestor.add(near);

  const sup = target(
    TARGETS.supersededMark,
    'superseded valuation mark',
    'A final mark replaced by a corrected one on the same effective date. Exercises ' +
      'supersedes_id and the partial unique index that permits exactly one final mark per date.',
  );
  if (sup) dirt.supersededMark.add(sup);

  const cross = target(
    TARGETS.crossCompanyRound,
    'transaction on another company’s round',
    'The orphan-transaction class the roadmap asks for. A literal orphan is refused by ' +
      'txn_one_subject, but nothing stops a transaction referencing a round that belongs ' +
      'to a different company, and the round-level invested sum in the export adapter ' +
      'would pick it up.',
  );
  if (cross) dirt.crossCompanyRound.add(cross);

  return dirt;
}
