/**
 * The port reproduces the prototype, exactly.
 *
 * Asserts every function in `packages/metrics/src` against the fixtures
 * captured from the committed prototype and the committed demo.json
 * (ADR-013, ADR-022).
 *
 * **A FAILURE HERE MEANS THE CODE IS WRONG, NEVER THE FIXTURE.** Do not edit
 * `fixtures/golden-master.json` to make a test pass. If a definition genuinely
 * needs to change, that is a decision recorded in docs/architecture-decisions.md
 * followed by a deliberate recapture, not an edit in the same commit as the
 * change it is hiding.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PortfolioExport } from '@portfolio-command/contract';
import { describe, expect, it } from 'vitest';

// The tolerance is shared with the capture harness's --check mode so there is
// one number, not two that can drift. Importing a constant does no I/O.
import { FLOAT_TOLERANCE } from './harness/prototype.js';
import {
  count,
  DISPLAY_LOCALE,
  fiDpi,
  fiIrr,
  fmt,
  fundMetrics,
  healthAlerts,
  lpMetrics,
  moic,
  ratio,
  runScenario,
  scenarioDefaults,
  signedPct,
  suggestedReserve,
  totalGainLoss,
  fiTvpi,
  xirr,
  type Cashflow,
} from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.resolve(here, p), 'utf8');

const demo = JSON.parse(read('../../../docs/reference/demo.json')) as PortfolioExport;
const golden = JSON.parse(read('./fixtures/golden-master.json')) as GoldenMaster;

const AS_OF = golden.capturedFrom.asOf;
const OPTS = { asOf: AS_OF };

/* ------------------------------------------------------------------ */

interface Frozen {
  value: number | null;
  display: string;
}
interface GoldenMaster {
  capturedFrom: { asOf: string; displayLocale: string; demoJsonSha256: string };
  counts: Record<string, number>;
  fundMetrics: Record<string, Frozen>;
  fiMetrics: Record<string, Frozen>;
  fundInvestments: { id: string; tvpi: Frozen; dpi: Frozen; irr: Frozen }[];
  xirr: { fundCashflowSeries: { flowCount: number; value: number | null; display: string } };
  companies: {
    id: string;
    name: string;
    moic: Frozen;
    suggestedReserve: Frozen;
    investedDisplay: string;
    fmvDisplay: string;
    gainLossDisplay: string;
  }[];
  healthAlerts: { companyId: string; sev: string; text: string }[];
  scenarios: {
    id: string;
    inputs: Record<string, number | boolean | null>;
    post: number;
    newInvPct: number;
    dilutionFactor: number;
    partAmt: number;
    ownAfter: number;
    investedTotal: number;
    ourPref: number;
    totalPref: number;
    proceedsAtSamples: { e: number; p: number }[];
    cases: {
      label: string;
      exitValue: number;
      proceeds: number;
      multiple: number;
      irr: number | null;
      proceedsDisplay: string;
      multipleDisplay: string;
      irrDisplay: string;
    }[];
  }[];
}

/**
 * Floats to 1e-12 RELATIVE (ADR-022).
 *
 * Deliberately looser than bit equality: reordering a `reduce` is not a change
 * to a board number, and exact equality would make these tests hostage to
 * summation order. Anything that survives 1e-12 and matters will also move the
 * display string, which IS asserted exactly.
 */
const RELATIVE_TOLERANCE = FLOAT_TOLERANCE;

function expectClose(actual: number | null | undefined, expected: number | null, label: string): void {
  if (expected === null) {
    expect(actual, `${label}: expected null`).toBeNull();
    return;
  }
  expect(actual, `${label}: expected a number, got ${String(actual)}`).toBeTypeOf('number');
  const a = actual as number;
  if (expected === 0) {
    expect(a, `${label}: expected exactly 0`).toBe(0);
    return;
  }
  const relative = Math.abs((a - expected) / expected);
  expect(relative, `${label}: ${a} vs frozen ${expected} (relative ${relative})`).toBeLessThan(RELATIVE_TOLERANCE);
}

function expectFrozen(actual: number | null | undefined, frozen: Frozen, display: string, label: string): void {
  expectClose(actual, frozen.value, label);
  expect(display, `${label} display string`).toBe(frozen.display);
}

/* ------------------------------------------------------------------ */

describe('fixture provenance', () => {
  it('is captured at the pinned asOf, not at a wall clock', () => {
    expect(AS_OF).toBe('2026-03-31');
  });

  it('covers the whole reference dataset', () => {
    expect(golden.counts.companies).toBe(demo.companies.length);
    expect(golden.counts.fundInvestments).toBe(demo.fundInvestments.length);
    expect(golden.companies).toHaveLength(demo.companies.length);
    expect(golden.scenarios).toHaveLength(demo.companies.length);
  });

  it('was captured under the same locale the port pins', () => {
    // The harness defines its own DISPLAY_LOCALE rather than importing this
    // one, so it does not depend on the implementation it checks (ADR-022).
    // This is the assertion that stops the two copies drifting apart -- and
    // that stops a job-count string differing for a locale reason rather than
    // a metric one.
    expect(golden.capturedFrom.displayLocale).toBe(DISPLAY_LOCALE);
  });
});

describe('fundMetrics', () => {
  const m = fundMetrics(demo, OPTS);

  // Formatter per field, matching the call site in the prototype's dashboard.
  const DISPLAY: Record<string, (v: number | null) => string> = {
    invested: fmt.m, fmv: fmt.m, realized: fmt.m, distributions: fmt.m,
    tvpi: fmt.x, dpi: fmt.x, rvpi: fmt.x,
    grossIRR: fmt.pct, netIRR: fmt.pct,
    netDeployed: fmt.m, dryPowder: fmt.m,
    leverage: ratio,
    capitalAttracted: fmt.m, roundsTotal: fmt.m, nbCapital: fmt.m, outsideCapital: fmt.m,
    fmvQoQ: signedPct, fmvYoY: signedPct, organicYoY: fmt.m,
    fte: count, fteAtEntry: count, fteNB: count,
    womenCos: (v) => (v == null ? '-' : String(v)),
    womenCosPct: fmt.pct0,
    womenExecs: (v) => (v == null ? '-' : String(v)),
    cSuiteTotal: (v) => (v == null ? '-' : String(v)),
    revenue: fmt.m, revQoQ: signedPct,
    nActive: (v) => (v == null ? '-' : String(v)),
    nExited: (v) => (v == null ? '-' : String(v)),
    unrealizedGL: fmt.m,
  };

  it('returns exactly the frozen field set, no more and no less', () => {
    expect(Object.keys(m).sort()).toEqual(Object.keys(golden.fundMetrics).sort());
  });

  for (const [field, frozen] of Object.entries(golden.fundMetrics)) {
    it(`${field} matches value and display`, () => {
      const actual = m[field as keyof typeof m];
      expectFrozen(actual, frozen, DISPLAY[field]!(actual), `fundMetrics.${field}`);
    });
  }

  it('is deterministic -- the same asOf gives the same IRR', () => {
    expect(fundMetrics(demo, OPTS).grossIRR).toBe(m.grossIRR);
  });
});

describe('lpMetrics', () => {
  const m = lpMetrics(demo, OPTS);

  const DISPLAY: Record<string, (v: number | null) => string> = {
    n: (v) => String(v), committed: fmt.m, called: fmt.m, unfunded: fmt.m,
    distributions: fmt.m, nav: fmt.m,
    tvpi: fmt.x, dpi: fmt.x, rvpi: fmt.x, irr: fmt.pct,
    coInvests: (v) => String(v), referrals: (v) => String(v),
    toDirect: fmt.m, womenGPs: (v) => String(v),
  };

  it('returns exactly the frozen field set', () => {
    expect(Object.keys(m).sort()).toEqual(Object.keys(golden.fiMetrics).sort());
  });

  for (const [field, frozen] of Object.entries(golden.fiMetrics)) {
    it(`${field} matches value and display`, () => {
      const actual = m[field as keyof typeof m];
      expectFrozen(actual, frozen, DISPLAY[field]!(actual), `lpMetrics.${field}`);
    });
  }
});

describe('per-position LP multiples', () => {
  for (const frozen of golden.fundInvestments) {
    it(`${frozen.id} TVPI, DPI and IRR`, () => {
      const f = demo.fundInvestments.find((x) => x.id === frozen.id)!;
      expect(f, `position ${frozen.id} missing from demo.json`).toBeDefined();
      expectFrozen(fiTvpi(f), frozen.tvpi, fmt.x(fiTvpi(f)), `${frozen.id}.tvpi`);
      expectFrozen(fiDpi(f), frozen.dpi, fmt.x(fiDpi(f)), `${frozen.id}.dpi`);
      expectFrozen(fiIrr(f, AS_OF), frozen.irr, fmt.pct(fiIrr(f, AS_OF)), `${frozen.id}.irr`);
    });
  }
});

describe('xirr', () => {
  it('reproduces the fund cashflow series independently of fundMetrics', () => {
    // Rebuilt exactly as fundMetrics builds it, so xirr is exercised on its own.
    const flows: Cashflow[] = [];
    demo.companies.forEach((c) => c.rounds.forEach((r) => flows.push({ date: r.date, amt: -r.invested })));
    demo.fund.distributions.forEach((d) => flows.push({ date: d.date, amt: d.amount }));
    flows.push({ date: AS_OF, amt: demo.companies.reduce((s, c) => s + c.fmv, 0) });

    const frozen = golden.xirr.fundCashflowSeries;
    expect(flows).toHaveLength(frozen.flowCount);
    const value = xirr(flows);
    expectClose(value, frozen.value, 'xirr(fund series)');
    expect(fmt.pct(value)).toBe(frozen.display);
  });

  it('agrees with fundMetrics.grossIRR to the last bit', () => {
    // Same inputs, same arithmetic -- these must be bit-identical, not merely close.
    expect(golden.xirr.fundCashflowSeries.value).toBe(golden.fundMetrics.grossIRR!.value);
  });
});

describe('per-company metrics', () => {
  for (const frozen of golden.companies) {
    it(`${frozen.id} ${frozen.name}`, () => {
      const c = demo.companies.find((x) => x.id === frozen.id)!;
      expect(c, `company ${frozen.id} missing from demo.json`).toBeDefined();

      const mo = moic(c);
      expectFrozen(mo, frozen.moic, fmt.x(mo), `${frozen.id}.moic`);

      const reserve = suggestedReserve(c);
      expectFrozen(reserve, frozen.suggestedReserve, reserve.toFixed(1), `${frozen.id}.suggestedReserve`);

      expect(c.invested.toFixed(1), `${frozen.id} invested display`).toBe(frozen.investedDisplay);
      expect(c.fmv.toFixed(1), `${frozen.id} fmv display`).toBe(frozen.fmvDisplay);

      const gl = totalGainLoss(c);
      expect(`${gl >= 0 ? '+' : ''}${gl.toFixed(1)}`, `${frozen.id} G/L display`).toBe(frozen.gainLossDisplay);
    });
  }
});

/**
 * THE ONE PLACE A9 DIVERGES FROM THE PROTOTYPE, ASSERTED RATHER THAN ABSORBED.
 *
 * `maxBurnMult` has been in the contract since v1 and sits on 68 of the
 * fixture's 70 companies. The prototype stored it and never computed anything
 * with it. ADR-032 gives it a rule -- quarterly net burn over quarterly net new
 * revenue -- and on this fixture that rule fires four times.
 *
 * WHY THE FIXTURE WAS NOT SIMPLY RECAPTURED WITH THE FOUR IN IT. It cannot be.
 * `capture.ts` produces the fixture by running the COMMITTED PROTOTYPE over the
 * committed demo.json, and the prototype has no burn-multiple rule, so a
 * recapture yields the same 39 it always did. `verify:fixtures --check`
 * compares the committed file against that same prototype output and names
 * hand-editing as the thing ADR-013 exists to prevent. The fixture is a
 * RECORDING OF THE PROTOTYPE, not a record of what this package currently does,
 * and it stays that way.
 *
 * So the divergence lives here, in full, as data. Four lines that someone has
 * to delete on purpose. The tests below assert both halves: that removing these
 * reproduces the prototype's 39 alerts exactly, in order, and that these are
 * the only additions. A fifth alert appearing anywhere fails the second test;
 * one of the 39 changing or moving fails the first.
 */
const A9_BURN_MULTIPLE_ADDITIONS = [
  { companyId: 'C002', sev: 'red', text: 'Burn multiple 14.0x (threshold 1.5x)' },
  { companyId: 'C009', sev: 'red', text: 'Burn multiple 5.3x (threshold 1.5x)' },
  { companyId: 'C001', sev: 'yellow', text: 'Burn multiple 1.9x (threshold 1.5x)' },
  { companyId: 'C008', sev: 'yellow', text: 'Burn multiple 1.6x (threshold 1.5x)' },
];

describe('healthAlerts', () => {
  const alerts = healthAlerts(demo);
  const flat = (xs: typeof alerts) => xs.map((a) => ({ companyId: a.company.id, sev: a.sev, text: a.text }));

  const isA9 = (a: (typeof alerts)[number]) => a.metric === 'burn-multiple';
  const inherited = alerts.filter((a) => !isA9(a));
  const added = alerts.filter(isA9);

  it('still produces every prototype alert, and only those, once A9 additions are set aside', () => {
    expect(flat(inherited)).toHaveLength(golden.healthAlerts.length);
  });

  it('still produces the prototype alerts IN THE SAME ORDER', () => {
    // Order is part of the output. The comparator is two-valued and leans on
    // sort stability for everything else; a different sort would reorder ties
    // and change what the dashboard's top-14 slice shows.
    expect(flat(inherited)).toEqual(golden.healthAlerts);
  });

  it('adds exactly the four burn-multiple alerts ADR-032 accounts for', () => {
    // Sorted, because the two-valued comparator interleaves these with the
    // inherited alerts and their absolute positions are not the assertion --
    // their existence and their count are.
    const by = (a: { companyId: string }, b: { companyId: string }) => a.companyId.localeCompare(b.companyId);
    expect(flat(added).sort(by)).toEqual([...A9_BURN_MULTIPLE_ADDITIONS].sort(by));
  });

  it('sorts every red alert ahead of every yellow one', () => {
    const firstYellow = alerts.findIndex((a) => a.sev === 'yellow');
    if (firstYellow === -1) return;
    expect(alerts.slice(firstYellow).every((a) => a.sev === 'yellow')).toBe(true);
  });

  /**
   * The fallback that makes all of the above possible. Everything else A9
   * added -- policy inheritance, the cash floor, revenue decline, NRR,
   * acknowledgements -- is gated on fields a schemaVersion 1 document does not
   * carry. If any of them ever acquires a hardcoded default, this test is what
   * notices, because the fixture would gain alerts nobody accounted for.
   */
  it('reads no fund policy from a schemaVersion 1 document', () => {
    expect(demo.alertPolicy).toBeUndefined();
    expect(alerts.some((a) => a.thresholdFrom === 'policy')).toBe(false);
  });
});

describe('scenarios', () => {
  for (const frozen of golden.scenarios) {
    it(`${frozen.id} defaults and waterfall`, () => {
      const c = demo.companies.find((x) => x.id === frozen.id)!;
      const inputs = scenarioDefaults(c);
      expect(inputs as unknown as Record<string, unknown>, `${frozen.id} scenario inputs`).toEqual(frozen.inputs);

      const r = runScenario(c, inputs);
      expectClose(r.post, frozen.post, `${frozen.id}.post`);
      expectClose(r.newInvPct, frozen.newInvPct, `${frozen.id}.newInvPct`);
      expectClose(r.dilutionFactor, frozen.dilutionFactor, `${frozen.id}.dilutionFactor`);
      expectClose(r.partAmt, frozen.partAmt, `${frozen.id}.partAmt`);
      expectClose(r.ownAfter, frozen.ownAfter, `${frozen.id}.ownAfter`);
      expectClose(r.investedTotal, frozen.investedTotal, `${frozen.id}.investedTotal`);
      expectClose(r.ourPref, frozen.ourPref, `${frozen.id}.ourPref`);
      expectClose(r.totalPref, frozen.totalPref, `${frozen.id}.totalPref`);

      // proceedsAt is a closure, frozen as a sampled curve.
      for (const sample of frozen.proceedsAtSamples) {
        expectClose(r.proceedsAt(sample.e), sample.p, `${frozen.id}.proceedsAt(${sample.e})`);
      }

      expect(r.cases).toHaveLength(frozen.cases.length);
      r.cases.forEach(([label, k], i) => {
        const f = frozen.cases[i]!;
        expect(label, `${frozen.id} case ${i} label`).toBe(f.label);
        expectClose(k.E, f.exitValue, `${frozen.id}.${label}.E`);
        expectClose(k.p, f.proceeds, `${frozen.id}.${label}.proceeds`);
        expectClose(k.mo, f.multiple, `${frozen.id}.${label}.multiple`);
        expectClose(k.irr, f.irr, `${frozen.id}.${label}.irr`);
        expect(fmt.m(k.p), `${frozen.id}.${label} proceeds display`).toBe(f.proceedsDisplay);
        expect(fmt.x(k.mo), `${frozen.id}.${label} multiple display`).toBe(f.multipleDisplay);
        expect(fmt.pct(k.irr), `${frozen.id}.${label} irr display`).toBe(f.irrDisplay);
      });
    });
  }
});
