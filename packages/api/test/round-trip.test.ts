/**
 * The A3 verification.
 *
 * ADR-021 names the residual risk this file exists to close:
 *
 *   "The adapter at A3 is the one component that can produce a well-typed
 *    contract object holding wrong numbers, and no golden-master test covers
 *    it -- the fixtures start at the contract, not at the database."
 *
 * So this does not test the adapter against itself. It loads `demo.json`
 * through the importer into a real Postgres, reads it back through the adapter,
 * and asserts the document that comes out is the document that went in. Every
 * intermediate step -- normalisation into 20-odd tables, the dollars/$M
 * boundary in both directions, reference resolution, array ordering, optional
 * field presence -- is covered by that single equality, and any of them getting
 * it wrong shows up here rather than on a board slide.
 *
 * Then it goes one step further and runs the A1 golden-master metrics over the
 * DATABASE-BUILT document, asserting the frozen board numbers survive the
 * storage round trip. A subtle adapter bug that deep-equality somehow tolerated
 * would still have to reproduce TVPI, DPI, IRR and leverage exactly.
 *
 * REQUIRES A DATABASE. Skipped when DATABASE_URL is unset so the no-services CI
 * job stays green; the database job sets it and runs these for real.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { config } from 'dotenv';
import pg from 'pg';

import type { PortfolioExport } from '@portfolio-command/contract';
import { fiDpi, fiIrr, fiTvpi, fundMetrics, lpMetrics, moic, xirr } from '@portfolio-command/metrics';

import { closeDb, db } from '../src/db.js';
import { importContract } from '../src/import/import-contract.js';
import { buildExport } from '../src/read/export.js';
import { readKpiCoverage } from '../src/read/kpi-coverage.js';
import { periodOf, toCalendarLabel } from '../src/periods.js';
import { toDollars, toMillions } from '../src/units.js';
import { assertTestDatabase } from './use-test-db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.resolve(here, p), 'utf8');

// vitest does not read the repo-root .env on its own, and a silently skipped
// suite is worse than a failing one -- this is the phase's verification.
config({ path: path.resolve(here, '../../../.env') });

const fixture = JSON.parse(read('../../../docs/reference/demo.json')) as PortfolioExport;
const golden = JSON.parse(read('../../metrics/test/fixtures/golden-master.json')) as {
  capturedFrom: { asOf: string };
  fundMetrics: Record<string, { value: number | null }>;
};

const ASOF = '2026-03-31';
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('ADR-001 contract round trip', () => {
  let actual: PortfolioExport;

  beforeAll(async () => {
    assertTestDatabase();
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query('begin');
      await client.query('set local search_path = pc, public');
      await importContract(client, fixture);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      await client.end();
    }
    actual = await buildExport(db(), { asOf: ASOF });
  }, 60_000);

  afterAll(async () => {
    await closeDb();
  });

  test('the pinned asOf matches the one the golden master was captured under', () => {
    // If these drift apart the metric assertions below silently start comparing
    // two different reporting dates.
    expect(golden.capturedFrom.asOf).toBe(ASOF);
  });

  test('fund reproduces exactly', () => {
    expect(actual.fund).toEqual(fixture.fund);
  });

  /**
   * The schemaVersion 3 additions, stripped before comparison and asserted
   * separately below.
   *
   * `riskFlagDetail` and `acknowledgements` are A9 fields with no counterpart
   * in a schemaVersion 1 fixture, and `kpis[].nrr` is a column that has been in
   * the schema since A1 and only reached the contract at 3. Each is removed by
   * name -- never by a loose filter -- so a field appearing here that nobody
   * accounted for still fails the comparison, which is the whole point of it.
   */
  const withoutV3 = (c: (typeof actual.companies)[number]) => {
    const rest = { ...c, kpis: c.kpis.map((k) => ({ ...k })) };
    delete rest.riskFlagDetail;
    delete rest.acknowledgements;
    for (const k of rest.kpis) delete k.nrr;
    return rest;
  };

  test('every company reproduces exactly', () => {
    expect(actual.companies).toHaveLength(fixture.companies.length);
    // Per company rather than one array comparison: a single failing field on
    // C037 should name C037, not print seventy companies of diff.
    for (const [i, expected] of fixture.companies.entries()) {
      expect(withoutV3(actual.companies[i]!), `company ${expected.id} (${expected.name})`).toEqual(expected);
    }
  });

  /**
   * A9. The fixture's flags are bare strings; the importer resolves each one to
   * a category through `classify_risk_flag_category`, the same function
   * migration 0005 backfilled the existing table with.
   *
   * THE PAIRING IS THE ASSERTION. The contract joins `riskFlags` to
   * `riskFlagDetail` by position, so a detail array of the right length holding
   * the wrong company's flags would satisfy a count check and corrupt every
   * alert. Text is compared entry by entry.
   */
  test('risk flags gain a category without losing their display string', () => {
    let checked = 0;
    for (const c of actual.companies) {
      expect(c.riskFlagDetail ?? []).toHaveLength(c.riskFlags.length);
      for (const [i, text] of c.riskFlags.entries()) {
        const detail = c.riskFlagDetail![i]!;
        expect(detail.category, `${c.id} flag ${i}`).toBeTruthy();
        // The display string is preserved verbatim (ADR-026) -- the category is
        // resolved beside it, never derived back into it.
        expect(text).toBe(fixture.companies.find((f) => f.id === c.id)!.riskFlags[i]);
        checked++;
      }
    }
    // A guard on the guard: if the importer silently stopped writing flags,
    // every loop above would pass vacuously.
    expect(checked).toBeGreaterThan(0);

    // Nothing in the fixture should land in 'other'. All fifteen of its
    // distinct strings are covered by the classifier, and a new one appearing
    // there is a vocabulary gap worth being told about.
    const uncategorised = actual.companies.flatMap((c) =>
      (c.riskFlagDetail ?? []).filter((d) => d.category === 'other').map((d) => `${c.id}: ${d.categoryLabel}`),
    );
    expect(uncategorised).toEqual([]);
  });

  /**
   * The fixture sets no policy and acknowledges nothing, and that is the state
   * that keeps the golden master intact -- `healthAlerts()` reads the policy
   * only when it is present. If an import ever invented one, this is what
   * notices.
   */
  test('a schemaVersion 1 document produces no alert policy and no acknowledgements', () => {
    expect(actual.alertPolicy).toBeNull();
    for (const c of actual.companies) expect(c.acknowledgements ?? []).toEqual([]);
  });

  test('pipeline reproduces exactly', () => {
    expect(actual.pipeline).toEqual(fixture.pipeline);
  });

  test('LP positions reproduce exactly', () => {
    expect(actual.fundInvestments).toEqual(fixture.fundInvestments);
  });

  test('memos reproduce exactly', () => {
    expect(actual.memos).toEqual(fixture.memos);
  });

  test('meta carries schemaVersion 3 and flags synthetic data', () => {
    // The API emits 3; the fixture is 1 and stays that way. demo.json is the
    // prototype's own boot state and re-exporting it would invalidate every
    // golden-master fixture (ADR-022), so the two legitimately differ here.
    expect(actual.meta.schemaVersion).toBe(3);
    // ADR-020: the banner is driven by this, and every imported row is flagged.
    expect(actual.meta.demo).toBe(true);
  });

  /**
   * schemaVersion 2 adds `funnelGroups`, the board's columns. It is reference
   * data rather than imported data, so it has no counterpart in the fixture.
   */
  test('funnelGroups describes the board, and every fixture stage lands in one', () => {
    const groups = actual.funnelGroups ?? [];
    expect(groups.map((g) => g.name)).toEqual([
      'Sourced', 'Screening', 'Diligence', 'IC Review', 'Term Sheet', 'Closed', 'Passed', 'Watchlist',
    ]);
    // Terminality is the source of the "active deals" definition and must not
    // drift into a hardcoded name list.
    expect(groups.filter((g) => g.isTerminal).map((g) => g.name)).toEqual(['Closed', 'Passed', 'Watchlist']);

    // Affinity's sixteen statuses plus the four fixture-only names, and every
    // stage a deal can actually be in resolves to exactly one column.
    const placements = new Map<string, number>();
    for (const g of groups) for (const s of g.stages) placements.set(s, (placements.get(s) ?? 0) + 1);
    expect([...placements.values()].every((n) => n === 1)).toBe(true);
    expect(placements.size).toBe(20);
    for (const deal of fixture.pipeline) expect(placements.has(deal.funnel)).toBe(true);
  });

  /**
   * A5's exit criterion. Coverage is deliberately NOT in the contract, and this
   * asserts the reason: the adapter coerces a null KPI to 0, so the document
   * cannot distinguish "reported nothing" from "reported zero" and the view can.
   */
  test('KPI coverage counts nulls the exported document cannot see', async () => {
    const coverage = await readKpiCoverage(db());
    expect(coverage.length).toBeGreaterThan(0);

    // Newest first, matching kpis[] in the contract.
    const ends = coverage.map((c) => c.periodEnd);
    expect([...ends].sort().reverse()).toEqual(ends);
    expect(coverage[0]!.period).toMatch(/^\d{4}-Q[1-4]$/);

    // The fixture has six companies with no KPI history at all, so reporting
    // must be short of the roster -- if these were equal the view would be
    // counting rows rather than answers.
    const latest = coverage[0]!;
    expect(latest.companiesReporting).toBeLessThan(latest.companiesTotal);
    expect(latest.fields.map((f) => f.label)).toContain('Women C-suite');

    // No field can report more often than companies filed, in any quarter.
    for (const row of coverage) {
      for (const field of row.fields) {
        expect(field.reported).toBeLessThanOrEqual(row.companiesReporting);
      }
    }

    // The fixture DOES carry womenCSuite -- the prototype holds it as a company
    // scalar and the importer lands it on the KPI row -- so coverage here is
    // non-zero while the same column reads zero on live Visible data, where the
    // question has never been asked. That contrast is the whole point: the view
    // reports what is actually present rather than what the schema allows.
    expect(latest.fields.find((f) => f.label === 'Women C-suite')!.reported).toBeGreaterThan(0);

    // Net revenue retention and gross margins are A5 additions with no
    // prototype ancestor, so the fixture cannot supply them.
    expect(latest.fields.find((f) => f.label === 'NRR')!.reported).toBe(0);
  });

  test('the whole document reproduces, savedAt and the v2/v3 additions aside', () => {
    // savedAt is a wall-clock stamp and normalised out of contract comparison
    // per ADR-022. funnelGroups is the schemaVersion 2 addition and alertPolicy
    // the schemaVersion 3 one; neither has a fixture counterpart and both are
    // asserted above, as are the per-company v3 fields `withoutV3` removes.
    // EVERYTHING ELSE MUST MATCH -- that exactness is what proves the storage
    // layer moved no board number, so this comparison is narrowed by exactly
    // the known additions and no more.
    const rest = { ...actual, companies: actual.companies.map(withoutV3) };
    delete rest.funnelGroups;
    delete rest.alertPolicy;
    expect({ ...rest, meta: { ...actual.meta, savedAt: null, schemaVersion: 1 as const } }).toEqual({
      ...fixture,
      meta: { ...fixture.meta, savedAt: null },
    });
  });
});

describe.skipIf(!hasDb)('frozen board numbers survive the storage round trip', () => {
  let built: PortfolioExport;

  beforeAll(async () => {
    built = await buildExport(db(), { asOf: ASOF });
  }, 60_000);

  afterAll(async () => {
    await closeDb();
  });

  test('fundMetrics over the database-built document matches the golden master', () => {
    const m = fundMetrics(built, { asOf: ASOF, includeAccelerator: true }) as unknown as Record<
      string,
      number | null
    >;
    for (const [field, frozen] of Object.entries(golden.fundMetrics)) {
      const got = m[field];
      if (frozen.value === null || got === null || got === undefined) {
        expect(got ?? null, field).toBe(frozen.value);
        continue;
      }
      // Same 1e-12 relative tolerance the A1 suite uses (ADR-022): loose enough
      // to survive a reassociated sum, tight enough that no real change passes.
      expect(Math.abs(got - frozen.value) / Math.max(1, Math.abs(frozen.value)), field).toBeLessThan(
        1e-12,
      );
    }
  });

  test('ADR-025 holds: distributions stay at the frozen $47.5M', () => {
    const m = fundMetrics(built, { asOf: ASOF, includeAccelerator: true });
    expect(m.distributions).toBeCloseTo(47.5, 10);
    // And the per-company realizations remain the independent $53.0M. If these
    // ever agree, the ADR-025 correction has landed and the golden master needs
    // recapturing with sign-off -- it is not a silent improvement.
    expect(built.companies.reduce((s, c) => s + c.realized, 0)).toBeCloseTo(53, 10);
  });

  test('rounds are delivered unfiltered, so metrics can apply the leverage predicate', () => {
    const rounds = built.companies.flatMap((c) => c.rounds);
    expect(rounds).toHaveLength(fixture.companies.flatMap((c) => c.rounds).length);
  });

  test('per-company MOIC reproduces', () => {
    for (const expected of fixture.companies) {
      const got = built.companies.find((c) => c.id === expected.id)!;
      expect(moic(got), `moic ${expected.id}`).toBe(moic(expected));
    }
  });

  test('LP position multiples and the aggregate reproduce', () => {
    for (const expected of fixture.fundInvestments) {
      const got = built.fundInvestments.find((f) => f.id === expected.id)!;
      expect(fiTvpi(got), `tvpi ${expected.id}`).toBe(fiTvpi(expected));
      expect(fiDpi(got), `dpi ${expected.id}`).toBe(fiDpi(expected));
      expect(fiIrr(got, ASOF), `irr ${expected.id}`).toBe(fiIrr(expected, ASOF));
    }
    expect(lpMetrics(built, { asOf: ASOF })).toEqual(lpMetrics(fixture, { asOf: ASOF }));
  });

  test('the fund IRR cashflow series is identical', () => {
    const series = (doc: PortfolioExport) => [
      ...doc.companies.flatMap((c) => c.rounds.map((r) => ({ date: r.date, amt: -r.invested }))),
      ...doc.fund.distributions.map((d) => ({ date: d.date, amt: d.amount })),
    ];
    expect(xirr(series(built))).toBe(xirr(series(fixture)));
  });
});

describe('unit and period helpers invert each other', () => {
  test('$M survives a dollars round trip', () => {
    for (const m of [0, 0.1, 2.9, 47.5, 300.8, 1092.1, 6.803981044795364]) {
      expect(toMillions(toDollars(m))).toBeCloseTo(m, 6);
    }
  });

  test('quarter labels survive a period round trip', () => {
    for (const q of ['2024-Q1', '2025-Q3', '2025-Q4', '2026-Q1', '2026-Q4']) {
      expect(toCalendarLabel(periodOf(q).periodEnd)).toBe(q);
    }
  });

  test('an unparseable quarter label throws rather than guessing', () => {
    expect(() => periodOf('FY2026-27 Q1')).toThrow(/Unparseable quarter label/);
  });
});
