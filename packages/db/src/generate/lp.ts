/**
 * A6's LP planner. Same contract as `plan.ts`: real control totals in, a
 * plausible cashflow history out.
 *
 * WHAT IS REAL, and it is the whole point:
 *   committed, called and remaining, per fund, from `packages/db/data/lp_fund.json`
 *   (NBIF LP Funds.xlsx, supplied 14 August 2026). $8,725,000 / $4,152,160 /
 *   $4,572,840 across sixteen positions.
 *
 * WHAT IS SYNTHETIC:
 *   the timing and size of the individual capital drawdowns (they sum EXACTLY to
 *   the real called figure), the vintage year, the NAV, and the descriptive
 *   fields.
 *
 * WHAT IS DELIBERATELY LEFT NULL:
 *   `women_senior_gp`. These are real, named firms. Asserting the composition
 *   of a real manager's senior team from a guess is a claim about identifiable
 *   people, and a demo is not worth it. NULL means not reported, which under
 *   D-5 is exactly what the platform is built to render honestly.
 *
 * Distributions are NOT generated, matching the direct portfolio: the workbook
 * carries none, so a distribution would be a board number with no source
 * (decision, 14 Aug 2026). Two positions have never been called at all, which
 * leaves TVPI genuinely undefined rather than zero -- a division `fiTvpi`
 * guards and which no fixture had previously exercised.
 */

import { Rng } from './rng.js';

const CENTS = 100;
const DOLLAR = 100; // cents in a dollar; calls are quoted to the dollar

export interface LpFactsInput {
  name: string;
  committed: number;
  called: number;
  remaining: number;
}

export interface PlannedCall {
  date: string;
  amountCents: number;
  note: string;
}

export interface PlannedNav {
  date: string;
  navCents: number;
  receivedAt: string;
}

export interface LpPlan {
  fundInvestmentId: string;
  name: string;
  managerName: string;
  strategy: string;
  vintageYear: number;
  committedCents: number;
  calledCents: number;
  coInvestRights: boolean;
  womenSeniorGp: null;
  nextCallEst: string | null;
  agmDate: string | null;
  irContact: string;
  rationale: string;
  calls: PlannedCall[];
  navs: PlannedNav[];
}

const pad3 = (n: number) => String(n).padStart(3, '0');

/**
 * Vintage, inferred from how much of the commitment has actually been drawn.
 *
 * This is a real signal rather than a coin toss: a fund that has called its
 * whole commitment has been investing for years, and one that has called
 * nothing signed recently. It is still an INFERENCE and is reported as
 * synthetic -- the workbook carries no vintage column.
 *
 * The sequel rule exists because the heuristic gets one case backwards on the
 * real data: Sandpiper II is 46% called against Sandpiper I's 10%, which would
 * date the sequel before the original. A fund numbered II is never older than
 * the fund it succeeds, whatever the draw-down says.
 *
 * The correction moves the ORIGINAL earlier rather than the sequel later, and
 * the difference matters. Pushing Sandpiper II forward from its own draw-down
 * put it in 2026 — a fund with 46% of its commitment already called, dated this
 * year, showing a NAV of zero because no GP statement can exist yet. Pulling
 * Sandpiper I back instead dates the pair 2019 and 2021, which is a shape that
 * reads correctly on the Funds tab.
 */
function inferVintage(called: number, committed: number, rng: Rng): number {
  const ratio = committed > 0 ? called / committed : 0;
  const year = 2026 - Math.round(ratio * 9) - rng.int(0, 2);
  return Math.max(2012, Math.min(2026, year));
}

/** "Sandpiper Ventures II" -> "Sandpiper Ventures". Null when it is not a sequel. */
function baseOfSequel(name: string): string | null {
  const m = /^(.*)\s+(II|III|IV|2|3)$/.exec(name.trim());
  return m ? m[1]!.trim() : null;
}

function strategyFor(name: string): string {
  if (name === 'Accelerators') return 'Accelerator programme commitments';
  return 'Early-stage venture';
}

export function planLpPositions(input: LpFactsInput[]): LpPlan[] {
  const vintages = new Map<string, number>();

  const plans = input.map((f, i) => {
    const rng = new Rng(f.name);
    const committedCents = Math.round(f.committed * CENTS);
    const calledCents = Math.round(f.called * CENTS);

    // Mutated by the sequel pass below, which reaches in through the object.
    const vintageYear = inferVintage(f.called, f.committed, rng);
    vintages.set(f.name, vintageYear);

    return { f, i, rng, committedCents, calledCents, vintageYear };
  });

  // Second pass: a sequel is never dated before its predecessor, and the
  // ORIGINAL gives way. See the note on inferVintage.
  const byName = new Map(plans.map((p) => [p.f.name, p]));
  for (const p of plans) {
    const base = baseOfSequel(p.f.name);
    if (!base) continue;
    const original = byName.get(base);
    if (!original) continue;
    if (original.vintageYear > p.vintageYear - 2) {
      original.vintageYear = Math.max(2012, p.vintageYear - 2);
      vintages.set(base, original.vintageYear);
    }
  }

  return plans.map(({ f, i, rng, committedCents, calledCents, vintageYear }) => {
    const calls = planCalls(calledCents, committedCents, vintageYear, rng);
    const navs = planNavs(calledCents, vintageYear, calls, rng);

    return {
      fundInvestmentId: `F${pad3(i + 1)}`,
      name: f.name,
      // The workbook has no manager column. For a venture fund the manager is
      // the brand on the fund, so the name stands in -- and it is reported as
      // synthetic rather than presented as captured.
      managerName: f.name,
      strategy: strategyFor(f.name),
      vintageYear,
      committedCents,
      calledCents,
      coInvestRights: rng.chance(0.6),
      womenSeniorGp: null,
      nextCallEst:
        calledCents < committedCents ? `2026-${rng.pick(['09', '10', '11', '12'])}-15` : null,
      agmDate: `2026-${rng.pick(['05', '06', '09', '10'])}-${rng.pick(['12', '18', '22'])}`,
      irContact: 'Not captured',
      rationale: 'Synthetic — LP investment rationale not yet captured (A6).',
      calls,
      navs,
    };
  });
}

/**
 * Capital drawdowns that sum EXACTLY to the real drawn figure (FR-33).
 *
 * A first drawdown takes a larger slice than the ones that follow, which is how
 * a fund actually draws; the last absorbs the remainder, so the odd figures in
 * the workbook -- Propel's $488,819, Sandpiper's $98,118 -- land as a real final
 * drawdown rather than as rounding smeared across the series.
 */
function planCalls(
  calledCents: number,
  committedCents: number,
  vintageYear: number,
  rng: Rng,
): PlannedCall[] {
  if (calledCents <= 0) return [];

  const ratio = committedCents > 0 ? calledCents / committedCents : 0;
  const n = Math.max(1, Math.min(11, Math.round(ratio * 9) + rng.int(1, 2)));

  // Weights: the first call is heaviest, the rest taper with noise.
  const raw = Array.from({ length: n }, (_, k) =>
    (k === 0 ? 1.8 : 1) * rng.between(0.6, 1.4),
  );
  const sum = raw.reduce((a, b) => a + b, 0);

  const amounts: number[] = [];
  let allocated = 0;
  for (let k = 0; k < n - 1; k++) {
    // Quoted to the dollar, as a drawdown notice is.
    const a = Math.max(DOLLAR, Math.round((calledCents * raw[k]!) / sum / DOLLAR) * DOLLAR);
    if (allocated + a >= calledCents) break;
    amounts.push(a);
    allocated += a;
  }
  amounts.push(calledCents - allocated);

  // Spread from the vintage year to 2026, roughly two calls a year.
  const startMonth = vintageYear * 12 + rng.int(2, 8);
  const endMonth = 2026 * 12 + 5;
  const span = Math.max(amounts.length - 1, 1);
  const step = Math.max(3, Math.min(14, Math.round((endMonth - startMonth) / span)));

  return amounts.map((amountCents, k) => {
    const mi = Math.min(startMonth + k * step + rng.int(0, 2), endMonth);
    const y = Math.floor(mi / 12);
    const m = (mi % 12) + 1;
    return {
      date: `${y}-${String(m).padStart(2, '0')}-${String(rng.int(3, 26)).padStart(2, '0')}`,
      amountCents,
      note: k === 0 ? 'Initial drawdown' : `Capital drawdown ${k + 1}`,
    };
  });
}

/**
 * GP capital-account NAV, on the J-curve.
 *
 * Dated a quarter behind, because a GP statement is: `fund_investment_nav`
 * carries `statement_received_at` precisely so the Funds tab can show how stale
 * the number is, and generating the two the same day would make that column
 * look decorative.
 *
 * A position with nothing drawn gets NO NAV row at all -- there is no
 * capital account yet. That leaves TVPI undefined rather than zero, which is
 * the honest reading and the one `v_lp_position_current` already returns NULL
 * for.
 */
function planNavs(
  calledCents: number,
  vintageYear: number,
  calls: PlannedCall[],
  rng: Rng,
): PlannedNav[] {
  if (calledCents <= 0 || calls.length === 0) return [];

  const age = 2026 - vintageYear;
  // Below cost early (fees before markups), above it as the book matures.
  const multiple = age <= 2 ? rng.between(0.72, 1.02) : age <= 5 ? rng.between(0.9, 1.5) : rng.between(1.05, 2.2);

  // The last four semi-annual statements, ending a quarter back.
  const out: PlannedNav[] = [];
  const ends = ['2024-09-30', '2025-03-31', '2025-09-30', '2026-03-31'];
  for (let i = 0; i < ends.length; i++) {
    const asOf = ends[i]!;
    const calledBy = calls
      .filter((c) => c.date <= asOf)
      .reduce((a, c) => a + c.amountCents, 0);
    if (calledBy <= 0) continue;

    const t = (i + 1) / ends.length;
    const m = 1 + (multiple - 1) * t * rng.between(0.85, 1.15);
    const received = new Date(`${asOf}T00:00:00Z`);
    received.setUTCDate(received.getUTCDate() + rng.int(38, 78));

    out.push({
      date: asOf,
      navCents: Math.max(0, Math.round(calledBy * m)),
      receivedAt: received.toISOString().slice(0, 10),
    });
  }
  return out;
}
