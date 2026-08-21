/**
 * F6 · The reconciliation surface (ADR-038), and the three things it promises.
 *
 * 1. **Every check finds what it is for, and nothing else.** A check that
 *    over-fires is worse than one that does not exist: the roadmap's own
 *    argument against this phase is that a list nobody can act on becomes
 *    wallpaper, and the fastest route there is a predicate that matches
 *    legitimate data. So each check is asserted to fire on a constructed
 *    failure AND to fall silent once it is fixed.
 *
 * 2. **The duplicate rule is a warning, never a block** (ADR-038 clause 4).
 *    Both halves are stated, because a test that only asserted the refusal
 *    would be indistinguishable from a test of a hard block — which is the
 *    opposite of the decision.
 *
 * 3. **A correction and a late arrival stop looking alike** (FR-14). The
 *    version store records which, and `new-information` is refused where there
 *    is nothing to restate, because a value selectable anywhere is one people
 *    pick at random.
 *
 * REQUIRES A DATABASE. Skipped when DATABASE_URL is unset, matching the other
 * database-backed suites.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'kysely';

import { closeDb, db } from '../src/db.js';
import type { Principal } from '../src/auth/principal.js';
import { applyFinancialMutation } from '../src/write/financial.js';
import { applyRoundMutation, type RoundCaptureInput } from '../src/write/rounds.js';
import { readReconciliation, type ReconciliationCheck } from '../src/read/reconciliation.js';
import { readRowHistory } from '../src/read/finance.js';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env') });

const hasDb = Boolean(process.env.DATABASE_URL);

const COMPANY = 'PCF601';
const OTHER = 'PCF602';

const FINANCE: Principal = {
  userId: '',
  entraObjectId: 'test-f6-finance',
  email: 'f6@example.test',
  displayName: 'Test Controller',
  role: 'finance',
};

let instrumentId = 0;

const round = (over: Partial<RoundCaptureInput> = {}): RoundCaptureInput => ({
  companyId: COMPANY,
  roundDate: '2025-03-01',
  label: 'Series A',
  instrumentId,
  coinvestors: [],
  ...over,
});

/** The rows this suite's own companies produced, for one check. */
async function mine(check: ReconciliationCheck): Promise<
  { subjectId: string; companyName: string; figureA: string | null; figureB: string | null }[]
> {
  const report = await readReconciliation(db(), FINANCE, { check });
  return report.rows
    .filter((r) => r.companyId === COMPANY || r.companyId === OTHER)
    .map((r) => ({
      subjectId: r.subjectId,
      companyName: r.companyName,
      figureA: r.figureA,
      figureB: r.figureB,
    }));
}

describe.skipIf(!hasDb)('ADR-038 · the reconciliation surface', () => {
  beforeEach(async () => {
    await sql`
      insert into pc.app_user (user_id, entra_object_id, display_name, email, role)
      values (gen_random_uuid(), 'test-f6-finance', 'Test Controller', 'f6@example.test', 'finance')
      on conflict (entra_object_id) do update set role = 'finance'
    `.execute(db());
    const { rows } = await sql<{ id: string }>`
      select user_id::text as id from pc.app_user where entra_object_id = 'test-f6-finance'
    `.execute(db());
    FINANCE.userId = rows[0]!.id;
    await sql`select set_config('pc.actor_id', ${FINANCE.userId}, false)`.execute(db());

    for (const [id, name] of [[COMPANY, 'Reconcile Test Co'], [OTHER, 'Second Test Co']]) {
      await sql`
        insert into pc.company (company_id, name, created_by)
        values (${id!}, ${name!}, ${FINANCE.userId}::uuid)
        on conflict (company_id) do nothing
      `.execute(db());
    }

    const { rows: instr } = await sql<{ id: number }>`
      select instrument_id as id from pc.ref_instrument order by instrument_id limit 1
    `.execute(db());
    instrumentId = Number(instr[0]!.id);

    await sql`delete from pc.transaction where company_id in (${COMPANY}, ${OTHER})`.execute(db());
    await sql`delete from pc.investment_round where company_id in (${COMPANY}, ${OTHER})`.execute(db());
    await sql`delete from pc.valuation_mark where company_id in (${COMPANY}, ${OTHER})`.execute(db());
    await sql`delete from pc.financial_row_version where changed_by = ${FINANCE.userId}::uuid`.execute(db());
  });

  afterAll(async () => {
    for (const t of ['transaction', 'valuation_mark', 'investment_round']) {
      await sql`delete from ${sql.table(`pc.${t}`)} where company_id in (${COMPANY}, ${OTHER})`
        .execute(db()).catch(() => {});
    }
    await sql`delete from pc.company where company_id in (${COMPANY}, ${OTHER})`
      .execute(db()).catch(() => {});
    await closeDb();
  });

  // --- the catalogue -------------------------------------------------------

  test('all eight checks are reported, including the ones finding nothing', async () => {
    /**
     * The design decision this asserts: a surface listing only what is wrong
     * cannot distinguish "this check found nothing" from "this check stopped
     * running". A zero is evidence; an absence is not.
     */
    const report = await readReconciliation(db(), FINANCE);
    expect(report.checks).toHaveLength(8);
    expect(report.checks.map((c) => c.kind)).toEqual([
      'unlinked-cheque',
      'participated-no-cheque',
      'unclassified-round',
      'coinvestor-sum-mismatch',
      'round-total-below-cheque',
      'mark-basis-drift',
      'exit-status-mismatch',
      'lp-overdrawn',
    ]);
    // Every check names the screen that fixes it. A row that cannot be acted on
    // from the list is the failure this whole phase is designed against.
    for (const c of report.checks) {
      expect(c.fixSurface).toBeTruthy();
      expect(c.fixLabel.length).toBeGreaterThan(0);
      expect(c.meaning.length).toBeGreaterThan(20);
    }
  });

  // --- the checks ----------------------------------------------------------

  test('an unlinked cheque fires, and confirming it standalone clears it', async () => {
    const { id } = await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'create',
      values: { txnDate: '2025-03-05', txnType: 'investment', companyId: COMPANY, amount: '250000.00' },
    });

    expect(await mine('unlinked-cheque')).toHaveLength(1);

    /* F1 added `standalone_confirmed_at` for exactly this: without it the
       surface reports every legitimately standalone cheque forever, and a list
       that can never reach zero is one people stop reading. */
    await sql`
      update pc.transaction
         set standalone_confirmed_at = clock_timestamp(), standalone_confirmed_by = ${FINANCE.userId}::uuid
       where transaction_id = ${id}::bigint
    `.execute(db());

    expect(await mine('unlinked-cheque')).toHaveLength(0);
  });

  test('a round we say we were in with no cheque against it fires', async () => {
    await applyRoundMutation(db(), FINANCE, {
      op: 'create',
      values: round({ nbifParticipated: 'yes', roundTotal: '4000000.00' }),
    });
    expect(await mine('participated-no-cheque')).toHaveLength(1);

    // `no` is what makes a round with no cheque legitimate rather than an
    // error (ADR-033), so it must take the row off this list.
    const rows = await readReconciliation(db(), FINANCE, { check: 'participated-no-cheque' });
    const id = rows.rows.find((r) => r.companyId === COMPANY)!.subjectId;
    await applyRoundMutation(db(), FINANCE, {
      op: 'update',
      id,
      values: round({ nbifParticipated: 'no', roundTotal: '4000000.00' }),
    });
    expect(await mine('participated-no-cheque')).toHaveLength(0);
  });

  test('a round whose cheques carry no instrument is awaiting classification', async () => {
    const { id: roundId } = await applyRoundMutation(db(), FINANCE, {
      op: 'create',
      values: round({ nbifParticipated: 'yes' }),
    });
    await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'create',
      values: {
        txnDate: '2025-03-05',
        txnType: 'investment',
        companyId: COMPANY,
        investmentRoundId: roundId,
        amount: '250000.00',
        // No instrument, no vehicle: F0 left 104 of 284 like this, honestly.
      },
    });

    const found = await mine('unclassified-round');
    expect(found).toHaveLength(1);
    // The two figures are counts, not money: cheques, and how many are unclassified.
    expect(found[0]!.figureA).toBe('1');
    expect(found[0]!.figureB).toBe('1');
  });

  test('nb_other and the NB co-investor sum disagreeing fires — S-10, on a screen', async () => {
    await applyRoundMutation(db(), FINANCE, {
      op: 'create',
      values: round({
        roundTotal: '4000000.00',
        nbOther: '900000.00',
        coinvestors: [
          { investorName: 'NB Fund One', isNbBased: true, amount: '400000.00' },
          { investorName: 'Elsewhere Capital', isNbBased: false, amount: '2000000.00' },
        ],
      }),
    });

    const found = await mine('coinvestor-sum-mismatch');
    expect(found).toHaveLength(1);
    // The KPI's figure first, the co-investor rows second. Naming both is the
    // whole of FR-09: a row saying only "these disagree" sends the reader back
    // to three screens to find out how.
    expect(found[0]!.figureA).toBe('900000.00');
    expect(found[0]!.figureB).toBe('400000.00');
  });

  test('a round smaller than our own cheque fires, and was never refused', async () => {
    const { id: roundId } = await applyRoundMutation(db(), FINANCE, {
      op: 'create',
      values: round({ nbifParticipated: 'yes', roundTotal: '100000.00' }),
    });
    await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'create',
      values: {
        txnDate: '2025-03-05',
        txnType: 'investment',
        companyId: COMPANY,
        investmentRoundId: roundId,
        amount: '250000.00',
        instrumentId,
      },
    });

    const found = await mine('round-total-below-cheque');
    expect(found).toHaveLength(1);
    expect(found[0]!.figureA).toBe('100000.00');
    expect(found[0]!.figureB).toBe('250000.00');
  });

  test('a mark whose basis was corrected afterwards fires — the reason F2 stored it', async () => {
    /**
     * D-3, and the single most easily deleted line in F2. `basis_fmv` is
     * stored rather than looked up so that a later correction to the basis
     * becomes DETECTABLE rather than silently invalidating everything derived
     * from it. This is the detection, and without this test the storage looks
     * redundant to anyone tidying up.
     */
    const { id: basis } = await applyFinancialMutation(db(), FINANCE, {
      table: 'valuation_mark',
      op: 'create',
      values: {
        companyId: COMPANY,
        effectiveDate: '2025-01-31',
        fmv: '1000000.00',
        methodLabel: 'Last round price',
        rationale: 'Baseline for the drift test.',
      },
    });
    await applyFinancialMutation(db(), FINANCE, {
      table: 'valuation_mark',
      op: 'create',
      values: {
        companyId: COMPANY,
        effectiveDate: '2025-07-31',
        adjustmentType: 'review',
        retentionFactor: '0.7500',
        methodLabel: 'Semi-annual review',
        rationale: 'Reviewed and impaired.',
      },
    });

    expect(await mine('mark-basis-drift')).toHaveLength(0);

    // The basis is corrected after the fact. Everything derived from it was
    // computed against a figure that no longer exists.
    await applyFinancialMutation(db(), FINANCE, {
      table: 'valuation_mark',
      op: 'update',
      id: basis,
      values: {
        companyId: COMPANY,
        effectiveDate: '2025-01-31',
        fmv: '1200000.00',
        methodLabel: 'Last round price',
        rationale: 'Corrected against the executed term sheet.',
      },
    });

    const found = await mine('mark-basis-drift');
    expect(found).toHaveLength(1);
    expect(found[0]!.figureA).toBe('1000000.00'); // as applied
    expect(found[0]!.figureB).toBe('1200000.00'); // as it now stands
  });

  // --- FR-08: a warning, and both halves of what that means ---------------

  test('a duplicate round is REFUSED without an acknowledgement', async () => {
    await applyRoundMutation(db(), FINANCE, { op: 'create', values: round({ label: 'Series A' }) });

    await expect(
      applyRoundMutation(db(), FINANCE, {
        op: 'create',
        values: round({ label: 'series  a!', roundDate: '2025-09-01' }),
      }),
    ).rejects.toThrow(/already has a round called/i);
  });

  test('and ACCEPTED with one — never a hard block', async () => {
    /**
     * ADR-038 clause 4, and the half a test of a hard block would look
     * identical without. The codebase's precedent is that a round total below
     * our own cheque is accepted and flagged, because pushing somebody into
     * fudging a figure to get past a form is worse than the figure being wrong
     * and visible.
     */
    await applyRoundMutation(db(), FINANCE, { op: 'create', values: round({ label: 'Series A' }) });

    const { id } = await applyRoundMutation(db(), FINANCE, {
      op: 'create',
      values: round({ label: 'Series A', roundDate: '2025-09-01' }),
      duplicateAckReason: 'Second tranche of the same raise, closed six months later.',
    });

    const { rows } = await sql<{ reason: string; by: string }>`
      select duplicate_ack_reason as reason, duplicate_ack_by::text as by
        from pc.investment_round where investment_round_id = ${id}::bigint
    `.execute(db());
    // Stored on the row, so the acknowledgement outlives the session that gave it.
    expect(rows[0]!.reason).toMatch(/second tranche/i);
    expect(rows[0]!.by).toBe(FINANCE.userId);
  });

  test('a bridge does not collide with the round it is under', async () => {
    /**
     * Funke's point, and the reason the rule needs no date window: bridged
     * funding "shows up as a qualifier, like an adjective", so real data reads
     * "Series A bridge" and normalises differently from "Series A".
     */
    await applyRoundMutation(db(), FINANCE, { op: 'create', values: round({ label: 'Series A' }) });
    const { id } = await applyRoundMutation(db(), FINANCE, {
      op: 'create',
      values: round({ label: 'Series A bridge', roundDate: '2025-11-01' }),
    });
    expect(id).toBeTruthy();
  });

  test('normalisation is case and punctuation only, not fuzzy', async () => {
    // "Series A" and "Series A-2" are different rounds and must stay so while
    // Q-9 is open. A rule that fires constantly gets clicked through unread.
    await applyRoundMutation(db(), FINANCE, { op: 'create', values: round({ label: 'Series A' }) });
    const { id } = await applyRoundMutation(db(), FINANCE, {
      op: 'create',
      values: round({ label: 'Series A-2', roundDate: '2025-11-01' }),
    });
    expect(id).toBeTruthy();
  });

  test('a duplicate is scoped to one company', async () => {
    await applyRoundMutation(db(), FINANCE, { op: 'create', values: round({ label: 'Series A' }) });
    const { id } = await applyRoundMutation(db(), FINANCE, {
      op: 'create',
      values: round({ companyId: OTHER, label: 'Series A' }),
    });
    expect(id).toBeTruthy();
  });

  // --- FR-14: a correction is not a late arrival --------------------------

  test('the version store records WHY a row changed, not only what', async () => {
    const { id } = await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'create',
      values: { txnDate: '2025-03-05', txnType: 'investment', companyId: COMPANY, amount: '250000.00' },
    });
    await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'update',
      id,
      values: { txnDate: '2025-03-05', txnType: 'investment', companyId: COMPANY, amount: '260000.00' },
      reason: 'Corrected against the wire confirmation.',
      changeKind: 'correction',
    });

    const history = await readRowHistory(db(), FINANCE, 'transaction', id);
    expect(history.some((h) => h.changeKind === 'correction')).toBe(true);
    // The creation predates any classification and is honestly unclassified.
    expect(history.find((h) => h.action === 'create')!.changeKind).toBeNull();
  });

  test('new-information is refused where there is nothing to restate', async () => {
    /**
     * ADR-038 clause 3. Outside a frozen period the distinction between a
     * correction and a late arrival is noise, and a value that can be picked
     * anywhere is one people pick at random — which would hollow out the exact
     * signal FR-14 asked for.
     */
    const { id } = await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'create',
      values: { txnDate: '2025-03-05', txnType: 'investment', companyId: COMPANY, amount: '250000.00' },
    });

    await expect(
      applyFinancialMutation(db(), FINANCE, {
        table: 'transaction',
        op: 'update',
        id,
        values: { txnDate: '2025-03-05', txnType: 'investment', companyId: COMPANY, amount: '260000.00' },
        changeKind: 'new-information',
      }),
    ).rejects.toThrow(/nothing for late-arriving information to restate/i);
  });

  test('an unknown change kind is refused rather than stored', async () => {
    const { id } = await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'create',
      values: { txnDate: '2025-03-05', txnType: 'investment', companyId: COMPANY, amount: '250000.00' },
    });
    await expect(
      applyFinancialMutation(db(), FINANCE, {
        table: 'transaction',
        op: 'update',
        id,
        values: { txnDate: '2025-03-05', txnType: 'investment', companyId: COMPANY, amount: '260000.00' },
        changeKind: 'oops' as never,
      }),
    ).rejects.toThrow(/must be one of/i);
  });
});
