/**
 * Golden-master capture (ADR-022).
 *
 * Runs the committed prototype over the committed demo.json and freezes every
 * metric it produces -- full-precision value AND the display string the board
 * actually reads. Writes test/fixtures/golden-master.json.
 *
 * Run with: npm run capture:fixtures -w @portfolio-command/metrics
 *
 * This script fails loudly or not at all. If the prototype throws, if the
 * demo.json identity check fails, or if any captured number comes back
 * undefined, it exits non-zero having written nothing. A partial fixture set
 * freezes the subset that happened to succeed and silently drops the rest,
 * which is worse than no fixtures.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AS_OF,
  DISPLAY_LOCALE,
  assertDemoMatchesBoot,
  loadDemoJson,
  loadPrototype,
  type PrototypeApi,
  type PrototypeCompany,
} from './prototype.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PATH = path.join(here, '../fixtures/golden-master.json');

/* ------------------------------------------------------------------ *
 * Display-string mapping.
 *
 * Each fundMetrics field is formatted the way the UI formats it, not with a
 * blanket formatter. Three fields are not rendered through `fmt` at all --
 * leverage as "N.N : 1", the FMV growth percentages with an explicit sign,
 * the job counts through toLocaleString -- so those are reproduced here from
 * the call sites they appear at (vc-toolkit.html renderDashboard).
 * ------------------------------------------------------------------ */
type Formatter = (v: number | null, fmt: PrototypeApi['fmt']) => string;

const asM: Formatter = (v, fmt) => fmt.m(v);
const asX: Formatter = (v, fmt) => fmt.x(v);
const asPct: Formatter = (v, fmt) => fmt.pct(v);
const asInt: Formatter = (v) => (v == null ? '-' : String(v));
/** renderDashboard :703 -- `m.fte.toLocaleString()`. Locale-sensitive by construction. */
const asCount: Formatter = (v) => (v == null ? '-' : v.toLocaleString(DISPLAY_LOCALE));
/** renderDashboard :700 -- `m.leverage.toFixed(1)+" : 1"`. */
const asRatio: Formatter = (v) => (v == null ? '-' : `${v.toFixed(1)} : 1`);
/** renderDashboard :699,:702 -- `(v>=0?"+":"")+v.toFixed(1)+"%"`. */
const asSignedPct: Formatter = (v) => (v == null ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
/** renderDashboard :704 -- `Math.round(m.womenCosPct)+"%"`. */
const asRoundedPct: Formatter = (v) => (v == null ? '-' : `${Math.round(v)}%`);

const FUND_METRIC_FORMAT: Record<string, Formatter> = {
  invested: asM, fmv: asM, realized: asM, distributions: asM,
  tvpi: asX, dpi: asX, rvpi: asX,
  grossIRR: asPct, netIRR: asPct,
  netDeployed: asM, dryPowder: asM,
  leverage: asRatio,
  capitalAttracted: asM, roundsTotal: asM, nbCapital: asM, outsideCapital: asM,
  fmvQoQ: asSignedPct, fmvYoY: asSignedPct, organicYoY: asM,
  fte: asCount, fteAtEntry: asCount, fteNB: asCount,
  womenCos: asInt, womenCosPct: asRoundedPct, womenExecs: asInt, cSuiteTotal: asInt,
  revenue: asM, revQoQ: asSignedPct,
  nActive: asInt, nExited: asInt,
  unrealizedGL: asM,
};

const FI_METRIC_FORMAT: Record<string, Formatter> = {
  n: asInt, committed: asM, called: asM, unfunded: asM, distributions: asM, nav: asM,
  tvpi: asX, dpi: asX, rvpi: asX, irr: asPct,
  coInvests: asInt, referrals: asInt, toDirect: asM, womenGPs: asInt,
};

interface Frozen { value: number | null; display: string }

function freeze(
  bag: Record<string, number | null>,
  formats: Record<string, Formatter>,
  fmt: PrototypeApi['fmt'],
  label: string,
): Record<string, Frozen> {
  const out: Record<string, Frozen> = {};
  for (const [key, value] of Object.entries(bag)) {
    if (value === undefined) throw new Error(`${label}.${key} is undefined. Refusing to write a fixture.`);
    if (typeof value === 'number' && Number.isNaN(value)) {
      // NaN is a legitimate prototype output in some coercion paths; freeze it
      // explicitly rather than letting JSON turn it into null on the way out.
      out[key] = { value: null, display: (formats[key] ?? asM)(value, fmt) };
      continue;
    }
    const format = formats[key];
    if (!format) throw new Error(`${label}.${key} has no display mapping. Add one before capturing.`);
    out[key] = { value, display: format(value, fmt) };
  }
  return out;
}

function capture() {
  const { api, bootDb, prototypeSha256, scriptBytes } = loadPrototype();
  const { demo, sha256: demoSha256 } = loadDemoJson();

  assertDemoMatchesBoot(bootDb, demo);
  api.DB = demo;

  const { fmt } = api;
  const companies = demo.companies;
  const positions = demo.fundInvestments;

  /* ---- fundMetrics: the whole bag, one function, per ADR-022 ---- */
  const fundMetrics = freeze(api.fundMetrics(), FUND_METRIC_FORMAT, fmt, 'fundMetrics');

  /* ---- determinism guard: the pinned clock must make this repeatable ---- */
  const second = api.fundMetrics();
  if (second.grossIRR !== (fundMetrics.grossIRR?.value ?? null)) {
    throw new Error(
      'fundMetrics().grossIRR is not repeatable within a single run even with the ' +
        'clock pinned. The AS_OF pin is not taking effect (ADR-021). No fixtures written.',
    );
  }

  /* ---- fiMetrics + per-position multiples ---- */
  const fiMetrics = freeze(api.fiMetrics(), FI_METRIC_FORMAT, fmt, 'fiMetrics');
  const fundInvestments = positions.map((f) => ({
    id: f.id,
    tvpi: { value: api.fiTvpi(f), display: fmt.x(api.fiTvpi(f)) },
    dpi: { value: api.fiDpi(f), display: fmt.x(api.fiDpi(f)) },
    irr: { value: api.fiIrr(f), display: fmt.pct(api.fiIrr(f)) },
  }));

  /* ---- xirr, exercised directly on the fund cashflow series ----
     Rebuilt exactly as fundMetrics builds it (vc-toolkit.html :599-603), so
     xirr is frozen independently of the bag that consumes it. */
  const fundFlows: { date: string; amt: number }[] = [];
  companies.forEach((c) => c.rounds.forEach((r) => fundFlows.push({ date: r.date, amt: -r.invested })));
  (demo.fund.distributions as { date: string; amount: number }[]).forEach((d) =>
    fundFlows.push({ date: d.date, amt: d.amount }),
  );
  fundFlows.push({ date: AS_OF, amt: companies.reduce((s, c) => s + c.fmv, 0) });
  const xirrFundSeries = api.xirr(fundFlows.map((f) => ({ date: new Date(f.date), amt: f.amt })));

  /* ---- per company: moic, suggestedReserve, and the portfolio-table strings ---- */
  const perCompany = companies.map((c) => {
    const mo = api.moic(c);
    const reserve = api.suggestedReserve(c);
    if (reserve === undefined) throw new Error(`suggestedReserve(${c.id}) is undefined.`);
    return {
      id: c.id,
      name: c.name,
      exited: Boolean(c.exited),
      moic: { value: mo, display: fmt.x(mo) },
      suggestedReserve: { value: reserve, display: reserve.toFixed(1) },
      // renderPortfolioTable :867-870 -- what the table actually prints
      investedDisplay: c.invested.toFixed(1),
      fmvDisplay: c.fmv.toFixed(1),
      gainLossDisplay: (() => {
        const gl = c.fmv + c.realized - c.invested;
        return `${gl >= 0 ? '+' : ''}${gl.toFixed(1)}`;
      })(),
    };
  });

  /* ---- healthAlerts: order matters (the sort is two-valued and relies on
         Array.prototype.sort stability), so freeze the sequence ---- */
  const healthAlerts = api.healthAlerts().map((a) => ({ companyId: a.c.id, sev: a.sev, text: a.text }));

  /* ---- runScenario over scenarioDefaults, every company ----
         `proceedsAt` is a closure and cannot be serialised, so it is sampled
         at the kink (totalPref) and at the three case exit values (ADR-022). */
  const scenarios = companies.map((c: PrototypeCompany) => {
    const inputs = api.scenarioDefaults(c);
    const r = api.runScenario(c, inputs);
    const samples = [0, r.totalPref, Number(inputs.bear), Number(inputs.base), Number(inputs.bull)];
    return {
      id: c.id,
      inputs,
      post: r.post,
      newInvPct: r.newInvPct as number,
      dilutionFactor: r.dilutionFactor as number,
      partAmt: r.partAmt as number,
      ownAfter: r.ownAfter,
      investedTotal: r.investedTotal,
      ourPref: r.ourPref,
      totalPref: r.totalPref,
      proceedsAtSamples: samples.map((e) => ({ e, p: r.proceedsAt(e) })),
      cases: r.cases.map(([label, k]) => ({
        label,
        exitValue: k.E,
        proceeds: k.p,
        multiple: k.mo,
        irr: k.irr,
        proceedsDisplay: fmt.m(k.p),
        multipleDisplay: fmt.x(k.mo),
        irrDisplay: fmt.pct(k.irr),
      })),
    };
  });

  return {
    $comment: [
      'GOLDEN MASTER -- generated, do not hand-edit.',
      'Captured by packages/metrics/test/harness/capture.ts from the committed',
      'prototype and the committed demo.json (ADR-013, ADR-022).',
      '',
      'A failing golden-master test means the CODE is wrong, never the fixture.',
      'This freezes fidelity to the prototype, NOT correctness: it reproduces the',
      "prototype's coercions and quirks deliberately. Those are inventoried in",
      'INHERITED-COERCIONS.md, which is where a correctness review starts.',
    ],
    capturedFrom: {
      prototype: 'docs/reference/vc-toolkit.html',
      prototypeSha256,
      inlineScriptBytes: scriptBytes,
      demoJson: 'docs/reference/demo.json',
      demoJsonSha256: demoSha256,
      demoMatchesPrototypeBootState: true,
      asOf: AS_OF,
      asOfNote:
        'fundMetrics/fiMetrics/fiIrr date their terminal NAV with new Date(). Pinned ' +
        'to AS_OF so the IRR figures are reproducible (ADR-021). Arithmetic unchanged.',
      displayLocale: DISPLAY_LOCALE,
      localeNote:
        'fte / fteAtEntry / fteNB display strings come from Number.toLocaleString(), which ' +
        'the prototype calls with NO locale -- so in a browser it follows the reader machine ' +
        'and there is no single correct string to freeze. Pinned here and in src/format.ts ' +
        'so the capture reproduces on a Windows laptop and a Linux runner alike.',
    },
    coverageGaps: [
      'LEVERAGE EXCLUSION NEVER EXERCISED: all 78 rounds have roundTotal > 0 and ' +
        'roundTotal >= invested. The exclusion predicate frozen by ADR-012/ADR-013 has ' +
        'zero negative cases here. Cover it with constructed unit tests.',
      'DIVERSITY NULLS NEVER EXERCISED: all 70 companies carry numeric womenCSuite and ' +
        'cSuiteSize. The (c.womenCSuite||0) coercion -- and the D-5 departure that will ' +
        'replace it -- produce identical output on this fixture.',
      'SAME-STORE REVENUE runs over 7 companies of 64; 57 carry one KPI period and 6 none.',
      'OUTSIDE-CAPITAL CLAMP NEVER ENGAGED at aggregate level: Math.max(0, ...) in ' +
        'fundMetrics is never the binding constraint here, though one round does carry ' +
        'nbOther greater than its own third-party capital.',
      'ALL SIX EXITED COMPANIES carry fmv=0, fte=0 and ownershipPct=0, which masks three ' +
        'scope asymmetries in fundMetrics (jobs over all companies vs diversity over ' +
        'active; unrealizedGL mixing both). See INHERITED-COERCIONS.md.',
    ],
    counts: {
      companies: companies.length,
      active: companies.filter((c) => !c.exited).length,
      exited: companies.filter((c) => c.exited).length,
      rounds: companies.reduce((s, c) => s + c.rounds.length, 0),
      fundInvestments: positions.length,
      healthAlerts: healthAlerts.length,
      scenarios: scenarios.length,
    },
    fundMetrics,
    fiMetrics,
    fundInvestments,
    xirr: { fundCashflowSeries: { flowCount: fundFlows.length, value: xirrFundSeries, display: fmt.pct(xirrFundSeries) } },
    companies: perCompany,
    healthAlerts,
    scenarios,
  };
}

function main() {
  let fixture: ReturnType<typeof capture>;
  try {
    fixture = capture();
  } catch (err) {
    console.error('\nGOLDEN-MASTER CAPTURE FAILED. No fixture was written.\n');
    console.error(err);
    process.exit(1);
    return;
  }
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  const c = fixture.counts;
  console.log(`wrote ${path.relative(process.cwd(), FIXTURE_PATH)}`);
  console.log(
    `  ${c.companies} companies (${c.active} active / ${c.exited} exited), ${c.rounds} rounds, ` +
      `${c.fundInvestments} LP positions, ${c.healthAlerts} alerts, ${c.scenarios} scenarios`,
  );
  console.log(`  asOf ${fixture.capturedFrom.asOf}, locale ${fixture.capturedFrom.displayLocale}`);
}

main();
