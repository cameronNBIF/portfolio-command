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
import { periodOf, toCalendarLabel } from '../src/periods.js';
import { toDollars, toMillions } from '../src/units.js';

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

  test('every company reproduces exactly', () => {
    expect(actual.companies).toHaveLength(fixture.companies.length);
    // Per company rather than one array comparison: a single failing field on
    // C037 should name C037, not print seventy companies of diff.
    for (const [i, expected] of fixture.companies.entries()) {
      expect(actual.companies[i], `company ${expected.id} (${expected.name})`).toEqual(expected);
    }
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

  test('meta carries schemaVersion 2 and flags synthetic data', () => {
    // The API emits 2; the fixture is 1 and stays that way. demo.json is the
    // prototype's own boot state and re-exporting it would invalidate every
    // golden-master fixture (ADR-022), so the two legitimately differ here.
    expect(actual.meta.schemaVersion).toBe(2);
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

  test('the whole document reproduces, savedAt and the v2 addition aside', () => {
    // savedAt is a wall-clock stamp and normalised out of contract comparison
    // per ADR-022. funnelGroups is the schemaVersion 2 addition and has no
    // fixture counterpart; it is asserted above. EVERYTHING ELSE MUST MATCH --
    // that exactness is what proves the storage layer moved no board number,
    // so this comparison is narrowed by exactly one known key and no more.
    const rest = { ...actual };
    delete rest.funnelGroups;
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
