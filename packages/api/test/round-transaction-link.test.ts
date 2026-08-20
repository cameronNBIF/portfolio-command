/**
 * F1 · The round/transaction link, and explicit participation (ADR-033).
 *
 * F1 closes findings S-1 and S-2. S-1 is that no interface wrote
 * `transaction.investment_round_id` at all; S-2 is that a round with nothing
 * pointing at it was four states wearing one face. Neither is a metric change,
 * and on the day this lands no board number moves — every round in the database
 * backfills to `yes`.
 *
 * THAT IS PRECISELY WHY THIS SUITE EXISTS. Everything F1 installs is a guard
 * against data that does not exist yet: the first round we sit out will arrive
 * months from now, entered by someone who has never read ADR-033, on a screen
 * nobody is watching. A predicate that nothing exercises is a predicate that
 * gets refactored away by a future reader who cannot see what it is for. So
 * every one of them is exercised here against a round built for the purpose.
 *
 * THE TEST THIS FILE EXISTS FOR is `a round we sat out stays out of the
 * published leverage figure`. It is the only one that touches a board number,
 * and it is the one ADR-033 as written would have missed: the ADR puts the
 * guard in `v_round_leverage`, which is marked CONVENIENCE ONLY and which no
 * API path reads. The published figure comes from `fundMetrics` over the
 * ADR-001 export, so the export carries the predicate too — and this asserts
 * both, because a change to one without the other is silent.
 *
 * What is covered:
 *   1. Participation defaults to `unknown`, not to either answer.
 *   2. The link mutation moves the foreign key AND NOTHING ELSE.
 *   3. Linking is versioned with a named actor, free, via the ADR-031 trigger.
 *   4. Restatement detection works on a link, including for the round the
 *      cheque is being taken OFF.
 *   5. Linking upgrades `unknown` to `yes` from evidence; never overwrites `no`.
 *   6. The two contradictory states are refused, in both directions.
 *   7. Clearing a link confirms standalone; relinking withdraws that.
 *   8. `CAN_CAPTURE_ROUND` gates the link — a deal lead can link and still
 *      cannot touch an amount.
 *   9. A round we sat out leaves `v_round_leverage`, leaves the export, and
 *      moves the published leverage ratio when it is wrongly left in.
 *
 * REQUIRES A DATABASE. Skipped when DATABASE_URL is unset, matching the other
 * database-backed suites; the CI database job sets it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'kysely';

import { fundMetrics } from '@portfolio-command/metrics';

import { closeDb, db } from '../src/db.js';
import type { Principal } from '../src/auth/principal.js';
import { applyLinkTransactions } from '../src/write/link-transactions.js';
import { applyRoundMutation, type RoundCaptureInput } from '../src/write/rounds.js';
import { applyFinancialMutation, type TransactionInput } from '../src/write/financial.js';
import { readCompanyCheques, readRounds } from '../src/read/rounds.js';
import { readRowHistory, readTransactions } from '../src/read/finance.js';
import { buildExport, resolveAsOf } from '../src/read/export.js';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env') });

const hasDb = Boolean(process.env.DATABASE_URL);

const COMPANY = 'PCF101';
const OTHER_COMPANY = 'PCF102';

/** `vc`. Holds CAN_CAPTURE_ROUND and NOT CAN_WRITE_FINANCIAL — the split ADR-033 turns on. */
const LEAD: Principal = {
  userId: '',
  entraObjectId: 'test-f1-vc',
  email: 'f1vc@example.test',
  displayName: 'Test Deal Lead',
  role: 'vc',
};
/** `finance`. Holds both. */
const FINANCE: Principal = { ...LEAD, role: 'finance' };

let instrumentId = 0;

const capture = (over: Partial<RoundCaptureInput> = {}): RoundCaptureInput => ({
  companyId: COMPANY,
  roundDate: '2024-05-01',
  label: 'Series A',
  instrumentId,
  roundTotal: '10000000.00',
  coinvestors: [],
  ...over,
});

const cheque = (over: Partial<TransactionInput> = {}): TransactionInput => ({
  txnDate: '2024-05-01',
  txnType: 'investment',
  companyId: COMPANY,
  amount: '1000000.00',
  ...over,
});

/** Creates a round and returns its id. */
async function newRound(over: Partial<RoundCaptureInput> = {}): Promise<string> {
  const { id } = await applyRoundMutation(db(), LEAD, { op: 'create', values: capture(over) });
  return id;
}

/** Creates an unlinked cheque and returns its id. */
async function newCheque(over: Partial<TransactionInput> = {}): Promise<string> {
  const { id } = await applyFinancialMutation(db(), FINANCE, {
    table: 'transaction',
    op: 'create',
    values: cheque(over),
  });
  return id;
}

/** The whole stored row, so a test can assert that nothing else moved. */
async function txnRow(id: string): Promise<Record<string, unknown>> {
  const { rows } = await sql<{ r: Record<string, unknown> }>`
    select to_jsonb(t) as r from pc.transaction t where transaction_id = ${id}::bigint
  `.execute(db());
  return rows[0]!.r;
}

async function participationOf(roundId: string): Promise<string> {
  const { rows } = await sql<{ v: string }>`
    select nbif_participated as v from pc.investment_round where investment_round_id = ${roundId}::bigint
  `.execute(db());
  return rows[0]!.v;
}

async function inLeverageView(roundId: string): Promise<boolean> {
  const { rows } = await sql<{ n: string }>`
    select count(*)::text as n from pc.v_round_leverage where investment_round_id = ${roundId}::bigint
  `.execute(db());
  return Number(rows[0]!.n) > 0;
}

describe.skipIf(!hasDb)('ADR-033 · the cheque-to-round link and explicit participation', () => {
  beforeEach(async () => {
    await sql`
      insert into pc.app_user (user_id, entra_object_id, display_name, email, role)
      values (gen_random_uuid(), 'test-f1-vc', 'Test Deal Lead', 'f1vc@example.test', 'vc')
      on conflict (entra_object_id) do update set role = 'vc'
    `.execute(db());
    const { rows } = await sql<{ id: string }>`
      select user_id::text as id from pc.app_user where entra_object_id = 'test-f1-vc'
    `.execute(db());
    LEAD.userId = rows[0]!.id;
    FINANCE.userId = rows[0]!.id;

    for (const [id, name] of [[COMPANY, 'Link Test Co'], [OTHER_COMPANY, 'Other Link Test Co']]) {
      await sql`
        insert into pc.company (company_id, name, created_by)
        values (${id!}, ${name!}, ${LEAD.userId}::uuid)
        on conflict (company_id) do nothing
      `.execute(db());
    }

    // Resolved per test: round-trip.test.ts truncates and reloads the reference
    // tables, so the ids are not stable across files.
    const { rows: instr } = await sql<{ id: number }>`
      select instrument_id as id from pc.ref_instrument order by instrument_id limit 1
    `.execute(db());
    instrumentId = Number(instr[0]!.id);

    await sql`select set_config('pc.actor_id', ${LEAD.userId}, false)`.execute(db());
    await sql`delete from pc.transaction where company_id in (${COMPANY}, ${OTHER_COMPANY})`.execute(db());
    await sql`delete from pc.investment_round where company_id in (${COMPANY}, ${OTHER_COMPANY})`.execute(db());
    await sql`delete from pc.financial_row_version where changed_by = ${LEAD.userId}::uuid`.execute(db());
    await sql`delete from pc.fund_nav_snapshot where fund_id = 1 and period_end = '2024-12-31'`.execute(db());
  });

  afterAll(async () => {
    await sql`delete from pc.transaction where company_id in (${COMPANY}, ${OTHER_COMPANY})`
      .execute(db()).catch(() => {});
    await sql`delete from pc.investment_round where company_id in (${COMPANY}, ${OTHER_COMPANY})`
      .execute(db()).catch(() => {});
    await sql`delete from pc.company where company_id in (${COMPANY}, ${OTHER_COMPANY})`
      .execute(db()).catch(() => {});
    await closeDb();
  });

  // --- clause 1: three states, defaulting to neither answer -----------------

  test('a captured round says unknown, not yes and not no', async () => {
    const id = await newRound();
    expect(await participationOf(id)).toBe('unknown');

    const { rows } = await readRounds(db(), LEAD, { companyId: COMPANY });
    expect(rows[0]!.nbifParticipated).toBe('unknown');
  });

  test('unknown is carried by the leverage view, and only an explicit no is dropped', async () => {
    // The reason the column has three states rather than two. If `unknown` were
    // excluded, a historical round nobody has classified would silently leave
    // the leverage figure — and coverage would improve every time somebody
    // failed to answer a question.
    const id = await newRound();
    await newCheque({ amount: '1000000.00' });
    expect(await participationOf(id)).toBe('unknown');
    expect(await inLeverageView(id)).toBe(true);
  });

  // --- clause 5: the mutation, and how narrow it is -------------------------

  test('linking moves the foreign key and nothing else on the transaction', async () => {
    const roundId = await newRound();
    const txnId = await newCheque();

    const before = await txnRow(txnId);
    const result = await applyLinkTransactions(db(), LEAD, {
      transactionIds: [txnId],
      investmentRoundId: roundId,
    });
    expect(result).toMatchObject({ linked: 1, cleared: 0 });

    const after = await txnRow(txnId);

    // THE ASSERTION ADR-033'S PERMISSION ARGUMENT RESTS ON. The gate is
    // CAN_CAPTURE_ROUND rather than CAN_WRITE_FINANCIAL because "an operation
    // that can move a foreign key and nothing else cannot restate Finance's
    // figures". That is only true if it is true, so it is checked here over the
    // whole row rather than over the columns someone remembered to name.
    const bookkeeping = new Set([
      'investment_round_id',
      'standalone_confirmed_at',
      'standalone_confirmed_by',
      'row_updated_at',
    ]);
    for (const key of Object.keys(before)) {
      if (bookkeeping.has(key)) continue;
      expect(after[key], `${key} must not change when a cheque is linked`).toEqual(before[key]);
    }
    expect(after['investment_round_id']).toBe(Number(roundId));
  });

  test('a link is versioned with a named actor, without a line of audit code', async () => {
    // ADR-031's trigger fires on any UPDATE to `transaction`, so `link-
    // transactions` gets audit capture for free. "For free" is worth asserting
    // rather than assuming: it is the reason this module has no audit code, and
    // a future refactor that routed the link around the trigger would leave
    // nothing behind to notice.
    const roundId = await newRound();
    const txnId = await newCheque();

    await applyLinkTransactions(db(), LEAD, {
      transactionIds: [txnId],
      investmentRoundId: roundId,
      reason: 'attached to the Series A at reconciliation',
    });

    const history = await readRowHistory(db(), LEAD, 'transaction', txnId);
    const update = history.find((h) => h.action === 'update');
    expect(update, 'the link must appear in the change log').toBeDefined();
    expect(update!.changedByName).toBe(LEAD.displayName);
    expect(update!.reason).toBe('attached to the Series A at reconciliation');
  });

  test('linking inside a frozen period is refused without a reason, and flagged with one', async () => {
    const roundId = await newRound();
    const txnId = await newCheque();

    await sql`
      insert into pc.fund_nav_snapshot (fund_id, period_end, nav, cumulative_cost, frozen_at)
      values (1, '2024-12-31', 0, 0, now())
      on conflict (fund_id, period_end) do update set frozen_at = now()
    `.execute(db());

    // Correct, and the reason ADR-031's amendment calls this out: the link moves
    // that round's ourInvested and can move leverage, so it restates a published
    // figure exactly as an amount change would.
    await expect(
      applyLinkTransactions(db(), LEAD, { transactionIds: [txnId], investmentRoundId: roundId }),
    ).rejects.toThrow(/already issued to the board/i);

    const result = await applyLinkTransactions(db(), LEAD, {
      transactionIds: [txnId],
      investmentRoundId: roundId,
      reason: 'cheque was booked against no round on import',
    });
    expect(result.restated).toBe(true);
  });

  test('detaching a cheque from a frozen round is caught by the round it is leaving', async () => {
    // The case checking only txn_date would miss. The cheque itself is dated
    // outside the frozen period; the round it is being taken off is inside it,
    // and removing the cheque changes that round's ourInvested.
    const frozenRound = await newRound({ roundDate: '2024-05-01' });
    const txnId = await newCheque({ txnDate: '2025-06-01' });
    await applyLinkTransactions(db(), LEAD, {
      transactionIds: [txnId],
      investmentRoundId: frozenRound,
    });

    await sql`
      insert into pc.fund_nav_snapshot (fund_id, period_end, nav, cumulative_cost, frozen_at)
      values (1, '2024-12-31', 0, 0, now())
      on conflict (fund_id, period_end) do update set frozen_at = now()
    `.execute(db());

    await expect(
      applyLinkTransactions(db(), LEAD, { transactionIds: [txnId], investmentRoundId: null }),
    ).rejects.toThrow(/already issued to the board/i);
  });

  // --- clause 2 extended: evidence upgrades, statements do not ---------------

  test('linking a cheque upgrades unknown to yes, and says so', async () => {
    const roundId = await newRound();
    const txnId = await newCheque();
    expect(await participationOf(roundId)).toBe('unknown');

    const result = await applyLinkTransactions(db(), LEAD, {
      transactionIds: [txnId],
      investmentRoundId: roundId,
    });

    expect(result.participationSetToYes).toBe(true);
    expect(await participationOf(roundId)).toBe('yes');
  });

  test('a round that says we did not participate refuses our cheque rather than rewriting itself', async () => {
    const roundId = await newRound({ nbifParticipated: 'no' });
    const txnId = await newCheque();

    await expect(
      applyLinkTransactions(db(), LEAD, { transactionIds: [txnId], investmentRoundId: roundId }),
    ).rejects.toThrow(/did not participate/i);

    expect(await participationOf(roundId)).toBe('no');
  });

  test('a round holding our cheque refuses to claim we did not participate', async () => {
    // The mirror of the case above, and the other half of ADR-033's state
    // table. Both directions are refused, so the contradiction cannot be
    // reached from either side.
    const roundId = await newRound();
    const txnId = await newCheque();
    await applyLinkTransactions(db(), LEAD, { transactionIds: [txnId], investmentRoundId: roundId });

    await expect(
      applyRoundMutation(db(), LEAD, {
        op: 'update',
        id: roundId,
        values: capture({ nbifParticipated: 'no' }),
      }),
    ).rejects.toThrow(/cheque/i);
  });

  test("a cheque cannot be attached to another company's round", async () => {
    const roundId = await newRound();
    const txnId = await newCheque({ companyId: OTHER_COMPANY });

    await expect(
      applyLinkTransactions(db(), LEAD, { transactionIds: [txnId], investmentRoundId: roundId }),
    ).rejects.toThrow(/different company/i);
  });

  test('an LP cashflow cannot be attached to a financing round', async () => {
    const roundId = await newRound();
    const { rows: lp } = await sql<{ id: string }>`
      select fund_investment_id as id from pc.fund_investment limit 1
    `.execute(db());
    if (lp.length === 0) return; // no LP positions seeded in this database

    const { id: txnId } = await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'create',
      values: {
        txnDate: '2024-05-01',
        txnType: 'capital_call',
        fundInvestmentId: lp[0]!.id,
        amount: '250000.00',
      },
    });

    await expect(
      applyLinkTransactions(db(), LEAD, { transactionIds: [txnId], investmentRoundId: roundId }),
    ).rejects.toThrow(/fund position/i);

    await sql`delete from pc.transaction where transaction_id = ${txnId}::bigint`.execute(db());
  });

  // --- clause 4: a null link somebody has looked at -------------------------

  test('choosing no round confirms the cheque as standalone, and relinking withdraws that', async () => {
    const txnId = await newCheque();

    let rows = (await readTransactions(db(), LEAD, { companyId: COMPANY })).rows;
    expect(rows[0]!.standaloneConfirmedAt, 'a new cheque is unreviewed, not confirmed').toBeNull();

    const cleared = await applyLinkTransactions(db(), LEAD, {
      transactionIds: [txnId],
      investmentRoundId: null,
    });
    expect(cleared).toMatchObject({ linked: 0, cleared: 1 });

    rows = (await readTransactions(db(), LEAD, { companyId: COMPANY })).rows;
    expect(rows[0]!.standaloneConfirmedAt).not.toBeNull();
    expect(rows[0]!.standaloneConfirmedByName).toBe(LEAD.displayName);

    // Attaching a round makes the confirmation false, so it goes. A check
    // constraint enforces this regardless of what the mutation remembers to do.
    const roundId = await newRound();
    await applyLinkTransactions(db(), LEAD, { transactionIds: [txnId], investmentRoundId: roundId });

    rows = (await readTransactions(db(), LEAD, { companyId: COMPANY })).rows;
    expect(rows[0]!.standaloneConfirmedAt).toBeNull();
    expect(rows[0]!.roundLabel).toBe('Series A');
  });

  test('re-saving the same link is a no-op rather than a fresh confirmation', async () => {
    const txnId = await newCheque();
    await applyLinkTransactions(db(), LEAD, { transactionIds: [txnId], investmentRoundId: null });
    const first = (await readTransactions(db(), LEAD, { companyId: COMPANY })).rows[0]!
      .standaloneConfirmedAt;

    const again = await applyLinkTransactions(db(), LEAD, {
      transactionIds: [txnId],
      investmentRoundId: null,
    });
    expect(again).toMatchObject({ linked: 0, cleared: 0 });

    // The column answers "when was this looked at". Restamping it on every save
    // would make a cheque nobody has revisited look freshly reviewed.
    const second = (await readTransactions(db(), LEAD, { companyId: COMPANY })).rows[0]!
      .standaloneConfirmedAt;
    expect(second).toBe(first);
  });

  // --- clause 6: the permission split ---------------------------------------

  test('a deal lead can link a cheque and still cannot touch its amount', async () => {
    // ADR-033's whole permission argument in one test. `vc` is in
    // CAN_CAPTURE_ROUND and not in CAN_WRITE_FINANCIAL, and the link is
    // deliberately on the first side of that line.
    const roundId = await newRound();
    const txnId = await newCheque();

    await expect(
      applyLinkTransactions(db(), LEAD, { transactionIds: [txnId], investmentRoundId: roundId }),
    ).resolves.toMatchObject({ linked: 1 });

    await expect(
      applyFinancialMutation(db(), LEAD, {
        table: 'transaction',
        op: 'update',
        id: txnId,
        values: cheque({ amount: '9999999.00' }),
      }),
    ).rejects.toThrow(/finance/i);
  });

  // --- the read the Deal Close surface is built on --------------------------

  test('the round carries its cheques, and the company carries every cheque that could join one', async () => {
    const roundId = await newRound();
    const linked = await newCheque({ amount: '1000000.00' });
    const loose = await newCheque({ amount: '250000.00', txnDate: '2024-09-01' });
    await applyLinkTransactions(db(), LEAD, { transactionIds: [linked], investmentRoundId: roundId });

    const { rows } = await readRounds(db(), LEAD, { companyId: COMPANY });
    expect(rows[0]!.cheques.map((c) => c.id)).toEqual([linked]);
    // The list and the total are read in one query so they cannot disagree.
    expect(rows[0]!.ourInvested).toBe('1000000.00');

    const cheques = await readCompanyCheques(db(), LEAD, COMPANY);
    expect(cheques.map((c) => c.id).sort()).toEqual([linked, loose].sort());
    expect(cheques.find((c) => c.id === linked)!.roundLabel).toBe('Series A');
    expect(cheques.find((c) => c.id === loose)!.investmentRoundId).toBeNull();
  });

  // --- clause 3: the guard, in the place that actually reports the number ----

  test('a round we sat out stays out of the published leverage figure', async () => {
    /**
     * THE TEST THIS FILE EXISTS FOR.
     *
     * Two rounds for one company. We wrote a $1M cheque into the first; we sat
     * the second out entirely, and it is $9M. If the second is counted, it adds
     * $9M of "capital attracted" against $0 of our own cost — so the leverage
     * ratio goes UP because we did LESS, which is the metric reporting the
     * opposite of what happened.
     *
     * The `unknown` pass is the counterfactual and it is the point: it is what
     * the number looks like with the guard absent. Without it this test would
     * pass just as well against a predicate that excluded nothing.
     */
    const joined = await newRound({ label: 'Series A', roundTotal: '5000000.00' });
    const txnId = await newCheque({ amount: '1000000.00' });
    await applyLinkTransactions(db(), LEAD, { transactionIds: [txnId], investmentRoundId: joined });

    const satOut = await newRound({
      label: 'Series B',
      roundDate: '2025-03-01',
      roundTotal: '9000000.00',
      nbifParticipated: 'unknown',
    });

    const asOf = await resolveAsOf(db());
    const leverageNow = async (): Promise<number | null> =>
      fundMetrics(await buildExport(db(), { asOf }), { asOf }).leverage;

    // --- with the round wrongly left in ---
    expect(await inLeverageView(satOut)).toBe(true);
    const inflated = await leverageNow();
    const withRound = (await buildExport(db(), { asOf })).companies.find((c) => c.id === COMPANY);
    expect(withRound!.rounds.map((r) => r.label).sort()).toEqual(['Series A', 'Series B']);

    // --- now say out loud that we sat it out ---
    await applyRoundMutation(db(), LEAD, {
      op: 'update',
      id: satOut,
      values: capture({
        label: 'Series B',
        roundDate: '2025-03-01',
        roundTotal: '9000000.00',
        nbifParticipated: 'no',
      }),
    });

    // The view ADR-033 names...
    expect(await inLeverageView(satOut)).toBe(false);

    // ...and the export the published figure is actually computed from. This is
    // the half ADR-033 as written would have left open.
    const after = (await buildExport(db(), { asOf })).companies.find((c) => c.id === COMPANY);
    expect(after!.rounds.map((r) => r.label)).toEqual(['Series A']);

    // The round we DID join is untouched, cheque and all.
    expect(after!.rounds[0]!.roundTotal).toBeCloseTo(5, 6);
    expect(after!.rounds[0]!.invested).toBeCloseTo(1, 6);

    // And the board number moves — which is the whole reason the predicate is
    // in the export and not only in the view.
    const corrected = await leverageNow();
    expect(inflated).not.toBeNull();
    expect(corrected).not.toBeNull();
    expect(corrected!).toBeLessThan(inflated!);
  });
});
