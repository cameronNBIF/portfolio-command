/**
 * The inverse of the fixture importer: takes the prototype's demo portfolio
 * back out of a database that has since been synced with the real roster.
 *
 * WHY THIS EXISTS. `import:fixture` truncates and reloads, so importing over a
 * fixture is safe and importing over the real roster is refused (A8.1). What
 * neither of those covers is the ordinary sequence that produced this: load the
 * fixture into an empty database to have something on screen, then run
 * `affinity:sync`, which INSERTS the real roster ALONGSIDE it rather than
 * replacing it. The sync anticipates exactly this -- its id allocator skips
 * C001-C070 so "a roster loaded beside the reference fixture cannot collide" --
 * and the result is a platform serving 152 companies, 70 of them fictional,
 * with nothing on any screen saying which are which. That is fine for
 * development and wrong for a demonstration.
 *
 * `db:reset` also fixes it, by rebuilding from Affinity and Visible. This exists
 * because that is the wrong tool the week before a demo: it needs both APIs
 * live, and it RENUMBERS the roster (C071 becomes C001), which re-seeds the A6
 * generator -- company seeds are keyed on `company_id` -- and re-rolls every
 * company's synthetic history. This removes the fixture and leaves every real
 * row exactly as it stands.
 *
 * THREE DISCRIMINATORS, each exact rather than heuristic:
 *
 * 1. **Companies: `affinity_org_id is null`.** Only two code paths insert a
 *    company -- this importer, which never writes the column, and the sync,
 *    which upserts ON it and so always does. This is the same signal the import
 *    guard reads, for the same reason. `visible_company_id` is checked too:
 *    the fixture cannot have one, so a row that does is real regardless.
 *
 * 2. **Pipeline deals: `affinity_row_id is null`.** The sync's upsert key, and
 *    the importer does not write it.
 *
 * 3. **Fund-level financial rows: the import's own batch id**, recovered from
 *    the `__import__` ledger row the importer writes to `audit_log`. This is
 *    what reaches the fixture's LP cashflows and fund distributions, which hang
 *    off the fund rather than off a company and would otherwise survive the
 *    roster's removal -- $47.5M of fictional realizations on the reference
 *    fixture, sitting in the fund's DPI.
 *
 * WHAT IT REFUSES TO TOUCH. A candidate company holding any financial row that
 * is not synthetic, or named by a fund distribution outside the fixture batches,
 * is left in place and reported. Neither is reachable today; both are what a
 * hand-entered company would look like, and a purge that silently ate one would
 * be a far worse bug than the one it fixes.
 *
 * The fund row is restored rather than deleted: `fund_nav_snapshot` references
 * it without cascade, and those 74 rows are real.
 */
import type { PortfolioExport } from '@portfolio-command/contract';
import type { FundIdentity } from '@portfolio-command/db/fund-identity';
import { FUND_FINANCIAL_COLUMNS } from '@portfolio-command/db/fund-identity';
import type pg from 'pg';

import { periodOf } from '../periods.js';
import { toDollars } from '../units.js';

/** The system principal seeded by `packages/db/src/seed.ts`. */
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001';

export interface PurgeSkip {
  subject: string;
  reason: string;
}

export interface PurgeResult {
  /** Import batches found in the `__import__` ledger. */
  batches: string[];
  /** Rows deleted, by table. Cascaded children are counted, not inferred. */
  removed: Record<string, number>;
  /** Fixture-looking rows deliberately left alone, with the reason. */
  skipped: PurgeSkip[];
  fund: 'restored' | 'not-fixture' | 'absent';
  /** What is left, so the caller can state the outcome rather than the delta. */
  remaining: { companies: number; pipelineDeals: number };
}

/** `count(*)`, as a number, for a statement that takes one array parameter. */
async function countBy(client: pg.Client, sqlText: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { rows } = await client.query<{ n: number }>(sqlText, [ids]);
  return rows[0]?.n ?? 0;
}

/**
 * Counts the rows a cascade is about to remove, reading the tables from the
 * catalogue rather than from a list kept by hand.
 *
 * The delete is already self-maintaining -- `on delete cascade` does not need to
 * know about a table added next quarter -- and the report should be too. A
 * hand-kept list would go stale silently, and the failure mode is a purge that
 * quietly removes more than it says it did.
 */
async function cascadeCounts(
  client: pg.Client,
  column: 'company_id' | 'deal_id',
  parent: string,
  ids: string[],
  explicit: readonly string[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (ids.length === 0) return out;

  const { rows: tables } = await client.query<{ table_name: string }>(
    `select c.table_name
       from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'pc'
        and c.column_name = $1
        and t.table_type = 'BASE TABLE'
        and c.table_name <> $2
        and not (c.table_name = any($3::text[]))
      order by 1`,
    [column, parent, explicit],
  );

  for (const { table_name } of tables) {
    const n = await countBy(
      client,
      `select count(*)::int as n from pc.${table_name} where ${column} = any($1::text[])`,
      ids,
    );
    if (n > 0) out[table_name] = n;
  }
  return out;
}

/**
 * Removes the fixture layer. Call inside a transaction; the caller commits.
 *
 * `doc` is the fixture document itself, used for two identity comparisons the
 * database cannot make on its own: whether the fund row is still the fixture's,
 * and whether an LP position is still carrying a fixture name.
 */
export async function purgeFixture(
  client: pg.Client,
  doc: PortfolioExport,
  fund: FundIdentity,
): Promise<PurgeResult> {
  // The capture trigger raises without an actor, including for a DELETE issued
  // by a script (ADR-031). Synthetic rows removed by the system principal are
  // exempt from versioning, which is the same exemption `db:generate` runs
  // under and for the same reason: this is demo data being cleared, not a
  // board figure being restated. A non-synthetic row would still be versioned.
  await client.query(`select set_config('pc.actor_id', $1, true)`, [SYSTEM_USER_ID]);
  await client.query(`select set_config('pc.change_reason', $1, true)`, [
    'fixture purge: removing the reference fixture from a synced database',
  ]);

  const removed: Record<string, number> = {};
  const skipped: PurgeSkip[] = [];
  const bump = (table: string, n: number) => {
    if (n > 0) removed[table] = (removed[table] ?? 0) + n;
  };

  // --- what the importer left behind, by its own ledger -------------------
  const { rows: batchRows } = await client.query<{ record_id: string }>(
    `select record_id from audit_log where table_name = '__import__' order by changed_at`,
  );
  const batches = batchRows.map((r) => r.record_id);

  // --- candidate companies ------------------------------------------------
  const { rows: candidates } = await client.query<{ company_id: string; name: string }>(
    `select company_id, name from company
      where affinity_org_id is null and visible_company_id is null
      order by company_id`,
  );
  let doomed = candidates.map((c) => c.company_id);
  const nameOf = new Map(candidates.map((c) => [c.company_id, c.name]));

  // A financial row somebody actually entered is the one thing that makes a
  // company without an Affinity id real. Checked before anything is deleted.
  const keep = new Set<string>();
  const protectedIds = await client.query<{ company_id: string }>(
    `select distinct company_id from (
        select company_id from transaction      where company_id is not null and not is_synthetic
        union all select company_id from valuation_mark   where not is_synthetic
        union all select company_id from investment_round where not is_synthetic
     ) r where company_id = any($1::text[])`,
    [doomed],
  );
  for (const { company_id } of protectedIds.rows) {
    keep.add(company_id);
    skipped.push({
      subject: `${company_id} ${nameOf.get(company_id) ?? ''}`.trim(),
      reason: 'holds a financial row that is not synthetic — not the fixture’s, so left alone',
    });
  }

  // A fund distribution outside the fixture batches naming this company is the
  // same signal, and it would block the delete anyway: the reference is not
  // ON DELETE CASCADE, deliberately, because a realization is fund-level history.
  const referenced = await client.query<{ company_id: string }>(
    `select distinct company_id from fund_distribution
      where company_id = any($1::text[])
        and (batch_id is null or not (batch_id::text = any($2::text[])))`,
    [doomed, batches],
  );
  for (const { company_id } of referenced.rows) {
    keep.add(company_id);
    skipped.push({
      subject: `${company_id} ${nameOf.get(company_id) ?? ''}`.trim(),
      reason: 'named by a fund distribution outside the import batches',
    });
  }

  doomed = doomed.filter((id) => !keep.has(id));

  // --- fund-level financial rows carrying an import batch id --------------
  if (batches.length > 0) {
    const txn = await client.query(
      `delete from transaction where batch_id::text = any($1::text[])`,
      [batches],
    );
    bump('transaction', txn.rowCount ?? 0);

    const dist = await client.query(
      `delete from fund_distribution where batch_id::text = any($1::text[])`,
      [batches],
    );
    bump('fund_distribution', dist.rowCount ?? 0);
  }

  // --- the fixture's pipeline --------------------------------------------
  const { rows: deals } = await client.query<{ deal_id: string }>(
    `select deal_id from pipeline_deal where affinity_row_id is null order by deal_id`,
  );
  const doomedDeals = deals.map((d) => d.deal_id);
  for (const [table, n] of Object.entries(
    await cascadeCounts(client, 'deal_id', 'pipeline_deal', doomedDeals, []),
  )) {
    bump(table, n);
  }
  if (doomedDeals.length > 0) {
    const del = await client.query(
      `delete from pipeline_deal where deal_id = any($1::text[])`,
      [doomedDeals],
    );
    bump('pipeline_deal', del.rowCount ?? 0);
  }

  // --- the fixture's roster ------------------------------------------------
  // `transaction` does not cascade from `company` (ADR-018: a financial row is
  // never removed as a side effect of something else), so any that remain on a
  // doomed company go first. The guard above has already established that none
  // of them are anything but synthetic.
  if (doomed.length > 0) {
    const stragglers = await client.query(
      `delete from transaction where company_id = any($1::text[])`,
      [doomed],
    );
    bump('transaction', stragglers.rowCount ?? 0);

    for (const [table, n] of Object.entries(
      await cascadeCounts(client, 'company_id', 'company', doomed, [
        'transaction',
        'fund_distribution',
      ]),
    )) {
      bump(table, n);
    }

    const del = await client.query(`delete from company where company_id = any($1::text[])`, [
      doomed,
    ]);
    bump('company', del.rowCount ?? 0);
  }

  // --- memos, which reference their subject WITHOUT a foreign key ----------
  // `memo.subject_id` is soft by design (a memo outlives the deal it was written
  // for), so nothing cascades and a fixture memo would survive its company as an
  // orphan. Only the doomed subjects are matched; orphan-sweeping in general is
  // not this command's business.
  if (doomed.length > 0 || doomedDeals.length > 0) {
    const memos = await client.query(
      `delete from memo
        where (subject_type = 'company' and subject_id = any($1::text[]))
           or (subject_type = 'deal'    and subject_id = any($2::text[]))`,
      [doomed, doomedDeals],
    );
    bump('memo', memos.rowCount ?? 0);
  }

  // --- the fixture's fund NAV history --------------------------------------
  // Not batch-tagged, not cascaded, and fund-level: left behind it puts
  // fictional quarters straight onto the dashboard's NAV chart. Matched on the
  // whole (period, nav, cumulative cost) triple to the cent, so a snapshot the
  // generator computed is not mistaken for one the fixture asserted. A FROZEN
  // snapshot is never touched -- that is an issued board pack (ADR-031).
  const navRows = doc.fund.navHistory;
  if (navRows.length > 0) {
    const nav = await client.query(
      `delete from fund_nav_snapshot s
         using unnest($1::date[], $2::numeric[], $3::numeric[]) as f(period_end, nav, cost)
        where s.frozen_at is null
          and s.period_end = f.period_end
          and s.nav = f.nav
          and s.cumulative_cost = f.cost`,
      [
        navRows.map((p) => periodOf(p.q).periodEnd),
        navRows.map((p) => toDollars(p.nav)),
        navRows.map((p) => toDollars(p.cost)),
      ],
    );
    bump('fund_nav_snapshot', nav.rowCount ?? 0);
  }

  // --- LP positions still carrying a fixture name -------------------------
  // Matched on id AND name together. The generator writes the real LP roster
  // over the same F001-F0nn ids, so an id alone would delete Propel; the pair
  // only matches a row the fixture wrote and nothing has since replaced.
  const lp = await client.query(
    `delete from fund_investment fi
       using unnest($1::text[], $2::text[]) as f(id, name)
      where fi.fund_investment_id = f.id and fi.name = f.name`,
    [doc.fundInvestments.map((f) => f.id), doc.fundInvestments.map((f) => f.name)],
  );
  bump('fund_investment', lp.rowCount ?? 0);

  // --- the fund row --------------------------------------------------------
  const { rows: fundRows } = await client.query<{ fund_id: number; name: string }>(
    `select fund_id, name from fund order by fund_id limit 1`,
  );
  let fundOutcome: PurgeResult['fund'] = 'absent';
  if (fundRows.length > 0) {
    if (fundRows[0]!.name !== doc.fund.name) {
      // Somebody has set a real name since. Restoring would overwrite it, and
      // the fixture's financial figures are not identifiable once that is true.
      fundOutcome = 'not-fixture';
      skipped.push({
        subject: `fund "${fundRows[0]!.name}"`,
        reason: `does not carry the fixture's name ("${doc.fund.name}") — left as it stands`,
      });
    } else {
      const nulls = FUND_FINANCIAL_COLUMNS.map((c) => `${c} = null`).join(', ');
      await client.query(
        `update fund set name = $1, style = $2, reporting_currency = $3,
                         inception_year = coalesce($4::int, extract(year from current_date)::int),
                         fiscal_year_start_month = $5, annual_platform_target = $6, ${nulls}
          where fund_id = $7`,
        [
          fund.name,
          fund.style,
          fund.currency,
          fund.inceptionYear,
          fund.fiscalYearStartMonth,
          fund.annualPlatformTarget,
          fundRows[0]!.fund_id,
        ],
      );
      fundOutcome = 'restored';
    }
  }

  const { rows: left } = await client.query<{ companies: number; deals: number }>(
    `select (select count(*) from company)::int       as companies,
            (select count(*) from pipeline_deal)::int as deals`,
  );

  // The ledger entry, matching the `__import__` row the importer writes. What
  // was removed, and from which batches, outlives this command's stdout.
  await client.query(
    `insert into audit_log (table_name, record_id, action, new_value, changed_by)
     values ('__purge__', $1, 'delete', $2, $3)`,
    [
      batches.join(',') || 'no-batch',
      JSON.stringify({ removed, skipped, fund: fundOutcome, batches }),
      SYSTEM_USER_ID,
    ],
  );

  return {
    batches,
    removed,
    skipped,
    fund: fundOutcome,
    remaining: { companies: left[0]!.companies, pipelineDeals: left[0]!.deals },
  };
}
