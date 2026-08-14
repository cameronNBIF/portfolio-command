/**
 * A6's company planner: real control totals in, a plausible financial history
 * out.
 *
 * PURE. No database, no clock, no I/O -- the half worth testing is testable
 * without any of them, on the `functions/src/affinity/map.ts` precedent.
 *
 * THE ONE PROPERTY THAT MATTERS
 * -----------------------------
 * Finance has not yet supplied per-transaction history (ADR-011), so the
 * *shape* of every history here is invented. The *totals* are not. For every
 * company:
 *
 *   sum(investment + follow_on transactions) === company.affinity_total_investment
 *   the final valuation mark                 === company.affinity_fmv
 *
 * exactly, to the cent. Those two columns are synced nightly from Affinity and
 * are the numbers the VC team already knows by heart, so a portfolio that adds
 * up to anything else is not a demo, it is a distraction. `reconcile.ts`
 * asserts both after the write and refuses to commit otherwise.
 *
 * Arithmetic is in INTEGER CENTS throughout for that reason. Splitting
 * $1,575,381 across four rounds in floating point leaves a fraction of a cent
 * somewhere, and a control total that is out by $0.01 is indistinguishable
 * from one that is out by $10,000 when the assertion is exact.
 *
 * WHAT IS DELIBERATELY *NOT* GENERATED
 * ------------------------------------
 * Realizations. The export carries invested and FMV and nothing else, so
 * realized proceeds would be a board number with no source (decision, 14 Aug
 * 2026). DPI reads 0.00x and TVPI 0.89x, which is what the supplied data
 * says. Write-offs are generated, because an FMV of zero IS in the data.
 */

import { Rng } from './rng.js';

// --- money -----------------------------------------------------------------

/** $1,000, the increment a cheque is quoted in. */
const STEP = 100_000;
const CENTS = 100;

export const toCents = (dollars: number | string): number =>
  Math.round(Number(dollars) * CENTS);
export const toDollars = (cents: number): string => (cents / CENTS).toFixed(2);

// --- dates -----------------------------------------------------------------

/** Months since 2000-01. Keeps date arithmetic integral and timezone-free. */
const monthIndex = (year: number, month: number) => (year - 2000) * 12 + (month - 1);
const yearOf = (mi: number) => 2000 + Math.floor(mi / 12);
const monthOf = (mi: number) => (mi % 12) + 1;

/** `YYYY-MM-DD` for a month index and a day, clamped into the month. */
function dateOf(mi: number, day: number): string {
  const y = yearOf(mi);
  const m = monthOf(mi);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const d = Math.min(Math.max(day, 1), last);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * The last month a generated round may fall in.
 *
 * Pinned to the data, not to the clock: the valuation series ends at the
 * 2026-07-31 exercise, and a round dated after the last mark would value a
 * company at a date its marks do not cover (ADR-007, ADR-021).
 */
const LAST_ROUND_MONTH = monthIndex(2026, 6);

/**
 * The first FMV exercise the generated series carries.
 *
 * Marks run semi-annually at end of January and end of July (ADR-007), but not
 * back to 2006: a formal valuation policy has a start date, and pretending
 * otherwise would invent twenty years of exercises nobody performed. Before it,
 * a position is held at cost, which is exactly what `company_fmv_asof` does
 * with no mark on or before the date -- so the old vintages exercise that path
 * rather than merely asserting it.
 */
const FIRST_MARK_YEAR = 2016;

// --- vocabularies ----------------------------------------------------------

const STAGE_LADDER = ['Pre-Seed', 'Seed', 'Series A', 'Series B', 'Series C+', 'Growth'] as const;

/** Round labels, and the ref_stage each maps to. Bridges do not advance stage. */
const ROUND_LADDER: { label: string; stage: (typeof STAGE_LADDER)[number] }[] = [
  { label: 'Pre-Seed', stage: 'Pre-Seed' },
  { label: 'Seed', stage: 'Seed' },
  { label: 'Seed extension', stage: 'Seed' },
  { label: 'Series A', stage: 'Series A' },
  { label: 'Series A-2', stage: 'Series A' },
  { label: 'Series B', stage: 'Series B' },
  { label: 'Series C', stage: 'Series C+' },
  { label: 'Series D', stage: 'Growth' },
];

const PRICED = 'Preferred Equity';
const UNPRICED = ['SAFE', 'Convertible Note'] as const;

/**
 * Lead investors and co-investors.
 *
 * Two groups, deliberately. The first names NBIF's OWN LP positions, because a
 * fund NBIF is an LP in leading a round in NBIF's direct portfolio is the exact
 * event `v_lp_capital_to_direct` measures and the mandate KPI it feeds -- so
 * `round_coinvestor.fund_investment_id` resolves and the Funds tab has
 * something real to show. The second is generic: plausible co-investor shapes
 * that name no actual firm, because inventing a named firm's participation in a
 * named real company is a claim about both of them.
 */
const GENERIC_COINVESTORS = [
  'Regional angel syndicate',
  'Provincial development fund',
  'Founder and management',
  'Strategic corporate investor',
  'Family office (undisclosed)',
  'Existing investors (pro-rata)',
  'Federal innovation programme',
  'Angel group — Atlantic',
];

const VALUATION_PREPARERS = ['Director of Finance', 'Finance Analyst'] as const;

// --- inputs and outputs ----------------------------------------------------

export interface CompanyFacts {
  companyId: string;
  name: string;
  yearFounded: number | null;
  /** Control total, cents. `company.affinity_total_investment`. */
  investedCents: number;
  /** Control total, cents. `company.affinity_fmv`. */
  fmvCents: number;
  riskGrade: string | null;
  lifecycleStatus: string | null;
  /** VCF / SIF / ACC, or null where the roster row is absent from the export. */
  vehicle: string | null;
  /** Earliest calendar year in `company_kpi`, when there is any. */
  firstKpiYear: number | null;
}

export interface PlannedRound {
  index: number;
  date: string;
  label: string;
  stage: string;
  instrument: string;
  vehicle: string | null;
  /** Our cheque for this round, cents. Sums to the control total across rounds. */
  chequeCents: number;
  /** Whole round size, cents. NULL where it was never captured (ADR-012). */
  roundTotalCents: number | null;
  nbOtherCents: number | null;
  postMoneyCents: number | null;
  ownershipAfterPct: number;
  lead: string;
  note: string;
  coinvestors: { name: string; isNb: boolean; amountCents: number | null; lpFund: string | null }[];
}

export interface PlannedTransaction {
  date: string;
  type: 'investment' | 'follow_on' | 'write_off';
  /** Booked amount in the booked currency, cents. */
  amountCents: number;
  currency: string;
  /** Set whenever currency is not CAD; `amountCents * rate` is the CAD figure. */
  fxRateToCad: number | null;
  roundIndex: number | null;
  vehicle: string | null;
  note: string | null;
}

export interface PlannedMark {
  date: string;
  fmvCents: number;
  method: string;
  preparedByLabel: string;
  rationale: string;
}

export interface CompanyPlan {
  companyId: string;
  rounds: PlannedRound[];
  transactions: PlannedTransaction[];
  marks: PlannedMark[];
  ownership: { date: string; pct: number; proRata: boolean }[];
  exit: { date: string; type: string; note: string } | null;
  /** Current stage, for `company_state.stage_id`. */
  stage: string;
  /** ADR-027: the headline instrument, NOT mechanically any round's. */
  headlineInstrument: string;
  reserve: { allocatedCents: number; deployedCents: number; basis: string } | null;
  fteAtEntry: number | null;
  thresholds: { minRunwayMo: number | null; maxBurnMult: number | null } | null;
}

// --- the split -------------------------------------------------------------

/**
 * Splits `total` cents across `n` cheques that sum to it EXACTLY.
 *
 * The first n-1 are rounded to $1,000 because that is how a cheque is quoted;
 * the last absorbs whatever is left, which is why odd control totals like
 * Inversa's $1,575,381 land as an odd final tranche rather than as rounding
 * spread invisibly across the history. A real note conversion looks exactly
 * like that.
 */
export function splitExact(total: number, n: number, rng: Rng): number[] {
  if (n <= 1) return [total];

  const parts = rng.weights(n).map((w) => Math.round(total * w));
  const head = parts.slice(0, n - 1).map((p) => Math.max(STEP, Math.round(p / STEP) * STEP));

  let headSum = head.reduce((a, b) => a + b, 0);
  // Leave the final tranche at least a $1,000 cheque's worth. Shave the
  // largest head entries down in $1,000 steps until it does.
  const floor = Math.min(STEP, Math.floor(total / (n * 4)));
  while (total - headSum < floor) {
    const biggest = head.indexOf(Math.max(...head));
    if (head[biggest]! <= STEP) break;
    head[biggest] = head[biggest]! - STEP;
    headSum -= STEP;
  }

  const last = total - headSum;
  if (last <= 0) {
    // Pathological: fall back to an even split with the remainder on the last.
    const even = Math.floor(total / n / STEP) * STEP || Math.floor(total / n);
    const evens = Array.from({ length: n - 1 }, () => even);
    return [...evens, total - even * (n - 1)];
  }
  return [...head, last];
}

/** How many rounds a position of this size plausibly took. */
function roundCount(facts: CompanyFacts, rng: Rng): number {
  const t = facts.investedCents / CENTS;
  if (facts.vehicle === 'ACC') return 1; // a programme cheque, written once
  if (t < 100_000) return 1;
  if (t < 300_000) return rng.int(1, 2);
  if (t < 800_000) return rng.int(2, 3);
  if (t < 1_600_000) return rng.int(3, 4);
  // The long tail the roadmap asks for: a few positions with six or more.
  return rng.chance(0.35) ? rng.int(6, 8) : rng.int(4, 5);
}

/**
 * Where a company's first cheque falls.
 *
 * THE FOUNDING YEAR IS A HARD FLOOR. An earlier version let the spacing clamp
 * override it -- reserving room for seven rounds at ten months apart pulled the
 * start back sixty months, which dated a 2024 company's first round in 2023.
 * The number of rounds bends to the available time (`roundsThatFit`), never
 * the other way round.
 */
function firstRoundMonth(facts: CompanyFacts, rng: Rng): number {
  const founded =
    facts.yearFounded ??
    (facts.firstKpiYear !== null ? facts.firstKpiYear - rng.int(2, 6) : 2014 + rng.int(-4, 5));
  const floorMonth = monthIndex(Math.max(2006, founded), 1);
  // Entry lands nought to three years after founding, and never before it.
  const entryYear = Math.min(Math.max(2006, founded) + rng.int(0, 3), 2025);
  const start = monthIndex(entryYear, rng.int(1, 12));
  return Math.max(floorMonth, Math.min(start, LAST_ROUND_MONTH));
}

/** How many rounds fit between entry and the last round month, at ~10 months apart. */
function roundsThatFit(start: number): number {
  return Math.max(1, Math.floor((LAST_ROUND_MONTH - start) / 10) + 1);
}

// --- the planner -----------------------------------------------------------

/**
 * @param lpFundNames The LP positions NBIF actually holds. A quarter of priced
 *   rounds name one as a co-investor, because a fund NBIF is an LP in putting
 *   capital into NBIF's direct portfolio is exactly the event
 *   `v_lp_capital_to_direct` measures -- and with no such row the
 *   `capitalToDirect` mandate KPI reads zero across the board and the Funds tab
 *   has nothing to show. Passed in rather than imported so this module stays
 *   free of I/O.
 */
export function planCompany(facts: CompanyFacts, lpFundNames: readonly string[] = []): CompanyPlan {
  const rng = new Rng(facts.companyId);
  const T = facts.investedCents;
  const F = facts.fmvCents;

  // Entry first, then the round count it has room for. A young company gets a
  // short history because that is the only honest shape available to it.
  const start = firstRoundMonth(facts, rng);
  const n = Math.min(roundCount(facts, rng), roundsThatFit(start));
  const cheques = splitExact(T, n, rng);

  const months: number[] = [start];
  if (n > 1) {
    const span = Math.max(LAST_ROUND_MONTH - start, (n - 1) * 10);
    const base = Math.min(30, Math.max(10, Math.round(span / (n - 1))));
    for (let i = 1; i < n; i++) {
      const gap = Math.max(8, Math.round(base * rng.between(0.65, 1.35)));
      months.push(Math.min(months[i - 1]! + gap, LAST_ROUND_MONTH));
    }
  }

  // --- the ladder ---
  const isAcc = facts.vehicle === 'ACC';
  // Start position on the ladder: a first cheque of $500k+ is not a pre-seed.
  let rung = isAcc ? 0 : cheques[0]! >= 50_000_000 ? 2 : cheques[0]! >= 15_000_000 ? 1 : 0;

  const rounds: PlannedRound[] = [];
  const transactions: PlannedTransaction[] = [];
  let cumulative = 0;

  // Final ownership scales with how much went in; walked backwards for history.
  const finalOwnership = isAcc
    ? rng.between(0.4, 3.5)
    : Math.min(24, rng.between(2.5, 9) + (T / CENTS / 1_000_000) * rng.between(1.5, 4.5));

  for (let i = 0; i < n; i++) {
    const cheque = cheques[i]!;
    cumulative += cheque;
    const date = dateOf(months[i]!, rng.int(3, 27));
    const year = yearOf(months[i]!);

    const ladder = isAcc
      ? { label: 'Accelerator', stage: 'Pre-Seed' as const }
      : ROUND_LADDER[Math.min(rung, ROUND_LADDER.length - 1)]!;
    if (!isAcc && i < n - 1) rung += rng.chance(0.25) ? 0 : 1; // a bridge holds the rung

    // Unpriced early, priced later -- and an accelerator cheque is a SAFE.
    const instrument =
      isAcc || (i === 0 && rung <= 1 && rng.chance(0.55)) ? rng.pick(UNPRICED) : PRICED;

    // Our participation in the whole round.
    const participation = isAcc ? rng.between(0.15, 0.6) : rng.between(0.04, 0.32);
    const rawTotal = Math.round(cheque / participation / STEP) * STEP;

    /**
     * ADR-012: round_total is captured by the deal lead at close and exists in
     * no upstream system, so historical rounds have gaps that no process can
     * now fill. The rates below are the point of the exercise -- leverage must
     * be computed over the rounds that HAVE a total, never over an imputed one.
     */
    const missingRate = year < 2015 ? 0.45 : year < 2020 ? 0.25 : 0.08;
    const roundTotalCents = rng.chance(missingRate) ? null : Math.max(rawTotal, cheque);

    const thirdParty = roundTotalCents === null ? 0 : roundTotalCents - cheque;
    const nbOtherCents =
      roundTotalCents !== null && thirdParty > 0 && rng.chance(0.55)
        ? Math.round((thirdParty * rng.between(0.08, 0.45)) / STEP) * STEP
        : null;

    const postMoneyCents =
      instrument === PRICED && roundTotalCents !== null
        ? Math.round(roundTotalCents / rng.between(0.08, 0.3) / STEP) * STEP
        : null;

    // Ownership climbs toward the final figure and dilutes a little on the way.
    const progress = cumulative / T;
    const ownershipAfterPct = Math.max(
      0.1,
      Math.min(30, finalOwnership * progress * rng.between(0.88, 1.12)),
    );

    // Co-investors. One in four rounds names an LP position we actually hold,
    // which is what gives v_lp_capital_to_direct something to measure.
    const coinvestors: PlannedRound['coinvestors'] = [];
    if (roundTotalCents !== null && thirdParty > 0) {
      const k = rng.int(1, 3);
      for (let j = 0; j < k; j++) {
        // A quarter of priced rounds name a fund we are an LP in. Restricted to
        // priced rounds because that is when an institutional co-investor turns
        // up; an accelerator SAFE does not attract one.
        const useLp = lpFundNames.length > 0 && instrument === PRICED && rng.chance(0.25);
        const name = useLp ? rng.pick(lpFundNames) : rng.pick(GENERIC_COINVESTORS);
        coinvestors.push({
          name,
          isNb: useLp ? true : rng.chance(0.4),
          amountCents: Math.round((thirdParty / k / STEP) * rng.between(0.5, 1)) * STEP,
          lpFund: useLp ? name : null,
        });
      }
    }

    rounds.push({
      index: i,
      date,
      label: ladder.label,
      stage: ladder.stage,
      instrument,
      vehicle: facts.vehicle,
      chequeCents: cheque,
      roundTotalCents,
      nbOtherCents:
        nbOtherCents !== null && roundTotalCents !== null
          ? Math.min(nbOtherCents, roundTotalCents)
          : null,
      postMoneyCents,
      ownershipAfterPct,
      lead: i === 0 && !isAcc ? 'NBIF' : rng.pick(GENERIC_COINVESTORS),
      note:
        roundTotalCents === null
          ? 'Round total not captured — predates the ADR-012 close checklist.'
          : '',
      coinvestors,
    });

    transactions.push({
      date,
      type: i === 0 ? 'investment' : 'follow_on',
      amountCents: cheque,
      currency: 'CAD',
      fxRateToCad: null,
      roundIndex: i,
      vehicle: facts.vehicle,
      note: null,
    });
  }

  // --- marks ---
  const marks = planMarks(facts, rounds, rng);

  // --- write-off and exit ---
  const writtenOff = F === 0;
  const windingDown = facts.lifecycleStatus === 'Winding Down';
  let exit: CompanyPlan['exit'] = null;
  if (writtenOff && windingDown) {
    const date = marks.length ? marks[marks.length - 1]!.date : rounds[rounds.length - 1]!.date;
    exit = {
      date,
      type: 'Shutdown / write-off',
      note: 'Position written to nil. Recorded from the Affinity lifecycle status.',
    };
    transactions.push({
      date,
      type: 'write_off',
      amountCents: T,
      currency: 'CAD',
      fxRateToCad: null,
      roundIndex: null,
      vehicle: facts.vehicle,
      note: 'Full write-off of cost basis.',
    });
  }

  // --- ownership history ---
  const ownership = rounds.map((r) => ({
    date: r.date,
    pct: r.ownershipAfterPct,
    proRata: rng.chance(0.55),
  }));

  /**
   * ADR-027: `deployed` is NOT the sum of follow-on rounds and the difference
   * is not rounding. A follow-on can be funded from a new allocation, and a
   * reserve can be released without being deployed. Generated as an
   * independent figure for exactly that reason.
   */
  const reserve = writtenOff
    ? null
    : {
        allocatedCents: Math.round((T * rng.between(0.4, 1.2)) / STEP) * STEP,
        deployedCents: Math.round((T * rng.between(0, 0.55)) / STEP) * STEP,
        basis: rng.pick([
          '0.8x initial cheque, green and pro-rata',
          '1.0x initial cheque, follow-on eligible',
          'Held flat pending next round',
          '0.5x initial cheque, watchlist',
        ]),
      };

  // Headline instrument: drawn independently of any round (ADR-027).
  const headlineInstrument = rng.chance(0.75)
    ? rounds[rounds.length - 1]!.instrument
    : rng.pick(['SAFE', 'Convertible Note', 'Debt-to-Note', PRICED, 'Common Equity']);

  return {
    companyId: facts.companyId,
    rounds,
    transactions,
    marks,
    ownership,
    exit,
    stage: isAcc ? 'Pre-Seed' : rounds[rounds.length - 1]!.stage,
    headlineInstrument,
    reserve,
    fteAtEntry: rng.chance(0.85) ? rng.int(1, 12) : null,
    thresholds: rng.chance(0.7)
      ? { minRunwayMo: rng.pick([6, 9, 12, 12, 18]), maxBurnMult: rng.between(1.2, 3.5) }
      : null,
  };
}

/**
 * The semi-annual FMV series (ADR-007), ending on the control total.
 *
 * The path is a noisy walk from cost toward the known final ratio, so a
 * position that tripled shows a climb and one written to nil shows a decline
 * rather than a cliff. THE LAST MARK IS FORCED TO THE CONTROL TOTAL -- the walk
 * decides the shape, never the destination.
 */
function planMarks(facts: CompanyFacts, rounds: PlannedRound[], rng: Rng): PlannedMark[] {
  const T = facts.investedCents;
  const F = facts.fmvCents;
  const first = rounds[0]!;
  const firstMonth = monthIndex(Number(first.date.slice(0, 4)), Number(first.date.slice(5, 7)));

  // Exercise dates: 31 January and 31 July, from the policy start or six
  // months after entry, whichever is later.
  const dates: { date: string; mi: number }[] = [];
  for (let y = FIRST_MARK_YEAR; y <= 2026; y++) {
    for (const m of [1, 7]) {
      const mi = monthIndex(y, m);
      if (mi < firstMonth + 6) continue;
      if (mi > monthIndex(2026, 7)) continue;
      dates.push({ date: dateOf(mi, 31), mi });
    }
  }
  // A very recent entry gets the one exercise that has happened since.
  if (dates.length === 0) dates.push({ date: '2026-07-31', mi: monthIndex(2026, 7) });

  const finalRatio = T > 0 ? F / T : 0;
  const writtenOff = F === 0;

  const out: PlannedMark[] = [];
  for (let i = 0; i < dates.length; i++) {
    const { date, mi } = dates[i]!;
    const isLast = i === dates.length - 1;

    // Cost carried at this date -- marks before a follow-on must not value it.
    const costAt = rounds
      .filter((r) => monthIndex(Number(r.date.slice(0, 4)), Number(r.date.slice(5, 7))) <= mi)
      .reduce((a, r) => a + r.chequeCents, 0);

    let fmvCents: number;
    if (isLast) {
      fmvCents = F; // the control total, exactly
    } else {
      const t = dates.length > 1 ? i / (dates.length - 1) : 1;
      if (writtenOff) {
        // Value holds, then falls away over the closing exercises.
        const decay = t < 0.6 ? rng.between(0.85, 1.15) : Math.max(0, (1 - t) / 0.4) ** 1.6;
        fmvCents = Math.round(costAt * decay);
      } else {
        // Ease from cost toward the known ratio, with noise that never
        // overshoots into a number the final mark would have to undo.
        const eased = 1 + (finalRatio - 1) * t ** 1.35;
        fmvCents = Math.max(0, Math.round(costAt * eased * rng.between(0.86, 1.14)));
      }
    }

    const direction = costAt === 0 ? 0 : fmvCents / costAt;
    const method = pickMethod(direction, writtenOff && isLast, rng);
    out.push({
      date,
      fmvCents,
      method,
      preparedByLabel: rng.pick(VALUATION_PREPARERS),
      rationale: rationaleFor(method, direction, facts.name),
    });
  }
  return out;
}

/**
 * ADR-026 in practice: a mark routinely qualifies a canonical method in free
 * text, and that qualification is meaningful to whoever reads the mark. Those
 * variants resolve to no `ref_valuation_method` row and carry a NULL key, which
 * is the behaviour the schema comment describes and which nothing had yet
 * exercised on real-shaped data.
 */
function pickMethod(ratio: number, isWriteOff: boolean, rng: Rng): string {
  if (isWriteOff) return 'Write-off';
  const base =
    ratio > 1.35
      ? rng.pick(['Revenue multiple', 'Calibrated last round'])
      : ratio < 0.8
        ? rng.pick(['Scenario-weighted', 'Calibrated last round'])
        : 'Last round';
  if (rng.chance(0.22)) {
    return `${base}, ${rng.pick(['discounted', 'illiquidity adjusted', 'backlog coverage', 'DLOM applied'])}`;
  }
  return base;
}

function rationaleFor(method: string, ratio: number, name: string): string {
  if (method.startsWith('Write-off')) {
    return `${name} written to nil. No realistic path to a recovery of cost; position closed for valuation purposes.`;
  }
  if (ratio > 1.35) {
    return `Carried above cost on ${method.toLowerCase()}. Revenue and pipeline support the step-up; no new priced round since the last exercise.`;
  }
  if (ratio < 0.8) {
    return `Marked down on ${method.toLowerCase()}. Performance behind plan against the last priced round; carrying value reduced accordingly.`;
  }
  return `Held at the last priced round. No material change since the previous exercise; ${method.toLowerCase()} applied unchanged.`;
}

export { STAGE_LADDER, GENERIC_COINVESTORS, monthIndex, dateOf, FIRST_MARK_YEAR };
