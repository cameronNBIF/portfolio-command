/**
 * The purge removes the fixture and nothing but the fixture.
 *
 * WHAT IT IS DEFENDING. A delete keyed on "has no Affinity id" is one wrong
 * predicate away from taking the real roster with it, and the failure would be
 * silent until someone counted the companies on the dashboard. The importer's
 * own guard exists because that class of mistake cost four rebuilds during A6
 * and A8; this is the same hazard pointed the other way, so it gets the same
 * treatment: a test that builds the exact mixed state the command is for --
 * fixture loaded first, real roster synced beside it -- and then checks both
 * halves of the outcome rather than only the half that is easy to see.
 *
 * Both halves matter equally. "The fixture is gone" is worthless if the answer
 * to "and is the roster still there?" is no.
 *
 * REQUIRES A DATABASE. Skipped when DATABASE_URL is unset, matching the other
 * suites; the database CI job sets it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { config } from 'dotenv';
import pg from 'pg';

import type { PortfolioExport } from '@portfolio-command/contract';
import { fundIdentity } from '@portfolio-command/db/fund-identity';

import { importContract } from '../src/import/import-contract.js';
import { purgeFixture, type PurgeResult } from '../src/import/purge-fixture.js';
import { assertTestDatabase } from './use-test-db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env') });

const fixture = JSON.parse(
  readFileSync(path.resolve(here, '../../../docs/reference/demo.json'), 'utf8'),
) as PortfolioExport;

const hasDb = Boolean(process.env.DATABASE_URL);
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001';

/** A synced company, a synced deal, and a hand-entered one the purge must spare. */
const REAL_COMPANY = 'PCPURGE1';
const REAL_DEAL = 'PCPURGED';
const MANUAL_COMPANY = 'PCPURGE2';

const one = async (client: pg.Client, sqlText: string, params: unknown[] = []): Promise<number> => {
  const { rows } = await client.query<{ n: number }>(sqlText, params);
  return rows[0]!.n;
};

describe.skipIf(!hasDb)('the fixture purge', () => {
  let client: pg.Client;
  let result: PurgeResult;

  beforeAll(async () => {
    assertTestDatabase();
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    await client.query('set search_path = pc, public');

    // 1. The fixture, loaded the way it is loaded in practice.
    await client.query('begin');
    await importContract(client, fixture);
    await client.query('commit');

    // 2. The real roster landing BESIDE it, which is what the sync does: an
    //    insert, not a replacement. Modelled rather than run, because a test
    //    cannot call Affinity -- but the discriminator is a column, and this
    //    sets the column exactly as the sync does.
    await client.query('begin');
    await client.query(
      `insert into company (company_id, name, affinity_org_id, created_by, synced_at)
       values ($1, 'Purge Test Co', '999999001', $2, now())`,
      [REAL_COMPANY, SYSTEM_USER_ID],
    );
    await client.query(
      `insert into pipeline_deal (deal_id, affinity_row_id, name, funnel_stage_id)
       values ($1, '999999002', 'Purge Test Deal',
               (select funnel_stage_id from ref_funnel_stage order by funnel_stage_id limit 1))`,
      [REAL_DEAL],
    );

    // 3. A company with no Affinity id that is NOT the fixture's: the shape a
    //    hand-entered holding would take. It carries a real financial row, and
    //    that is what must save it.
    await client.query(
      `insert into company (company_id, name, created_by) values ($1, 'Hand Entered Co', $2)`,
      [MANUAL_COMPANY, SYSTEM_USER_ID],
    );
    await client.query(`select set_config('pc.actor_id', $1, true)`, [SYSTEM_USER_ID]);
    await client.query(
      `insert into transaction (txn_date, txn_type, company_id, amount, is_synthetic, entered_by)
       values ('2026-01-15', 'investment', $1, 250000.00, false, $2)`,
      [MANUAL_COMPANY, SYSTEM_USER_ID],
    );

    // 4. A fund-level distribution nobody imported, to prove the batch
    //    discriminator is doing the work rather than `is_synthetic`.
    await client.query(
      `insert into fund_distribution (fund_id, distribution_date, amount, company_label,
                                      note, is_synthetic, entered_by)
       values ((select fund_id from fund order by fund_id limit 1), '2026-02-01', 1000000.00,
               'Real Exit Co', 'entered by hand', false, $1)`,
      [SYSTEM_USER_ID],
    );
    await client.query('commit');

    await client.query('begin');
    result = await purgeFixture(client, fixture, fundIdentity());
    await client.query('commit');
  }, 120_000);

  /**
   * Cleanup is load-bearing, not tidiness. Left behind, `PCPURGE1` looks to
   * `import-guard.test.ts` exactly like a synced roster and makes its first
   * assertion fail in the next file -- which is how this was found. The
   * transaction goes first: `transaction.company_id` does NOT cascade (ADR-018),
   * so deleting the company while it stands fails the whole statement.
   */
  afterAll(async () => {
    if (!client) return;
    try {
      await client.query('begin');
      await client.query(`select set_config('pc.actor_id', $1, true)`, [SYSTEM_USER_ID]);
      await client.query(`delete from transaction where company_id like 'PCPURGE%'`);
      await client.query(`delete from fund_distribution where company_label = 'Real Exit Co'`);
      await client.query(`delete from pipeline_deal where deal_id = $1`, [REAL_DEAL]);
      await client.query(`delete from company where company_id like 'PCPURGE%'`);
      await client.query('commit');
    } catch {
      await client.query('rollback').catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  });

  test('every fixture company is gone', async () => {
    const ids = fixture.companies.map((c) => c.id);
    expect(await one(client, `select count(*)::int as n from company where company_id = any($1)`, [ids])).toBe(0);
  });

  test('the synced roster survives', async () => {
    expect(
      await one(client, `select count(*)::int as n from company where company_id = $1`, [REAL_COMPANY]),
    ).toBe(1);
  });

  /**
   * The one that would have been missed. Fixture LP cashflows and fund
   * distributions hang off the fund, not off a company, so removing the roster
   * leaves them behind — and they are fund-level realizations, which means they
   * land straight in DPI.
   */
  test('fixture fund distributions go, and one entered by hand stays', async () => {
    expect(await one(client, `select count(*)::int as n from fund_distribution where batch_id is not null`)).toBe(0);
    expect(
      await one(
        client,
        `select count(*)::int as n from fund_distribution where company_label = 'Real Exit Co'`,
      ),
    ).toBe(1);
  });

  test('fixture LP cashflows go with them', async () => {
    expect(await one(client, `select count(*)::int as n from transaction where batch_id is not null`)).toBe(0);
  });

  test('fixture pipeline deals go, the synced one stays', async () => {
    const ids = fixture.pipeline.map((p) => p.id);
    expect(await one(client, `select count(*)::int as n from pipeline_deal where deal_id = any($1)`, [ids])).toBe(0);
    expect(
      await one(client, `select count(*)::int as n from pipeline_deal where deal_id = $1`, [REAL_DEAL]),
    ).toBe(1);
  });

  /**
   * A company that looks like the fixture by the discriminator but holds a
   * financial row somebody actually entered. Deleting it would be the worst
   * outcome this command can produce, so it is refused and reported.
   */
  test('a hand-entered company with a real financial row is spared, and said out loud', async () => {
    expect(
      await one(client, `select count(*)::int as n from company where company_id = $1`, [MANUAL_COMPANY]),
    ).toBe(1);
    expect(result.skipped.some((s) => s.subject.startsWith(MANUAL_COMPANY))).toBe(true);
  });

  test('the fund row is NBIF again, with no fabricated financials', async () => {
    const { rows } = await client.query<{
      name: string;
      reporting_currency: string;
      capital_base: string | null;
      committed: string | null;
      called: string | null;
    }>(`select name, reporting_currency, capital_base, committed, called
          from fund order by fund_id limit 1`);
    const fund = rows[0]!;
    expect(result.fund).toBe('restored');
    expect(fund.name).toBe(fundIdentity().name);
    expect(fund.name).not.toBe(fixture.fund.name);
    expect(fund.reporting_currency).toBe('CAD');
    // ADR-020: a capital base nobody supplied is not carried forward under a
    // real fund's name.
    expect(fund.capital_base).toBeNull();
    expect(fund.committed).toBeNull();
    expect(fund.called).toBeNull();
  });

  test('the fund NAV history the fixture wrote goes with it', async () => {
    // Not batch-tagged and not cascaded: left behind, these put fictional
    // quarters on the dashboard's NAV chart after everything else is clean.
    expect(await one(client, `select count(*)::int as n from fund_nav_snapshot`)).toBe(0);
  });

  test('it reports what it removed, and the ledger records it', async () => {
    expect(result.removed.company).toBe(fixture.companies.length);
    expect(result.removed.pipeline_deal).toBe(fixture.pipeline.length);
    expect(result.batches.length).toBeGreaterThan(0);
    expect(await one(client, `select count(*)::int as n from audit_log where table_name = '__purge__'`))
      .toBeGreaterThan(0);
  });

  test('running it twice removes nothing the second time', async () => {
    await client.query('begin');
    const second = await purgeFixture(client, fixture, fundIdentity());
    await client.query('commit');
    expect(second.removed).toEqual({});
    expect(
      await one(client, `select count(*)::int as n from company where company_id = $1`, [REAL_COMPANY]),
    ).toBe(1);
  });
});
