/**
 * F5 · The LP three-stage model (ADR-037), and the two things it must not break.
 *
 * The phase does two independent things and each has its own failure mode.
 *
 * **The rename** changes a stored value that four modules and a CHECK
 * constraint agree on. Its failure mode is silence: a query filtering on the
 * old spelling returns nothing and reads as "no LP activity" rather than as an
 * error. So the tests here assert the constraint refuses the old words, and the
 * round-trip suite plus the 252 golden masters assert the contract did not
 * move — `LpCashflow` encodes direction as a SIGN and never names the event,
 * which is the whole reason the rename stopped at the export adapter.
 *
 * **The commitment** stops being a column and becomes a ledger. Its failure
 * mode is arithmetic: read the ledger as deltas and every unfunded figure on
 * the Funds tab is wrong in a plausible direction. So `a raise is an absolute,
 * not a delta` is the test to be most reluctant to delete, and it says so.
 *
 * The third group is ADR-037 clause 5 — a drawdown beyond the commitment is
 * ACCEPTED and flagged. A test that asserted a refusal there would be asserting
 * the opposite of the decision, so both halves are stated: the row lands, and
 * the caller is told.
 *
 * REQUIRES A DATABASE. Skipped when DATABASE_URL is unset, matching the other
 * database-backed suites; the CI database job sets it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'kysely';

import { closeDb, db } from '../src/db.js';
import type { Principal } from '../src/auth/principal.js';
import {
  applyFinancialMutation,
  type FundCommitmentInput,
} from '../src/write/financial.js';
import { readFundCommitments } from '../src/read/finance.js';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env') });

const hasDb = Boolean(process.env.DATABASE_URL);

const POSITION = 'PCF5A';
const EMPTY = 'PCF5B';

const FINANCE: Principal = {
  userId: '',
  entraObjectId: 'test-f5-finance',
  email: 'f5@example.test',
  displayName: 'Test Controller',
  role: 'finance',
};

const commitment = (over: Partial<FundCommitmentInput> = {}): FundCommitmentInput => ({
  fundInvestmentId: POSITION,
  asOfDate: '2020-03-01',
  committed: '500000.00',
  changeReason: 'Subscription agreement, first close.',
  ...over,
});

async function newCommitment(over: Partial<FundCommitmentInput> = {}): Promise<string> {
  const { id } = await applyFinancialMutation(db(), FINANCE, {
    table: 'fund_commitment',
    op: 'create',
    values: commitment(over),
  });
  return id;
}

/** `fund_committed_asof`, as text — never through `to_jsonb`, per ADR-008. */
async function committedAsOf(positionId: string, asOf: string): Promise<string | null> {
  const { rows } = await sql<{ v: string | null }>`
    select pc.fund_committed_asof(${positionId}, ${asOf}::date)::text as v
  `.execute(db());
  return rows[0]!.v;
}

async function drawdown(amount: string, date = '2021-01-15'): Promise<string> {
  const { id } = await applyFinancialMutation(db(), FINANCE, {
    table: 'transaction',
    op: 'create',
    values: {
      txnDate: date,
      txnType: 'capital_drawdown',
      fundInvestmentId: POSITION,
      amount,
    },
  });
  return id;
}

describe.skipIf(!hasDb)('ADR-037 · the LP three-stage model', () => {
  beforeEach(async () => {
    await sql`
      insert into pc.app_user (user_id, entra_object_id, display_name, email, role)
      values (gen_random_uuid(), 'test-f5-finance', 'Test Controller', 'f5@example.test', 'finance')
      on conflict (entra_object_id) do update set role = 'finance'
    `.execute(db());
    const { rows } = await sql<{ id: string }>`
      select user_id::text as id from pc.app_user where entra_object_id = 'test-f5-finance'
    `.execute(db());
    FINANCE.userId = rows[0]!.id;

    // Before the fixture rows: `fund_commitment` is trigger-backed and the
    // ADR-031 trigger raises rather than defaulting when nobody is named.
    await sql`select set_config('pc.actor_id', ${FINANCE.userId}, false)`.execute(db());

    for (const [id, name] of [[POSITION, 'Three Stage LP'], [EMPTY, 'Uncommitted LP']]) {
      await sql`
        insert into pc.fund_investment (fund_investment_id, name, manager_name, created_by)
        values (${id!}, ${name!}, 'Test GP', ${FINANCE.userId}::uuid)
        on conflict (fund_investment_id) do nothing
      `.execute(db());
    }

    await sql`delete from pc.transaction where fund_investment_id in (${POSITION}, ${EMPTY})`
      .execute(db());
    await sql`delete from pc.fund_commitment where fund_investment_id in (${POSITION}, ${EMPTY})`
      .execute(db());
    await sql`delete from pc.financial_row_version where changed_by = ${FINANCE.userId}::uuid`
      .execute(db());
  });

  afterAll(async () => {
    await sql`delete from pc.transaction where fund_investment_id in (${POSITION}, ${EMPTY})`
      .execute(db()).catch(() => {});
    await sql`delete from pc.fund_investment where fund_investment_id in (${POSITION}, ${EMPTY})`
      .execute(db()).catch(() => {});
    await closeDb();
  });

  // --- the rename ----------------------------------------------------------

  test('the stored vocabulary is NBIF’s, and the GP’s words are refused', async () => {
    /**
     * FR-33, Q-23. The rename is of the STORED value, so the constraint is
     * where it has to be true — a label swapped in TypeScript would leave
     * `capital_call` writable from psql and from the next module somebody adds.
     */
    await expect(
      sql`
        insert into pc.transaction (txn_date, txn_type, fund_investment_id, amount, entered_by)
        values ('2021-01-15', 'capital_call', ${POSITION}, 1000.00, ${FINANCE.userId}::uuid)
      `.execute(db()),
    ).rejects.toThrow(/transaction_txn_type_check/i);

    await expect(
      sql`
        insert into pc.transaction (txn_date, txn_type, fund_investment_id, amount, entered_by)
        values ('2021-01-15', 'distribution', ${POSITION}, 1000.00, ${FINANCE.userId}::uuid)
      `.execute(db()),
    ).rejects.toThrow(/transaction_txn_type_check/i);
  });

  test('the rebuilt CHECKs still separate direct activity from LP activity', async () => {
    /**
     * `transaction_txn_type_check` and `txn_lp_types` were DROPPED and rebuilt
     * by migration 0012, which is exactly where a clause gets quietly lost. Both
     * are asserted from raw SQL rather than through the write path: the
     * TypeScript validator refuses these first, and a test that only reaches the
     * validator would pass with the constraints gone.
     */
    const { rows: co } = await sql<{ id: string }>`
      select company_id as id from pc.company order by company_id limit 1
    `.execute(db());
    if (co.length > 0) {
      await expect(
        sql`
          insert into pc.transaction (txn_date, txn_type, company_id, amount, entered_by)
          values ('2021-01-15', 'capital_drawdown', ${co[0]!.id}, 1000.00, ${FINANCE.userId}::uuid)
        `.execute(db()),
      ).rejects.toThrow(/txn_direct_types/i);
    }

    await expect(
      sql`
        insert into pc.transaction (txn_date, txn_type, fund_investment_id, amount, entered_by)
        values ('2021-01-15', 'investment', ${POSITION}, 1000.00, ${FINANCE.userId}::uuid)
      `.execute(db()),
    ).rejects.toThrow(/txn_lp_types/i);
  });

  // --- the commitment as an event ------------------------------------------

  test('fund_investment.committed is gone', async () => {
    const { rows } = await sql<{ n: string }>`
      select count(*)::text as n from information_schema.columns
       where table_schema = 'pc' and table_name = 'fund_investment' and column_name = 'committed'
    `.execute(db());
    expect(rows[0]!.n).toBe('0');
  });

  test('the commitment in force is the latest row on or before the date', async () => {
    await newCommitment({ asOfDate: '2020-03-01', committed: '500000.00' });
    await newCommitment({
      asOfDate: '2024-06-01',
      committed: '750000.00',
      changeReason: 'Side letter, second close.',
    });

    expect(await committedAsOf(POSITION, '2019-12-31')).toBeNull();
    expect(await committedAsOf(POSITION, '2020-03-01')).toBe('500000.00');
    expect(await committedAsOf(POSITION, '2024-05-31')).toBe('500000.00');
    expect(await committedAsOf(POSITION, '2024-06-01')).toBe('750000.00');
    expect(await committedAsOf(POSITION, '2030-01-01')).toBe('750000.00');
  });

  test('a raise is an ABSOLUTE, not a delta — be reluctant to delete this', async () => {
    /**
     * ADR-037 clause 1, and the failure mode the whole phase turns on.
     *
     * Read this ledger as deltas and a position committed at $500,000 and
     * raised to $750,000 reports $1,250,000 — a plausible figure, on a
     * board-facing screen, that nothing else in the system contradicts. The row
     * says what the commitment IS from its date, never what changed.
     */
    await newCommitment({ asOfDate: '2020-03-01', committed: '500000.00' });
    await newCommitment({
      asOfDate: '2024-06-01',
      committed: '750000.00',
      changeReason: 'Side letter, second close.',
    });

    expect(await committedAsOf(POSITION, '2026-01-01')).toBe('750000.00');

    const { rows } = await sql<{ total: string }>`
      select sum(committed)::text as total from pc.fund_commitment
       where fund_investment_id = ${POSITION}
    `.execute(db());
    // The sum of the ledger is meaningless and is NOT the commitment. Stated
    // so that anyone tempted to aggregate this table sees the number it gives.
    expect(rows[0]!.total).toBe('1250000.00');
  });

  test('null is not zero: a position with no commitment says so', async () => {
    expect(await committedAsOf(EMPTY, '2026-01-01')).toBeNull();
  });

  test('two entries at one date are one restated fact, not two commitments', async () => {
    const first = await newCommitment({ committed: '500000.00' });
    const second = await newCommitment({
      committed: '600000.00',
      changeReason: 'Corrected against the executed subscription.',
    });

    expect(second).toBe(first);
    expect(await committedAsOf(POSITION, '2026-01-01')).toBe('600000.00');
  });

  test('a commitment must say what set it', async () => {
    await expect(
      applyFinancialMutation(db(), FINANCE, {
        table: 'fund_commitment',
        op: 'create',
        values: commitment({ changeReason: '' }),
      }),
    ).rejects.toThrow(/what set it/i);
  });

  test('a deleted commitment leaves the answer, and a restore brings it back', async () => {
    await newCommitment({ asOfDate: '2020-03-01', committed: '500000.00' });
    const raise = await newCommitment({
      asOfDate: '2024-06-01',
      committed: '750000.00',
      changeReason: 'Side letter, second close.',
    });

    await applyFinancialMutation(db(), FINANCE, {
      table: 'fund_commitment',
      op: 'delete',
      id: raise,
      reason: 'Entered against the wrong position.',
    });
    // Falls back to the level below it rather than to null: soft delete removes
    // a row from every total, and the earlier commitment is still a fact.
    expect(await committedAsOf(POSITION, '2026-01-01')).toBe('500000.00');

    await applyFinancialMutation(db(), FINANCE, {
      table: 'fund_commitment',
      op: 'restore',
      id: raise,
    });
    expect(await committedAsOf(POSITION, '2026-01-01')).toBe('750000.00');
  });

  test('the ledger reports which row is in force, and a future-dated one is not', async () => {
    await newCommitment({ asOfDate: '2020-03-01', committed: '500000.00' });
    await newCommitment({
      asOfDate: '2099-01-01',
      committed: '900000.00',
      changeReason: 'Agreed at the AGM, effective on the next close.',
    });

    const rows = await readFundCommitments(db(), FINANCE, { fundInvestmentId: POSITION });
    expect(rows).toHaveLength(2);
    // Newest first, and the newest is NOT the one in force.
    expect(rows[0]!.asOfDate).toBe('2099-01-01');
    expect(rows[0]!.inForce).toBe(false);
    expect(rows[1]!.inForce).toBe(true);
  });

  // --- ADR-031: the commitment is a versioned financial row ----------------

  test('a corrected commitment reconstructs at its prior level', async () => {
    /**
     * The ADR-031 round trip, on the seventh versioned table. The guarantee is
     * not "the change is logged" but "the figure a board pack was built on can
     * be recovered", and only reconstruction proves that.
     */
    const id = await newCommitment({ committed: '500000.00' });
    const { rows: t } = await sql<{ t: string }>`select clock_timestamp()::text as t`.execute(db());
    const before = t[0]!.t;

    await applyFinancialMutation(db(), FINANCE, {
      table: 'fund_commitment',
      op: 'update',
      id,
      values: commitment({ committed: '650000.00', changeReason: 'Amended LPA.' }),
    });

    const { rows: then } = await sql<{ committed: string }>`
      select committed::text as committed from pc.fund_commitment_asof(${before}::timestamptz)
       where fund_commitment_id = ${id}::bigint
    `.execute(db());
    expect(then[0]!.committed).toBe('500000.00');

    const { rows: now } = await sql<{ committed: string }>`
      select committed::text as committed from pc.fund_commitment
       where fund_commitment_id = ${id}::bigint
    `.execute(db());
    expect(now[0]!.committed).toBe('650000.00');
  });

  test('a commitment cannot be written anonymously', async () => {
    await sql`select set_config('pc.actor_id', '', false)`.execute(db());
    await expect(
      sql`
        insert into pc.fund_commitment (fund_investment_id, as_of_date, committed, entered_by)
        values (${POSITION}, '2020-03-01', 500000.00, ${FINANCE.userId}::uuid)
      `.execute(db()),
    ).rejects.toThrow(/cannot be modified anonymously/i);
    await sql`select set_config('pc.actor_id', ${FINANCE.userId}, false)`.execute(db());
  });

  // --- ADR-037 clause 5: accepted and flagged, never refused ---------------

  test('a drawdown beyond the commitment LANDS, and the caller is told', async () => {
    await newCommitment({ committed: '500000.00' });

    const result = await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'create',
      values: {
        txnDate: '2021-01-15',
        txnType: 'capital_drawdown',
        fundInvestmentId: POSITION,
        amount: '600000.00',
      },
    });

    // The row exists. Asserted first and deliberately: the clause is that this
    // is a real state of real data, and a test written the other way round
    // would be asserting the opposite of the decision.
    const { rows } = await sql<{ n: string }>`
      select count(*)::text as n from pc.v_transaction_live
       where fund_investment_id = ${POSITION} and txn_type = 'capital_drawdown'
    `.execute(db());
    expect(rows[0]!.n).toBe('1');

    expect(result.overdrawn).toBeDefined();
    expect(result.overdrawn!.committed).toBe('500000.00');
    expect(result.overdrawn!.drawn).toBe('600000.00');
  });

  test('lowering a commitment below what is drawn is recorded, and flagged', async () => {
    await newCommitment({ committed: '500000.00' });
    await drawdown('400000.00');

    const result = await applyFinancialMutation(db(), FINANCE, {
      table: 'fund_commitment',
      op: 'create',
      values: commitment({
        asOfDate: '2025-01-01',
        committed: '300000.00',
        changeReason: 'Commitment released in part at the GP’s final close.',
      }),
    });

    expect(await committedAsOf(POSITION, '2026-01-01')).toBe('300000.00');
    expect(result.overdrawn).toBeDefined();
    expect(result.overdrawn!.drawn).toBe('400000.00');
  });

  test('a drawdown within the commitment says nothing', async () => {
    await newCommitment({ committed: '500000.00' });
    const { id } = await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'create',
      values: {
        txnDate: '2021-01-15',
        txnType: 'capital_drawdown',
        fundInvestmentId: POSITION,
        amount: '400000.00',
      },
    });
    expect(id).toBeTruthy();

    const result = await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'create',
      values: {
        txnDate: '2022-01-15',
        txnType: 'capital_drawdown',
        fundInvestmentId: POSITION,
        amount: '50000.00',
      },
    });
    expect(result.overdrawn).toBeUndefined();
  });

  test('drawing against a position with no commitment on record is reported', async () => {
    const result = await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'create',
      values: {
        txnDate: '2021-01-15',
        txnType: 'capital_drawdown',
        fundInvestmentId: EMPTY,
        amount: '10000.00',
      },
    });
    expect(result.overdrawn).toBeDefined();
    expect(result.overdrawn!.committed).toBeNull();
  });

  // --- the view Finance reads ----------------------------------------------

  test('the position view derives committed and flags the overdraw', async () => {
    await newCommitment({ committed: '500000.00' });
    await drawdown('600000.00');

    const { rows } = await sql<{
      committed: string | null; called: string; unfunded: string; overdrawn: boolean | null;
    }>`
      select committed::text as committed, called::text as called,
             unfunded::text as unfunded, overdrawn
        from pc.v_lp_position_current where fund_investment_id = ${POSITION}
    `.execute(db());

    expect(rows[0]!.committed).toBe('500000.00');
    expect(rows[0]!.called).toBe('600000.00');
    expect(rows[0]!.unfunded).toBe('-100000.00');
    expect(rows[0]!.overdrawn).toBe(true);
  });

  test('no commitment on record is NULL, not false — the three-valued flag', async () => {
    await drawdown('10000.00');
    const { rows } = await sql<{ overdrawn: boolean | null }>`
      select overdrawn from pc.v_lp_position_current where fund_investment_id = ${EMPTY}
    `.execute(db());
    expect(rows[0]!.overdrawn).toBeNull();
  });
});
