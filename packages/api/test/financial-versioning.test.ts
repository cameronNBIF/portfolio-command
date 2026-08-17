/**
 * The A7 verification, and the price of ADR-031.
 *
 * ADR-018 kept previously issued board reports reproducible by never letting a
 * financial row change. ADR-031 lets Finance edit rows and keeps the same
 * property by versioning them instead. That trade has a stated cost:
 *
 *   "Under append-only, 'what did we report then' was free -- the rows were
 *    still there and a dated filter answered it. It is now a reconstruction,
 *    which means it is code, which means it can have bugs that silence itself.
 *    The A7 test suite therefore asserts the round trip directly."
 *
 * This is that suite. If it is deleted or skipped, the reproducibility
 * guarantee ADR-031 claims is no longer being checked by anything, and the ADR
 * should be reopened rather than the tests quietly removed.
 *
 * What is covered:
 *   1. No financial row can be modified without naming an actor -- including
 *      from a raw connection that never touches the API.
 *   2. Creation, edit, deletion and restoration are all captured.
 *   3. Reconstruction returns the pre-edit figures, after an edit AND after a
 *      deletion.
 *   4. A soft-deleted row leaves the aggregates, and comes back when restored.
 *   5. An edit inside a frozen period is refused without a reason and flagged
 *      as a restatement with one.
 *
 * REQUIRES A DATABASE. Skipped when DATABASE_URL is unset, matching
 * `round-trip.test.ts`; the database CI job sets it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'kysely';

import { closeDb, db } from '../src/db.js';
import type { Principal } from '../src/auth/principal.js';
import { applyFinancialMutation } from '../src/write/financial.js';
import { readRowHistory, readTransactions } from '../src/read/finance.js';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env') });

const hasDb = Boolean(process.env.DATABASE_URL);

const COMPANY = 'PCT001';
const FINANCE: Principal = {
  userId: '',
  entraObjectId: 'test-finance',
  email: 'finance@example.test',
  displayName: 'Test Finance',
  role: 'finance',
};

/** Invested for the fixture company, through the live view every screen reads. */
async function invested(): Promise<string> {
  const { rows } = await sql<{ v: string }>`
    select coalesce(sum(amount_cad), 0)::text as v
      from pc.v_transaction_live
     where company_id = ${COMPANY} and txn_type in ('investment','follow_on')
  `.execute(db());
  return rows[0]!.v;
}

/** The same figure reconstructed as it stood at an instant. */
async function investedAsOf(at: string): Promise<string> {
  const { rows } = await sql<{ v: string }>`
    select coalesce(sum(amount * coalesce(fx_rate_to_cad,1)), 0)::text as v
      from pc.transaction_asof(${at}::timestamptz)
     where company_id = ${COMPANY} and txn_type in ('investment','follow_on')
       and voided_at is null and reverses_transaction_id is null
  `.execute(db());
  return rows[0]!.v;
}

const nowInDb = async (): Promise<string> => {
  const { rows } = await sql<{ t: string }>`select clock_timestamp()::text as t`.execute(db());
  return rows[0]!.t;
};

describe.skipIf(!hasDb)('ADR-031 financial row versioning', () => {
  beforeEach(async () => {
    // A dedicated company and user, torn down and rebuilt per test, so these
    // never depend on -- or disturb -- whatever else is in the test database.
    await sql`
      insert into pc.app_user (user_id, entra_object_id, display_name, email, role)
      values (gen_random_uuid(), 'test-finance', 'Test Finance', 'finance@example.test', 'finance')
      on conflict (entra_object_id) do update set role = 'finance'
    `.execute(db());
    const { rows } = await sql<{ id: string }>`
      select user_id::text as id from pc.app_user where entra_object_id = 'test-finance'
    `.execute(db());
    FINANCE.userId = rows[0]!.id;

    await sql`
      insert into pc.company (company_id, name, created_by)
      values (${COMPANY}, 'Versioning Test Co', ${FINANCE.userId}::uuid)
      on conflict (company_id) do nothing
    `.execute(db());

    await sql`select set_config('pc.actor_id', ${FINANCE.userId}, false)`.execute(db());
    await sql`delete from pc.transaction where company_id = ${COMPANY}`.execute(db());

    // Scoped to this suite's actor, not to the ids it created. `round-trip.test.ts`
    // truncates the root tables with RESTART IDENTITY, so a transaction id from a
    // previous run is handed out again -- and version rows keyed on the old id
    // would then read as history belonging to the new row.
    await sql`delete from pc.financial_row_version where changed_by = ${FINANCE.userId}::uuid`.execute(db());
    await sql`delete from pc.fund_nav_snapshot where fund_id = 1 and period_end = '2020-12-31'`.execute(db());
  });

  afterAll(async () => {
    await sql`delete from pc.transaction where company_id = ${COMPANY}`.execute(db()).catch(() => {});
    await sql`delete from pc.company where company_id = ${COMPANY}`.execute(db()).catch(() => {});
    await closeDb();
  });

  const create = (amount: string, txnDate = '2021-06-01') =>
    applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'create',
      values: { txnDate, txnType: 'investment', companyId: COMPANY, amount },
    });

  test('a financial row cannot be modified without naming an actor', async () => {
    const { id } = await create('1000000.00');

    // A connection that resets the session variable -- i.e. anything that did
    // not come through the write path, including psql.
    await expect(
      sql`
        do $$ begin
          perform set_config('pc.actor_id', '', false);
          update pc.transaction set amount = 1 where company_id = ${sql.lit(COMPANY)};
        end $$;
      `.execute(db()),
    ).rejects.toThrow(/cannot be modified anonymously/i);

    // and the row is untouched
    const page = await readTransactions(db(), FINANCE, { companyId: COMPANY });
    expect(page.rows.find((r) => r.id === id)?.amount).toBe('1000000.00');
  });

  test('creation, edit, deletion and restoration are all captured', async () => {
    const { id } = await create('1000000.00');

    await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'update',
      id,
      values: { txnDate: '2021-06-01', txnType: 'investment', companyId: COMPANY, amount: '1250000.00' },
      reason: 'cheque was keyed at the wrong amount',
    });
    await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction', op: 'delete', id, reason: 'duplicate of the June entry',
    });
    await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction', op: 'restore', id, reason: 'not a duplicate after all',
    });

    const history = await readRowHistory(db(), FINANCE, 'transaction', id);
    expect(history.map((h) => h.action)).toEqual(['create', 'update', 'delete', 'restore']);
    expect(history.every((h) => h.changedByName === 'Test Finance')).toBe(true);

    // The edit's diff names the field and both values, which is the whole point
    // of a verbose log rather than a "row changed" marker.
    //
    // The amounts arrive as JSON numbers, not the strings the rest of the write
    // path uses: `to_jsonb(row)` maps a `numeric` column to a JSON number. The
    // stored jsonb keeps full numeric precision -- it is `JSON.parse` on the way
    // into JavaScript that produces a double -- so this is a display concern on
    // the History panel and never touches the reconstruction, which is pure SQL.
    // See the note on `rowImage` in read/finance.ts.
    const edit = history[1]!;
    expect(edit.changes).toContainEqual({ field: 'amount', from: 1000000, to: 1250000 });
    expect(edit.reason).toBe('cheque was keyed at the wrong amount');
  });

  test('reconstruction returns the figures as they stood before an edit', async () => {
    const { id } = await create('1000000.00');
    expect(await invested()).toBe('1000000.00');

    const before = await nowInDb();

    await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'update',
      id,
      values: { txnDate: '2021-06-01', txnType: 'investment', companyId: COMPANY, amount: '4000000.00' },
      reason: 'restated against the signed subscription agreement',
    });

    expect(await invested()).toBe('4000000.00');
    // THE ADR-031 PROPERTY. The board pack that quoted $1.0M still reproduces.
    expect(await investedAsOf(before)).toBe('1000000.00');
  });

  test('a deleted row leaves the totals, stays reconstructable, and comes back', async () => {
    const { id } = await create('1000000.00');
    await create('500000.00', '2021-09-01');
    expect(await invested()).toBe('1500000.00');

    const before = await nowInDb();
    await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction', op: 'delete', id, reason: 'booked against the wrong company',
    });

    expect(await invested()).toBe('500000.00');
    expect(await investedAsOf(before)).toBe('1500000.00');

    // Deleted rows stay out of the way but remain reachable on request.
    const live = await readTransactions(db(), FINANCE, { companyId: COMPANY });
    expect(live.rows).toHaveLength(1);
    const all = await readTransactions(db(), FINANCE, { companyId: COMPANY, includeDeleted: true });
    expect(all.rows).toHaveLength(2);
    // Totals stay net of deletions even while deleted rows are displayed.
    expect(all.totals.invested).toBe('500000.00');

    await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction', op: 'restore', id, reason: 'company was right, my note was wrong',
    });
    expect(await invested()).toBe('1500000.00');
  });

  test('editing inside an issued period is refused without a reason, and flagged with one', async () => {
    // Order matters and mirrors reality: the row is booked, the period is
    // reported to the board, and only then does someone find the error. Booking
    // a NEW row into an already-issued period is a restatement too, and would
    // demand a reason at creation if done the other way round.
    const { id } = await create('1000000.00', '2019-05-01');

    // Freeze a period covering the transaction's date, the way issuing a board
    // report does (ADR-007).
    await sql`
      insert into pc.fund_nav_snapshot (fund_id, period_end, nav, cumulative_cost, frozen_at)
      values (1, '2020-12-31', 0, 0, now())
      on conflict (fund_id, period_end) do update set frozen_at = now()
    `.execute(db());

    const edit = (reason?: string) =>
      applyFinancialMutation(db(), FINANCE, {
        table: 'transaction',
        op: 'update',
        id,
        values: { txnDate: '2019-05-01', txnType: 'investment', companyId: COMPANY, amount: '1100000.00' },
        reason: reason ?? null,
      });

    await expect(edit()).rejects.toThrow(/already issued to the board/i);
    // A token reason is not a reason.
    await expect(edit('typo')).rejects.toThrow(/at least ten characters/i);

    const result = await edit('corrected against the executed term sheet');
    expect(result.restated).toBe(true);

    const { rows } = await sql<{ n: string }>`
      select count(*)::text as n from pc.v_restatement_log
       where table_name = 'transaction' and record_id = ${id}
    `.execute(db());
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });

  test('the roles that may not write financial rows cannot', async () => {
    const vc: Principal = { ...FINANCE, role: 'vc' };
    await expect(
      applyFinancialMutation(db(), vc, {
        table: 'transaction',
        op: 'create',
        values: { txnDate: '2021-06-01', txnType: 'investment', companyId: COMPANY, amount: '1.00' },
      }),
    ).rejects.toThrow(/Requires one of/);
  });
});
