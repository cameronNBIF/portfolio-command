/**
 * Tests for A6's generator planners.
 *
 * These cover the half that has no database in it, which is the half where a
 * mistake is silent: `run.ts` reconciles against Postgres and refuses to commit
 * when a total is wrong, so a bug there is loud. A bug in the split arithmetic
 * or the mark path is only visible as a number that looks slightly off.
 *
 * The exactness assertions are the point. Everything else about this dataset is
 * invented; the totals are not.
 */
import { describe, expect, test } from 'vitest';

import { planCompany, splitExact, toCents, type CompanyFacts } from '../src/generate/plan.js';
import { planLpPositions } from '../src/generate/lp.js';
import { Rng, mulberry32, hashSeed } from '../src/generate/rng.js';

const facts = (over: Partial<CompanyFacts> = {}): CompanyFacts => ({
  companyId: 'C001',
  name: 'Test Co',
  yearFounded: 2014,
  investedCents: 100_000_000, // $1,000,000
  fmvCents: 150_000_000, // $1,500,000
  riskGrade: 'B',
  lifecycleStatus: null,
  rosterStatus: 'Portfolio',
  vehicle: 'VCF',
  firstKpiYear: 2021,
  ...over,
});

describe('mulberry32', () => {
  test('reproduces the prototype generator exactly', () => {
    // vc-toolkit.html seeds with 42; these are the first values that stream
    // produces. If this test fails the port has drifted from the precedent.
    const r = mulberry32(42);
    expect(r()).toBeCloseTo(0.6011037519201636, 15);
    expect(r()).toBeCloseTo(0.44829055899754167, 15);
  });

  test('the same seed gives the same stream', () => {
    const a = Array.from({ length: 5 }, mulberry32(7));
    const b = Array.from({ length: 5 }, mulberry32(7));
    expect(a).toEqual(b);
  });

  test('hashSeed is stable and differs per key', () => {
    expect(hashSeed('C001')).toBe(hashSeed('C001'));
    expect(hashSeed('C001')).not.toBe(hashSeed('C002'));
  });
});

describe('splitExact', () => {
  const rng = () => new Rng('split-fixture');

  test('one round takes the whole total', () => {
    expect(splitExact(2_500_000, 1, rng())).toEqual([2_500_000]);
  });

  test('sums to the total exactly, for every round count', () => {
    for (let n = 1; n <= 8; n++) {
      const parts = splitExact(157_538_100, n, new Rng(`n${n}`));
      expect(parts).toHaveLength(n);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(157_538_100);
      expect(parts.every((p) => p > 0)).toBe(true);
    }
  });

  /**
   * The odd control totals are the interesting ones -- Inversa's $1,575,381 and
   * Smart Skin's $1,601,454 are not round numbers, and the remainder has to
   * land somewhere rather than being rounded away.
   */
  test.each([
    ['Inversa Systems', 157_538_100],
    ['Smart Skin', 160_145_400],
    ['Sonrai Security', 71_324_300],
    ['Populus Global', 157_160_000],
    ['an accelerator cheque', 2_500_000],
  ])('reconciles an odd real total: %s', (_name, total) => {
    for (let n = 1; n <= 6; n++) {
      const parts = splitExact(total, n, new Rng(`${total}:${n}`));
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  test('every cheque but the last is a whole number of thousands', () => {
    const parts = splitExact(157_538_100, 5, new Rng('thousands'));
    for (const p of parts.slice(0, -1)) expect(p % 100_000).toBe(0);
  });
});

describe('planCompany', () => {
  test('transactions sum to the control total, exactly', () => {
    for (const invested of [2_500_000, 5_000_000, 30_500_000, 157_538_100, 305_000_000]) {
      const plan = planCompany(facts({ investedCents: invested, fmvCents: invested * 2 }));
      const sum = plan.transactions
        .filter((t) => t.type === 'investment' || t.type === 'follow_on')
        .reduce((a, t) => a + t.amountCents, 0);
      expect(sum).toBe(invested);
    }
  });

  test('the round cheques sum to the control total too', () => {
    const plan = planCompany(facts({ investedCents: 157_538_100 }));
    expect(plan.rounds.reduce((a, r) => a + r.chequeCents, 0)).toBe(157_538_100);
  });

  test('the final mark is the FMV control total, exactly', () => {
    for (const fmv of [0, 1, 28_065_800, 513_251_300]) {
      const plan = planCompany(facts({ fmvCents: fmv }));
      expect(plan.marks.at(-1)!.fmvCents).toBe(fmv);
    }
  });

  test('the final mark is dated at the last exercise, so as-of resolves to it', () => {
    const plan = planCompany(facts());
    expect(plan.marks.at(-1)!.date).toBe('2026-07-31');
  });

  test('a written-off position gets a write-off mark and no negative values', () => {
    const plan = planCompany(facts({ fmvCents: 0 }));
    expect(plan.marks.at(-1)!.fmvCents).toBe(0);
    expect(plan.marks.at(-1)!.method).toBe('Write-off');
    expect(plan.marks.every((m) => m.fmvCents >= 0)).toBe(true);
  });

  /**
   * F4 REWROTE THIS TEST, AND THE REWRITE IS THE CORRECTION.
   *
   * It used to assert that an exit follows the LIFECYCLE status -- "Winding
   * Down" -- which is a different Affinity field from the roster Status that
   * decides membership. Under ADR-036 a company winding down is still a
   * portfolio company until the roster says it has left, and seven companies on
   * today's dashboard were counted as exited on the strength of the wrong
   * field. The old assertion is what kept that in place.
   */
  test('an exit row follows the ROSTER status, not the lifecycle status', () => {
    expect(planCompany(facts({ fmvCents: 0 })).exit).toBeNull();

    // Winding down and written to nil, and still a portfolio company.
    const windingDown = planCompany(facts({ fmvCents: 0, lifecycleStatus: 'Winding Down' }));
    expect(windingDown.exit).toBeNull();
    expect(windingDown.transactions.some((t) => t.type === 'write_off')).toBe(true);

    const exited = planCompany(facts({ fmvCents: 0, rosterStatus: 'Exited' }));
    expect(exited.exit?.type).toBe('Shutdown / write-off');
    expect(exited.transactions.some((t) => t.type === 'write_off')).toBe(true);
  });

  /**
   * ADR-036 clause 2, in the demo data rather than only in the ADR: Finance
   * books the write-off in March and Affinity is updated in June, so a written
   * -off position sitting on the roster is a state the dataset should contain.
   * It is what the F6 reconciliation surface will have to find.
   */
  test('a written-off position still on the roster keeps its write-off and has no exit', () => {
    const plan = planCompany(facts({ fmvCents: 0, lifecycleStatus: 'Winding Down' }));
    expect(plan.transactions.filter((t) => t.type === 'write_off')).toHaveLength(1);
    expect(plan.exit).toBeNull();
  });

  test('a write-off transaction does not count toward invested', () => {
    const plan = planCompany(facts({ fmvCents: 0, lifecycleStatus: 'Winding Down' }));
    const invested = plan.transactions
      .filter((t) => t.type === 'investment' || t.type === 'follow_on')
      .reduce((a, t) => a + t.amountCents, 0);
    expect(invested).toBe(facts().investedCents);
  });

  test('rounds are chronological and the first is the only `investment`', () => {
    const plan = planCompany(facts({ investedCents: 305_000_000 }));
    const dates = plan.rounds.map((r) => r.date);
    expect([...dates].sort()).toEqual(dates);
    expect(plan.transactions.filter((t) => t.type === 'investment')).toHaveLength(1);
  });

  test('no round is dated after the final mark', () => {
    for (let i = 0; i < 60; i++) {
      const plan = planCompany(facts({ companyId: `C${String(i).padStart(3, '0')}` }));
      for (const r of plan.rounds) expect(r.date <= '2026-07-31').toBe(true);
    }
  });

  test('the first round never predates the company', () => {
    for (const yearFounded of [2005, 2012, 2019, 2024]) {
      const plan = planCompany(facts({ yearFounded }));
      expect(Number(plan.rounds[0]!.date.slice(0, 4))).toBeGreaterThanOrEqual(yearFounded);
    }
  });

  test('an accelerator position is a single small cheque', () => {
    const plan = planCompany(facts({ vehicle: 'ACC', investedCents: 2_500_000 }));
    expect(plan.rounds).toHaveLength(1);
    expect(plan.stage).toBe('Pre-Seed');
  });

  test('ownership stays inside the column constraint', () => {
    for (let i = 0; i < 80; i++) {
      const plan = planCompany(facts({ companyId: `C${i}`, investedCents: 305_000_000 }));
      for (const o of plan.ownership) {
        expect(o.pct).toBeGreaterThan(0);
        expect(o.pct).toBeLessThanOrEqual(100);
      }
    }
  });

  test('nb_other never exceeds the round total', () => {
    for (let i = 0; i < 80; i++) {
      const plan = planCompany(facts({ companyId: `C${i}` }));
      for (const r of plan.rounds) {
        if (r.nbOtherCents !== null && r.roundTotalCents !== null) {
          expect(r.nbOtherCents).toBeLessThanOrEqual(r.roundTotalCents);
        }
      }
    }
  });

  test('old vintages are likelier to have no captured round total (ADR-012)', () => {
    let oldMissing = 0, oldTotal = 0, newMissing = 0, newTotal = 0;
    for (let i = 0; i < 400; i++) {
      const plan = planCompany(facts({ companyId: `C${i}`, investedCents: 305_000_000 }));
      for (const r of plan.rounds) {
        const old = Number(r.date.slice(0, 4)) < 2015;
        if (old) { oldTotal++; if (r.roundTotalCents === null) oldMissing++; }
        else { newTotal++; if (r.roundTotalCents === null) newMissing++; }
      }
    }
    expect(oldTotal).toBeGreaterThan(0);
    expect(oldMissing / oldTotal).toBeGreaterThan(newMissing / newTotal);
  });

  test('the same company id always produces the same plan', () => {
    expect(JSON.stringify(planCompany(facts()))).toBe(JSON.stringify(planCompany(facts())));
  });

  /**
   * Per-company seeding is what makes a regeneration reviewable: adding a
   * company to the roster must not rewrite every other company's history.
   */
  test('a different company id produces a different plan', () => {
    const a = planCompany(facts({ companyId: 'C001' }));
    const b = planCompany(facts({ companyId: 'C002' }));
    expect(JSON.stringify(a.rounds)).not.toBe(JSON.stringify(b.rounds));
  });

  test('LP co-investors only appear when a roster is supplied', () => {
    const without = planCompany(facts({ investedCents: 305_000_000 }));
    expect(without.rounds.flatMap((r) => r.coinvestors).every((c) => c.lpFund === null)).toBe(true);

    let found = false;
    for (let i = 0; i < 60 && !found; i++) {
      const plan = planCompany(facts({ companyId: `C${i}`, investedCents: 305_000_000 }), [
        'Concrete Ventures',
        'Brightspark Ventures',
      ]);
      found = plan.rounds.flatMap((r) => r.coinvestors).some((c) => c.lpFund !== null);
    }
    expect(found).toBe(true);
  });
});

describe('planLpPositions', () => {
  // The real workbook figures.
  const funds = [
    { name: 'Propel', committed: 500_000, called: 488_819, remaining: 11_181 },
    { name: 'Energia Ventures', committed: 500_000, called: 500_000, remaining: 0 },
    { name: 'Sandpiper Ventures', committed: 1_000_000, called: 98_118, remaining: 901_882 },
    { name: 'Sandpiper Ventures II', committed: 1_000_000, called: 463_477, remaining: 536_523 },
    { name: 'Island Capital Partners', committed: 500_000, called: 0, remaining: 500_000 },
    { name: 'Accelerators', committed: 175_000, called: 175_000, remaining: 0 },
  ];

  test('capital calls sum to the real called figure, exactly', () => {
    for (const p of planLpPositions(funds)) {
      const called = p.calls.reduce((a, c) => a + c.amountCents, 0);
      expect(called).toBe(p.calledCents);
    }
  });

  test('committed carries through untouched', () => {
    const plans = planLpPositions(funds);
    expect(plans.reduce((a, p) => a + p.committedCents, 0)).toBe(
      funds.reduce((a, f) => a + f.committed, 0) * 100,
    );
  });

  test('a position that has never been called has no calls and no NAV', () => {
    const island = planLpPositions(funds).find((p) => p.name === 'Island Capital Partners')!;
    expect(island.calls).toHaveLength(0);
    expect(island.navs).toHaveLength(0);
  });

  test('a fully called position has no estimated next call', () => {
    const energia = planLpPositions(funds).find((p) => p.name === 'Energia Ventures')!;
    expect(energia.nextCallEst).toBeNull();
  });

  /**
   * The draw-down heuristic dates Sandpiper II before Sandpiper I on the real
   * numbers -- the sequel is 46% called against the original's 10%. A sequel is
   * never older than the fund it succeeds.
   */
  test('a sequel fund is never dated before its predecessor', () => {
    const plans = planLpPositions(funds);
    const one = plans.find((p) => p.name === 'Sandpiper Ventures')!;
    const two = plans.find((p) => p.name === 'Sandpiper Ventures II')!;
    expect(two.vintageYear).toBeGreaterThan(one.vintageYear);
  });

  test('ids are allocated in workbook order', () => {
    expect(planLpPositions(funds).map((p) => p.fundInvestmentId)).toEqual([
      'F001', 'F002', 'F003', 'F004', 'F005', 'F006',
    ]);
  });

  /** Real, named firms. A guess about a real person's seniority is not worth a demo. */
  test('women_senior_gp is left unreported rather than invented', () => {
    expect(planLpPositions(funds).every((p) => p.womenSeniorGp === null)).toBe(true);
  });

  test('NAV never precedes the first capital call', () => {
    for (const p of planLpPositions(funds)) {
      if (!p.navs.length) continue;
      const firstCall = p.calls.map((c) => c.date).sort()[0]!;
      for (const n of p.navs) expect(n.date >= firstCall).toBe(true);
    }
  });

  test('a GP statement is received after the date it is as at', () => {
    for (const p of planLpPositions(funds)) {
      for (const n of p.navs) expect(n.receivedAt > n.date).toBe(true);
    }
  });
});

describe('toCents', () => {
  test('reads a Postgres numeric string without float drift', () => {
    expect(toCents('1575381.00')).toBe(157_538_100);
    expect(toCents('0.00')).toBe(0);
    expect(toCents('713243.00')).toBe(71_324_300);
  });
});
