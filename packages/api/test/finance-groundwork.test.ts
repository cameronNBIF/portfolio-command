/**
 * F0 · The two things migration 0006 added, and the properties they were added
 * for.
 *
 * Both are additive and neither is read by a metric, so nothing here is
 * protecting a board number. What it is protecting is two guarantees that are
 * easy to erode by accident later:
 *
 *   1. **`instrument_id` means what it says.** Unrecorded is a state, not a
 *      gap to be quietly filled — including by a form that round-trips a row it
 *      did not draw a field for, which is exactly how A8 discovered the first
 *      amount edit had nulled a transaction's link to its round.
 *   2. **`affinity_control_snapshot` is write-once.** Its entire worth is that
 *      nobody touched it between F0 and A13, and a guarantee nothing asserts is
 *      a guarantee that has already been lost by the time anyone checks.
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
import { applyFinancialMutation } from '../src/write/financial.js';
import { readReferenceData } from '../src/read/rounds.js';
import { readTransactions } from '../src/read/finance.js';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env') });

const hasDb = Boolean(process.env.DATABASE_URL);

const COMPANY = 'PCF001';
const FUND_POSITION = 'PCF-LP-001';
const FINANCE: Principal = {
  userId: '',
  entraObjectId: 'test-f0-finance',
  email: 'f0@example.test',
  displayName: 'Test Groundwork',
  role: 'finance',
};

/** Resolved from the seeded reference list rather than hardcoded as an id. */
let equityId = 0;
let noteId = 0;

describe.skipIf(!hasDb)('F0 groundwork', () => {
  beforeEach(async () => {
    /* ITS OWN ACTOR. Hygiene rather than a fix: this suite shared
       `test-finance` with `financial-versioning.test.ts` and both purge
       `financial_row_version` BY ACTOR in beforeEach, which is harmless only
       because `fileParallelism: false` makes the files run one at a time. A
       suite whose isolation depends on a setting in another file's config is
       one bad day from being wrong. (The intermittent failure this was first
       reached for turned out to be something else entirely -- see the
       `financial_row_version` note in `import-contract.ts`.) */
    await sql`
      insert into pc.app_user (user_id, entra_object_id, display_name, email, role)
      values (gen_random_uuid(), 'test-f0-finance', 'Test Groundwork', 'f0@example.test', 'finance')
      on conflict (entra_object_id) do update set role = 'finance'
    `.execute(db());
    const { rows } = await sql<{ id: string }>`
      select user_id::text as id from pc.app_user where entra_object_id = 'test-f0-finance'
    `.execute(db());
    FINANCE.userId = rows[0]!.id;

    /* Set before the fixture rows rather than after them: the F5 commitment
       below is a versioned financial row, and the ADR-031 trigger raises rather
       than defaulting when nobody is named. */
    await sql`select set_config('pc.actor_id', ${FINANCE.userId}, false)`.execute(db());

    await sql`
      insert into pc.company (company_id, name, created_by)
      values (${COMPANY}, 'Groundwork Test Co', ${FINANCE.userId}::uuid)
      on conflict (company_id) do nothing
    `.execute(db());
    await sql`
      insert into pc.fund_investment
        (fund_investment_id, name, manager_name, created_by)
      values (${FUND_POSITION}, 'Groundwork Test LP', 'Groundwork GP', ${FINANCE.userId}::uuid)
      on conflict (fund_investment_id) do nothing
    `.execute(db());
    /* F5. The commitment left the position and became a dated event
       (ADR-037), so this fixture writes one. Kept because the F0 tests below
       write LP drawdowns against this position and a drawdown against a
       position with no commitment on record is a state the write path now
       reports on -- it should not be the state every F0 test runs in. */
    await sql`
      insert into pc.fund_commitment
        (fund_investment_id, as_of_date, committed, change_reason, entered_by)
      values (${FUND_POSITION}, '2020-01-01', 1000000.00,
              'Test fixture: subscription', ${FINANCE.userId}::uuid)
      on conflict (fund_investment_id, as_of_date) do nothing
    `.execute(db());

    await sql`delete from pc.transaction where company_id = ${COMPANY} or fund_investment_id = ${FUND_POSITION}`
      .execute(db());
    await sql`delete from pc.financial_row_version where changed_by = ${FINANCE.userId}::uuid`.execute(db());

    const reference = await readReferenceData(db(), FINANCE);
    equityId = reference.instruments.find((i) => i.name === 'Preferred Equity')!.id;
    noteId = reference.instruments.find((i) => i.name === 'Convertible Note')!.id;
  });

  afterAll(async () => {
    await sql`delete from pc.transaction where company_id = ${COMPANY} or fund_investment_id = ${FUND_POSITION}`
      .execute(db()).catch(() => {});
    await sql`delete from pc.fund_investment where fund_investment_id = ${FUND_POSITION}`
      .execute(db()).catch(() => {});
    await sql`delete from pc.company where company_id = ${COMPANY}`.execute(db()).catch(() => {});
    await closeDb();
  });

  const row = async (id: string) =>
    (await readTransactions(db(), FINANCE, { companyId: COMPANY, includeDeleted: true }))
      .rows.find((r) => r.id === id);

  // --- instrument on the transaction ---------------------------------------

  test('an instrument set on a cheque comes back with its name', async () => {
    const { id } = await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'create',
      values: {
        txnDate: '2024-03-01', txnType: 'investment', companyId: COMPANY,
        amount: '250000.00', instrumentId: noteId,
      },
    });

    const r = await row(id);
    expect(r?.instrumentId).toBe(noteId);
    expect(r?.instrumentName).toBe('Convertible Note');
  });

  test('unrecorded is a state: an omitted instrument stays null and is never inferred', async () => {
    const { id } = await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'create',
      values: {
        txnDate: '2024-03-01', txnType: 'investment', companyId: COMPANY,
        amount: '250000.00',
      },
    });

    const r = await row(id);
    expect(r?.instrumentId).toBeNull();
    expect(r?.instrumentName).toBeNull();
  });

  /**
   * THE ONE THAT WOULD BITE. The write path takes a COMPLETE row on an update
   * rather than a patch, so a caller that omits a column nulls it. That is how
   * the first amount edit made through the A8 form silently cleared a
   * transaction's link to its round. This asserts the shape of that hazard for
   * the new column, so that a future caller which forgets to round-trip it
   * fails here rather than on someone's screen.
   */
  test('an update that omits the instrument clears it — which is why the form round-trips it', async () => {
    const { id } = await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'create',
      values: {
        txnDate: '2024-03-01', txnType: 'investment', companyId: COMPANY,
        amount: '250000.00', instrumentId: equityId,
      },
    });
    expect((await row(id))?.instrumentId).toBe(equityId);

    await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'update',
      id,
      values: {
        txnDate: '2024-03-01', txnType: 'investment', companyId: COMPANY,
        amount: '260000.00',
      },
    });
    expect((await row(id))?.instrumentId).toBeNull();

    // And carrying it through preserves it, which is what the form does.
    await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'update',
      id,
      values: {
        txnDate: '2024-03-01', txnType: 'investment', companyId: COMPANY,
        amount: '270000.00', instrumentId: equityId,
      },
    });
    expect((await row(id))?.instrumentId).toBe(equityId);
  });

  test('LP activity bought no instrument and is refused one', async () => {
    await expect(
      applyFinancialMutation(db(), FINANCE, {
        table: 'transaction',
        op: 'create',
        values: {
          txnDate: '2024-03-01', txnType: 'capital_drawdown',
          fundInvestmentId: FUND_POSITION, amount: '100000.00', instrumentId: equityId,
        },
      }),
    ).rejects.toThrow(/did not buy an instrument/i);
  });

  /**
   * The TypeScript rule above exists for the message; the constraint is what
   * makes it true. Asserted from a raw statement so a second write path — or a
   * psql session — cannot get past it.
   */
  test('the constraint holds against a write that never touches the API', async () => {
    await expect(
      sql`
        insert into pc.transaction
          (txn_date, txn_type, fund_investment_id, amount, entered_by, instrument_id)
        values ('2024-03-01', 'capital_drawdown', ${FUND_POSITION}, 100000.00,
                ${FINANCE.userId}::uuid, ${equityId})
      `.execute(db()),
    ).rejects.toThrow(/txn_instrument_direct_only/i);
  });

  test('changing the instrument is captured with the actor named', async () => {
    const { id } = await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'create',
      values: {
        txnDate: '2024-03-01', txnType: 'investment', companyId: COMPANY,
        amount: '250000.00', instrumentId: noteId,
      },
    });
    await applyFinancialMutation(db(), FINANCE, {
      table: 'transaction',
      op: 'update',
      id,
      values: {
        txnDate: '2024-03-01', txnType: 'investment', companyId: COMPANY,
        amount: '250000.00', instrumentId: equityId,
      },
      reason: 'Converted to preferred; the cheque bought equity, not the note.',
    });

    const { rows } = await sql<{ prior: number | null; by: string; reason: string | null }>`
      select (row_image ->> 'instrument_id')::int as prior,
             u.display_name                       as by,
             v.change_reason                      as reason
        from pc.financial_row_version v
        join pc.app_user u on u.user_id = v.changed_by
       where v.table_name = 'transaction' and v.record_id = ${id} and v.action = 'update'
       order by v.valid_to desc limit 1
    `.execute(db());

    expect(rows[0]?.prior).toBe(noteId);
    expect(rows[0]?.by).toBe(FINANCE.displayName);
    expect(rows[0]?.reason).toMatch(/bought equity/);
  });

  // --- the frozen Affinity baseline ----------------------------------------

  /**
   * ADR-039. Whatever else is true of this table, an edited baseline
   * reconciles to nothing, and A13 is a year away from anyone remembering why.
   *
   * Written against a row this test inserts under its own label, so it neither
   * depends on the real 'pre-cutover baseline' having been taken nor risks
   * being the thing that damages it.
   */
  test('the Affinity control snapshot refuses to be updated, deleted or truncated', async () => {
    // Never cleaned up between runs, because it cannot be — which is the
    // property. `on conflict do nothing` is what makes the suite re-runnable.
    const label = 'test baseline';

    await sql`
      insert into pc.affinity_control_snapshot
        (snapshot_label, taken_by, company_id, company_name, total_investment, fmv)
      values (${label}, ${FINANCE.userId}::uuid, ${COMPANY}, 'Groundwork Test Co',
              1000000.00, 900000.00)
      on conflict (snapshot_label, company_id) do nothing
    `.execute(db());

    await expect(
      sql`update pc.affinity_control_snapshot set fmv = 0 where snapshot_label = ${label}`.execute(db()),
    ).rejects.toThrow(/write-once/i);

    await expect(
      sql`delete from pc.affinity_control_snapshot where snapshot_label = ${label}`.execute(db()),
    ).rejects.toThrow(/write-once/i);

    // The door a row-level trigger does not see. Also the reason this table
    // carries no foreign key to `company`: the fixture importer truncates the
    // roster with `cascade` on every run, and TRUNCATE fires no row trigger.
    await expect(
      sql`truncate pc.affinity_control_snapshot`.execute(db()),
    ).rejects.toThrow(/write-once/i);

    const { rows } = await sql<{ fmv: string }>`
      select fmv::text as fmv from pc.affinity_control_snapshot where snapshot_label = ${label}
    `.execute(db());
    expect(rows[0]?.fmv).toBe('900000.00');
  });
});
