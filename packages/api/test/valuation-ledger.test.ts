/**
 * F2 · The valuation ledger (ADR-034), and the properties it must not break.
 *
 * F2 changes the most load-bearing function in the system. `company_fmv_asof`
 * is the definition of NAV, and therefore of TVPI, RVPI and IRR, and this phase
 * relaxes the index that guarded it, adds a term to its ordering, and
 * introduces the first figure the platform computes rather than receives.
 *
 * SO THE TESTS THAT MATTER MOST HERE ARE THE ONES ASSERTING NOTHING CHANGED.
 * `every existing mark is untouched` and the golden masters in
 * packages/metrics are what say the storage change was affordable. If they go
 * red, the answer is never to recapture a fixture (ADR-013).
 *
 * The rest assert the three things the review path promises and cannot be
 * allowed to quietly stop doing:
 *
 *   1. **The server computes the figure and the client cannot supply it.** A
 *      computed value the client can also send is one that will eventually
 *      disagree with itself (ADR-034 clause 2).
 *   2. **The basis is stored, not looked up.** A later correction to an earlier
 *      mark must become DETECTABLE rather than silently invalidating everything
 *      derived from it (clause 3). The test for this is the one that would be
 *      easiest to delete while "simplifying", so it says so out loud.
 *   3. **The factor is checked against the list as it stands.** The options are
 *      a table Finance edits, not a constant, so a hardcoded check would be
 *      wrong the first time they use that ability.
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
import { applyFinancialMutation, type ValuationMarkInput } from '../src/write/financial.js';
import { readValuationMarks } from '../src/read/finance.js';
import { readFmvReview, readFmvReviewQueue } from '../src/read/fmv-review.js';
import { applyRoundMutation } from '../src/write/rounds.js';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env') });

const hasDb = Boolean(process.env.DATABASE_URL);

const COMPANY = 'PCF201';
const UNMARKED = 'PCF202';
const CYCLE = '2025-07-31';

const FINANCE: Principal = {
  userId: '',
  entraObjectId: 'test-f2-finance',
  email: 'f2@example.test',
  displayName: 'Test Controller',
  role: 'finance',
};

let instrumentId = 0;

const mark = (over: Partial<ValuationMarkInput> = {}): ValuationMarkInput => ({
  companyId: COMPANY,
  effectiveDate: '2025-01-31',
  fmv: '1000000.00',
  methodLabel: 'Last round price',
  rationale: 'Baseline mark for the ledger tests.',
  ...over,
});

/** Creates a mark and returns its id. */
async function newMark(over: Partial<ValuationMarkInput> = {}): Promise<string> {
  const { id } = await applyFinancialMutation(db(), FINANCE, {
    table: 'valuation_mark',
    op: 'create',
    values: mark(over),
  });
  return id;
}

/**
 * The stored row, with every money column CAST TO TEXT.
 *
 * NOT `to_jsonb`, which is the obvious way to write this and is wrong here for
 * the reason `ChangeLogEntry.rowImage` already documents: `to_jsonb` maps a
 * `numeric` to a JSON number and `JSON.parse` makes it a double, so `1250000.00`
 * comes back as `1250000` and `0.2500` as `0.25`. Asserting exact stored money
 * through that shape asserts something weaker than it appears to (ADR-008).
 */
async function markRow(id: string): Promise<Record<string, string | null>> {
  const { rows } = await sql<Record<string, string | null>>`
    select adjustment_type,
           fmv::text               as fmv,
           basis_fmv::text         as basis_fmv,
           basis_mark_id::text     as basis_mark_id,
           retention_factor::text  as retention_factor,
           adjustment_amount::text as adjustment_amount
      from pc.valuation_mark where valuation_mark_id = ${id}::bigint
  `.execute(db());
  return rows[0]!;
}

const fmvAsOf = async (companyId: string, asOf: string): Promise<string> => {
  const { rows } = await sql<{ v: string }>`
    select pc.company_fmv_asof(${companyId}, ${asOf}::date)::text as v
  `.execute(db());
  return rows[0]!.v;
};

describe.skipIf(!hasDb)('ADR-034 · the valuation ledger', () => {
  beforeEach(async () => {
    await sql`
      insert into pc.app_user (user_id, entra_object_id, display_name, email, role)
      values (gen_random_uuid(), 'test-f2-finance', 'Test Controller', 'f2@example.test', 'finance')
      on conflict (entra_object_id) do update set role = 'finance'
    `.execute(db());
    const { rows } = await sql<{ id: string }>`
      select user_id::text as id from pc.app_user where entra_object_id = 'test-f2-finance'
    `.execute(db());
    FINANCE.userId = rows[0]!.id;

    for (const [id, name] of [[COMPANY, 'Ledger Test Co'], [UNMARKED, 'Never Marked Co']]) {
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

    await sql`select set_config('pc.actor_id', ${FINANCE.userId}, false)`.execute(db());
    await sql`delete from pc.valuation_mark where company_id in (${COMPANY}, ${UNMARKED})`.execute(db());
    await sql`delete from pc.transaction where company_id in (${COMPANY}, ${UNMARKED})`.execute(db());
    await sql`delete from pc.investment_round where company_id in (${COMPANY}, ${UNMARKED})`.execute(db());
    await sql`delete from pc.financial_row_version where changed_by = ${FINANCE.userId}::uuid`.execute(db());
    await sql`
      update pc.ref_fmv_retention_option set is_active = true where factor in (1.0, 0.75, 0.5, 0.25)
    `.execute(db());
  });

  afterAll(async () => {
    for (const t of ['valuation_mark', 'transaction', 'investment_round']) {
      await sql`delete from ${sql.table(`pc.${t}`)} where company_id in (${COMPANY}, ${UNMARKED})`
        .execute(db()).catch(() => {});
    }
    await sql`delete from pc.company where company_id in (${COMPANY}, ${UNMARKED})`
      .execute(db()).catch(() => {});
    await closeDb();
  });

  // --- the property that makes the whole phase affordable -------------------

  test('a mark written the pre-F2 way still lands, and lands as free entry', async () => {
    /**
     * THE PROPERTY THAT MAKES THE WHOLE PHASE AFFORDABLE: every write path that
     * existed before the ledger keeps working, unchanged and unaware of it.
     * A13 loads fifteen years of absolute marks, the fixture importer loads
     * schemaVersion 1 documents, and a direct `insert` at 9pm has to behave the
     * same as both.
     *
     * Written as a raw INSERT naming none of the F2 columns, which is exactly
     * what those callers do. It passes because `adjustment_type` has a DEFAULT;
     * had F2 made the column required, this is the shape that would have broken
     * at the point of migration, silently, on the paths nobody runs in a test.
     *
     * WHAT THIS TEST DELIBERATELY DOES NOT DO is count the rows migration 0009
     * relabelled. That was a one-time effect on 1,016 rows -- verified at apply
     * time, recorded in BUILD-LOG.md -- and a suite sharing a database that
     * other suites truncate by design cannot re-assert it afterwards. A test
     * that appears to check a migration and actually checks whatever happens to
     * be left in the table is worse than no test, because it reads as coverage.
     */
    const { rows } = await sql<{ id: string }>`
      insert into pc.valuation_mark
        (company_id, effective_date, fmv, method_label, rationale, prepared_by_label)
      values (${COMPANY}, '2024-07-31'::date, 1750000.00, 'Last round price',
              'Loaded the way A13 and the fixture importer load history.', 'Historic')
      returning valuation_mark_id::text as id
    `.execute(db());

    const row = await markRow(rows[0]!.id);
    expect(row['adjustment_type']).toBe('manual');
    expect(row['fmv']).toBe('1750000.00');
    expect(row['retention_factor']).toBeNull();
    expect(row['basis_fmv']).toBeNull();
  });

  test('no mark anywhere stores a derivation it could have worked out', async () => {
    // ADR-002, over the whole table rather than over rows this suite wrote. A
    // review stores the factor it was given and never the amount, which is
    // fmv - basis_fmv; a transaction-driven mark, when Q-3 is answered, does the
    // reverse. The database enforces both, and this asserts the rule rather
    // than the constraint, so a future migration that relaxes the constraint
    // still has to answer for it.
    const { rows } = await sql<{ bad: string }>`
      select count(*)::text as bad from pc.valuation_mark
       where (adjustment_type = 'review'
              and (retention_factor is null or adjustment_amount is not null
                   or basis_fmv is null))
          or (adjustment_type <> 'review' and retention_factor is not null)
          or (basis_mark_id is not null and basis_fmv is null)
    `.execute(db());
    expect(Number(rows[0]!.bad)).toBe(0);
  });

  test('a mark entered without a type is still free entry, exactly as before', async () => {
    // ADR-034 clause 7. A13 loads fifteen years of absolute marks through this
    // path and the fixture importer uses it; making `adjustmentType` required
    // would have broken both silently at the point of migration.
    const id = await newMark({ fmv: '1250000.00' });
    const row = await markRow(id);
    expect(row['adjustment_type']).toBe('manual');
    expect(row['fmv']).toBe('1250000.00');
    expect(row['retention_factor']).toBeNull();
  });

  // --- clause 2: the server computes it, the client cannot send it ----------

  test('a review computes FMV from the basis and the factor', async () => {
    await newMark({ effectiveDate: '2025-01-31', fmv: '1000000.00' });

    const result = await applyFinancialMutation(db(), FINANCE, {
      table: 'valuation_mark',
      op: 'create',
      values: mark({
        effectiveDate: CYCLE,
        adjustmentType: 'review',
        fmv: undefined,
        retentionFactor: '0.75',
        methodLabel: 'Semi-annual review',
        rationale: 'Missed plan two quarters running; carried at 75%.',
      }),
    });

    expect(result.mark).toBeDefined();
    expect(result.mark!.fmv).toBe('750000.00');
    expect(result.mark!.basisFmv).toBe('1000000.00');
    expect(result.mark!.retentionFactor).toBe('0.7500');

    // And it is what every metric now reads.
    expect(await fmvAsOf(COMPANY, CYCLE)).toBe('750000.00');
  });

  test('a review refuses an FMV from the client rather than ignoring it', async () => {
    await newMark({ effectiveDate: '2025-01-31', fmv: '1000000.00' });

    // Silently discarding it would let a caller believe it had set a figure the
    // server overwrote, and the disagreement would surface much later as a
    // board number nobody could account for.
    await expect(
      applyFinancialMutation(db(), FINANCE, {
        table: 'valuation_mark',
        op: 'create',
        values: mark({
          effectiveDate: CYCLE,
          adjustmentType: 'review',
          fmv: '999999.00',
          retentionFactor: '0.75',
        }),
      }),
    ).rejects.toThrow(/computes its own FMV/i);
  });

  test('impairment compounds, which is the reading D-3 flagged for confirmation', async () => {
    // 50% then 50% leaves a position at 25% of where it started, not at zero.
    // Asserted because it is the kind of rule that surprises someone two years
    // later, and because Q-1 is a confirmation rather than an open question.
    await newMark({ effectiveDate: '2024-01-31', fmv: '4000000.00' });

    for (const [date, factor] of [['2024-07-31', '0.5'], ['2025-01-31', '0.5']] as const) {
      await applyFinancialMutation(db(), FINANCE, {
        table: 'valuation_mark',
        op: 'create',
        values: mark({
          effectiveDate: date,
          adjustmentType: 'review',
          fmv: undefined,
          retentionFactor: factor,
          rationale: 'Successive impairment, testing that the factor compounds.',
        }),
      });
    }

    expect(await fmvAsOf(COMPANY, '2025-01-31')).toBe('1000000.00');
  });

  test('a company held at cost can be reviewed, with cost as the basis', async () => {
    // ADR-007 holds an unmarked company at cost, so cost IS its carrying value.
    // Refusing here would send Finance to work out cost x 0.75 by hand and type
    // it as an absolute — the re-entry FR-19 exists to remove.
    await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'create',
      values: {
        txnDate: '2025-03-01',
        txnType: 'investment',
        companyId: UNMARKED,
        amount: '800000.00',
      },
    });

    const result = await applyFinancialMutation(db(), FINANCE, {
      table: 'valuation_mark',
      op: 'create',
      values: mark({
        companyId: UNMARKED,
        effectiveDate: CYCLE,
        adjustmentType: 'review',
        fmv: undefined,
        retentionFactor: '0.5',
        rationale: 'First review; never formally marked, so carried at cost.',
      }),
    });

    expect(result.mark!.basisFmv).toBe('800000.00');
    // A basis with no basis ROW — legal and meaningful, and the reason the
    // schema constraint is one-directional.
    expect(result.mark!.basisMarkId).toBeNull();
    expect(result.mark!.fmv).toBe('400000.00');
  });

  // --- clause 3: the basis is stored, not looked up -------------------------

  test('correcting an earlier mark makes the later one DETECTABLY stale, not silently wrong', async () => {
    /**
     * THE TEST THIS FILE EXISTS FOR, and the one most likely to look redundant
     * to a future reader: it asserts that two numbers are allowed to disagree.
     *
     * That disagreement IS the feature (ADR-034 clause 3). Under a lookup, the
     * correction below would silently change what the July mark was derived
     * from and nothing anywhere would say so. Stored, the July mark keeps the
     * basis it was actually computed against, and the mismatch becomes a line
     * F6 can report.
     *
     * If someone "fixes" this by re-deriving on read, the evidence that an
     * issued figure was restated is destroyed.
     */
    const january = await newMark({ effectiveDate: '2025-01-31', fmv: '1000000.00' });
    await applyFinancialMutation(db(), FINANCE, {
      table: 'valuation_mark',
      op: 'create',
      values: mark({
        effectiveDate: CYCLE,
        adjustmentType: 'review',
        fmv: undefined,
        retentionFactor: '0.75',
        rationale: 'Impaired at the July cycle.',
      }),
    });

    await applyFinancialMutation(db(), FINANCE, {
      table: 'valuation_mark',
      op: 'update',
      id: january,
      reason: 'January mark used a stale cap table; corrected on review.',
      values: mark({ effectiveDate: '2025-01-31', fmv: '1200000.00' }),
    });

    const rows = await readValuationMarks(db(), FINANCE, { companyId: COMPANY });
    const july = rows.find((r) => r.effectiveDate === CYCLE)!;

    expect(july.basisFmv).toBe('1000000.00'); // what it was computed against
    expect(july.basisFmvNow).toBe('1200000.00'); // what that mark says today
    expect(july.basisFmv).not.toBe(july.basisFmvNow); // and the gap is visible

    // The stored result did NOT move. A correction upstream does not silently
    // restate a figure that has already been issued.
    expect(july.fmv).toBe('750000.00');
    expect(await fmvAsOf(COMPANY, CYCLE)).toBe('750000.00');
  });

  // --- clause 4: the factor is checked against the live list ----------------

  test('a factor outside the approved list is refused, and the message says what is approved', async () => {
    await newMark({ effectiveDate: '2025-01-31', fmv: '1000000.00' });
    await expect(
      applyFinancialMutation(db(), FINANCE, {
        table: 'valuation_mark',
        op: 'create',
        values: mark({
          effectiveDate: CYCLE,
          adjustmentType: 'review',
          fmv: undefined,
          retentionFactor: '0.6',
        }),
      }),
    ).rejects.toThrow(/not one of the retention options/i);
  });

  test('retiring an option withdraws it from new marks and leaves old ones alone', async () => {
    // The whole reason the vocabulary is a table rather than a CHECK: Finance
    // changes the list through the Policies surface, and a hardcoded validator
    // would be wrong the first time they did.
    const base = await newMark({ effectiveDate: '2025-01-31', fmv: '1000000.00' });
    expect(base).toBeTruthy();

    const { id: existing } = await applyFinancialMutation(db(), FINANCE, {
      table: 'valuation_mark',
      op: 'create',
      values: mark({
        effectiveDate: CYCLE,
        adjustmentType: 'review',
        fmv: undefined,
        retentionFactor: '0.25',
        rationale: 'Impaired hard before the option was retired.',
      }),
    });

    await sql`update pc.ref_fmv_retention_option set is_active = false where factor = 0.25`
      .execute(db());

    await expect(
      applyFinancialMutation(db(), FINANCE, {
        table: 'valuation_mark',
        op: 'create',
        values: mark({
          effectiveDate: '2026-01-31',
          adjustmentType: 'review',
          fmv: undefined,
          retentionFactor: '0.25',
        }),
      }),
    ).rejects.toThrow(/not one of the retention options/i);

    // The mark written while it was legal still reconstructs exactly. There is
    // no foreign key precisely so that reproducing an issued board pack cannot
    // depend on the option list still containing what it contained then.
    const row = await markRow(existing);
    expect(row['retention_factor']).toBe('0.2500');
    expect(row['fmv']).toBe('250000.00');
  });

  // --- S-3: the index, and the ordering it used to guarantee ----------------

  test('two marks can share a date, but a company is reviewed once per cycle', async () => {
    // S-3. The old index blocked two follow-ons on one day and blocked a
    // transaction landing on 31 January, which is a valuation date.
    await newMark({ effectiveDate: CYCLE, fmv: '500000.00' });
    await expect(newMark({ effectiveDate: CYCLE, fmv: '600000.00' })).resolves.toBeTruthy();

    await applyFinancialMutation(db(), FINANCE, {
      table: 'valuation_mark',
      op: 'create',
      values: mark({
        effectiveDate: CYCLE,
        adjustmentType: 'review',
        fmv: undefined,
        retentionFactor: '1.0',
        rationale: 'Reviewed and held.',
      }),
    });

    await expect(
      applyFinancialMutation(db(), FINANCE, {
        table: 'valuation_mark',
        op: 'create',
        values: mark({
          effectiveDate: CYCLE,
          adjustmentType: 'review',
          fmv: undefined,
          retentionFactor: '0.75',
          rationale: 'A second review of the same cycle, which is a duplicate.',
        }),
      }),
    ).rejects.toThrow(/already been reviewed/i);
  });

  test('a deleted mark releases its date, so the index and the check agree', async () => {
    // Pre-F2 the index did not exclude soft-deleted rows while the application
    // check did, so this sequence passed validation and then failed on a
    // constraint the operator could not see or act on.
    const first = await applyFinancialMutation(db(), FINANCE, {
      table: 'valuation_mark',
      op: 'create',
      values: mark({
        effectiveDate: CYCLE,
        adjustmentType: 'review',
        fmv: undefined,
        retentionFactor: '1.0',
        rationale: 'Reviewed and held, then deleted as entered against the wrong company.',
      }),
    });

    await applyFinancialMutation(db(), FINANCE, {
      table: 'valuation_mark',
      op: 'delete',
      id: first.id,
      reason: 'Entered against the wrong company.',
    });

    await expect(
      applyFinancialMutation(db(), FINANCE, {
        table: 'valuation_mark',
        op: 'create',
        values: mark({
          effectiveDate: CYCLE,
          adjustmentType: 'review',
          fmv: undefined,
          retentionFactor: '0.75',
          rationale: 'The replacement review, at the same cycle date.',
        }),
      }),
    ).resolves.toBeTruthy();
  });

  test('two marks written in one transaction resolve deterministically', async () => {
    /**
     * `booked_at` defaults to now(), which is TRANSACTION START TIME, so two
     * marks written inside one database transaction carry an identical
     * timestamp. Before F2 the ordering between them was whatever the plan
     * produced — in the function that defines NAV.
     */
    const ids = await db().transaction().execute(async (trx) => {
      await sql`select set_config('pc.actor_id', ${FINANCE.userId}, true)`.execute(trx);
      const out: string[] = [];
      for (const fmv of ['300000.00', '400000.00']) {
        const { rows } = await sql<{ id: string }>`
          insert into pc.valuation_mark
            (company_id, effective_date, fmv, method_label, rationale, prepared_by_label,
             adjustment_type)
          values (${COMPANY}, ${CYCLE}::date, ${fmv}::numeric, 'Same-transaction',
                  'Two marks, one transaction, identical booked_at.', 'Test', 'manual')
          returning valuation_mark_id::text as id
        `.execute(trx);
        out.push(rows[0]!.id);
      }
      return out;
    });

    const { rows: tie } = await sql<{ same: boolean }>`
      select count(distinct booked_at) = 1 as same from pc.valuation_mark
       where valuation_mark_id = any(${ids}::bigint[])
    `.execute(db());
    expect(tie[0]!.same, 'the tie this guards against must actually be reachable').toBe(true);

    // Highest id wins, every time, rather than whatever the plan produced.
    expect(await fmvAsOf(COMPANY, CYCLE)).toBe('400000.00');
  });

  // --- FR-19: the workspace ------------------------------------------------

  test('the workspace shows the provenance and everything booked since the mark', async () => {
    await newMark({ effectiveDate: '2025-01-31', fmv: '1000000.00' });

    const { id: roundId } = await applyRoundMutation(db(), FINANCE, {
      op: 'create',
      values: {
        companyId: COMPANY,
        roundDate: '2025-04-15',
        label: 'Series B',
        instrumentId,
        roundTotal: '5000000.00',
        postMoney: '20000000.00',
        coinvestors: [],
      },
    });
    await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'create',
      values: {
        txnDate: '2025-04-15',
        txnType: 'follow_on',
        companyId: COMPANY,
        investmentRoundId: roundId,
        amount: '600000.00',
      },
    });

    const review = await readFmvReview(db(), FINANCE, COMPANY, CYCLE);

    expect(review.current.fmv).toBe('1000000.00');
    expect(review.current.effectiveDate).toBe('2025-01-31');
    expect(review.current.preparedByLabel).toBe(FINANCE.displayName);

    // The cheque, and — thanks to F1 — the round it funded, which is the lookup
    // FR-19 is about removing.
    expect(review.transactionsSince).toHaveLength(1);
    expect(review.transactionsSince[0]!.amountCad).toBe('600000.00');
    expect(review.transactionsSince[0]!.roundLabel).toBe('Series B');

    expect(review.roundsSince).toHaveLength(1);
    expect(review.roundsSince[0]!.postMoney).toBe('20000000.00');

    expect(review.retentionOptions.map((o) => o.factor)).toContain('0.7500');
  });

  test('"since the last mark" means since its effective date, not since it was booked', async () => {
    // A mark as at 31 January entered in March values the position as it stood
    // in January, so a February cheque is activity that mark did not see even
    // though it was entered first.
    await newMark({ effectiveDate: '2025-01-31', fmv: '1000000.00' });
    await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'create',
      values: {
        txnDate: '2025-02-10',
        txnType: 'follow_on',
        companyId: COMPANY,
        amount: '150000.00',
      },
    });

    const review = await readFmvReview(db(), FINANCE, COMPANY, CYCLE);
    expect(review.transactionsSince.map((t) => t.txnDate)).toEqual(['2025-02-10']);
  });

  test('the queue is a checklist that can be cleared', async () => {
    // FR-18's second consequence: once 100% is a positive entry meaning
    // "reviewed, held", a cycle becomes a list that reaches zero rather than a
    // set of forms that were or were not opened.
    await newMark({ effectiveDate: '2025-01-31', fmv: '1000000.00' });

    let queue = await readFmvReviewQueue(db(), FINANCE, CYCLE);
    const before = queue.find((r) => r.companyId === COMPANY)!;
    expect(before.reviewedThisCycle).toBe(false);
    expect(before.lastMarkDate).toBe('2025-01-31');

    await applyFinancialMutation(db(), FINANCE, {
      table: 'valuation_mark',
      op: 'create',
      values: mark({
        effectiveDate: CYCLE,
        adjustmentType: 'review',
        fmv: undefined,
        retentionFactor: '1.0',
        rationale: 'Reviewed, no change.',
      }),
    });

    queue = await readFmvReviewQueue(db(), FINANCE, CYCLE);
    const after = queue.find((r) => r.companyId === COMPANY)!;
    expect(after.reviewedThisCycle).toBe(true);
    // Holding at 100% is a review, and it moved nothing.
    expect(after.currentFmv).toBe('1000000.00');
  });

  test('a never-marked company reports cost, and says it has never been marked', async () => {
    await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'create',
      values: {
        txnDate: '2025-03-01',
        txnType: 'investment',
        companyId: UNMARKED,
        amount: '800000.00',
      },
    });

    const queue = await readFmvReviewQueue(db(), FINANCE, CYCLE);
    const row = queue.find((r) => r.companyId === UNMARKED)!;
    expect(row.lastMarkDate).toBeNull();
    expect(row.currentFmv).toBe('800000.00');
    expect(row.cost).toBe('800000.00');
  });
});
