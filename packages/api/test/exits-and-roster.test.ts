/**
 * F4 · Roster status, the exit event, and what `exited` means (ADR-036).
 *
 * THE TEST THAT MATTERS MOST HERE IS THE ONE ABOUT THE FALLBACK. `exited` is in
 * the frozen ADR-001 contract, and the golden masters assert against a fixture
 * with no Affinity roster status anywhere in it. ADR-036 clause 4 keeps that
 * path working:
 *
 *     exited = (the roster says exited)
 *           or (the roster has not spoken, and an exit event exists)
 *
 * Delete the second half and 252 golden masters go red. Delete the first half
 * and the platform quietly goes back to counting seven exits that are not.
 *
 * The rest assert what the phase promises and cannot be allowed to stop doing:
 *
 *   1. **An exit event does not move a company between views.** Recording one
 *      against a company the roster still calls ours leaves it in the portfolio
 *      — the ADR-036 clause 2 state, which the Exited view shows and does not
 *      resolve.
 *   2. **Membership and exit are answered by the table**, so a status nobody
 *      has classified changes no view.
 *   3. **The exit vocabulary comes from the constraint**, not from a copy in
 *      TypeScript that would refuse a value the database accepts.
 *
 * REQUIRES A DATABASE. Skipped when DATABASE_URL is unset.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { config } from 'dotenv';
import { sql } from 'kysely';

import { closeDb, db } from '../src/db.js';
import type { Principal } from '../src/auth/principal.js';
import { applyExitMutation } from '../src/write/exits.js';
import { readExitedView } from '../src/read/exits.js';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '../../../.env') });

const hasDb = Boolean(process.env.DATABASE_URL);

/** The roster says this one has left. */
const GONE = 'PCF401';
/** Written off, and the roster still calls it ours — ADR-036 clause 2. */
const LAGGING = 'PCF402';
/** No Affinity roster status at all — the fixture path. */
const FIXTURE = 'PCF403';

const AS_OF = '2026-08-31';

const FINANCE: Principal = {
  userId: '',
  entraObjectId: 'test-f4-finance',
  email: 'f4-finance@example.test',
  displayName: 'Test Controller',
  role: 'finance',
};
const VC: Principal = {
  userId: '',
  entraObjectId: 'test-f4-vc',
  email: 'f4-vc@example.test',
  displayName: 'Test Deal Lead',
  role: 'vc',
};

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

/** The roster status, as the sync would have written it. */
async function setRoster(companyId: string, status: string | null): Promise<void> {
  await sql`
    insert into pc.company_state (company_id, effective_from, roster_status, set_by, note)
    values (${companyId}, current_date, ${status}, ${FINANCE.userId}::uuid, 'F4 test')
    on conflict (company_id) where effective_to is null
      do update set roster_status = excluded.roster_status
  `.execute(db());
}

/** `exited`, from the function every screen and the export read. */
async function isExited(companyId: string): Promise<boolean | null> {
  const { rows } = await sql<{ exited: boolean }>`
    select exited from pc.company_current_asof(${AS_OF}::date) where company_id = ${companyId}
  `.execute(db());
  return rows[0]?.exited ?? null;
}

const record = (companyId: string, over: Partial<{ exitDate: string; exitType: string; note: string }> = {}) =>
  applyExitMutation(db(), FINANCE, {
    op: 'record',
    values: {
      companyId,
      exitDate: over.exitDate ?? '2026-06-30',
      exitType: over.exitType ?? 'Acquisition',
      note: over.note ?? 'Acquired by a strategic buyer.',
    },
  });

describe.skipIf(!hasDb)('ADR-036 · roster status and the exit event', () => {
  beforeEach(async () => {
    for (const p of [FINANCE, VC]) await user(p);

    for (const [id, name] of [
      [GONE, 'Left The Roster Co'],
      [LAGGING, 'Written Off Still Listed Co'],
      [FIXTURE, 'No Affinity Status Co'],
    ]) {
      await sql`
        insert into pc.company (company_id, name, created_by)
        values (${id!}, ${name!}, ${FINANCE.userId}::uuid)
        on conflict (company_id) do nothing
      `.execute(db());
    }

    const ids = [GONE, LAGGING, FIXTURE];
    await sql`delete from pc.company_exit  where company_id in (${ids[0]!}, ${ids[1]!}, ${ids[2]!})`.execute(db());
    await sql`delete from pc.company_state where company_id in (${ids[0]!}, ${ids[1]!}, ${ids[2]!})`.execute(db());

    await setRoster(GONE, 'Exited');
    await setRoster(LAGGING, 'Portfolio');
    // FIXTURE deliberately gets no state row at all: that is what "the roster
    // has not spoken" means, and it is the shape every golden master runs on.
  });

  afterAll(async () => {
    for (const t of ['company_exit', 'company_state']) {
      await sql`delete from ${sql.table(`pc.${t}`)} where company_id in (${GONE}, ${LAGGING}, ${FIXTURE})`
        .execute(db()).catch(() => {});
    }
    await sql`delete from pc.company where company_id in (${GONE}, ${LAGGING}, ${FIXTURE})`
      .execute(db()).catch(() => {});
    await closeDb();
  });

  // --- the derivation ------------------------------------------------------

  test('the roster decides, and an exit event does not override it', async () => {
    expect(await isExited(GONE)).toBe(true);
    expect(await isExited(LAGGING)).toBe(false);

    // The clause 2 state: Finance books the write-off in March, Affinity is
    // updated in June. The company stays in the portfolio in between.
    await record(LAGGING, { exitType: 'Shutdown / write-off' });
    expect(await isExited(LAGGING)).toBe(false);
  });

  test('the fallback keeps the fixture path, which is what the golden masters run on', async () => {
    /**
     * THE ONE TO ARGUE ABOUT BEFORE DELETING. `demo.json` carries no Affinity
     * roster status anywhere, so without this clause every company in the
     * frozen fixture reads "not exited" and 252 golden masters move at once.
     */
    expect(await isExited(FIXTURE)).toBe(false);
    await record(FIXTURE);
    expect(await isExited(FIXTURE)).toBe(true);
  });

  test('a status nobody has classified falls back rather than asserting false', async () => {
    // An option added in Affinity on a Tuesday. "We do not know what this means"
    // is not evidence that the company is still in the portfolio.
    await setRoster(GONE, 'Some New Status Nobody Mapped');
    expect(await isExited(GONE)).toBe(false);

    await record(GONE);
    expect(await isExited(GONE)).toBe(true);
  });

  test('membership and exit are the table\'s answer, not a literal', async () => {
    const { rows } = await sql<{ n: string }>`
      select count(*)::text as n from pc.affinity_status_map
       where affinity_status = 'Exited' and is_exited and is_portfolio_member
    `.execute(db());
    expect(rows[0]!.n).toBe('1');

    // Exited is still a MEMBER: an exited company is on the roster, in the
    // Exited view, rather than vanishing from the platform.
    const { rows: notMember } = await sql<{ n: string }>`
      select count(*)::text as n from pc.affinity_status_map
       where affinity_status in ('Watchlist','Passed') and is_portfolio_member
    `.execute(db());
    expect(notMember[0]!.n).toBe('0');
  });

  // --- the write path ------------------------------------------------------

  test('recording an exit says whether the company is still on the roster', async () => {
    const first = await record(LAGGING, { exitType: 'Shutdown / write-off' });
    expect(first.replacedExisting).toBe(false);
    expect(first.stillOnRoster, 'the roster still calls this one ours').toBe(true);

    const second = await record(LAGGING, { exitType: 'Secondary' });
    expect(second.replacedExisting, 'one exit per company; a second entry corrects the first').toBe(true);

    const off = await record(GONE);
    expect(off.stillOnRoster).toBe(false);
  });

  test('the exit type is checked against the vocabulary the database holds', async () => {
    await expect(record(GONE, { exitType: 'Wound up' })).rejects.toThrow(/not one of the recorded exit types/i);

    const view = await readExitedView(db(), FINANCE, AS_OF);
    // Read from the CHECK, so the form cannot offer a value the write refuses.
    expect(view.exitTypes).toContain('Strategic acquisition');
    expect(view.exitTypes).toContain('Shutdown / write-off');
    for (const t of view.exitTypes) {
      await expect(record(GONE, { exitType: t })).resolves.toBeTruthy();
    }
  });

  test('removing an exit event requires a reason, and is audited', async () => {
    await record(GONE);
    await expect(
      applyExitMutation(db(), FINANCE, { op: 'remove', companyId: GONE, reason: '' }),
    ).rejects.toThrow(/requires a reason/i);

    await applyExitMutation(db(), FINANCE, {
      op: 'remove',
      companyId: GONE,
      reason: 'recorded against the wrong company',
    });

    const { rows } = await sql<{ action: string; changed_by: string }>`
      select action, changed_by::text as changed_by from pc.audit_log
       where table_name = 'company_exit' and record_id = ${GONE}
       order by audit_log_id desc limit 1
    `.execute(db());
    expect(rows[0]!.action).toBe('delete');
    expect(rows[0]!.changed_by).toBe(FINANCE.userId);

    // Off the roster with no exit event: a state, not an error.
    expect(await isExited(GONE)).toBe(true);
  });

  test('the deal lead cannot record an exit', async () => {
    await expect(
      applyExitMutation(db(), VC, {
        op: 'record',
        values: { companyId: GONE, exitDate: '2026-06-30', exitType: 'Acquisition' },
      }),
    ).rejects.toThrow(/Requires one of \[finance, admin\]/);
  });

  // --- the view ------------------------------------------------------------

  test('the view separates the two states rather than merging them', async () => {
    await record(GONE);
    await record(LAGGING, { exitType: 'Shutdown / write-off' });

    const view = await readExitedView(db(), FINANCE, AS_OF);

    expect(view.exited.map((r) => r.companyId)).toContain(GONE);
    expect(view.exited.map((r) => r.companyId)).not.toContain(LAGGING);

    const lagging = view.recordedNotOnRoster.find((r) => r.companyId === LAGGING);
    expect(lagging, 'the clause 2 state has its own group').toBeDefined();
    expect(lagging!.rosterStatus).toBe('Portfolio');
    expect(lagging!.exited).toBe(false);
  });

  test('a company off the roster with no exit event is listed, not hidden', async () => {
    const view = await readExitedView(db(), FINANCE, AS_OF);
    const gone = view.exited.find((r) => r.companyId === GONE);
    expect(gone, 'membership does not wait on Finance').toBeDefined();
    expect(gone!.exitDate).toBeNull();
    expect(gone!.exitType).toBeNull();
  });
});
