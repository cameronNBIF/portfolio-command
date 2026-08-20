/**
 * F3 · Ownership maintenance and significant influence (ADR-035).
 *
 * THE TEST THAT MATTERS MOST HERE IS THE ONE ABOUT NULL. ADR-035 clause 4 says
 * the flag returns NULL, never false, when ownership is unrecorded or no policy
 * is in force — because "we hold no figure for this company" and "this company
 * is below the threshold" are different statements, and reporting the second
 * when the first is true is how a company quietly drops off a schedule an
 * auditor expects to find it on. Nothing on screen distinguishes the two if the
 * function stops making the distinction, so it is asserted at the function, at
 * the report, and with no policy at all.
 *
 * The rest assert what the phase promises and cannot be allowed to stop doing:
 *
 *   1. **The threshold is inclusive.** A company at exactly 10.00% is flagged.
 *      That is a reading of "10% is the standard rule", and it is written down
 *      as a test so Pat confirms it rather than the code assuming it silently.
 *   2. **A past classification reproduces.** Setting a new threshold must not
 *      reclassify a company inside a period already reported, which is the only
 *      reason the policy is effective-dated at all.
 *   3. **An adjustment says what caused it.** The standalone path refuses a
 *      figure with no reason; the deal-close path stores the round instead,
 *      because there the round is the reason.
 *   4. **The gates hold.** A finance policy is not settable by the investment
 *      team, and the ownership path is not reachable by leadership.
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
import { applyOwnershipMutation } from '../src/write/ownership.js';
import { applyFinancePolicyEdit } from '../src/write/finance-policy.js';
import { readOwnershipHistory, readSignificantInfluence } from '../src/read/ownership.js';
import { readFinancePolicies } from '../src/read/policies.js';
import { applyRoundMutation } from '../src/write/rounds.js';
import { readRowHistory } from '../src/read/finance.js';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env') });

const hasDb = Boolean(process.env.DATABASE_URL);

/** Holds a position. */
const HELD = 'PCF301';
/** Invested in, and nobody has ever recorded what we own. */
const UNRECORDED = 'PCF302';
/** Someone else's company, for the cross-company refusals. */
const OTHER = 'PCF303';

const AS_OF = '2026-08-31';

const FINANCE: Principal = {
  userId: '',
  entraObjectId: 'test-f3-finance',
  email: 'f3-finance@example.test',
  displayName: 'Test Controller',
  role: 'finance',
};
const VC: Principal = {
  userId: '',
  entraObjectId: 'test-f3-vc',
  email: 'f3-vc@example.test',
  displayName: 'Test Deal Lead',
  role: 'vc',
};
const LEADERSHIP: Principal = {
  userId: '',
  entraObjectId: 'test-f3-leadership',
  email: 'f3-lead@example.test',
  displayName: 'Test Leadership',
  role: 'leadership',
};

let instrumentId = 0;

async function user(p: Principal): Promise<void> {
  await sql`
    insert into pc.app_user (user_id, entra_object_id, display_name, email, role)
    values (gen_random_uuid(), ${p.entraObjectId}, ${p.displayName}, ${p.email}, ${p.role})
    on conflict (entra_object_id) do update set role = ${p.role}
  `.execute(db());
  const { rows } = await sql<{ id: string }>`
    select user_id::text as id from pc.app_user where entra_object_id = ${p.entraObjectId}
  `.execute(db());
  p.userId = rows[0]!.id;
}

/** Records one position through the standalone path. */
async function setOwnership(
  companyId: string,
  asOfDate: string,
  pct: string,
  over: { changeReason?: string; investmentRoundId?: string | null; reason?: string } = {},
): Promise<{ id: string; restated: boolean; replacedExisting: boolean }> {
  return applyOwnershipMutation(db(), FINANCE, {
    op: 'set',
    reason: over.reason ?? null,
    values: {
      companyId,
      asOfDate,
      ownershipPct: pct,
      proRataRights: false,
      changeReason: over.changeReason ?? 'Option pool expanded by 8% at the board meeting.',
      investmentRoundId: over.investmentRoundId ?? null,
    },
  });
}

const setThreshold = (pct: number | null, note?: string): Promise<unknown> =>
  applyFinancePolicyEdit(db(), FINANCE, {
    kind: 'accounting-policy',
    significantInfluencePct: pct,
    note: note ?? null,
  });

/** The flag straight from the database, which is what every reader resolves. */
async function flag(companyId: string, asOf = AS_OF): Promise<boolean | null> {
  const { rows } = await sql<{ v: boolean | null }>`
    select pc.significant_influence_asof(${companyId}, ${asOf}::date) as v
  `.execute(db());
  return rows[0]!.v;
}

/** Creates a round through the deal-close path and returns its id. */
async function newRound(companyId: string, ownershipPct?: string): Promise<string> {
  const { id } = await applyRoundMutation(db(), FINANCE, {
    op: 'create',
    values: {
      companyId,
      roundDate: '2026-06-30',
      label: 'Series A',
      instrumentId,
      coinvestors: [],
      ownership: ownershipPct
        ? { asOfDate: '2026-06-30', ownershipPct, proRataRights: true }
        : null,
    },
  });
  return id;
}

describe.skipIf(!hasDb)('ADR-035 · ownership maintenance and significant influence', () => {
  beforeEach(async () => {
    for (const p of [FINANCE, VC, LEADERSHIP]) await user(p);

    for (const [id, name] of [
      [HELD, 'Held Position Co'],
      [UNRECORDED, 'Unrecorded Cap Table Co'],
      [OTHER, 'Someone Else Co'],
    ]) {
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

    const ids = [HELD, UNRECORDED, OTHER];
    await sql`delete from pc.company_ownership where company_id in (${ids[0]!}, ${ids[1]!}, ${ids[2]!})`.execute(db());
    await sql`delete from pc.transaction where company_id in (${ids[0]!}, ${ids[1]!}, ${ids[2]!})`.execute(db());
    await sql`delete from pc.investment_round where company_id in (${ids[0]!}, ${ids[1]!}, ${ids[2]!})`.execute(db());
    await sql`delete from pc.financial_row_version where changed_by = ${FINANCE.userId}::uuid`.execute(db());

    /* The policy table is global and migration 0010 leaves it empty, which is
       the state clause 3 is about. Every test that needs a threshold sets one. */
    await sql`delete from pc.fund_accounting_policy`.execute(db());
    await sql`delete from pc.fund_nav_snapshot where fund_id = 1 and period_end = '2024-12-31'`.execute(db());

    // Both companies have money in them, so both belong on the schedule.
    for (const id of [HELD, UNRECORDED]) {
      await sql`
        insert into pc.transaction (txn_date, txn_type, company_id, amount, entered_by)
        values ('2026-01-15'::date, 'investment', ${id}, 500000.00, ${FINANCE.userId}::uuid)
      `.execute(db());
    }
  });

  afterAll(async () => {
    for (const t of ['company_ownership', 'transaction', 'investment_round']) {
      await sql`delete from ${sql.table(`pc.${t}`)} where company_id in (${HELD}, ${UNRECORDED}, ${OTHER})`
        .execute(db()).catch(() => {});
    }
    await sql`delete from pc.fund_accounting_policy`.execute(db()).catch(() => {});
    await sql`delete from pc.company where company_id in (${HELD}, ${UNRECORDED}, ${OTHER})`
      .execute(db()).catch(() => {});
    await closeDb();
  });

  // --- the three-valued flag -----------------------------------------------

  test('no ownership figure reads NULL, never false — with a policy in force', async () => {
    /**
     * THE CLAUSE 4 TEST. This is the one that would be easiest to "simplify"
     * into a boolean, and doing so would not fail anything else in this file —
     * it would just quietly reclassify every company we have no figure for as
     * one we have checked and cleared. Deleting this test is the change to
     * argue about, so it says so out loud.
     */
    await setThreshold(10);
    await setOwnership(HELD, '2026-07-01', '25');

    expect(await flag(HELD)).toBe(true);
    expect(await flag(UNRECORDED)).toBeNull();

    const report = await readSignificantInfluence(db(), FINANCE, AS_OF);
    const unrecorded = report.rows.find((r) => r.companyId === UNRECORDED);
    expect(unrecorded, 'a company with no figure must still appear').toBeDefined();
    expect(unrecorded!.significantInfluence).toBeNull();
    expect(unrecorded!.ownershipPct).toBeNull();
  });

  test('no policy in force reads NULL for a company we do hold a figure for', async () => {
    // Migration 0010 inserts no policy row on purpose: until someone sets one,
    // "nobody has decided" and "below the threshold" must not look alike.
    await setOwnership(HELD, '2026-07-01', '25');

    expect(await flag(HELD)).toBeNull();

    const report = await readSignificantInfluence(db(), FINANCE, AS_OF);
    expect(report.threshold).toBeNull();
    expect(report.rows.find((r) => r.companyId === HELD)!.significantInfluence).toBeNull();
  });

  test('the threshold is inclusive: exactly 10% is significant influence', async () => {
    await setThreshold(10);

    await setOwnership(HELD, '2026-07-01', '10');
    expect(await flag(HELD)).toBe(true);

    await setOwnership(HELD, '2026-07-02', '9.9999');
    expect(await flag(HELD)).toBe(false);
  });

  test('a below-threshold company reads false, which is not the same as null', async () => {
    await setThreshold(10);
    await setOwnership(HELD, '2026-07-01', '4');

    const report = await readSignificantInfluence(db(), FINANCE, AS_OF);
    const held = report.rows.find((r) => r.companyId === HELD)!;
    const none = report.rows.find((r) => r.companyId === UNRECORDED)!;

    expect(held.significantInfluence).toBe(false);
    expect(none.significantInfluence).toBeNull();
    // The distinction the report exists to keep: same screen, different groups.
    expect(held.significantInfluence).not.toBe(none.significantInfluence);
  });

  // --- effective dating ----------------------------------------------------

  test('a past classification reproduces against the policy that was in force', async () => {
    /**
     * The only reason the threshold is dated. A company at 12% is significant
     * under a 10% policy and not under a 15% one; if setting the second rewrote
     * the first, a board pack issued under the first would silently disagree
     * with itself.
     *
     * The earlier policy is INSERTED WITH AN EARLIER `effective_from` rather
     * than set through the write path, because the write path deliberately
     * dates a policy from the day it is set — a back-dated threshold entered
     * through a form would reclassify periods that have already been reported.
     * This is standing in for a policy that was genuinely set in January.
     */
    await setOwnership(HELD, '2026-01-31', '12');
    await sql`
      insert into pc.fund_accounting_policy
        (significant_influence_pct, effective_from, set_by, note)
      values (10.000, '2026-01-01'::date, ${FINANCE.userId}::uuid, 'Standard rule.')
    `.execute(db());

    expect(await flag(HELD, '2026-03-31')).toBe(true);

    await setThreshold(15, 'Raised.');

    // Today reads the new policy; March still reads the one that was in force
    // in March, which is the whole property.
    expect(await flag(HELD)).toBe(false);
    expect(await flag(HELD, '2026-03-31')).toBe(true);

    /* THE GRAIN IS A DAY, and that is worth stating rather than discovering. A
       policy set and superseded on the same date covers no date at all, so a
       classification reproduced for that day reads "not determined" rather than
       guessing which of the two applied. `fund_alert_policy` behaves the same
       way and for the same reason. */
  });

  test('setting a threshold supersedes rather than updates, and one row stays open', async () => {
    await setThreshold(10);
    await setThreshold(20);

    const policies = await readFinancePolicies(db(), FINANCE);
    expect(policies.history).toHaveLength(2);
    expect(policies.current!.significantInfluencePct).toBe('20.000');
    expect(policies.history.filter((p) => p.effectiveTo === null)).toHaveLength(1);

    // The superseded row keeps its own figure. An UPDATE would have lost it,
    // and with it the ability to reproduce anything classified under it.
    const closed = policies.history.find((p) => p.effectiveTo !== null)!;
    expect(closed.significantInfluencePct).toBe('10.000');
  });

  test('clearing the threshold is not the same as setting it to zero', async () => {
    await setOwnership(HELD, '2026-07-01', '0.5');

    await setThreshold(0);
    expect(await flag(HELD), 'every recorded holding is at or above 0%').toBe(true);

    await setThreshold(null);
    expect(await flag(HELD), 'no policy in force means not determined').toBeNull();
  });

  // --- the adjustment says what caused it ----------------------------------

  test('a standalone adjustment is refused without a reason', async () => {
    await expect(
      applyOwnershipMutation(db(), FINANCE, {
        op: 'set',
        values: {
          companyId: HELD,
          asOfDate: '2026-07-01',
          ownershipPct: '11',
          proRataRights: false,
          changeReason: '  ',
        },
      }),
    ).rejects.toThrow(/must say what caused it/i);
  });

  test('the deal-close path stores the round instead of a reason', async () => {
    // ADR-035 clause 1, both halves in one test: the capture writes no prose,
    // and what it writes instead is the round it was captured with.
    const roundId = await newRound(HELD, '18.5');

    const history = await readOwnershipHistory(db(), FINANCE, HELD);
    expect(history).toHaveLength(1);
    expect(history[0]!.changeReason).toBeNull();
    expect(history[0]!.investmentRoundId).toBe(roundId);
    expect(history[0]!.roundLabel).toBe('Series A');
  });

  test('a named round must belong to the company, and must be live', async () => {
    const foreign = await newRound(OTHER);

    await expect(
      setOwnership(HELD, '2026-07-01', '11', { investmentRoundId: foreign }),
    ).rejects.toThrow(/belongs to PCF303/);

    const own = await newRound(HELD);
    await applyRoundMutation(db(), FINANCE, {
      op: 'delete',
      id: own,
      reason: 'captured in error during testing',
    });

    await expect(
      setOwnership(HELD, '2026-07-01', '11', { investmentRoundId: own }),
    ).rejects.toThrow(/has been deleted/);
  });

  test('an adjustment at a date already recorded restates that position', async () => {
    const first = await setOwnership(HELD, '2026-07-01', '11');
    expect(first.replacedExisting).toBe(false);

    const second = await setOwnership(HELD, '2026-07-01', '9', {
      changeReason: 'Corrected against the signed cap table.',
    });
    expect(second.replacedExisting).toBe(true);
    expect(second.id).toBe(first.id);

    // One position at that date, not two — and the prior figure is in the
    // version store, captured by the trigger rather than by this module.
    const history = await readOwnershipHistory(db(), FINANCE, HELD);
    expect(history).toHaveLength(1);
    expect(history[0]!.ownershipPct).toBe('9.0000000000000000');

    const log = await readRowHistory(db(), FINANCE, 'company_ownership', first.id);
    const update = log.find((h) => h.action === 'update');
    expect(update, 'the correction must appear in the change log').toBeDefined();
    expect(update!.changedByName).toBe(FINANCE.displayName);
  });

  test('a deleted position stays visible on the history, and can be entered again', async () => {
    /* The hazard `writeOwnership` documents and F2 fixed on the marks index:
       the unique key does not exclude soft-deleted rows, so a deleted position
       still occupies its date. The entry path resurrects it and the history
       keeps showing it, rather than the operator meeting a constraint error
       against a row no screen admits exists. */
    const { id } = await setOwnership(HELD, '2026-07-01', '11');

    await applyOwnershipMutation(db(), FINANCE, {
      op: 'delete',
      id,
      reason: 'entered against the wrong company',
    });

    const afterDelete = await readOwnershipHistory(db(), FINANCE, HELD);
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0]!.deleted).toBe(true);
    // A deleted position is not a holding: the flag must not read from it.
    await setThreshold(10);
    expect(await flag(HELD)).toBeNull();

    const again = await setOwnership(HELD, '2026-07-01', '12');
    expect(again.id).toBe(id);
    const afterRestore = await readOwnershipHistory(db(), FINANCE, HELD);
    expect(afterRestore[0]!.deleted).toBe(false);
    expect(await flag(HELD)).toBe(true);
  });

  test('deleting a position requires a reason', async () => {
    const { id } = await setOwnership(HELD, '2026-07-01', '11');
    await expect(
      applyOwnershipMutation(db(), FINANCE, { op: 'delete', id }),
    ).rejects.toThrow(/requires a reason/i);
  });

  test('an adjustment inside a frozen period is refused without a restatement reason', async () => {
    await sql`
      insert into pc.fund_nav_snapshot (fund_id, period_end, nav, cumulative_cost, frozen_at)
      values (1, '2024-12-31', 0, 0, now())
      on conflict (fund_id, period_end) do update set frozen_at = now()
    `.execute(db());

    // The two reasons are different things and the test says so: the row-level
    // `changeReason` is supplied and the write is still refused, because what is
    // missing is the ADR-031 explanation for touching an issued period.
    await expect(setOwnership(HELD, '2024-06-30', '11')).rejects.toThrow(/already issued to the board/i);

    const result = await setOwnership(HELD, '2024-06-30', '11', {
      reason: 'cap table corrected from the signed 2024 closing file',
    });
    expect(result.restated).toBe(true);
  });

  // --- the report ----------------------------------------------------------

  test('the report agrees with the function, row for row', async () => {
    /* Two definitions of significant influence would be one too many. The
       report calls the function rather than repeating the comparison, and this
       is what says so after the fact. */
    await setThreshold(10);
    await setOwnership(HELD, '2026-07-01', '25');

    const report = await readSignificantInfluence(db(), FINANCE, AS_OF);
    for (const row of report.rows) {
      expect(row.significantInfluence, row.companyId).toBe(await flag(row.companyId));
    }
    expect(report.threshold).toBe('10.000');
  });

  test('the report carries the date each ownership figure is as at', async () => {
    // FR-21 depends on FR-36 because a flag over a stale cap table looks exactly
    // as authoritative as one over a current one. The age is a fact on the row;
    // no staleness threshold is invented anywhere.
    await setThreshold(10);
    await setOwnership(HELD, '2026-02-28', '25');

    const report = await readSignificantInfluence(db(), FINANCE, AS_OF);
    const held = report.rows.find((r) => r.companyId === HELD)!;
    expect(held.ownershipAsOfDate).toBe('2026-02-28');
    expect(held.changeReason).toMatch(/option pool/i);
    expect(held.enteredBy).toBe(FINANCE.displayName);
  });

  // --- the gates -----------------------------------------------------------

  test('the investment team cannot set a finance policy', async () => {
    await expect(
      applyFinancePolicyEdit(db(), VC, { kind: 'accounting-policy', significantInfluencePct: 10 }),
    ).rejects.toThrow(/Requires one of \[finance, admin\]/);
  });

  test('leadership cannot record ownership, and can read the schedule', async () => {
    await expect(
      applyOwnershipMutation(db(), LEADERSHIP, {
        op: 'set',
        values: {
          companyId: HELD,
          asOfDate: '2026-07-01',
          ownershipPct: '11',
          proRataRights: false,
          changeReason: 'Secondary sale.',
        },
      }),
    ).rejects.toThrow(/Requires one of \[vc, finance, admin\]/);

    const report = await readSignificantInfluence(db(), LEADERSHIP, AS_OF);
    expect(report.rows.length).toBeGreaterThan(0);
  });

  test('the deal lead can record ownership, because the table is already theirs', async () => {
    const result = await applyOwnershipMutation(db(), VC, {
      op: 'set',
      values: {
        companyId: HELD,
        asOfDate: '2026-07-01',
        ownershipPct: '11',
        proRataRights: false,
        changeReason: 'Founder secondary; heard at the board meeting.',
      },
    });
    expect(result.id).toBeTruthy();
  });

  // --- the retention options ------------------------------------------------

  test('a retired retention option keeps its marks and leaves the list', async () => {
    /* F2 left this table with no editing surface. The rule it was built with is
       what is asserted here: options are RETIRED, never deleted, because a
       factor already used is referenced by marks that must keep reconstructing. */
    await applyFinancePolicyEdit(db(), FINANCE, {
      kind: 'retention-option-active',
      factor: '0.25',
      isActive: false,
    });

    const after = await readFinancePolicies(db(), FINANCE);
    const retired = after.retentionOptions.find((o) => o.factor === '0.2500')!;
    expect(retired.isActive).toBe(false);
    expect(after.retentionOptions.find((o) => o.factor === '1.0000')!.isActive).toBe(true);

    await applyFinancePolicyEdit(db(), FINANCE, {
      kind: 'retention-option-active',
      factor: '0.25',
      isActive: true,
    });
    const restored = await readFinancePolicies(db(), FINANCE);
    expect(restored.retentionOptions.find((o) => o.factor === '0.2500')!.isActive).toBe(true);
  });

  test('a factor already on the list is not added twice under a second label', async () => {
    await expect(
      applyFinancePolicyEdit(db(), FINANCE, {
        kind: 'retention-option-add',
        factor: '0.75',
        label: 'Retain three quarters',
      }),
    ).rejects.toThrow(/already offered/i);
  });

  test('a 0% option is refused with the reason, not with a constraint error', async () => {
    /* F2 recorded that Q-19's 0% option had become "a one-row insert rather
       than a migration". It has not: `ref_fmv_retention_option` carries
       `check (factor > 0)`. The refusal says so in words, which is the only
       part of that this phase can fix without answering Q-19. */
    await expect(
      applyFinancePolicyEdit(db(), FINANCE, {
        kind: 'retention-option-add',
        factor: '0',
        label: 'Retain nothing — written to nil',
      }),
    ).rejects.toThrow(/Q-19/);
  });

  test('an added option is offered at the end of the list, and the review can use it', async () => {
    await applyFinancePolicyEdit(db(), FINANCE, {
      kind: 'retention-option-add',
      factor: '0.6',
      label: 'Retain 60% of existing FMV — a 40% decrease',
    });

    const policies = await readFinancePolicies(db(), FINANCE);
    const added = policies.retentionOptions.find((o) => o.factor === '0.6000')!;
    expect(added.isActive).toBe(true);
    expect(added.marksUsing).toBe(0);
    expect(added.sortOrder).toBeGreaterThan(
      policies.retentionOptions.find((o) => o.factor === '0.2500')!.sortOrder,
    );

    await sql`delete from pc.ref_fmv_retention_option where factor = 0.6`.execute(db());
  });
});
