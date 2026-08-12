/**
 * Constructed tests for the paths `demo.json` cannot reach.
 *
 * The golden master proves fidelity over the reference dataset, but that
 * dataset is clean and complete: no round fails the leverage exclusion, no
 * diversity field is null, and there is no accelerator concept at all. Those
 * gaps are listed in the fixture header (ADR-022), and this is where they get
 * covered.
 *
 * These assert THE PROTOTYPE'S RULE, not a rule that seems reasonable. Where
 * the prototype's behaviour looks wrong it is asserted anyway and cross-
 * referenced to INHERITED-COERCIONS.md -- the one exception being
 * `diversityWithCoverage`, which is the sanctioned D-5 departure.
 */
import type { Company, PortfolioExport, Round } from '@portfolio-command/contract';
import { describe, expect, it } from 'vitest';

import {
  diversityWithCoverage,
  fmt,
  fundMetrics,
  healthAlerts,
  moic,
  runScenario,
  scenarioDefaults,
  suggestedReserve,
  xirr,
} from '../src/index.js';

/* ---------------------------- factories ---------------------------- */

function round(over: Partial<Round> = {}): Round {
  return {
    date: '2022-01-15',
    label: 'Series A',
    instrument: 'Preferred Equity',
    invested: 2,
    roundTotal: 10,
    nbOther: 1,
    postMoney: 20,
    ownershipAfter: 10,
    lead: 'Us',
    note: '',
    ...over,
  };
}

function company(over: Partial<Company> = {}): Company {
  return {
    id: 'X001', name: 'Test Co', sector: 'Fintech', stage: 'Series A', vintage: 2022,
    health: 'green', instrument: 'Preferred Equity', ownershipPct: 10,
    invested: 2, fmv: 4, realized: 0, exited: false,
    ceo: '-', hq: 'Fredericton, NB', desc: '', riskFlags: [], proRata: true,
    reservesAllocated: 0, reservesDeployed: 0,
    board: { seat: 'None', holder: '-', nextMeeting: null },
    kpis: [], thresholds: { minRunwayMo: 12 }, rounds: [round()],
    milestones: [], covenants: [], govFunding: null, marks: [], tasks: [],
    fteAtEntry: 5, fte: 10, fteNB: 8, womenCSuite: 1, cSuiteSize: 4,
    source: 'Direct',
    ...over,
  };
}

function db(companies: Company[], over: Partial<PortfolioExport['fund']> = {}): PortfolioExport {
  return {
    fund: {
      name: 'Test Fund', currency: 'CAD', vintage: 2019, style: 'evergreen',
      capitalBase: 100, committed: 100, called: 50, distributionPolicy: '',
      feeDragPct: 2, navHistory: [], annualPlatformTarget: 5, annualFollowOnBudget: 10,
      ytdPlatformsClosed: 1, reservesPolicy: '', distributions: [],
      ...over,
    },
    companies,
    pipeline: [],
    fundInvestments: [],
    memos: {},
    meta: { schemaVersion: 1, savedAt: null, demo: false },
  };
}

const OPTS = { asOf: '2026-03-31' };

/* ------------------------- gap 1: leverage ------------------------- */

describe('leverage exclusion (gap 1 -- no negative case in demo.json)', () => {
  it('excludes a round with no roundTotal rather than imputing one', () => {
    const m = fundMetrics(
      db([company({ rounds: [round({ invested: 2, roundTotal: 10 }), round({ invested: 3, roundTotal: null })] })]),
      OPTS,
    );
    // Only the first round counts: (10 - 2) / 2 = 4. The second is dropped
    // entirely -- its $3M of our money is NOT in the denominator (ADR-012).
    expect(m.roundsTotal).toBe(10);
    expect(m.capitalAttracted).toBe(8);
    expect(m.leverage).toBe(4);
  });

  it('excludes a round whose total is below our own cheque', () => {
    // roundTotal 1 < invested 3 is not a real round total; excluding beats
    // reporting negative attracted capital.
    const m = fundMetrics(db([company({ rounds: [round({ invested: 3, roundTotal: 1 })] })]), OPTS);
    expect(m.roundsTotal).toBe(0);
    expect(m.leverage).toBeNull();
  });

  it('excludes a roundTotal of exactly 0 -- via truthiness, not the comparison', () => {
    // INHERITED-COERCIONS.md §12: `if (r.roundTotal && ...)` drops a literal 0
    // before `>=` sees it. With invested 0 the comparison would have PASSED.
    const m = fundMetrics(db([company({ invested: 0, rounds: [round({ invested: 0, roundTotal: 0 })] })]), OPTS);
    expect(m.roundsTotal).toBe(0);
    expect(m.leverage).toBeNull();
  });

  it('returns null leverage when every round is excluded, never 0', () => {
    // Null means "we cannot say". Zero would mean "we attracted nothing",
    // which is a different and wrong claim.
    const m = fundMetrics(db([company({ rounds: [round({ roundTotal: undefined })] })]), OPTS);
    expect(m.leverage).toBeNull();
    expect(fmt.x(m.leverage)).toBe('-');
  });

  it('keeps a round whose total exactly equals our cheque -- the boundary is inclusive', () => {
    const m = fundMetrics(db([company({ rounds: [round({ invested: 5, roundTotal: 5 })] })]), OPTS);
    expect(m.roundsTotal).toBe(5);
    expect(m.leverage).toBe(0);
  });
});

describe('NB co-investment (gap 4 -- the clamp never binds in demo.json)', () => {
  it('sums nbOther over EXCLUDED rounds too, then clamps outsideCapital at zero', () => {
    // INHERITED-COERCIONS.md §2. The excluded round contributes nothing to
    // capitalAttracted but its nbOther still lands in nbCapital, so the
    // subtraction goes negative and Math.max(0, ...) is what saves it.
    const m = fundMetrics(
      db([
        company({
          rounds: [round({ invested: 2, roundTotal: 4, nbOther: 1 }), round({ invested: 5, roundTotal: null, nbOther: 50 })],
        }),
      ]),
      OPTS,
    );
    expect(m.capitalAttracted).toBe(2);
    expect(m.nbCapital).toBe(51);
    expect(m.outsideCapital).toBe(0);
  });
});

/* ------------------------- gap 2: diversity ------------------------ */

describe('diversity nulls (gap 2 -- no nulls in demo.json)', () => {
  /**
   * A KPI row is what marks a company as HAVING REPORTED. The diversity
   * scalars are serialised from the latest one (ADR-010), and where no row
   * exists the API emits 0 rather than null -- the reference fixture carries a
   * literal 0 on its six KPI-less companies and the ADR-001 round trip has to
   * reproduce it. So the scalar alone cannot distinguish "reported none" from
   * "never asked"; the presence of history can.
   */
  const reported = (over: Partial<Company>) =>
    company({ kpis: [{ period: '2026-Q1', revenue: 1, burn: 1, cash: 10, runwayMo: 10 }], ...over });

  const roster = [
    reported({ id: 'A', womenCSuite: 2, cSuiteSize: 5 }),
    reported({ id: 'B', womenCSuite: 0, cSuiteSize: 4 }),
    reported({ id: 'C', womenCSuite: null, cSuiteSize: null }),
    reported({ id: 'D', womenCSuite: null, cSuiteSize: null }),
  ];

  it('fundMetrics counts a non-reporter as a company with no women (frozen behaviour)', () => {
    // ADR-013. This is the coercion D-5 exists to reverse; the frozen port
    // keeps it. See INHERITED-COERCIONS.md §4.
    const m = fundMetrics(db(roster), OPTS);
    expect(m.womenCos).toBe(1);
    expect(m.womenCosPct).toBe(25); // 1 of 4, treating both non-reporters as zeros
    expect(m.cSuiteTotal).toBe(9);
  });

  it('diversityWithCoverage excludes non-reporters from the denominator (D-5)', () => {
    const d = diversityWithCoverage(db(roster), {});
    expect(d.womenCos).toBe(1);
    expect(d.womenCosPct).toBe(50); // 1 of the 2 that actually reported
    expect(d.reported).toBe(2);
    expect(d.total).toBe(4);
    expect(d.coveragePct).toBe(50);
  });

  it('reports null, never 0%, when nobody has reported at all', () => {
    // The live case today: the fields are not yet collected (ADR-010, O-4).
    // "0% of companies have women in the C-suite" would be a false statement.
    const d = diversityWithCoverage(db([reported({ womenCSuite: null, cSuiteSize: null })]), {});
    expect(d.womenCosPct).toBeNull();
    expect(d.reported).toBe(0);
    expect(fmt.pct0(d.womenCosPct)).toBe('-');
  });

  it('distinguishes a reported zero from an unreported one', () => {
    const reportedZero = diversityWithCoverage(db([reported({ womenCSuite: 0, cSuiteSize: 3 })]), {});
    const notReported = diversityWithCoverage(db([reported({ womenCSuite: null, cSuiteSize: null })]), {});
    expect(reportedZero.womenCosPct).toBe(0);
    expect(reportedZero.reported).toBe(1);
    expect(notReported.womenCosPct).toBeNull();
    expect(notReported.reported).toBe(0);
  });

  /**
   * The A4 case, and the reason the KPI test exists at all. Every company on
   * the real Affinity roster is KPI-less until A5 brings Visible in, and the
   * API emits 0 for their diversity scalars. Without the history check the
   * tile read "0% of companies have women in the C-suite, reported by 82 of
   * 82" -- the exact false statement D-5 exists to prevent, board-facing.
   */
  it('treats a company with NO KPI history as a non-reporter, whatever its scalar says', () => {
    const d = diversityWithCoverage(db([company({ kpis: [], womenCSuite: 0, cSuiteSize: 0 })]), {});
    expect(d.reported).toBe(0);
    expect(d.total).toBe(1);
    expect(d.coveragePct).toBe(0);
    expect(d.womenCosPct).toBeNull();
    expect(fmt.pct0(d.womenCosPct)).toBe('-');
  });
});

/* --------------------- gap 3: same-store revenue -------------------- */

describe('same-store revenue growth (gap 3 -- only 7 of 64 qualify in demo.json)', () => {
  const kpi = (period: string, revenue: number) => ({ period, revenue, burn: 0.5, cash: 5, runwayMo: 10 });

  it('requires two periods -- a company with one is excluded from the growth pair', () => {
    const m = fundMetrics(
      db([
        company({ id: 'A', kpis: [kpi('2026-Q1', 10), kpi('2025-Q4', 8)] }),
        company({ id: 'B', kpis: [kpi('2026-Q1', 100)] }),
      ]),
      OPTS,
    );
    // B's 100 counts toward the revenue total but not toward growth.
    expect(m.revenue).toBe(110);
    expect(m.revQoQ).toBeCloseTo(25, 10);
  });

  it('returns null when no company has two periods', () => {
    const m = fundMetrics(db([company({ kpis: [kpi('2026-Q1', 10)] })]), OPTS);
    expect(m.revenue).toBe(10);
    expect(m.revQoQ).toBeNull();
  });

  it('excludes exited companies from both revenue and growth', () => {
    const m = fundMetrics(
      db([company({ id: 'A', exited: true, kpis: [kpi('2026-Q1', 50), kpi('2025-Q4', 25)] })]),
      OPTS,
    );
    expect(m.revenue).toBe(0);
    expect(m.revQoQ).toBeNull();
  });
});

/* ------------------- gap 5: accelerator exclusion ------------------- */

describe('includeAccelerator (not golden-masterable -- the prototype has no ACC concept)', () => {
  const roster = [
    company({ id: 'CORE', invested: 10, fmv: 20, fte: 100, rounds: [round({ invested: 10, roundTotal: 30, nbOther: 5 })] }),
    company({ id: 'ACC1', isAccelerator: true, invested: 1, fmv: 2, fte: 5, rounds: [round({ invested: 1, roundTotal: 3, nbOther: 1 })] }),
  ];

  it('includes accelerator positions by default, matching the prototype', () => {
    const m = fundMetrics(db(roster), OPTS);
    expect(m.invested).toBe(11);
    expect(m.fmv).toBe(22);
    expect(m.nActive).toBe(2);
  });

  it('removes exactly the accelerator contribution and nothing else', () => {
    const all = fundMetrics(db(roster), { ...OPTS, includeAccelerator: true });
    const core = fundMetrics(db(roster), { ...OPTS, includeAccelerator: false });
    expect(core.invested).toBe(all.invested - 1);
    expect(core.fmv).toBe(all.fmv - 2);
    expect(core.fte).toBe(all.fte - 5);
    expect(core.roundsTotal).toBe(all.roundsTotal - 3);
    expect(core.nbCapital).toBe(all.nbCapital - 1);
    expect(core.nActive).toBe(1);
  });

  it('leaves FMV growth untouched -- navHistory has no company dimension', () => {
    const history = { navHistory: [{ q: '2025-Q1', nav: 100, cost: 80 }, { q: '2025-Q2', nav: 110, cost: 82 }] };
    const all = fundMetrics(db(roster, history), { ...OPTS, includeAccelerator: true });
    const core = fundMetrics(db(roster, history), { ...OPTS, includeAccelerator: false });
    expect(core.fmvQoQ).toBe(all.fmvQoQ);
  });
});

/* -------------------------- xirr edge cases ------------------------- */

describe('xirr edge cases', () => {
  it('returns null on fewer than two flows', () => {
    expect(xirr([])).toBeNull();
    expect(xirr([{ date: '2024-01-01', amt: -10 }])).toBeNull();
  });

  it('returns null when the NPV never changes sign across the bracket', () => {
    // All outflows: there is no rate at which this returns capital.
    expect(xirr([{ date: '2024-01-01', amt: -10 }, { date: '2025-01-01', amt: -5 }])).toBeNull();
  });

  it('solves a clean doubling over one year', () => {
    const r = xirr([{ date: '2024-01-01', amt: -100 }, { date: '2025-01-01', amt: 200 }]);
    // 2024 is a leap year, so this spans 366 days against an ACT/365.25 year.
    // The extra 0.75 of a day is why it lands just under 100%, not on it.
    expect(r).toBeCloseTo(99.716, 3);
  });

  it('returns a negative rate for a loss inside the bracket', () => {
    const r = xirr([{ date: '2024-01-01', amt: -100 }, { date: '2025-01-01', amt: 50 }]);
    expect(r).toBeLessThan(0);
    expect(r).toBeGreaterThan(-95);
  });

  it('returns null for a loss worse than the -95% bracket floor', () => {
    // Recovering 0.0001 on 100 is worse than -95%/yr, so the NPV is negative at
    // BOTH ends of the bracket and the sign-change test bails. The prototype
    // reports "cannot say" rather than clamping to the floor -- which is the
    // honest answer, since the true rate lies outside what it will search.
    // A near-total write-off therefore shows "-", not a huge negative number.
    expect(xirr([{ date: '2024-01-01', amt: -100 }, { date: '2025-01-01', amt: 0.0001 }])).toBeNull();
  });
});

/* ----------------------- other frozen behaviour --------------------- */

describe('moic', () => {
  it('returns null with no cost basis, and 0 for a total write-off', () => {
    expect(moic(company({ invested: 0, fmv: 0, realized: 0 }))).toBeNull();
    expect(moic(company({ invested: 5, fmv: 0, realized: 0 }))).toBe(0);
    // The display distinguishes them, which is the point.
    expect(fmt.x(null)).toBe('-');
    expect(fmt.x(0)).toBe('0.00x');
  });

  it('counts realizations toward the multiple', () => {
    expect(moic(company({ invested: 10, fmv: 5, realized: 15 }))).toBe(2);
  });
});

describe('suggestedReserve', () => {
  it('excludes exited, non-pro-rata and red positions', () => {
    expect(suggestedReserve(company({ exited: true }))).toBe(0);
    expect(suggestedReserve(company({ proRata: false }))).toBe(0);
    expect(suggestedReserve(company({ health: 'red' }))).toBe(0);
  });

  it('applies 0.8x for green and 0.5x for yellow, on the FIRST round', () => {
    const rounds = [round({ invested: 10 }), round({ invested: 99 })];
    expect(suggestedReserve(company({ health: 'green', rounds }))).toBe(8);
    expect(suggestedReserve(company({ health: 'yellow', rounds }))).toBe(5);
  });

  it('falls back to total invested when there are no rounds', () => {
    expect(suggestedReserve(company({ health: 'green', invested: 10, rounds: [] }))).toBe(8);
  });

  it('rounds to one decimal INSIDE the metric', () => {
    // INHERITED-COERCIONS.md §10 -- a portfolio total is a sum of rounded values.
    expect(suggestedReserve(company({ health: 'green', rounds: [round({ invested: 1.11 })] }))).toBe(0.9);
  });
});

describe('healthAlerts', () => {
  const kpi = (runwayMo: number) => [{ period: '2026-Q1', revenue: 1, burn: 0.5, cash: 1, runwayMo }];

  it('fires red below six months and yellow below the threshold', () => {
    expect(healthAlerts(db([company({ kpis: kpi(4) })]))[0]!.sev).toBe('red');
    expect(healthAlerts(db([company({ kpis: kpi(9) })]))[0]!.sev).toBe('yellow');
  });

  it('does not fire when a threshold is absent or zero', () => {
    // INHERITED-COERCIONS.md §7: the truthiness gate means 0 DISABLES the
    // alert rather than firing it on everything.
    expect(healthAlerts(db([company({ kpis: kpi(1), thresholds: {} })]))).toHaveLength(0);
    expect(healthAlerts(db([company({ kpis: kpi(1), thresholds: { minRunwayMo: 0 } })]))).toHaveLength(0);
  });

  it('suppresses a risk flag matching /Runway/i to avoid double-reporting', () => {
    // Control flow on display text. Rename the flag and the dedupe silently stops.
    const withFlag = healthAlerts(db([company({ kpis: kpi(4), riskFlags: ['Runway below 12 months'] })]));
    expect(withFlag).toHaveLength(1);
    const renamed = healthAlerts(db([company({ kpis: kpi(4), riskFlags: ['Cash below 12 months'] })]));
    expect(renamed).toHaveLength(2);
  });

  it('skips exited companies entirely', () => {
    expect(healthAlerts(db([company({ exited: true, kpis: kpi(1), riskFlags: ['Anything'] })]))).toHaveLength(0);
  });
});

describe('runScenario', () => {
  it('falls back to a post-money, then to 50, when ownership is zero', () => {
    // INHERITED-COERCIONS.md §12 -- the magic 50.
    const viaPostMoney = scenarioDefaults(company({ ownershipPct: 0, rounds: [round({ postMoney: 200 })] }));
    expect(viaPostMoney.pre).toBe(240); // 200 * 1.2
    const viaMagic = scenarioDefaults(company({ ownershipPct: 0, rounds: [] }));
    expect(viaMagic.pre).toBe(60); // 50 * 1.2
  });

  it('pays the preference pro rata below the stack and converts above it', () => {
    const c = company({ invested: 10, ownershipPct: 20, proRata: false });
    const s = { ...scenarioDefaults(c), participate: false, totalPref: 40, pre: 90, raise: 10, pool: 0 };
    const r = runScenario(c, s);
    expect(r.totalPref).toBe(50); // 40 + 0 + (10 - 0)
    expect(r.proceedsAt(0)).toBe(0);
    expect(r.proceedsAt(50)).toBeCloseTo(10, 10); // exactly our pref at the kink
    expect(r.proceedsAt(25)).toBeCloseTo(5, 10); // half the stack, half our pref
    expect(r.proceedsAt(1000)).toBeCloseTo((r.ownAfter / 100) * 1000, 10);
  });

  it('never pays less than the preference above the kink', () => {
    const c = company({ invested: 10, ownershipPct: 1, proRata: false });
    const s = { ...scenarioDefaults(c), participate: false, totalPref: 20, pre: 90, raise: 10, pool: 0 };
    const r = runScenario(c, s);
    expect(r.proceedsAt(40)).toBe(r.ourPref);
  });

  it('returns a multiple of 0, not null, when there is no invested total', () => {
    // INHERITED-COERCIONS.md §11 -- the opposite convention to moic().
    const c = company({ invested: 0, ownershipPct: 10, proRata: false });
    const r = runScenario(c, { ...scenarioDefaults(c), participate: false });
    expect(r.cases[0]![1].mo).toBe(0);
    expect(r.cases[0]![1].irr).toBeNull();
  });
});

describe('formatter guards', () => {
  it('switches to billions at an absolute value of 1000', () => {
    expect(fmt.m(999.9)).toBe('$999.9M');
    expect(fmt.m(1000)).toBe('$1.00B');
    expect(fmt.m(1092.1)).toBe('$1.09B');
  });

  it('renders a negative with the sign inside the currency symbol', () => {
    // INHERITED-COERCIONS.md §5.
    expect(fmt.m(-5)).toBe('$-5.0M');
  });

  it('guards isFinite in fmt.x only', () => {
    // The inconsistency is inherited. Asserted so a "tidy-up" fails loudly.
    expect(fmt.x(Infinity)).toBe('-');
    expect(fmt.m(Infinity)).toBe('$InfinityB');
    expect(fmt.pct(Infinity)).toBe('$Infinity%'.replace('$', ''));
  });

  it('renders null and NaN as a dash everywhere', () => {
    for (const f of [fmt.m, fmt.x, fmt.pct, fmt.pct0]) {
      expect(f(null)).toBe('-');
      expect(f(NaN)).toBe('-');
    }
  });

  it('renders an empty string as a dash, by truthiness', () => {
    expect(fmt.d('')).toBe('-');
    expect(fmt.d(null)).toBe('-');
    expect(fmt.d('2026-03-31')).toBe('2026-03-31');
  });
});
