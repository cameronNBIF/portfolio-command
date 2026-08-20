/**
 * The A8 verification: deal-close capture, and the guarantee migration 0003 was
 * written to give `round_coinvestor`.
 *
 * A7 priced ADR-031 on one property — a figure the board has already seen can
 * still be reproduced after the row behind it changes — and asserted it directly
 * rather than trusting the trigger. A8 extends the editable surface to two more
 * mandate figures, so it owes the same assertion on the same terms.
 *
 * THE TEST THIS FILE EXISTS FOR is `an NB co-investment figure survives a later
 * correction`. Everything else here is scaffolding around it. If it is deleted
 * or skipped, `round_coinvestor` has an edit button and no reproducibility
 * guarantee, which is the exact state migration 0003 was written to prevent.
 *
 * What is covered:
 *   1. One capture writes all three ADR-012 tables in one transaction.
 *   2. A co-investor cannot be modified anonymously, including from psql.
 *   3. Reconstruction returns the pre-edit NB co-investment figure.
 *   4. Removing a co-investor is a soft delete: it leaves the totals, stays
 *      reconstructable, and re-adding the same name restores rather than
 *      duplicates.
 *   5. A round total below our own cheque is ACCEPTED and flagged, never
 *      refused (ADR-012's exclusion rule).
 *   6. A soft-deleted round leaves coverage, leverage and the export.
 *   7. The restatement gate fires on a co-investor, which only works because
 *      0003 resolves its effective date from the parent round.
 *   8. Leadership is refused.
 *
 * REQUIRES A DATABASE. Skipped when DATABASE_URL is unset, matching the other
 * two suites; the database CI job sets it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'kysely';

import { closeDb, db } from '../src/db.js';
import type { Principal } from '../src/auth/principal.js';
import { applyRoundMutation, type RoundCaptureInput } from '../src/write/rounds.js';
import { applyFinancialMutation } from '../src/write/financial.js';
import { readMandateCompleteness, readRounds } from '../src/read/rounds.js';
import { readRowHistory } from '../src/read/finance.js';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env') });

const hasDb = Boolean(process.env.DATABASE_URL);

const COMPANY = 'PCA801';

const LEAD: Principal = {
  userId: '',
  entraObjectId: 'test-vc',
  email: 'vc@example.test',
  displayName: 'Test Deal Lead',
  role: 'vc',
};

const LEADERSHIP: Principal = { ...LEAD, role: 'leadership' };

let instrumentId = 0;

/** A complete, valid capture. Individual tests override the fields they care about. */
const capture = (over: Partial<RoundCaptureInput> = {}): RoundCaptureInput => ({
  companyId: COMPANY,
  roundDate: '2024-05-01',
  label: 'Series A',
  instrumentId,
  roundTotal: '10000000.00',
  nbOther: '1500000.00',
  postMoney: '40000000.00',
  ownershipAfterPct: '12.5',
  leadInvestor: 'Meridian Growth',
  coinvestors: [
    { investorName: 'Meridian Growth', isNbBased: false, amount: '6000000.00' },
    { investorName: 'East Valley Fund', isNbBased: true, amount: '1500000.00' },
  ],
  ...over,
});

/** NB co-investment for this round's co-investors, as every read path sums it. */
async function nbCoinvestment(roundId: string): Promise<string> {
  const { rows } = await sql<{ v: string }>`
    select coalesce(sum(amount), 0)::text as v
      from pc.round_coinvestor
     where investment_round_id = ${roundId}::bigint and is_nb_based and deleted_at is null
  `.execute(db());
  return rows[0]!.v;
}

/** The same figure reconstructed as it stood at an instant (migration 0003). */
async function nbCoinvestmentAsOf(roundId: string, at: string): Promise<string> {
  const { rows } = await sql<{ v: string }>`
    select coalesce(sum(amount), 0)::text as v
      from pc.round_coinvestor_asof(${at}::timestamptz)
     where investment_round_id = ${roundId}::bigint and is_nb_based
  `.execute(db());
  return rows[0]!.v;
}

const nowInDb = async (): Promise<string> => {
  const { rows } = await sql<{ t: string }>`select clock_timestamp()::text as t`.execute(db());
  return rows[0]!.t;
};

describe.skipIf(!hasDb)('ADR-012 deal-close capture', () => {
  beforeEach(async () => {
    await sql`
      insert into pc.app_user (user_id, entra_object_id, display_name, email, role)
      values (gen_random_uuid(), 'test-vc', 'Test Deal Lead', 'vc@example.test', 'vc')
      on conflict (entra_object_id) do update set role = 'vc'
    `.execute(db());
    const { rows } = await sql<{ id: string }>`
      select user_id::text as id from pc.app_user where entra_object_id = 'test-vc'
    `.execute(db());
    LEAD.userId = rows[0]!.id;
    LEADERSHIP.userId = rows[0]!.id;

    await sql`
      insert into pc.company (company_id, name, created_by)
      values (${COMPANY}, 'Capture Test Co', ${LEAD.userId}::uuid)
      on conflict (company_id) do nothing
    `.execute(db());

    // The instrument vocabulary is seeded, but round-trip.test.ts truncates and
    // reloads, so the ids are not stable across files. Resolved per test.
    const { rows: instr } = await sql<{ id: number }>`
      select instrument_id as id from pc.ref_instrument order by instrument_id limit 1
    `.execute(db());
    instrumentId = Number(instr[0]!.id);

    await sql`select set_config('pc.actor_id', ${LEAD.userId}, false)`.execute(db());
    await sql`delete from pc.transaction where company_id = ${COMPANY}`.execute(db());
    // Ownership before rounds: F3's investment_round_id link means a round
    // cannot be hard-deleted while a position still names it.
    await sql`delete from pc.company_ownership where company_id = ${COMPANY}`.execute(db());
    await sql`delete from pc.investment_round where company_id = ${COMPANY}`.execute(db());
    // Scoped to this suite's actor for the same reason the A7 suite is: ids are
    // handed out again after a RESTART IDENTITY truncate, and version rows keyed
    // on an old id would read as history belonging to a new row.
    await sql`delete from pc.financial_row_version where changed_by = ${LEAD.userId}::uuid`.execute(db());
    await sql`delete from pc.fund_nav_snapshot where fund_id = 1 and period_end = '2024-12-31'`.execute(db());
  });

  afterAll(async () => {
    await sql`delete from pc.transaction where company_id = ${COMPANY}`.execute(db()).catch(() => {});
    await sql`delete from pc.company_ownership where company_id = ${COMPANY}`.execute(db()).catch(() => {});
    await sql`delete from pc.investment_round where company_id = ${COMPANY}`.execute(db()).catch(() => {});
    await sql`delete from pc.company where company_id = ${COMPANY}`.execute(db()).catch(() => {});
    await closeDb();
  });

  test('one capture writes the round, its co-investors and the ownership row', async () => {
    const result = await applyRoundMutation(db(), LEAD, {
      op: 'create',
      values: capture({
        ownership: { asOfDate: '2024-05-01', ownershipPct: '12.5', proRataRights: true },
      }),
    });

    expect(result.coinvestors).toEqual({ created: 2, updated: 0, removed: 0 });
    expect(result.ownershipWritten).toBe(true);

    const page = await readRounds(db(), LEAD, { companyId: COMPANY });
    const round = page.rows.find((r) => r.id === result.id)!;
    expect(round.roundTotal).toBe('10000000.00');
    expect(round.nbOther).toBe('1500000.00');
    expect(round.ownershipAfterPct).toBe('12.5000000000000000');
    expect(round.coinvestors).toHaveLength(2);
    expect(round.coinvestorNbTotal).toBe('1500000.00');
    // ADR-012's marker that a deal lead has been through the form. This is what
    // v_mandate_completeness counts, and what tells "nobody has opened this"
    // apart from "someone opened it and left a field blank".
    expect(round.capturedAt).not.toBeNull();
    expect(round.capturedByName).toBe('Test Deal Lead');

    const { rows: own } = await sql<{ pct: string; pro_rata: boolean }>`
      select ownership_pct::text as pct, pro_rata_rights as pro_rata
        from pc.company_ownership
       where company_id = ${COMPANY} and as_of_date = '2024-05-01'
    `.execute(db());
    expect(own).toHaveLength(1);
    expect(own[0]!.pro_rata).toBe(true);
  });

  test('a co-investor cannot be modified without naming an actor', async () => {
    const { id } = await applyRoundMutation(db(), LEAD, { op: 'create', values: capture() });

    // Anything that did not come through the write path, psql included.
    await expect(
      sql`
        do $$ begin
          perform set_config('pc.actor_id', '', false);
          update pc.round_coinvestor set amount = 1
           where investment_round_id = ${sql.lit(Number(id))};
        end $$;
      `.execute(db()),
    ).rejects.toThrow(/cannot be modified anonymously/i);

    expect(await nbCoinvestment(id)).toBe('1500000.00');
  });

  /**
   * THE ONE THIS PHASE IS PRICED ON.
   *
   * A board pack quotes NB co-investment. A deal lead later finds the East
   * Valley cheque was 1.5M rather than 2.1M and corrects it. The published
   * figure must still be reproducible from the database afterwards, or ADR-031's
   * guarantee does not extend to the table A8 just made editable.
   */
  test('an NB co-investment figure survives a later correction', async () => {
    const { id } = await applyRoundMutation(db(), LEAD, {
      op: 'create',
      values: capture({
        coinvestors: [{ investorName: 'East Valley Fund', isNbBased: true, amount: '2100000.00' }],
      }),
    });
    expect(await nbCoinvestment(id)).toBe('2100000.00');

    const beforeTheCorrection = await nowInDb();

    await applyRoundMutation(db(), LEAD, {
      op: 'update',
      id,
      reason: 'East Valley confirmed the cheque was 1.5M, not 2.1M',
      values: capture({
        coinvestors: [{ investorName: 'East Valley Fund', isNbBased: true, amount: '1500000.00' }],
      }),
    });

    expect(await nbCoinvestment(id)).toBe('1500000.00');
    // and the figure the board was shown still reconstructs
    expect(await nbCoinvestmentAsOf(id, beforeTheCorrection)).toBe('2100000.00');
  });

  test('removing a co-investor is a soft delete, and re-adding restores it', async () => {
    const { id } = await applyRoundMutation(db(), LEAD, { op: 'create', values: capture() });
    const beforeRemoval = await nowInDb();

    const removed = await applyRoundMutation(db(), LEAD, {
      op: 'update',
      id,
      reason: 'East Valley did not close after all',
      values: capture({
        coinvestors: [{ investorName: 'Meridian Growth', isNbBased: false, amount: '6000000.00' }],
      }),
    });
    expect(removed.coinvestors.removed).toBe(1);
    expect(await nbCoinvestment(id)).toBe('0');
    // Out of the total, still reconstructable — which a hard DELETE would not be.
    expect(await nbCoinvestmentAsOf(id, beforeRemoval)).toBe('1500000.00');

    const readded = await applyRoundMutation(db(), LEAD, {
      op: 'update',
      id,
      reason: 'East Valley closed a month late',
      values: capture(),
    });
    // Restored on the same row rather than duplicated: a removal and an undo
    // should leave one row with a legible history, not two rows and a puzzle.
    expect(readded.coinvestors.created).toBe(0);
    expect(await nbCoinvestment(id)).toBe('1500000.00');

    const { rows } = await sql<{ n: string }>`
      select count(*)::text as n from pc.round_coinvestor
       where investment_round_id = ${id}::bigint and investor_name = 'East Valley Fund'
    `.execute(db());
    expect(rows[0]!.n).toBe('1');
  });

  /**
   * ADR-012: "a round with a missing or invalid total is EXCLUDED from leverage,
   * never imputed". Excluded is not the same as refused, and the form must not
   * push a deal lead into adjusting a figure to get past validation.
   */
  test('a round total below our own cheque is accepted and flagged, not refused', async () => {
    const { id } = await applyRoundMutation(db(), LEAD, {
      op: 'create',
      values: capture({ roundTotal: '500000.00', nbOther: null }),
    });

    await applyFinancialMutation(db(), { ...LEAD, role: 'admin' }, {
      table: 'transaction',
      op: 'create',
      values: {
        txnDate: '2024-05-01', txnType: 'investment', companyId: COMPANY,
        amount: '2000000.00', investmentRoundId: id,
      },
    });

    const page = await readRounds(db(), LEAD, { companyId: COMPANY });
    const round = page.rows.find((r) => r.id === id)!;
    expect(round.roundTotal).toBe('500000.00');
    expect(round.excludedFromLeverage).toBe(true);

    // v_round_leverage drops it, which is the definition rather than a display rule.
    const { rows } = await sql<{ n: string }>`
      select count(*)::text as n from pc.v_round_leverage where investment_round_id = ${id}::bigint
    `.execute(db());
    expect(rows[0]!.n).toBe('0');
  });

  test('a soft-deleted round leaves coverage and leverage', async () => {
    const { id } = await applyRoundMutation(db(), LEAD, { op: 'create', values: capture() });

    const before = await readMandateCompleteness(db());
    await applyRoundMutation(db(), LEAD, {
      op: 'delete', id, reason: 'entered against the wrong company',
    });
    const after = await readMandateCompleteness(db());

    expect(after.roundsTotal).toBe(before.roundsTotal - 1);

    const { rows } = await sql<{ n: string }>`
      select count(*)::text as n from pc.v_round_leverage where investment_round_id = ${id}::bigint
    `.execute(db());
    expect(rows[0]!.n).toBe('0');

    // And it comes back.
    await applyRoundMutation(db(), LEAD, { op: 'restore', id });
    expect((await readMandateCompleteness(db())).roundsTotal).toBe(before.roundsTotal);
  });

  test('a round still carrying transactions cannot be deleted', async () => {
    const { id } = await applyRoundMutation(db(), LEAD, { op: 'create', values: capture() });
    await applyFinancialMutation(db(), { ...LEAD, role: 'admin' }, {
      table: 'transaction',
      op: 'create',
      values: {
        txnDate: '2024-05-01', txnType: 'investment', companyId: COMPANY,
        amount: '2000000.00', investmentRoundId: id,
      },
    });

    await expect(
      applyRoundMutation(db(), LEAD, { op: 'delete', id, reason: 'tidying up' }),
    ).rejects.toThrow(/still has 1 transaction/i);
  });

  /**
   * The restatement gate, and the reason migration 0003 had to touch the trigger
   * at all: `round_coinvestor` carries no date column, so without the
   * parent-round fallback a co-investor edit inside an issued period would be
   * recorded with is_restatement = false and stay out of v_restatement_log.
   */
  test('editing inside a frozen period is refused without a reason, and flagged with one', async () => {
    const { id } = await applyRoundMutation(db(), LEAD, { op: 'create', values: capture() });

    await sql`
      insert into pc.fund_nav_snapshot (fund_id, period_end, nav, cumulative_cost, frozen_at)
      values (1, '2024-12-31', 0, 0, now())
      on conflict (fund_id, period_end) do update set frozen_at = now()
    `.execute(db());

    await expect(
      applyRoundMutation(db(), LEAD, { op: 'update', id, values: capture({ roundTotal: '11000000.00' }) }),
    ).rejects.toThrow(/already issued to the board/i);

    const result = await applyRoundMutation(db(), LEAD, {
      op: 'update',
      id,
      reason: 'closing statement received, round was 11M not 10M',
      values: capture({
        roundTotal: '11000000.00',
        coinvestors: [
          { investorName: 'Meridian Growth', isNbBased: false, amount: '6000000.00' },
          { investorName: 'East Valley Fund', isNbBased: true, amount: '2000000.00' },
        ],
      }),
    });
    expect(result.restated).toBe(true);

    // The round's own version row is flagged...
    const roundHistory = await readRowHistory(db(), LEAD, 'investment_round', id);
    expect(roundHistory.some((h) => h.action === 'update' && h.isRestatement)).toBe(true);

    // ...and so is the co-investor's, which is the 0003 fallback working. The
    // co-investor knows no date of its own; it inherits the round's.
    const { rows: coRows } = await sql<{ id: string }>`
      select round_coinvestor_id::text as id from pc.round_coinvestor
       where investment_round_id = ${id}::bigint and investor_name = 'East Valley Fund'
    `.execute(db());
    const coHistory = await readRowHistory(db(), LEAD, 'round_coinvestor', coRows[0]!.id);
    expect(coHistory.some((h) => h.isRestatement)).toBe(true);
  });

  test('leadership may read the portfolio but not capture a round', async () => {
    await expect(
      applyRoundMutation(db(), LEADERSHIP, { op: 'create', values: capture() }),
    ).rejects.toThrow(/Requires one of \[vc, finance, admin\]/);
  });
});
